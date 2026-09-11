/**
 * The concierge: single entry point for calling agents. It routes a request
 * to the specialists the evidence points at, merges their answers, applies the
 * governance decision (withholding answers that are rejected or awaiting a
 * human), validates the result against the contract, records the exchange, and
 * only then returns it.
 */
import { EscalationPolicy } from "../config/schema.js";
import type { Contract } from "../schema/contract.js";
import {
  AskInput,
  CheckReviewInput,
  GetComponentInput,
  GetFoundationInput,
  type Domain,
  type DocentResponse,
  type FetchResponse,
  type ReviewRecord,
  type ReviewResponse,
  type ValidationResult,
} from "../schema/response.js";
import { createComponentsSpecialist } from "../specialists/components/index.js";
import { createDistributor, type Distributor } from "../specialists/components/fetch.js";
import { ContractIndex, extractMentions } from "../specialists/context.js";
import { createGovernanceSpecialist } from "../specialists/governance/index.js";
import { createPatternsSpecialist } from "../specialists/patterns/index.js";
import { createTokensSpecialist } from "../specialists/tokens/index.js";
import type { Section, Specialist } from "../specialists/types.js";
import { route } from "./router.js";
import { validateFetch, validateResponse } from "./validate.js";

export type ToolName = "ask" | "get_component" | "get_foundation" | "check_review";

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
  routing: { domains: Domain[]; reason: string; scores?: Record<string, number>; signals?: DocentResponse["routing"]["signals"] };
  status: DocentResponse["status"] | FetchResponse["status"] | ReviewResponse["status"];
  componentIds: string[];
  /** Paths and hashes of source files handed out, for get_component / get_foundation. */
  filesDelivered: { path: string; sha256: string }[];
  reviewId: string | null;
  validation: ValidationResult;
  flagged: boolean;
  flags: string[];
  latencyMs: number;
  contractHash: string;
  response: DocentResponse | FetchResponse | ReviewResponse;
}

export interface AuditLog {
  record(entry: AuditEntry): void | Promise<void>;
}

/** Where escalated requests wait for a human decision. */
export interface ReviewStore {
  create(review: ReviewRecord): void | Promise<void>;
  get(id: string): ReviewRecord | null | Promise<ReviewRecord | null>;
  list(): ReviewRecord[] | Promise<ReviewRecord[]>;
  decide(id: string, decision: { status: "approved" | "denied"; by: string; note: string }): ReviewRecord | Promise<ReviewRecord>;
}

export class MemoryReviewStore implements ReviewStore {
  private readonly reviews = new Map<string, ReviewRecord>();
  create(review: ReviewRecord) {
    this.reviews.set(review.id, structuredClone(review));
  }
  get(id: string) {
    const r = this.reviews.get(id);
    return r ? structuredClone(r) : null;
  }
  list() {
    return [...this.reviews.values()].map((r) => structuredClone(r));
  }
  decide(id: string, decision: { status: "approved" | "denied"; by: string; note: string }) {
    const r = this.reviews.get(id);
    if (!r) throw new Error(`No review ${id}`);
    if (r.status !== "pending") throw new Error(`Review ${id} was already ${r.status}`);
    r.status = decision.status;
    r.decision = { by: decision.by, at: new Date().toISOString(), note: decision.note };
    return structuredClone(r);
  }
}

export interface ConciergeOptions {
  contract: Contract;
  audit: AuditLog;
  docentVersion: string;
  /** Escalation policy from the client config. Defaults mirror a typical severity gate. */
  policy?: EscalationPolicy;
  reviews?: ReviewStore;
  /** Source snapshot from ingestion. Without it, get_component and get_foundation return errors. */
  sources?: Record<string, string>;
  /** Overrides for tests. */
  specialists?: Partial<Record<Domain, Specialist>>;
  distributor?: Distributor;
}

const PENDING: ValidationResult = { passed: false, checks: [] };

export class Concierge {
  private readonly contract: Contract;
  private readonly audit: AuditLog;
  private readonly policy: EscalationPolicy;
  private readonly reviews: ReviewStore;
  private readonly index: ContractIndex;
  private readonly specialists: Record<Domain, Specialist>;
  private readonly distributor: Distributor | null;
  private readonly docentVersion: string;

