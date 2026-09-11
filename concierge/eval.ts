/**
 * Routing evaluation: runs a labelled batch of real-world requests through the
 * concierge and compares where they went and what came back. This is how the
 * Phase 2 exit criterion is measured, and how a new client's routing is
 * checked during onboarding.
 */
import { z } from "zod";
import type { EscalationPolicy } from "../config/schema.js";
import type { Contract } from "../schema/contract.js";
import { Domain, ResponseStatus, type DocentResponse } from "../schema/response.js";
import { Concierge, MemoryReviewStore, type AuditEntry } from "./concierge.js";

export const EvalCase = z.object({
  name: z.string().optional(),
  ask: z.string(),
  component: z.string().optional(),
  code: z.string().optional(),
  expect: z.object({
    domains: z.array(Domain).optional().describe("Exact set of specialists the request must reach"),
    includesDomains: z.array(Domain).optional(),
    status: ResponseStatus.optional(),
    outcome: z.enum(["no-conflict", "warn", "needs-review", "disallowed"]).optional(),
    rules: z.array(z.string()).optional().describe("Rule ids that must appear in findings"),
    components: z.array(z.string()).optional().describe("Component ids that must be answered"),
    patterns: z.array(z.string()).optional(),
    tokens: z.array(z.string()).optional(),
    unresolved: z.array(z.string()).optional(),
  }),
});
export type EvalCase = z.infer<typeof EvalCase>;
export const EvalBatch = z.array(EvalCase);
export type EvalBatch = z.infer<typeof EvalBatch>;

export interface EvalResult {
  case: EvalCase;
  passed: boolean;
  failures: string[];
  response: DocentResponse;
}

export async function runEval(
  contract: Contract,
  policy: EscalationPolicy,
  batch: EvalCase[],
  docentVersion: string,
  domains?: Domain[],
): Promise<EvalResult[]> {
  // In-memory audit and reviews: evaluation must not pollute a client's real logs or review queue.
  const audit = { entries: [] as AuditEntry[], record(e: AuditEntry) { this.entries.push(e); } };
  const concierge = new Concierge({ contract, audit, policy, docentVersion, reviews: new MemoryReviewStore(), ...(domains ? { domains } : {}) });
  const results: EvalResult[] = [];

  for (const c of batch) {
    const response = await concierge.ask(
      { question: c.ask, ...(c.component ? { component: c.component } : {}), ...(c.code ? { code: c.code } : {}), caller: "eval" },
      { name: "eval", client: null, transport: "test" },
    );
    const failures: string[] = [];
    const e = c.expect;
    const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
    const missing = (wanted: string[] | undefined, got: string[], label: string) => {
      const absent = (wanted ?? []).filter((w) => !got.includes(w));
      if (absent.length) failures.push(`${label} missing ${absent.join(", ")} (got ${got.join(", ") || "none"})`);
    };

    if (!response.validation.passed) failures.push(`validation failed: ${response.validation.checks.filter((x) => !x.passed).flatMap((x) => x.failures).join("; ")}`);
    if (e.domains && !sameSet(e.domains, response.routing.domains)) failures.push(`routed to ${response.routing.domains.join(", ") || "nothing"}, expected ${e.domains.join(", ")}`);
    missing(e.includesDomains, response.routing.domains, "routing");
    if (e.status && response.status !== e.status) failures.push(`status ${response.status}, expected ${e.status}`);
    if (e.outcome && response.governance?.outcome !== e.outcome) failures.push(`governance outcome ${response.governance?.outcome ?? "none"}, expected ${e.outcome}`);
    missing(e.rules, response.governance?.findings.map((f) => f.ruleId ?? "") ?? [], "findings");
    missing(e.components, response.components.map((x) => x.id), "components");
    missing(e.patterns, response.patterns.map((x) => x.id), "patterns");
    missing(e.tokens, response.tokens.map((x) => x.id), "tokens");
    missing(e.unresolved, response.unresolved, "unresolved");

    results.push({ case: c, passed: failures.length === 0, failures, response });
  }
  return results;
}
