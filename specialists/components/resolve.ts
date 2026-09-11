/**
 * Works out which components a request is about, using only names that exist
 * in the contract. Nothing is fuzzy-matched into existence: an unknown name is
 * reported as unresolved, never mapped to the nearest real component.
 */
import type { ComponentContract, Contract } from "../../schema/contract.js";

export type Resolution =
  | { kind: "matched"; components: ComponentContract[]; unresolved: string[] }
  | { kind: "ambiguous"; candidates: ComponentContract[]; unresolved: string[]; shared?: AmbiguousName[] }
  | { kind: "not-found"; candidates: ComponentContract[]; unresolved: string[] }
  | { kind: "inventory" };

const MAX_WEAK_MATCHES = 3;
export const INVENTORY_QUESTION = /\b(list (all|the|every)?\s*components?|component (inventory|list|catalog)|(what|which) components (are there|exist|are available|can i use)|all (available )?components)\b/i;
/** PascalCase words that are tooling, not components someone could be asking for. */
const NOT_COMPONENT_NAMES = new Set(["typescript", "javascript", "github", "nextjs", "reactdom", "tailwindcss", "variantprops", "componentprops", "forwardref", "radixui", "shadcnui"]);
const STOPWORDS = new Set(
  "a an and are as at be but by can do does for from have how i if in into is it its me my need not of on or should so some that the their them then there these this to use used using want what when where which while who why will with without would you your component components".split(" "),
);

export function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface AmbiguousName {
  name: string;
  candidates: ComponentContract[];
}

export class ComponentIndex {
  private readonly byId = new Map<string, ComponentContract>();
  /** Ids and names, which win over part and type names. */
  private readonly byName = new Map<string, ComponentContract[]>();
  private readonly byPart = new Map<string, ComponentContract[]>();

  constructor(readonly contract: Contract) {
    for (const c of contract.components) {
      this.byId.set(c.id, c);
      for (const key of [c.id, c.name, c.manifest?.id, c.guidance?.id]) add(this.byName, key, c);
      for (const key of [...c.parts.map((p) => p.name), ...c.typeExports]) add(this.byPart, key, c);
    }
  }

  /**
   * Every component a name could mean. An exact id is unambiguous; otherwise
   * two components exporting the same name (e.g. two Toasters) are both returned.
   */
  lookup(key: string): ComponentContract[] {
    const exact = this.byId.get(key);
    if (exact) return [exact];
    const k = normalizeKey(key);
    return this.byName.get(k) ?? this.byPart.get(k) ?? [];
  }

  /** The one component a name means, or undefined when it means none or several. */
  get(key: string): ComponentContract | undefined {
    const hits = this.lookup(key);
    return hits.length === 1 ? hits[0] : undefined;
  }

  /** Names that more than one component answers to. */
  duplicateNames(): AmbiguousName[] {
    return [...this.byName.values()]
      .filter((list) => list.length > 1)
      .map((candidates) => ({ name: candidates[0]!.name, candidates }))
      .filter((d, i, all) => all.findIndex((o) => normalizeKey(o.name) === normalizeKey(d.name)) === i);
  }
}

function add(map: Map<string, ComponentContract[]>, key: string | null | undefined, c: ComponentContract) {
  const k = key ? normalizeKey(key) : "";
  if (!k) return;
  const list = map.get(k) ?? [];
  if (!list.includes(c)) list.push(c);
  map.set(k, list);
}

export function resolveRequest(index: ComponentIndex, question: string, component?: string): Resolution {
  if (component) {
    const hits = index.lookup(component);
    if (hits.length === 1) return { kind: "matched", components: hits, unresolved: [] };
    if (hits.length > 1) return { kind: "ambiguous", candidates: hits, unresolved: [], shared: [{ name: component, candidates: hits }] };
    return { kind: "not-found", candidates: search(index.contract, `${component} ${question}`), unresolved: [component] };
  }

  const { strong, weak, unresolved, ambiguous } = findMentions(index, question);
  // A name several components share is never settled by picking one.
  if (ambiguous.length) return { kind: "ambiguous", candidates: [...new Set(ambiguous.flatMap((a) => a.candidates))], unresolved, shared: ambiguous };
  if (strong.length === 0 && weak.length === 0 && unresolved.length === 0 && INVENTORY_QUESTION.test(question)) {
    return { kind: "inventory" };
  }
  if (strong.length > 0) return { kind: "matched", components: strong, unresolved };
  if (weak.length > 0 && weak.length <= MAX_WEAK_MATCHES) return { kind: "matched", components: weak, unresolved };
  if (weak.length > MAX_WEAK_MATCHES) return { kind: "ambiguous", candidates: weak, unresolved };

  const candidates = search(index.contract, question);
  if (unresolved.length > 0 || candidates.length === 0) return { kind: "not-found", candidates, unresolved };
  return { kind: "ambiguous", candidates, unresolved };
}

