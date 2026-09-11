/**
 * Governance & compliance specialist: what may ship as-is, what needs a
 * human's review, and what the rules disallow. Findings come from three kinds
 * of evidence, and the escalation policy decides what each one leads to:
 *
 *   check              proven from code or a named entity (restricted package, raw color, ...)
 *   rule-wording       the request resembles a rule; never enough to reject on
 *   exception-request  the request asks to bypass a rule; a human decides
 */
import type { EscalationPolicy } from "../../config/schema.js";
import type { Contract, GovernanceCheck, GovernanceRule } from "../../schema/contract.js";
import type { GovernanceDecision, GovernanceFinding } from "../../schema/response.js";
import { toRef } from "../components/answer.js";
import { search } from "../components/resolve.js";
import { matchRules, type ContractIndex } from "../context.js";
import type { Section, Specialist } from "../types.js";
import { checkCode, CODE_CHECKS } from "./code.js";
import { actionFor, outcomeFor } from "./policy.js";

export function createGovernanceSpecialist(contract: Contract, policy: EscalationPolicy): Specialist {
  const system = contract.client.name;

  const fromCheck = (index: ContractIndex, check: GovernanceCheck, evidence: string, line?: number): GovernanceFinding => {
    const rule = contract.governance.checks[check] ? index.rule(contract.governance.checks[check]!) : undefined;
    const finding: GovernanceFinding = {
      ruleId: rule?.id ?? null,
      rule: rule?.rule ?? null,
      severity: rule?.severity ?? "unspecified",
      category: rule?.category ?? null,
      basis: "check",
      check,
      action: "warn",
      evidence: rule ? evidence : `${evidence} (Docent check ${check} is not mapped to one of this design system's rules)`,
      response: rule?.response ?? null,
    };
    if (line !== undefined) finding.line = line;
    finding.action = actionFor(policy, finding);
    return finding;
  };

  const fromRule = (rule: GovernanceRule, basis: "rule-wording" | "exception-request", evidence: string): GovernanceFinding => {
    const finding: GovernanceFinding = {
      ruleId: rule.id,
      rule: rule.rule,
      severity: rule.severity,
      category: rule.category,
      basis,
      check: null,
      action: "warn",
      evidence,
      response: rule.response,
    };
    finding.action = actionFor(policy, finding);
    return finding;
  };

  return {
    domain: "governance",
    handle({ input, mentions: m, index }): Section {
      const findings: GovernanceFinding[] = [];
      const checksRun = new Set<string>();
      const notEvaluated: string[] = [];

      if (input.code) {
        const result = checkCode(input.code, index);
        CODE_CHECKS.forEach((c) => checksRun.add(c));
        notEvaluated.push(...result.notEvaluated);
        for (const f of result.findings) findings.push(fromCheck(index, f.check, f.evidence, f.line));
      }

      // Named things the rules govern count as violations only when the request proposes using them.
      const proposing = Boolean(m.words.proposal || m.words.permission || m.words.exception || m.entities.baseMutation || m.entities.newDependency);
      if (proposing) {
        for (const pkg of m.entities.restrictedPackages) findings.push(fromCheck(index, "restricted-package", `the request proposes ${pkg}`));
        for (const c of m.entities.rawColors) findings.push(fromCheck(index, "raw-color", `the request proposes the raw color ${c}`));
        for (const c of m.entities.paletteUtilities) findings.push(fromCheck(index, "palette-utility", `the request proposes the palette utility ${c}`));
        if (m.entities.baseMutation) findings.push(fromCheck(index, "base-mutation", `the request proposes changing a base component: "${m.entities.baseMutation}"`));
        if (m.entities.newDependency) findings.push(fromCheck(index, "new-dependencies", `the request proposes adding a dependency: "${m.entities.newDependency}"`));
        for (const name of m.components.unresolved) findings.push(fromCheck(index, "unindexed-component", `${name} is not in the component inventory`));
        const inventory = contract.components.some((c) => c.manifest !== null);
        for (const c of [...m.components.strong, ...m.components.weak]) {
          if (inventory && c.manifest === null) findings.push(fromCheck(index, "unindexed-component", `${c.name} exists in source but is not in the component inventory`));
        }
        [
          ["restricted-package", m.entities.restrictedPackages.length],
          ["raw-color", m.entities.rawColors.length],
          ["palette-utility", m.entities.paletteUtilities.length],
          ["base-mutation", m.entities.baseMutation],
          ["new-dependencies", m.entities.newDependency],
          ["unindexed-component", m.components.unresolved.length],
        ].forEach(([check, hit]) => hit && checksRun.add(check as string));
      }

      const matches = matchRules(contract, input.question);
      const cited = new Set(findings.map((f) => f.ruleId).filter(Boolean));
      if (m.words.permission || m.words.proposal) {
        for (const match of matches.filter((x) => x.strong && !cited.has(x.rule.id)).slice(0, 2)) {
          findings.push(fromRule(match.rule, "rule-wording", `the request matches the rule's wording (${match.overlap.join(", ")})`));
          cited.add(match.rule.id);
        }
      }

      for (const rule of m.rules) {
        if (cited.has(rule.id) || m.words.exception) continue;
        findings.push(fromRule(rule, "rule-wording", `the request names the rule ${rule.id}`));
        cited.add(rule.id);
      }

      if (m.words.exception) {
        const target = m.rules[0]?.id ?? findings.find((f) => f.ruleId)?.ruleId;
        const rule = (target && index.rule(target)) || matches[0]?.rule;
        if (rule) findings.push(fromRule(rule, "exception-request", `the request asks for an exception: "${m.words.exception}"`));
        else {
          findings.push({
            ruleId: null,
            rule: null,
            severity: "unspecified",
            category: null,
            basis: "exception-request",
            check: null,
            action: policy.onExceptionRequest,
            evidence: `the request asks for an exception ("${m.words.exception}") without naming a specific rule`,
            response: null,
          });
        }
      }

      if (!input.code) {
        notEvaluated.push("Plain-language requests are matched against rule wording and named items (packages, colors, components, dependencies); rules that need design judgment are not evaluated.");
      }
      const outcome = outcomeFor(findings);
      const decision: GovernanceDecision = {
        outcome,
        exceptionRequested: Boolean(m.words.exception),
        findings,
        applicableRules: matches
          .filter((x) => !cited.has(x.rule.id))
          .slice(0, 5)
          .map(({ rule }) => ({ id: rule.id, rule: rule.rule, severity: rule.severity, category: rule.category })),
        checksRun: [...checksRun].sort(),
        notEvaluated,
      };

      // Client responses can be templates ("Use {token} instead of {value}"); unfilled ones read worse than the rule itself.
      const describe = (f: GovernanceFinding) => {
        const response = f.response && !/\{\w+\}/.test(f.response) ? f.response : null;
        return `${f.ruleId ?? f.check ?? "exception"} (${f.severity}): ${response ?? f.rule ?? f.evidence} [${f.evidence}]`;
      };
      const byAction = (a: GovernanceFinding["action"]) => findings.filter((f) => f.action === a).map(describe);
      const reviewers = policy.reviewers.length ? policy.reviewers.join(", ") : "the design-system team";
      const messages: Record<GovernanceDecision["outcome"], string> = {
        disallowed: `Not allowed by the ${system} design system. ${byAction("reject").join(" ")} Do not proceed with this approach.`,
        "needs-review": `This conflicts with the ${system} design system's rules and needs a human decision before you proceed. ${[...byAction("escalate"), ...byAction("reject")].join(" ")} It has been sent to ${reviewers}; do not implement it until the review is approved.`,
        warn: `Allowed, with warnings you should resolve: ${byAction("warn").join(" ")}`,
        "no-conflict": input.code
          ? `No violations found by the checks that ran (${decision.checksRun.join(", ")}). See notEvaluated for what was not checked.`
          : `Docent found no rule in the ${system} design system that this request conflicts with.${decision.applicableRules.length ? " Related rules are listed under applicableRules." : ""} See notEvaluated for the limits of this check.`,
      };

      const needsAlternatives = findings.some((f) => f.check === "restricted-package" || f.check === "unindexed-component" || f.check === "bespoke-duplicate");
      const alternatives = needsAlternatives
        ? search(contract, input.question, 4).filter((c) => c.manifest !== null || !contract.components.some((x) => x.manifest)).map(toRef)
        : [];

      return { status: "answered", message: messages[outcome], governance: decision, alternatives };
    },
  };
}
