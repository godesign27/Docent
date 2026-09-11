/**
 * The concierge: single entry point for calling agents. It routes a request
 * to a specialist, validates the drafted result against the contract, records
 * the exchange, and only then returns it.
 *
 * Phase 1 has one specialist (components), so routing is a pass-through; the
 * routing decision is still recorded so Phase 2 routing is observable.
 */
import type { Contract } from "../schema/contract.js";
import {
  AskInput,
  GetComponentInput,
  GetFoundationInput,
  type DocentResponse,
  type FetchResponse,
  type ValidationResult,
} from "../schema/response.js";
import { createDistributor, type Distributor } from "../specialists/components/fetch.js";
import { createComponentsSpecialist, type Specialist } from "../specialists/components/index.js";
import { validateFetch, validateResponse } from "./validate.js";

export type ToolName = "ask" | "get_component" | "get_foundation";

export interface CallerInfo {
  /** Self-reported by the caller (the caller argument), else the MCP client name. */
  name: string;
  client: { name: string; version: string } | null;
  transport: "stdio" | "http" | "cli" | "test";
}

export interface AuditEntry {
  event: "request";
  tool: ToolName;
  requestId: string;
  at: string;
  client: string;
  caller: CallerInfo;
  input: unknown;
  routing: { specialist: string | null; reason: string };
  status: DocentResponse["status"] | FetchResponse["status"];
  componentIds: string[];
  /** Paths and hashes of source files handed out, for get_component / get_foundation. */
  filesDelivered: { path: string; sha256: string }[];
  validation: ValidationResult;
  flagged: boolean;
  flags: string[];
  latencyMs: number;
  contractHash: string;
  response: DocentResponse | FetchResponse;
}

export interface AuditLog {
  record(entry: AuditEntry): void | Promise<void>;
}

export interface ConciergeOptions {
  contract: Contract;
  audit: AuditLog;
  docentVersion: string;
  /** Source snapshot from ingestion. Without it, get_component and get_foundation return errors. */
  sources?: Record<string, string>;
  /** Overrides for tests. */
  specialist?: Specialist;
  distributor?: Distributor;
}

const ROUTING = { specialist: "components", reason: "phase 1: the components specialist handles every request" };
const PENDING: ValidationResult = { passed: false, checks: [] };

export class Concierge {
  private readonly contract: Contract;
  private readonly audit: AuditLog;
  private readonly specialist: Specialist;
  private readonly distributor: Distributor | null;
  private readonly docentVersion: string;

  constructor(options: ConciergeOptions) {
    this.contract = options.contract;
    this.audit = options.audit;
    this.docentVersion = options.docentVersion;
    this.specialist = options.specialist ?? createComponentsSpecialist(options.contract);
    this.distributor = options.distributor ?? (options.sources ? createDistributor(options.contract, options.sources) : null);
  }

  get clientName(): string {
    return this.contract.client.name;
  }

  get canDistribute(): boolean {
    return this.distributor !== null;
  }

  private provenance() {
    return {
      client: this.contract.client,
      contractHash: this.contract.contentHash,
      contractGeneratedAt: this.contract.generatedAt,
      sourceCommit: this.contract.source.commit,
      docentVersion: this.docentVersion,
    };
  }

  async ask(rawInput: unknown, caller: CallerInfo): Promise<DocentResponse> {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    const base = { requestId, specialist: null, components: [], unresolved: [], clarification: null, alternatives: [], inventory: null, provenance: this.provenance() };
    const flags: string[] = [];
    const input = AskInput.safeParse(rawInput);

    let response: DocentResponse;
    if (!input.success) {
      flags.push("invalid-input");
      response = { ...base, status: "error", message: invalidInput(input.error.issues), validation: { passed: true, checks: [] } };
    } else {
      let draft: DocentResponse;
      try {
        draft = { ...base, specialist: this.specialist.name, ...this.specialist.handle(input.data), validation: PENDING };
      } catch (err) {
        flags.push("specialist-error");
        draft = { ...base, status: "error", message: `Specialist failed: ${(err as Error).message}`, validation: PENDING };
      }
      const validation = validateResponse(draft, this.contract);
      response = validation.passed ? { ...draft, validation } : { ...base, specialist: this.specialist.name, status: "error", message: WITHHELD, validation };
      if (!validation.passed) flags.push("validation-failed");
      if (response.unresolved.length > 0 || response.status === "not-found") flags.push("requested-component-not-in-design-system");
      if (response.components.some((c) => c.allowed === false)) flags.push("component-outside-inventory");
      if (response.components.some((c) => c.docentGaps.some((g) => g.kind === "spec-drift"))) flags.push("spec-drift");
    }

    await this.record("ask", requestId, started, rawInput, caller, input.success ? ROUTING : { specialist: null, reason: "invalid input" }, response, flags);
    return response;
  }

