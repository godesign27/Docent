/**
 * Turns findings into actions and an outcome under the client's escalation
 * policy. Shared by the governance specialist and by validation, so the two
 * cannot disagree about what a finding should lead to.
 */
import type { EscalationPolicy } from "../../config/schema.js";
import type { GovernanceDecision, GovernanceFinding } from "../../schema/response.js";

export type Action = GovernanceFinding["action"];

export function actionFor(policy: EscalationPolicy, finding: Pick<GovernanceFinding, "basis" | "severity">): Action {
  switch (finding.basis) {
    case "check":
      return policy.onViolation[finding.severity];
    case "exception-request":
      return policy.onExceptionRequest;
    case "rule-wording":
      // A resemblance to a rule is not proof. Never reject on it.
      return finding.severity === "critical" || finding.severity === "high" ? policy.onPossibleViolation : "warn";
  }
}

export function outcomeFor(findings: Pick<GovernanceFinding, "action" | "basis">[]): GovernanceDecision["outcome"] {
  if (findings.length === 0) return "no-conflict";
  // Asking for an exception hands the decision to a human, even when a rule would otherwise reject.
  if (findings.some((f) => f.basis === "exception-request" && f.action === "escalate")) return "needs-review";
  if (findings.some((f) => f.action === "reject")) return "disallowed";
  if (findings.some((f) => f.action === "escalate")) return "needs-review";
  return "warn";
}
