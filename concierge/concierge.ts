/**
 * The concierge: single entry point for calling agents. It routes a request
 * to a specialist, validates the drafted answer against the contract, records
 * the exchange, and only then returns it.
 *
 * Phase 1 has one specialist (components), so routing is a pass-through; the
 * routing decision is still recorded so Phase 2 routing is observable.
 */
import type { Contract } from "../schema/contract.js";
import { AskInput, type DocentResponse, type ValidationResult } from "../schema/response.js";
import { createComponentsSpecialist, type Specialist } from "../specialists/components/index.js";
import { validateResponse } from "./validate.js";

export interface CallerInfo {
  /** Self-reported by the caller (the caller argument), else the MCP client name. */
  name: string;
  client: { name: string; version: string } | null;
  transport: "stdio" | "http" | "cli" | "test";
}

export interface AuditEntry {
  event: "request";
  requestId: string;
  at: string;
  client: string;
  caller: CallerInfo;
  input: unknown;
  routing: { specialist: string | null; reason: string };
  status: DocentResponse["status"];
  componentIds: string[];
  validation: ValidationResult;
  flagged: boolean;
  flags: string[];
  latencyMs: number;
  contractHash: string;
  response: DocentResponse;
}

export interface AuditLog {
  record(entry: AuditEntry): void | Promise<void>;
}

export interface ConciergeOptions {
  contract: Contract;
  audit: AuditLog;
  docentVersion: string;
  /** Override for tests. */
  specialist?: Specialist;
}

export class Concierge {
  private readonly contract: Contract;
  private readonly audit: AuditLog;
  private readonly specialist: Specialist;
  private readonly docentVersion: string;

  constructor(options: ConciergeOptions) {
    this.contract = options.contract;
    this.audit = options.audit;
    this.docentVersion = options.docentVersion;
    this.specialist = options.specialist ?? createComponentsSpecialist(options.contract);
  }

  get clientName(): string {
    return this.contract.client.name;
  }

  async ask(rawInput: unknown, caller: CallerInfo): Promise<DocentResponse> {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    const provenance = {
      client: this.contract.client,
      contractHash: this.contract.contentHash,
      contractGeneratedAt: this.contract.generatedAt,
      sourceCommit: this.contract.source.commit,
      docentVersion: this.docentVersion,
    };
    const base = { requestId, specialist: null, components: [], unresolved: [], clarification: null, alternatives: [], inventory: null, provenance };

    const input = AskInput.safeParse(rawInput);
    let response: DocentResponse;
    let routing: AuditEntry["routing"];
    const flags: string[] = [];

    if (!input.success) {
      routing = { specialist: null, reason: "invalid input" };
      response = {
        ...base,
        status: "error",
        message: `Invalid request: ${input.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`,
        validation: { passed: true, checks: [] },
      };
      flags.push("invalid-input");
    } else {
      routing = { specialist: this.specialist.name, reason: "phase 1: the components specialist handles every request" };
      let draft: DocentResponse;
      try {
        draft = { ...base, specialist: this.specialist.name, ...this.specialist.handle(input.data), validation: { passed: false, checks: [] } };
      } catch (err) {
        draft = { ...base, status: "error", message: `Specialist failed: ${(err as Error).message}`, validation: { passed: false, checks: [] } };
        flags.push("specialist-error");
      }

      const validation = validateResponse(draft, this.contract);
      if (validation.passed) {
        response = { ...draft, validation };
      } else {
        // Never return an answer that does not match the contract.
        response = {
          ...base,
          specialist: this.specialist.name,
          status: "error",
          message: "Docent could not validate its answer against the design-system contract, so no answer was returned. The failure has been logged for review.",
          validation,
        };
        flags.push("validation-failed");
      }

      if (response.unresolved.length > 0 || response.status === "not-found") flags.push("requested-component-not-in-design-system");
      if (response.components.some((c) => c.allowed === false)) flags.push("component-outside-inventory");
      if (response.components.some((c) => c.docentGaps.some((g) => g.kind === "spec-drift"))) flags.push("spec-drift");
    }

    await this.audit.record({
      event: "request",
      requestId,
      at: new Date(started).toISOString(),
      client: this.contract.client.id,
      caller,
      input: rawInput,
      routing,
      status: response.status,
      componentIds: response.components.map((c) => c.id),
      validation: response.validation,
      flagged: flags.length > 0,
      flags,
      latencyMs: Date.now() - started,
      contractHash: this.contract.contentHash,
      response,
    });
    return response;
  }
}
