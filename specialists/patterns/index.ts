/**
 * Patterns & usage specialist: how components compose into flows, when to use
 * a component, and what it must not be used for.
 */
import type { ComponentContract, Contract, PatternContract } from "../../schema/contract.js";
import type { PatternAnswer, UsageAnswer } from "../../schema/response.js";
import { toRef } from "../components/answer.js";
import { search, terms } from "../components/resolve.js";
import type { Section, Specialist } from "../types.js";

/** Words every pattern shares; they say nothing about which pattern is meant. */
const GENERIC = new Set(terms("flow flows pattern patterns workflow build show way right best user users screen page"));

export function searchPatterns(contract: Contract, text: string, limit = 5): { pattern: PatternContract; score: number }[] {
  const wanted = [...new Set(terms(text))].filter((t) => !GENERIC.has(t));
  if (wanted.length === 0) return [];
  return contract.patterns
    .map((pattern) => {
      const fields: [string[], number][] = [
        [terms(`${pattern.id} ${pattern.name}`), 3],
        [terms(pattern.intent ?? ""), 2],
        [terms([...pattern.sequence, ...pattern.rules, ...pattern.forbidden].join(" ")), 1],
      ];
      const score = wanted.reduce((sum, term) => sum + Math.max(0, ...fields.filter(([w]) => w.includes(term)).map(([, v]) => v)), 0);
      return { pattern, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score || a.pattern.id.localeCompare(b.pattern.id))
    .slice(0, limit);
}

export function patternAnswer(p: PatternContract, contract: Contract): PatternAnswer {
  const refs = (ids: string[]) => ids.flatMap((id) => {
    const c = contract.components.find((x) => x.id === id);
    return c ? [toRef(c)] : [];
  });
  return {
    id: p.id,
    name: p.name,
    intent: p.intent,
    requiredComponents: refs(p.requiredComponents),
    recommendedComponents: refs(p.recommendedComponents),
    optionalComponents: refs(p.optionalComponents),
    sequence: p.sequence,
    rules: p.rules,
    forbidden: p.forbidden,
    example: p.example,
    metadata: p.metadata,
  };
}

export function usageAnswer(c: ComponentContract, contract: Contract): UsageAnswer {
  const byGuidanceId = (id: string) =>
    contract.components.find((x) => x.id === id || x.manifest?.id === id || x.guidance?.id === id || x.name === id);
  return {
    component: toRef(c),
    whenNotToUse: c.guidance?.forbiddenUsage ?? [],
    agentRules: c.guidance?.agentRules ?? [],
    related: (c.guidance?.related ?? []).flatMap((r) => {
      const target = byGuidanceId(r.id);
      return target ? [{ id: target.id, name: target.name, note: r.note }] : [];
    }),
    patterns: contract.patterns.flatMap((p) => {
      const role = p.requiredComponents.includes(c.id) ? "required" : p.recommendedComponents.includes(c.id) ? "recommended" : p.optionalComponents.includes(c.id) ? "optional" : null;
      return role ? [{ id: p.id, name: p.name, role: role as "required" | "recommended" | "optional" }] : [];
    }),
  };
}

export function createPatternsSpecialist(contract: Contract): Specialist {
  const system = contract.client.name;

  return {
    domain: "patterns",
    handle({ input, mentions }): Section {
      let patterns = mentions.patterns;
      const named = [...mentions.components.strong, ...mentions.components.weak];
      // Only components written like code outrank a pattern search; "form" in "form submission" does not.
      const codeNamed = mentions.components.strong;
      const askedForPattern = /\bpatterns?\b/i.test(input.question);

      if (patterns.length === 0) {
        const hits = searchPatterns(contract, input.question, 4);
        const [first, second] = hits;
        if (first && (first.score >= 5 || codeNamed.length === 0 || askedForPattern) && (!second || first.score > second.score)) patterns = [first.pattern];
        else if (first && second && codeNamed.length === 0) {
          return {
            status: "clarification-needed",
            message: "More than one pattern fits the question. Ask again naming one of them.",
            clarification: {
              question: "Which of these patterns do you mean?",
              options: hits.map(({ pattern }) => ({ kind: "pattern", id: pattern.id, name: pattern.name, description: pattern.intent })),
            },
          };
        }
      }

      let usageFor = (patterns.length && !codeNamed.length ? [] : named).slice(0, 4);
      if (patterns.length === 0 && usageFor.length === 0) usageFor = search(contract, input.question, 3);
      const usage = usageFor.map((c) => usageAnswer(c, contract));

      if (patterns.length === 0 && usage.length === 0) {
        return {
          status: "not-found",
          message: `No pattern or component in the ${system} design system matches the question.${mentions.components.unresolved.length ? ` ${mentions.components.unresolved.map((u) => `"${u}"`).join(", ")} is not in the design system.` : ""}`,
          unresolved: mentions.components.unresolved,
        };
      }

      const parts = [
        patterns.length ? `Pattern${patterns.length === 1 ? "" : "s"} ${patterns.map((p) => p.name).join(", ")}: follow the sequence, include the required components and respect the forbidden list.` : "",
        usage.length ? `Usage guidance for ${usage.map((u) => u.component.name).join(", ")}: check whenNotToUse and related before choosing.` : "",
      ];
      return {
        status: "answered",
        message: parts.filter(Boolean).join(" "),
        patterns: patterns.map((p) => patternAnswer(p, contract)),
        usage,
        unresolved: mentions.components.unresolved,
      };
    },
  };
}