/**
 * Strong mentions are written like code (Button, `button`, ui:button);
 * weak mentions are ordinary words that happen to name a component ("form").
 */
export function findMentions(index: ComponentIndex, question: string) {
  const backticked = new Set([...question.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/^<|\/?>$/g, "").trim()));
  const tokens = [...question.matchAll(/<?[A-Za-z][A-Za-z0-9]*(?:[:\-][A-Za-z0-9]+)*/g)].map((m) => m[0].replace(/^</, ""));
  const strong: ComponentContract[] = [];
  const weak: ComponentContract[] = [];
  const unresolved: string[] = [];
  const ambiguous: AmbiguousName[] = [];

  for (let i = 0; i < tokens.length; ) {
    let matched = false;
    for (let n = Math.min(3, tokens.length - i); n >= 1; n--) {
      const words = tokens.slice(i, i + n);
      const hits = index.lookup(n === 1 ? words[0]! : words.join(""));
      if (hits.length === 0) continue;
      const codeLike = words.some((w) => /[A-Z]/.test(w) || w.includes(":") || backticked.has(w));
      if (hits.length > 1) {
        const name = words.join("");
        if (codeLike && !ambiguous.some((a) => a.name === name)) ambiguous.push({ name, candidates: hits });
        i += n;
        matched = true;
        break;
      }
      const hit = hits[0]!;
      const bucket = codeLike ? strong : weak;
      if (!bucket.includes(hit)) bucket.push(hit);
      i += n;
      matched = true;
      break;
    }
    if (matched) continue;

    const token = tokens[i]!;
    const looksLikeComponent = /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/.test(token) || /^[a-z]+:[a-z0-9-]+$/.test(token) || backticked.has(token);
    if (looksLikeComponent && !NOT_COMPONENT_NAMES.has(normalizeKey(token)) && !unresolved.includes(token)) unresolved.push(token);
    i += 1;
  }
  return { strong, weak: weak.filter((c) => !strong.includes(c)), unresolved, ambiguous };
}

export function terms(text: string): string[] {
  return (text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map(stem);
}

/** Light suffix stripping so "confirmation" meets "confirm" and "deletion" meets "delete". */
function stem(word: string): string {
  let w = word.replace(/mission$/, "mit");
  if (w.length > 5) w = w.replace(/(ations?|tions?|ions?|ings?|ments?|als?)$/, "");
  else if (w.length > 4) w = w.replace(/(ings?|s)$/, "");
  if (w.length > 4) w = w.replace(/(ed|es|e|s)$/, "");
  return w;
}

/** Ranks components by overlap with their name, intent and description. */
export function search(contract: Contract, text: string, limit = 5): ComponentContract[] {
  const wanted = [...new Set(terms(text))];
  if (wanted.length === 0) return [];

  // What other components' specs say about this one ("alert-dialog: required companion for destructive actions").
  const index = new ComponentIndex(contract);
  const describedBy = new Map<string, string[]>();
  for (const c of contract.components) {
    for (const r of c.guidance?.related ?? []) {
      const target = index.get(r.id);
      if (target && r.note) describedBy.set(target.id, [...(describedBy.get(target.id) ?? []), r.note]);
    }
  }

  const scored = contract.components.map((c) => {
    const fields: [string[], number][] = [
      [terms(`${c.name} ${c.id}`), 3],
      [terms(c.guidance?.intent ?? c.manifest?.notes.intent ?? ""), 2],
      [terms((describedBy.get(c.id) ?? []).join(" ")), 2],
      [terms(`${c.guidance?.description ?? c.description ?? ""} ${c.guidance?.category ?? c.manifest?.category ?? ""}`), 1],
    ];
    const score = wanted.reduce((sum, term) => sum + Math.max(0, ...fields.filter(([words]) => words.includes(term)).map(([, w]) => w)), 0);
    return { c, score };
  });
  return scored
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id))
    .slice(0, limit)
    .map((s) => s.c);
}