  constructor(options: ConciergeOptions) {
    this.contract = options.contract;
    this.audit = options.audit;
    this.docentVersion = options.docentVersion;
    this.policy = options.policy ?? EscalationPolicy.parse({});
    this.reviews = options.reviews ?? new MemoryReviewStore();
    this.index = new ContractIndex(options.contract);
    this.specialists = {
      components: createComponentsSpecialist(options.contract),
      tokens: createTokensSpecialist(options.contract),
      patterns: createPatternsSpecialist(options.contract),
      governance: createGovernanceSpecialist(options.contract, this.policy),
      ...options.specialists,
    };
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

  private emptyResponse(requestId: string): Omit<DocentResponse, "status" | "message" | "validation"> {
    return {
      requestId,
      specialists: [],
      routing: { domains: [], scores: {}, signals: [], reason: "" },
      components: [],
      unresolved: [],
      clarification: null,
      alternatives: [],
      inventory: null,
      tokens: [],
      tokenDecisions: [],
      tokenForbidden: [],
      patterns: [],
      usage: [],
      notes: [],
      governance: null,
      review: null,
      provenance: this.provenance(),
    };
  }

  async ask(rawInput: unknown, caller: CallerInfo): Promise<DocentResponse> {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    const base = this.emptyResponse(requestId);
    const flags: string[] = [];
    const input = AskInput.safeParse(rawInput);

    let response: DocentResponse;
    if (!input.success) {
      flags.push("invalid-input");
      response = { ...base, status: "error", message: invalidInput(input.error.issues), validation: { passed: true, checks: [] } };
    } else {
      let draft: DocentResponse;
      try {
        draft = this.draft(requestId, input.data);
      } catch (err) {
        flags.push("specialist-error");
        draft = { ...base, status: "error", message: `Specialist failed: ${(err as Error).message}`, validation: PENDING };
      }
      const validation = validateResponse(draft, this.contract, this.policy);
      response = validation.passed
        ? { ...draft, validation }
        : { ...base, routing: draft.routing, specialists: draft.specialists, status: "error", message: WITHHELD, validation };
      if (!validation.passed) flags.push("validation-failed");

      if (response.review) {
        await this.reviews.create({
          id: response.review.id,
          client: this.contract.client.id,
          requestId,
          createdAt: new Date(started).toISOString(),
          status: "pending",
          caller: caller.name,
          request: {
            question: input.data.question,
            ...(input.data.component ? { component: input.data.component } : {}),
            ...(input.data.domain ? { domain: input.data.domain } : {}),
            ...(input.data.code ? { code: input.data.code } : {}),
          },
          outcome: response.governance!.outcome,
          findings: response.governance!.findings,
          decision: null,
        });
      }

      if (response.status === "escalated") flags.push("escalated-for-review");
      if (response.status === "rejected") flags.push("rejected-by-governance");
      if (response.governance?.outcome === "warn") flags.push("governance-warning");
      if (response.unresolved.length > 0 || response.status === "not-found") flags.push("requested-item-not-in-design-system");
      if (response.components.some((c) => c.allowed === false)) flags.push("component-outside-inventory");
      if (response.components.some((c) => c.docentGaps.some((g) => g.kind === "spec-drift"))) flags.push("spec-drift");
    }

    await this.record(
      "ask",
      requestId,
      started,
      rawInput,
      caller,
      { domains: response.routing.domains, reason: response.routing.reason || "invalid input", scores: response.routing.scores, signals: response.routing.signals },
      response,
      flags,
    );
    return response;
  }

  /**
   * Routes, runs specialists and merges their sections into one response.
   * The result is deep-copied: nothing a caller does with a response may reach
   * back into the loaded contract, whichever specialist built it.
   */
  private draft(requestId: string, input: AskInput): DocentResponse {
    return structuredClone(this.merge(requestId, input));
  }

  private merge(requestId: string, input: AskInput): DocentResponse {
    const base = this.emptyResponse(requestId);
    const mentions = extractMentions(this.index, input);
    const routing = route(this.index, input, mentions);
    const routingRecord = { domains: routing.domains, scores: routing.scores, signals: routing.signals, reason: routing.reason };

    if (routing.clarification) {
      return { ...base, routing: routingRecord, status: "clarification-needed", message: routing.clarification.question, clarification: routing.clarification, validation: PENDING };
    }

    const sections = routing.domains.map((d) => [d, this.specialists[d].handle({ input, mentions, index: this.index })] as const);
    const merged: DocentResponse = { ...base, routing: routingRecord, specialists: routing.domains, status: "not-found", message: "", validation: PENDING };
    const uniqueBy = <T>(items: T[], key: (t: T) => string) => items.filter((item, i) => items.findIndex((x) => key(x) === key(item)) === i);

    for (const [, s] of sections) {
      merged.components = uniqueBy([...merged.components, ...(s.components ?? [])], (c) => c.id);
      merged.unresolved = uniqueBy([...merged.unresolved, ...(s.unresolved ?? [])], (u) => u);
      merged.alternatives = uniqueBy([...merged.alternatives, ...(s.alternatives ?? [])], (a) => a.id);
      merged.tokens = uniqueBy([...merged.tokens, ...(s.tokens ?? [])], (t) => t.id);
      merged.tokenDecisions = uniqueBy([...merged.tokenDecisions, ...(s.tokenDecisions ?? [])], (d) => d.need);
      merged.tokenForbidden = s.tokenForbidden?.length ? s.tokenForbidden : merged.tokenForbidden;
      merged.patterns = uniqueBy([...merged.patterns, ...(s.patterns ?? [])], (p) => p.id);
      merged.usage = uniqueBy([...merged.usage, ...(s.usage ?? [])], (u) => u.component.id);
      merged.notes = uniqueBy([...merged.notes, ...(s.notes ?? [])], (n) => n);
      merged.inventory = s.inventory ?? merged.inventory;
      merged.governance = s.governance ?? merged.governance;
    }

    const statuses = sections.map(([, s]) => s.status);
    merged.status = statuses.includes("answered") ? "answered" : statuses.includes("clarification-needed") ? "clarification-needed" : "not-found";
    if (merged.status === "clarification-needed") merged.clarification = sections.map(([, s]) => s.clarification).find(Boolean) ?? null;

    const governance = sections.find(([d]) => d === "governance")?.[1];
    const others = sections.filter(([d]) => d !== "governance").map(([, s]) => s.message);
    const outcome = merged.governance?.outcome;

    if (outcome === "disallowed" || outcome === "needs-review") {
      // Governance conflicts stop the answer: nothing that would help implement it goes back.
      Object.assign(merged, { components: [], tokens: [], tokenDecisions: [], tokenForbidden: [], patterns: [], usage: [], inventory: null, clarification: null });
      merged.status = outcome === "disallowed" ? "rejected" : "escalated";
      merged.message = governance!.message;
      if (outcome === "needs-review") {
        const id = `rev_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        merged.review = {
          id,
          status: "pending",
          reviewers: this.policy.reviewers,
          instructions: `Do not implement this until the review is approved. Call check_review with reviewId "${id}" to see the decision.`,
        };
        merged.message += ` Review id: ${id}.`;
      }
    } else {
      merged.message = [outcome === "warn" ? governance!.message : "", ...others, outcome === "no-conflict" ? governance!.message : ""].filter(Boolean).join(" ");
    }
    return merged;
  }

  async checkReview(rawInput: unknown, caller: CallerInfo): Promise<ReviewResponse> {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    const input = CheckReviewInput.safeParse(rawInput);
    const flags: string[] = [];
    let response: ReviewResponse;
    if (!input.success) {
      flags.push("invalid-input");
      response = { requestId, tool: "check_review", status: "error", message: invalidInput(input.error.issues), review: null, validation: { passed: true, checks: [] }, provenance: this.provenance() };
    } else {
      const review = await this.reviews.get(input.data.reviewId);
      const valid = !review || review.client === this.contract.client.id;
      const messages = {
        pending: "The review is still pending. Do not implement the escalated request yet.",
        approved: "A reviewer approved the request. Proceed within the reviewer's note.",
        denied: "A reviewer denied the request. Do not implement it; follow the reviewer's note.",
      };
      response = {
        requestId,
        tool: "check_review",
        status: review && valid ? review.status : "not-found",
        message: review && valid ? `${messages[review.status]}${review.decision ? ` Note from ${review.decision.by}: ${review.decision.note}` : ""}` : `No review ${input.data.reviewId} exists for this design system.`,
        review: review && valid ? review : null,
        validation: { passed: valid, checks: [{ id: "review-belongs-to-client", passed: valid, failures: valid ? [] : ["review belongs to another client"] }] },
        provenance: this.provenance(),
      };
    }
    await this.record("check_review", requestId, started, rawInput, caller, { domains: ["governance"], reason: "review lookup" }, response, flags);
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
      if (response.unresolved.length > 0) flags.push("requested-item-not-in-design-system");
      if (response.rejected.length > 0) flags.push("component-outside-inventory");
    }

    await this.record(tool, requestId, started, rawInput, caller, { domains: ["components"], reason: input.success ? "source delivery" : "invalid input" }, response, flags);
    return response;
  }

  private async record(
    tool: ToolName,
    requestId: string,
    started: number,
    input: unknown,
    caller: CallerInfo,
    routing: AuditEntry["routing"],
    response: DocentResponse | FetchResponse | ReviewResponse,
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
      componentIds: "components" in response ? response.components.map((c) => c.id) : [],
      filesDelivered: "files" in response ? response.files.map((f) => ({ path: f.path, sha256: f.sha256 })) : [],
      reviewId: "review" in response && response.review ? response.review.id : null,
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