  getComponent(rawInput: unknown, caller: CallerInfo): Promise<FetchResponse> {
    return this.fetch("get_component", GetComponentInput, rawInput, caller);
  }

  getFoundation(rawInput: unknown, caller: CallerInfo): Promise<FetchResponse> {
    return this.fetch("get_foundation", GetFoundationInput, rawInput ?? {}, caller);
  }

  private async fetch(
    tool: "get_component" | "get_foundation",
    schema: typeof GetComponentInput | typeof GetFoundationInput,
    rawInput: unknown,
    caller: CallerInfo,
  ): Promise<FetchResponse> {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    const base = {
      requestId,
      tool,
      components: [],
      files: [],
      packages: [],
      pathAliases: this.contract.foundation?.pathAliases ?? [],
      instructions: [],
      unresolved: [],
      rejected: [],
      alternatives: [],
      provenance: this.provenance(),
    };
    const flags: string[] = [];
    const input = schema.safeParse(rawInput);

    let response: FetchResponse;
    if (!input.success) {
      flags.push("invalid-input");
      response = { ...base, status: "error", message: invalidInput(input.error.issues), validation: { passed: true, checks: [] } };
    } else if (!this.distributor) {
      flags.push("distribution-unavailable");
      response = { ...base, status: "error", message: "This Docent instance has no source snapshot loaded, so it cannot deliver source. Re-run ingestion.", validation: { passed: true, checks: [] } };
    } else {
      let draft: FetchResponse;
      try {
        const body = tool === "get_component" ? this.distributor.getComponent(input.data as GetComponentInput) : this.distributor.getFoundation();
        draft = { ...base, ...body, validation: PENDING };
      } catch (err) {
        flags.push("specialist-error");
        draft = { ...base, status: "error", message: `Specialist failed: ${(err as Error).message}`, validation: PENDING };
      }
      const validation = await validateFetch(
        draft,
        this.contract,
        tool === "get_component" ? { tool, input: input.data as GetComponentInput } : { tool },
      );
      response = validation.passed ? { ...draft, validation } : { ...base, status: "error", message: WITHHELD, validation };
      if (!validation.passed) flags.push("validation-failed");
      if (response.unresolved.length > 0) flags.push("requested-component-not-in-design-system");
      if (response.rejected.length > 0) flags.push("component-outside-inventory");
    }

    await this.record(tool, requestId, started, rawInput, caller, input.success ? ROUTING : { specialist: null, reason: "invalid input" }, response, flags);
    return response;
  }

  private async record(
    tool: ToolName,
    requestId: string,
    started: number,
    input: unknown,
    caller: CallerInfo,
    routing: AuditEntry["routing"],
    response: DocentResponse | FetchResponse,
    flags: string[],
  ) {
    await this.audit.record({
      event: "request",
      tool,
      requestId,
      at: new Date(started).toISOString(),
      client: this.contract.client.id,
      caller,
      input,
      routing,
      status: response.status,
      componentIds: response.components.map((c) => c.id),
      filesDelivered: "files" in response ? response.files.map((f) => ({ path: f.path, sha256: f.sha256 })) : [],
      validation: response.validation,
      flagged: flags.length > 0,
      flags,
      latencyMs: Date.now() - started,
      contractHash: this.contract.contentHash,
      // File contents are identified by hash above; storing them again would bloat the log.
      response: "files" in response ? { ...response, files: response.files.map((f) => ({ ...f, content: `<${f.content.length} chars>` })) } : response,
    });
  }
}

const WITHHELD =
  "Docent could not validate its result against the design-system contract, so nothing was returned. The failure has been logged for review.";

function invalidInput(issues: { path: PropertyKey[]; message: string }[]): string {
  return `Invalid request: ${issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`;
}
