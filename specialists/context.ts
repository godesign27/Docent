/**
 * What a request mentions, resolved against the contract once and shared by
 * the router and every specialist. Detection is deterministic: names are
 * matched exactly against the contract, and everything else is a pattern with
 * visible evidence that ends up in the routing record.
 */
import { ARBITRARY_COLOR, ClassIndex, PALETTE } from "../ingestion/tokens/tailwind-classes.js";
import type { ComponentContract, Contract, GovernanceRule, PatternContract, TokenContract } from "../schema/contract.js";
import type { AskInput } from "../schema/response.js";
import { type AmbiguousName, ComponentIndex, findMentions, INVENTORY_QUESTION, normalizeKey, terms } from "./components/resolve.js";

/** Common UI libraries by the names people use for them, mapped to their npm packages. */
const UI_LIBRARIES: [RegExp, string][] = [
  [/\b(material[- ]?ui|mui|@mui\/[\w-]+)\b/i, "@mui/material"],
  [/\b(ant[- ]?design|antd)\b/i, "antd"],
  [/\b(chakra([- ]ui)?|@chakra-ui\/[\w-]+)\b/i, "@chakra-ui/react"],
  [/\b(mantine|@mantine\/[\w-]+)\b/i, "@mantine/core"],
  [/\breact[- ]bootstrap\b/i, "react-bootstrap"],
  [/\bbootstrap\b/i, "bootstrap"],
  [/\b(headless ?ui|@headlessui\/[\w-]+)\b/i, "@headlessui/react"],
  [/\b(prime ?react)\b/i, "primereact"],
  [/\b(next ?ui|hero ?ui)\b/i, "@nextui-org/react"],
  [/\bsemantic[- ]ui\b/i, "semantic-ui-react"],
];

