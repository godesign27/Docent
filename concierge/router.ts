/**
 * Intent routing. Scores each specialist on evidence found in the request and
 * sends it to every specialist with enough evidence. When nothing is clear it
 * asks the caller instead of picking one. Every signal is recorded, so a
 * routing decision can always be explained after the fact.
 */
import type { AskInput, ClarificationOption, Domain, Routing } from "../schema/response.js";
import { search, terms } from "../specialists/components/resolve.js";
import { matchRules, type ContractIndex, type Mentions } from "../specialists/context.js";
import { searchPatterns } from "../specialists/patterns/index.js";
import { searchTokens } from "../specialists/tokens/index.js";

export const DOMAINS: Domain[] = ["components", "tokens", "patterns", "governance"];
const THRESHOLD = 3;

export interface RoutingResult extends Routing {
  clarification: { question: string; options: ClarificationOption[] } | null;
  /** Specialists the evidence pointed at that this client does not have. */
  unavailable: Domain[];
}

export function route(index: ContractIndex, input: AskInput, m: Mentions, enabled: Domain[] = DOMAINS): RoutingResult {
  const signals: Routing["signals"] = [];
  const scores: Record<Domain, number> = { components: 0, tokens: 0, patterns: 0, governance: 0 };
  const add = (domain: Domain, points: number, signal: string, detail: string) => {
    scores[domain] += points;
    signals.push({ domain, signal, detail });
  };
  const names = (items: { name: string }[]) => items.map((i) => i.name).join(", ");

  // Components: what exists and what it accepts.
  if (m.components.strong.length) add("components", 3, "component-named", names(m.components.strong));
  else if (m.components.weak.length) add("components", 1, "component-word", names(m.components.weak));
  if (m.components.unresolved.length) add("components", 3, "unknown-component-named", m.components.unresolved.join(", "));
  if (m.words.componentApi && (m.components.strong.length || m.components.weak.length)) add("components", 2, "component-api-question", m.words.componentApi);
  if (m.words.inventory) add("components", 3, "inventory-question", m.words.inventory);

  // Tokens: colors, spacing, type, theming.
  if (m.tokens.length) add("tokens", 3, "token-named", m.tokens.map((t) => t.cssVariable ?? t.id).join(", "));
  if (m.unknownTokens.length) add("tokens", 3, "unknown-token-named", m.unknownTokens.join(", "));
  if (m.words.tokenExplicit) add("tokens", 3, "token-asked-for", m.words.tokenExplicit);
  else if (m.words.token) add("tokens", 2, "token-vocabulary", m.words.token);

  // Patterns: how to compose and when to use what.
  if (m.patterns.length) add("patterns", 4, "pattern-named", names(m.patterns));
  if (m.words.pattern) add("patterns", 2, "usage-question", m.words.pattern);
  const named = [...m.components.strong, ...m.components.weak];
  if (named.length >= 2 && /\b(vs\.?|versus|or|instead of|difference|between|compare)\b/i.test(input.question)) {
    add("patterns", 3, "component-comparison", names(named));
  }

  // Governance: permission, exceptions, and things the rules forbid.
  if (input.code) add("governance", 5, "code-submitted", `${input.code.split("\n").length} lines`);
  if (m.rules.length) add("governance", 3, "rule-named", m.rules.map((r) => r.id).join(", "));
  if (m.words.exception) add("governance", 4, "exception-request", m.words.exception);
  if (m.words.permission) add("governance", 2, "permission-question", m.words.permission);
  const entities = [
    ...m.entities.restrictedPackages.map((p) => `restricted package ${p}`),
    ...m.entities.rawColors.map((c) => `raw color ${c}`),
    ...m.entities.paletteUtilities.map((c) => `palette utility ${c}`),
    ...(m.entities.baseMutation ? [`base component change: "${m.entities.baseMutation}"`] : []),
    ...(m.entities.newDependency ? [`new dependency: "${m.entities.newDependency}"`] : []),
  ];
  if (entities.length) add("governance", 3, "governed-entity", entities.join("; "));
  if (m.words.permission || m.words.proposal) {
    const strong = matchRules(index.contract, input.question).filter((r) => r.strong);
    if (strong.length) add("governance", 2, "rule-wording", strong.slice(0, 3).map((r) => r.rule.id).join(", "));
  }

  const isEnabled = (d: Domain) => enabled.includes(d);
  const split = (wanted: Domain[]) => ({ domains: wanted.filter(isEnabled), unavailable: wanted.filter((d) => !isEnabled(d)) });

  // An explicit domain wins, but submitted code always gets a governance check.
  if (input.domain) {
    const wanted: Domain[] = input.domain === "governance" || !input.code ? [input.domain] : [input.domain, "governance"];
    return { ...split(wanted), scores, signals, reason: `The caller asked for the ${input.domain} specialist.`, clarification: null };
  }

  const evidenced = DOMAINS.filter((d) => scores[d] >= THRESHOLD);
  if (evidenced.length) {
    const { domains, unavailable } = split(evidenced);
    const reason = `Routed on evidence: ${evidenced.map((d) => `${d} ${scores[d]}`).join(", ")}.${unavailable.length ? ` Not enabled for this client: ${unavailable.join(", ")}.` : ""}`;
    return { domains, unavailable, scores, signals, reason, clarification: null };
  }

  const top = Math.max(...DOMAINS.filter(isEnabled).map((d) => scores[d]));
  const leaders = DOMAINS.filter((d) => isEnabled(d) && scores[d] === top);
  if (top > 0 && leaders.length === 1) {
    return { domains: leaders, unavailable: [], scores, signals, reason: `Weak evidence, but only ${leaders[0]} has any (${top}).`, clarification: null };
  }
  let domains: Domain[];

  // No usable signal: search what the design system contains before asking.
  const hits = {
    patterns: isEnabled("patterns") ? searchPatterns(index.contract, input.question, 3) : [],
    components: isEnabled("components") ? search(index.contract, input.question, 3) : [],
    tokens: isEnabled("tokens") ? searchTokens(index.contract, input.question, 3) : [],
  };
  if (hits.patterns.length) add("patterns", 0, "catalog-search", hits.patterns.map((p) => p.pattern.id).join(", "));
  if (hits.components.length) add("components", 0, "catalog-search", hits.components.map((c) => c.id).join(", "));
  if (hits.tokens.length) add("tokens", 0, "catalog-search", hits.tokens.map((t) => t.id).join(", "));

  const strongPattern = hits.patterns[0] && hits.patterns[0].score >= 5 && (hits.patterns[1]?.score ?? 0) < hits.patterns[0].score;
  if (strongPattern) {
    return { domains: ["patterns"], unavailable: [], scores, signals, reason: `No explicit signal; the question closely matches the ${hits.patterns[0]!.pattern.id} pattern.`, clarification: null };
  }
  // A single overlapping word ("page") is not evidence; routing on search alone needs at least two.
  const asked = new Set(terms(input.question));
  const overlap = (text: string) => new Set(terms(text).filter((t) => asked.has(t))).size;
  const strongComponent = hits.components.some((c) => overlap(`${c.name} ${c.guidance?.intent ?? ""} ${c.guidance?.description ?? ""}`) >= 2);
  const withHits = (Object.keys(hits) as (keyof typeof hits)[]).filter((k) => hits[k].length > 0);
  if (withHits.length === 1 && (withHits[0] === "patterns" || (withHits[0] === "components" && strongComponent))) {
    domains = [withHits[0]!];
    return { domains, unavailable: [], scores, signals, reason: `No explicit signal; only ${withHits[0]} had matches in the design system.`, clarification: null };
  }

  const options: ClarificationOption[] = [
    ...hits.patterns.map(({ pattern }) => ({ kind: "pattern" as const, id: pattern.id, name: pattern.name, description: pattern.intent })),
    ...hits.components.map((c) => ({ kind: "component" as const, id: c.id, name: c.name, description: c.guidance?.intent ?? null })),
    ...hits.tokens.map((t) => ({ kind: "token" as const, id: t.id, name: t.cssVariable ?? t.name, description: t.description })),
  ];
  return {
    domains: [],
    unavailable: [],
    scores,
    signals,
    reason: withHits.length ? "Matches in more than one area and nothing to choose between them." : "No evidence for any specialist.",
    clarification: {
      question: options.length
        ? "Which of these do you mean? Ask again naming it, or set domain."
        : "Docent answers questions about this design system's components, tokens, patterns and rules. Which is this about? Ask again naming a component, token or pattern, or set domain.",
      options: options.length
        ? options
        : (
            [
              { kind: "domain", id: "components", name: "Components", description: "Props, variants, imports and structure of a component" },
              { kind: "domain", id: "tokens", name: "Tokens & foundations", description: "Colors, spacing, typography and theme values" },
              { kind: "domain", id: "patterns", name: "Patterns & usage", description: "Which component to use and how to compose a flow" },
              { kind: "domain", id: "governance", name: "Governance", description: "Whether something is allowed, and checking code before it ships" },
            ] as ClarificationOption[]
          ).filter((o) => isEnabled(o.id as Domain)),
    },
  };
}
