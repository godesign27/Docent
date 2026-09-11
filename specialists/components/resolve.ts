/**
 * Works out which components a request is about, using only names that exist
 * in the contract. Nothing is fuzzy-matched into existence: an unknown name is
 * reported as unresolved, never mapped to the nearest real component.
 */
import type { ComponentContract, Contract } from "../../schema/contract.js";

export type Resolution =
  | { kind: "matched"; components: ComponentContract[]; unresolved: string[] }
  | { kind: "ambiguous"; candidates: ComponentContract[]; unresolved: string[] }
  | { kind: "not-found"; candidates: ComponentContract[]; unresolved: string[] }
  | { kind: "inventory" };

const MAX_WEAK_MATCHES = 3;
const INVENTORY_QUESTION = /\b(list (all|the|every)?\s*components?|component (inventory|list|catalog)|(what|which) components (are there|exist|are available|can i use)|all (available )?components)\b/i;
/** PascalCase words that are tooling, not components someone could be asking for. */
const NOT_COMPONENT_NAMES = new Set(["typescript", "javascript", "github", "nextjs", "reactdom", "tailwindcss", "variantprops", "componentprops", "forwardref", "radixui", "shadcnui"]);
const STOPWORDS = new Set(
  "a an and are as at be but by can do does for from have how i if in into is it its me my need not of on or should so some that the their them then there these this to use used using want what when where which while who why will with without would you your".split(" "),
);

export function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export class ComponentIndex {
  private readonly byKey = new Map<string, ComponentContract>();

  constructor(readonly contract: Contract) {
    // Ids and names first so they win over part and type names.
    for (const c of contract.components) {
      for (const key of [c.id, c.name, c.manifest?.id, c.guidance?.id]) this.add(key, c);
    }
    for (const c of contract.components) {
      for (const key of [...c.parts.map((p) => p.name), ...c.typeExports]) this.add(key, c);
    }
  }

  private add(key: string | null | undefined, c: ComponentContract) {
    const k = key ? normalizeKey(key) : "";
    if (k && !this.byKey.has(k)) this.byKey.set(k, c);
  }

  get(key: string): ComponentContract | undefined {
    return this.byKey.get(normalizeKey(key));
  }
}

export function resolveRequest(index: ComponentIndex, question: string, component?: string): Resolution {
  if (component) {
    const hit = index.get(component);
    if (hit) return { kind: "matched", components: [hit], unresolved: [] };
    return { kind: "not-found", candidates: search(index.contract, `${component} ${question}`), unresolved: [component] };
  }

  const { strong, weak, unresolved } = findMentions(index, question);
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
function findMentions(index: ComponentIndex, question: string) {
  const backticked = new Set([...question.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/^<|\/?>$/g, "").trim()));
  const tokens = [...question.matchAll(/<?[A-Za-z][A-Za-z0-9]*(?:[:\-][A-Za-z0-9]+)*/g)].map((m) => m[0].replace(/^</, ""));
  const strong: ComponentContract[] = [];
  const weak: ComponentContract[] = [];
  const unresolved: string[] = [];

  for (let i = 0; i < tokens.length; ) {
    let matched = false;
    for (let n = Math.min(3, tokens.length - i); n >= 1; n--) {
      const words = tokens.slice(i, i + n);
      const hit = index.get(words.join(""));
      if (!hit) continue;
      const codeLike = words.some((w) => /[A-Z]/.test(w) || w.includes(":") || backticked.has(w));
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
  return { strong, weak: weak.filter((c) => !strong.includes(c)), unresolved };
}

function terms(text: string): string[] {
  return (text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
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
