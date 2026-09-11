/**
 * Tokens & foundations specialist: color, type, spacing, radius, elevation and
 * theme values, with the meaning and decision guidance the client authored.
 * Tokens that are not defined are reported, never invented.
 */
import type { Contract, TokenCategory, TokenContract } from "../../schema/contract.js";
import type { TokenAnswer } from "../../schema/response.js";
import { terms } from "../components/resolve.js";
import type { Section, Specialist } from "../types.js";

const CATEGORY_WORDS: [RegExp, TokenCategory][] = [
  [/\b(colou?rs?|palette)\b/i, "color"],
  [/\b(spacing|padding|margins?|gaps?)\b/i, "spacing"],
  [/\b(radius|radii|rounded|corners?)\b/i, "radius"],
  [/\b(typography|fonts?|font[- ]sizes?|type scale|line[- ]height)\b/i, "typography"],
  [/\b(shadows?|elevation)\b/i, "elevation"],
  [/\b(motion|animations?|durations?|easing)\b/i, "motion"],
  [/\b(breakpoints?|screens?)\b/i, "breakpoint"],
];
const LISTING = /\b(all|list|which|what|scale|available|every|show)\b/i;

export function tokenAnswer(t: TokenContract): TokenAnswer {
  return {
    id: t.id,
    name: t.name,
    cssVariable: t.cssVariable,
    type: t.type,
    category: t.category,
    role: t.role,
    meaning: t.description,
    values: Object.fromEntries(Object.entries(t.values).map(([mode, v]) => [mode, v.raw])),
    utilities: [...new Set(t.tailwind.flatMap((b) => b.exampleClasses))],
    references: t.references,
  };
}

/** Tokens whose meaning, role or name overlap the text. */
export function searchTokens(contract: Contract, text: string, limit = 5): TokenContract[] {
  const wanted = new Set(terms(text));
  if (wanted.size === 0) return [];
  return contract.tokens
    .map((t) => {
      const name = terms(`${t.id} ${t.role ?? ""}`);
      const meaning = terms(t.description ?? "");
      const score = [...wanted].reduce((s, w) => s + (name.includes(w) ? 2 : meaning.includes(w) ? 1 : 0), 0);
      return { t, score };
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score || a.t.id.localeCompare(b.t.id))
    .slice(0, limit)
    .map((x) => x.t);
}

/** Authored "need -> use" entries whose need the text describes. */
export function searchDecisions(contract: Contract, text: string): { need: string; use: string }[] {
  const wanted = new Set(terms(text));
  return (contract.tokenGuidance?.decisions ?? []).filter((d) => {
    const need = [...new Set(terms(d.need))];
    const overlap = need.filter((t) => wanted.has(t)).length;
    return overlap >= 2 || (need.length > 0 && overlap === need.length);
  });
}

export function createTokensSpecialist(contract: Contract): Specialist {
  const system = contract.client.name;
  const frameworkDefaultsGap = contract.gaps.find((g) => g.kind === "framework-defaults-not-captured");

  return {
    domain: "tokens",
    handle({ input, mentions, index }): Section {
      const q = input.question;
      const found = new Map(mentions.tokens.map((t) => [t.id, t]));
      const notes: string[] = [];

      const decisions = searchDecisions(contract, q);
      for (const d of decisions) {
        const refs = index.classes.analyze([{ value: d.use.replace(/[+,]/g, " "), line: 1 }]).tokenRefs;
        refs.forEach((id) => found.set(id, index.token(id)!));
      }

      const category = CATEGORY_WORDS.find(([re]) => re.test(q))?.[1];
      if (category && found.size === 0 && LISTING.test(q)) {
        const inCategory = contract.tokens.filter((t) => t.category === category);
        inCategory.slice(0, 60).forEach((t) => found.set(t.id, t));
        if (inCategory.length === 0 && frameworkDefaultsGap) {
          notes.push(`The ${system} design system defines no ${category} tokens of its own. ${frameworkDefaultsGap.message}`);
        }
      }

      if (found.size === 0 && decisions.length === 0 && mentions.unknownTokens.length === 0) {
        for (const t of searchTokens(contract, q)) found.set(t.id, t);
      }

      const unresolved = mentions.unknownTokens;
      const tokens = [...found.values()].sort((a, b) => a.id.localeCompare(b.id)).map(tokenAnswer);
      const missing = unresolved.length
        ? ` ${unresolved.map((u) => `"${u}"`).join(", ")} ${unresolved.length === 1 ? "is" : "are"} not a token in this design system; do not invent ${unresolved.length === 1 ? "it" : "them"}.`
        : "";

      if (tokens.length === 0 && decisions.length === 0) {
        return {
          status: unresolved.length || notes.length ? "not-found" : "clarification-needed",
          message: (notes.join(" ") || `No token in the ${system} design system matches the question.`) + missing,
          unresolved,
          notes,
          clarification:
            unresolved.length || notes.length
              ? null
              : {
                  question: "Name the token (e.g. --primary or bg-muted) or describe the styling need (e.g. helper text, a dangerous action).",
                  options: (contract.tokenGuidance?.decisions ?? []).slice(0, 8).map((d) => ({ kind: "token" as const, id: d.use, name: d.need, description: d.use })),
                },
        };
      }

      return {
        status: "answered",
        message:
          `${tokens.length ? `Token${tokens.length === 1 ? "" : "s"} ${tokens.map((t) => t.cssVariable ?? t.name).join(", ")}` : "Token guidance"} from the ${system} design system. ` +
          "Apply tokens through the listed utilities; never use raw color values or Tailwind palette classes." +
          missing,
        tokens,
        tokenDecisions: decisions,
        tokenForbidden: contract.tokenGuidance?.forbidden ?? [],
        unresolved,
        notes,
      };
    },
  };
}