const TOKEN_WORDS = /\b(tokens?|colou?rs?|spacing|padding|margins?|radius|radii|rounded( corners)?|shadows?|elevation|typography|fonts?|font[- ]size|line[- ]height|dark mode|light mode|themes?|theming|hsl|hex|palette|css variables?|css vars?|utility class(es)?|background colou?r|text colou?r)\b/i;
const PATTERN_WORDS = /\b(patterns?|flows?|workflows?|best practices?|recipes?|(right|best|recommended|correct) way to|how (do|should|can) (i|we) (build|implement|design|structure|lay out|handle|show|present|display|let)|when (should|do|would) (i|we) use|which component (should|do|to|for|is|would)|what component (should|to|for|do)|should (i|we) use|vs\.?|versus|instead of|difference between|compose|composition)\b/i;
const COMPONENT_API_WORDS = /\b(props?|variants?|sizes?|imports?|exports?|api|parts?|children|aschild|required|attributes?|accepts?|signature|typescript types?)\b/i;
const PERMISSION = /\b(can (i|we)|may (i|we)|am i allowed|are we allowed|is it (ok|okay|allowed|acceptable|fine|alright)|allowed to|permitted|compliant|compliance|violat\w*|against the rules|forbidden|ok to ship|ready to ship|safe to ship|pass (review|governance)|rules? (say|allow))\b/i;
const EXCEPTION = /\b(exception|just (this|for this) once|one[- ]off|overrid(e|ing)|bypass|work ?around|skip (the )?(rule|check|review|design system)|ignore (the )?(rules?|design system|guidelines?|tokens?)|opt out|carve[- ]out|special case|waive|break (the|a) rule|temporarily (use|allow|bypass|ignore))\b/i;
const PROPOSAL = /\b(use|using|add|adding|install|installing|import|importing|switch to|replace|build (it )?with|hard-?code|hardcode|set|apply|put|render|nest|place|wrap|pull in)\b/i;
const BASE_MUTATION =
  /\b((edit|modify|change|update|patch|fork|rewrite|customi[sz]e|restyle|tweak)\b[^.?!]{0,50}\b(source( code)?|file|implementation|base component|src\/components\/(ui|ai)\/?[\w-]*|the component itself)|add(ing)? (a |an |new |another )?[\w="'-]*\s?(variant|size|prop|option|state)s?\b[^.?!]{0,30}\bto (the )?[A-Z]\w+)/;
const NEW_DEPENDENCY = /\b((npm|yarn|pnpm|bun) (i|install|add)\b|install(ing)? (a |an |the |another )?(new )?(npm )?(package|library|dependency|dep)\b|add(ing)? (a |an |another )?(new )?(npm )?(package|library|dependency)\b)/i;
const RAW_COLOR = /(#[0-9a-f]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d)/i;

export interface Mentions {
  components: { strong: ComponentContract[]; weak: ComponentContract[]; unresolved: string[]; ambiguous: AmbiguousName[] };
  tokens: TokenContract[];
  unknownTokens: string[];
  patterns: PatternContract[];
  entities: {
    restrictedPackages: string[];
    otherLibraries: string[];
    rawColors: string[];
    paletteUtilities: string[];
    baseMutation: string | null;
    newDependency: string | null;
  };
  /** Governance rule ids named in the request, e.g. FORBID_RAW_COLOR. */
  rules: GovernanceRule[];
  words: {
    token: string | null;
    /** "token" or "CSS variable" said outright, as opposed to a styling word like "color". */
    tokenExplicit: string | null;
    pattern: string | null;
    componentApi: string | null;
    permission: string | null;
    exception: string | null;
    proposal: string | null;
    inventory: string | null;
  };
}

export class ContractIndex {
  readonly components: ComponentIndex;
  readonly classes: ClassIndex;
  private readonly tokensById = new Map<string, TokenContract>();
  private readonly tokensByVar = new Map<string, TokenContract>();
  private readonly patternsByKey = new Map<string, PatternContract>();

  constructor(readonly contract: Contract) {
    this.components = new ComponentIndex(contract);
    this.classes = new ClassIndex(contract.tokens, []);
    for (const t of contract.tokens) {
      this.tokensById.set(t.id, t);
      if (t.cssVariable) this.tokensByVar.set(t.cssVariable, t);
    }
    for (const p of contract.patterns) {
      this.patternsByKey.set(normalizeKey(p.id), p);
      this.patternsByKey.set(normalizeKey(p.name), p);
    }
  }

  token(id: string): TokenContract | undefined {
    return this.tokensById.get(id) ?? this.tokensByVar.get(id);
  }

  /** Words that name a component or a prop value somewhere, so they can't identify a token on their own. */
  isAmbiguousWord(word: string): boolean {
    if (!this.ambiguous) {
      this.ambiguous = new Set(
        this.contract.components.flatMap((c) => [
          normalizeKey(c.id),
          normalizeKey(c.name),
          ...c.parts.flatMap((p) => p.props.flatMap((prop) => prop.values ?? []).map(normalizeKey)),
        ]),
      );
    }
    return this.ambiguous.has(normalizeKey(word));
  }
  private ambiguous: Set<string> | null = null;

  pattern(key: string): PatternContract | undefined {
    return this.patternsByKey.get(normalizeKey(key));
  }

  isRestricted(pkg: string): boolean {
    return this.contract.governance.restrictedPackages.some((r) =>
      r.endsWith("/*") ? pkg.startsWith(r.slice(0, -1)) : pkg === r || pkg.startsWith(`${r}/`),
    );
  }

  rule(id: string): GovernanceRule | undefined {
    return this.contract.governance.rules.find((r) => r.id === id);
  }
}

export function extractMentions(index: ContractIndex, input: AskInput): Mentions {
  const q = input.question;
  const words = q.match(/[A-Za-z0-9]+/g) ?? [];
  const found = findMentions(index.components, q);
  // "Drawer and Sheet": a capitalized word set against a known component is a component name, even if unknown.
  const knownNames = new Set([...found.strong, ...found.weak].map((c) => c.name));
  for (const m of q.matchAll(/\b([A-Z][a-z]{2,}) (?:and|or|vs\.?|versus|instead of|than) ([A-Z][a-z]{2,})\b|\b([A-Z][a-z]{2,}) (?:and|or|vs\.?|versus) ([A-Z][a-z]{2,})\b/g)) {
    const pair = [m[1] ?? m[3], m[2] ?? m[4]].filter((w): w is string => Boolean(w));
    if (!pair.some((w) => knownNames.has(w))) continue;
    for (const w of pair) {
      if (!index.components.lookup(w).length && !UI_LIBRARIES.some(([re]) => re.test(w)) && !found.unresolved.includes(w)) found.unresolved.push(w);
    }
  }
  if (input.component) {
    const hits = index.components.lookup(input.component);
    if (hits.length === 1 && !found.strong.includes(hits[0]!)) found.strong.unshift(hits[0]!);
    if (hits.length > 1 && !found.ambiguous.some((a) => a.name === input.component)) found.ambiguous.unshift({ name: input.component, candidates: hits });
    if (hits.length === 0 && !found.unresolved.includes(input.component)) found.unresolved.unshift(input.component);
  }

  // Tokens: CSS variables, utility classes and multi-word token ids named outright;
  // single-word ids ("primary") only when the question is about tokens.
  const tokens = new Set<TokenContract>();
  const unknownTokens: string[] = [];
  for (const v of q.match(/--[a-z][\w-]*/gi) ?? []) {
    const t = index.token(v);
    if (t) tokens.add(t);
    else if (!unknownTokens.includes(v)) unknownTokens.push(v);
  }
  const classLike = q.match(/(?:[\w-]+:)*-?[a-z]+(?:-[a-z0-9]+)+(?:\/\d+)?|\[[^\]\s]+\]/gi) ?? [];
  const analysis = index.classes.analyze([{ value: classLike.join(" "), line: 1 }]);
  analysis.tokenRefs.forEach((id) => tokens.add(index.token(id)!));
  const tokenWord = q.match(TOKEN_WORDS)?.[0] ?? null;
  const singleWordTokens: TokenContract[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(3, words.length - i); n >= 1; n--) {
      const id = words.slice(i, i + n).join("-").toLowerCase();
      const t = index.token(id);
      if (!t) continue;
      if (n > 1 || tokenWord) tokens.add(t);
      else if (!index.isAmbiguousWord(id)) singleWordTokens.push(t);
    }
  }
  // Plain words like "muted" count as tokens only in token talk, or when several are named together.
  if (new Set(singleWordTokens).size >= 2) singleWordTokens.forEach((t) => tokens.add(t));

  // Patterns: named by id or name, in any spacing ("destructive action", "form-submit").
  const patterns = new Set<PatternContract>();
  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(4, words.length - i); n >= 1; n--) {
      const p = index.pattern(words.slice(i, i + n).join(""));
      if (p && (n > 1 || normalizeKey(p.id) === normalizeKey(words[i]!))) patterns.add(p);
    }
  }

  const restrictedPackages: string[] = [];
  const otherLibraries: string[] = [];
  const withoutReactBootstrap = q.replace(/react[- ]bootstrap/gi, "");
  for (const [re, pkg] of UI_LIBRARIES) {
    if (!re.test(pkg === "bootstrap" ? withoutReactBootstrap : q)) continue;
    (index.isRestricted(pkg) ? restrictedPackages : otherLibraries).push(pkg);
  }
  for (const spec of q.match(/@[\w-]+\/[\w.-]+/g) ?? []) {
    if (index.isRestricted(spec) && !restrictedPackages.some((p) => p.split("/")[0] === spec.split("/")[0])) restrictedPackages.push(spec);
  }

  const paletteUtilities = classLike.filter((c) => {
    const stem = c.replace(/^(?:[\w-]+:)*/, "").replace(/\/\d+$/, "");
    return PALETTE.test(stem) || ARBITRARY_COLOR.test(stem);
  });

  const rules = index.contract.governance.rules.filter((r) => /^[A-Z][A-Z0-9_]{3,}$/.test(r.id) && new RegExp(`\\b${r.id}\\b`).test(q));

  return {
    components: found,
    rules,
    tokens: [...tokens],
    unknownTokens,
    patterns: [...patterns],
    entities: {
      restrictedPackages,
      otherLibraries,
      rawColors: [...q.matchAll(new RegExp(RAW_COLOR, "gi"))].map((m) => m[0]),
      paletteUtilities,
      baseMutation: q.match(BASE_MUTATION)?.[0] ?? null,
      newDependency: q.match(NEW_DEPENDENCY)?.[0] ?? null,
    },
    words: {
      token: tokenWord,
      tokenExplicit: q.match(/\b(tokens?|css variables?|css vars?)\b/i)?.[0] ?? null,
      inventory: q.match(INVENTORY_QUESTION)?.[0] ?? null,
      pattern: q.match(PATTERN_WORDS)?.[0] ?? null,
      componentApi: q.match(COMPONENT_API_WORDS)?.[0] ?? null,
      permission: q.match(PERMISSION)?.[0] ?? null,
      exception: q.match(EXCEPTION)?.[0] ?? null,
      proposal: q.match(PROPOSAL)?.[0] ?? null,
    },
  };
}

/** Rules whose wording overlaps the request, strongest first. */
export function matchRules(contract: Contract, text: string): { rule: GovernanceRule; overlap: string[]; strong: boolean }[] {
  const wanted = new Set(terms(text));
  if (wanted.size === 0) return [];
  const generic = new Set(["rule", "must", "never", "always", "any", "every", "without", "only", "ui", "agent", "component"]);
  return contract.governance.rules
    .map((rule) => {
      const ruleTerms = [...new Set(terms(rule.rule))].filter((t) => !generic.has(t));
      const overlap = ruleTerms.filter((t) => wanted.has(t));
      const strong = overlap.length >= 3 || (overlap.length >= 2 && overlap.length / Math.max(ruleTerms.length, 1) >= 0.34);
      return { rule, overlap, strong };
    })
    .filter((m) => m.overlap.length >= 2)
    .sort((a, b) => Number(b.strong) - Number(a.strong) || b.overlap.length - a.overlap.length || a.rule.id.localeCompare(b.rule.id));
}
