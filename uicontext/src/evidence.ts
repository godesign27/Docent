/**
 * Phase 0: everything the prototype says about the design system, confirmed or flagged through Docent.
 * No model is involved. Each confirmation keeps the Docent request id that made it, so any line of a
 * UIContext draft can be traced back to the answer behind it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type DocentAnswer, type DocentClient, DocentUnavailable } from "./docent.js";
import { isPackage, loadAliases, resolveImport, scanCss, scanFile, type ScannedFile } from "./scan.js";

const Location = z.object({ file: z.string(), line: z.number() });
type Location = z.infer<typeof Location>;

export const Flag = z.object({
  id: z.string(),
  severity: z.enum(["blocking", "advisory"]),
  kind: z.enum([
    "component-unconfirmed",
    "component-ambiguous",
    "component-not-in-inventory",
    "component-near-match",
    "export-not-in-contract",
    "token-unconfirmed",
    "utility-unknown-variable",
    "utility-raw-color",
    "governance-rejected",
    "governance-escalated",
    "governance-warning",
    "governance-unavailable",
    "contract-changed",
    /** Raised by the claim lint in render.ts, not by this pass: a draft named something Docent never confirmed. */
    "unconfirmed-claim",
  ]),
  message: z.string(),
  locations: z.array(Location),
  requestIds: z.array(z.string()),
});
export type Flag = z.infer<typeof Flag>;

const Prop = z.object({ name: z.string(), type: z.string(), required: z.boolean(), values: z.array(z.string()).optional(), default: z.string().optional() });

export const ComponentEvidence = z.object({
  id: z.string(),
  module: z.string(),
  status: z.enum(["confirmed", "near-match", "ambiguous", "not-in-inventory", "unconfirmed"]),
  imports: z.array(z.object({ name: z.string(), local: z.string(), typeOnly: z.boolean(), at: Location })),
  docent: z
    .object({
      id: z.string(),
      name: z.string(),
      importPath: z.string().nullable(),
      allowed: z.boolean().nullable(),
      intent: z.string().nullable(),
      parts: z.array(z.object({ name: z.string(), primary: z.boolean(), props: z.array(Prop), variants: z.array(z.object({ name: z.string(), values: z.array(z.string()) })) })),
    })
    .nullable(),
  candidates: z.array(z.object({ id: z.string(), name: z.string() })),
  usage: z.array(z.object({ part: z.string(), at: Location, props: z.array(z.object({ name: z.string(), value: z.string().nullable() })) })),
  requestIds: z.array(z.string()),
});
export type ComponentEvidence = z.infer<typeof ComponentEvidence>;

export const TokenEvidence = z.object({
  id: z.string(),
  variable: z.string(),
  status: z.enum(["confirmed", "unconfirmed"]),
  token: z.object({ id: z.string(), type: z.string(), category: z.string(), meaning: z.string().nullable(), values: z.record(z.string(), z.string()) }).nullable(),
  uses: z.array(Location),
  requestId: z.string(),
});

export const UtilityEvidence = z.object({
  class: z.string(),
  kind: z.enum(["token", "palette", "arbitrary-color", "unknown-variable", "unbound", "unclassified"]),
  token: z.string().nullable(),
  uses: z.array(Location),
  requestId: z.string(),
});

export const GovernanceEvidence = z.object({
  file: z.string(),
  outcome: z.enum(["no-conflict", "warn", "needs-review", "disallowed"]),
  findings: z.array(z.object({ ruleId: z.string().nullable(), rule: z.string().nullable(), severity: z.string(), check: z.string().nullable(), action: z.string(), evidence: z.string(), line: z.number().optional() })),
  notEvaluated: z.array(z.string()),
  requestId: z.string(),
});

export const Evidence = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  prototype: z.object({ root: z.string(), entries: z.array(z.string()), scanned: z.array(z.string()), stylesheets: z.array(z.string()) }),
  docent: z.object({ client: z.object({ id: z.string(), name: z.string() }), contractHash: z.string(), sourceCommit: z.string().nullable() }),
  components: z.array(ComponentEvidence),
  localModules: z.array(z.object({ file: z.string(), exports: z.array(z.string()), importedBy: z.array(Location) })),
  packages: z.array(z.object({ name: z.string(), importedBy: z.array(Location) })),
  tokens: z.array(TokenEvidence),
  utilities: z.array(UtilityEvidence),
  governance: z.array(GovernanceEvidence),
  flags: z.array(Flag),
});
export type Evidence = z.infer<typeof Evidence>;

export interface GatherOptions {
  root: string;
  /** Prototype files to start from, relative to root, e.g. src/pages/Reports.tsx. */
  entries: string[];
  docent: DocentClient;
  now?: () => Date;
}

const QUESTION_BUDGET = 3500;

export async function gatherEvidence(options: GatherOptions): Promise<Evidence> {
  const { root, docent } = options;
  const aliases = loadAliases(root);
  const flags: Omit<Flag, "id">[] = [];
  const flag = (f: Omit<Flag, "id">) => flags.push(f);
  let provenance: DocentAnswer["provenance"] | null = null;
  const answers = new Map<string, DocentAnswer["components"][number]>();

  const ask = async (input: Parameters<DocentClient["ask"]>[0]) => {
    const answer = await docent.ask(input);
    if (!provenance) provenance = answer.provenance;
    else if (provenance.contractHash !== answer.provenance.contractHash) {
      flag({ severity: "blocking", kind: "contract-changed", message: `Docent's contract changed during the run (${provenance.contractHash.slice(0, 19)}… → ${answer.provenance.contractHash.slice(0, 19)}…); run again.`, locations: [], requestIds: [answer.requestId] });
      provenance = answer.provenance;
    }
    return answer;
  };

  for (const entry of options.entries) {
    if (!existsSync(join(root, entry))) throw new Error(`Entry ${entry} does not exist under ${root}.`);
  }

  // --- Walk the prototype's own code, stopping at design-system components ---------------
  const scanned = new Map<string, ScannedFile>();
  const stylesheets = new Map<string, ReturnType<typeof scanCss>>();
  const components = new Map<string, ComponentEvidence>();
  const localModules = new Map<string, { exports: Set<string>; importedBy: Location[] }>();
  const packages = new Map<string, Location[]>();
  const queue = [...options.entries];

  while (queue.length) {
    const file = queue.shift()!;
    if (scanned.has(file)) continue;
    const scan = scanFile(root, file);
    scanned.set(file, scan);

    for (const imp of scan.imports) {
      const at = { file, line: imp.line };
      if (isPackage(imp.module, aliases)) {
        packages.set(imp.module, [...(packages.get(imp.module) ?? []), at]);
        continue;
      }
      const target = resolveImport(root, file, imp.module, aliases);
      if (target?.endsWith(".css")) {
        if (!stylesheets.has(target)) stylesheets.set(target, scanCss(root, target));
        continue;
      }

      const known = components.get(imp.module);
      if (known) {
        known.imports.push({ name: imp.imported, local: imp.local, typeOnly: imp.typeOnly, at });
        continue;
      }
      if (localModules.has(target ?? "")) {
        const local = localModules.get(target!)!;
        local.importedBy.push(at);
        if (imp.imported !== "*" && imp.imported !== "default") local.exports.add(imp.imported);
        continue;
      }

      const resolved = await resolveComponent(ask, imp.module, target, scan.imports.filter((i) => i.module === imp.module).map((i) => i.imported));
      if (resolved.status === "unconfirmed" && target) {
        // Not the design system's, but a file in the prototype: its own code, scanned in turn.
        localModules.set(target, { exports: new Set(imp.imported !== "*" && imp.imported !== "default" ? [imp.imported] : []), importedBy: [at] });
        queue.push(target);
        continue;
      }
      resolved.imports.push({ name: imp.imported, local: imp.local, typeOnly: imp.typeOnly, at });
      components.set(imp.module, resolved);
      if (resolved.status === "near-match" && target) queue.push(target);
    }
  }

  // --- Usage, exports and flags per component ------------------------------------------------
  const componentList = [...components.values()].sort((a, b) => a.module.localeCompare(b.module));
  componentList.forEach((c, i) => (c.id = `C-${i + 1}`));
  for (const c of componentList) {
    const byLocal = new Map(c.imports.map((imp) => [imp.local, imp.name]));
    for (const scan of scanned.values()) {
      for (const el of scan.elements) {
        const root = el.tag.split(".")[0]!;
        const imported = byLocal.get(root);
        if (!imported || !c.imports.some((i) => i.at.file === scan.file && i.local === root)) continue;
        const part = imported === "*" ? el.tag.split(".").slice(1).join(".") || root : imported;
        c.usage.push({ part, at: { file: scan.file, line: el.line }, props: el.props });
      }
    }
    const locations = c.imports.map((i) => i.at);
    switch (c.status) {
      case "unconfirmed":
        flag({ severity: "blocking", kind: "component-unconfirmed", message: `${c.module} is not a design-system component Docent can confirm, and no project file resolves from it.`, locations, requestIds: c.requestIds });
        break;
      case "ambiguous":
        flag({ severity: "blocking", kind: "component-ambiguous", message: `${c.module} could be any of ${c.candidates.map((x) => x.id).join(", ")}; Docent would not pick one.`, locations, requestIds: c.requestIds });
        break;
      case "not-in-inventory":
        flag({ severity: "blocking", kind: "component-not-in-inventory", message: `${c.docent!.name} exists in the design system's source but is not in its component inventory, so it may not be used.`, locations, requestIds: c.requestIds });
        break;
      case "near-match":
        flag({ severity: "advisory", kind: "component-near-match", message: `${c.module} is confirmed by name as ${c.docent!.name}, but the design system imports it from ${c.docent!.importPath}.`, locations, requestIds: c.requestIds });
        break;
    }
    if (c.docent) {
      const contractExports = new Set(c.docent.parts.map((p) => p.name));
      const answer = answers.get(c.docent.id);
      answer?.helpers.forEach((h) => contractExports.add(h));
      answer?.typeExports.forEach((t) => contractExports.add(t));
      for (const imp of c.imports) {
        if (imp.name === "default" || imp.name === "*" || contractExports.has(imp.name)) continue;
        flag({ severity: "blocking", kind: "export-not-in-contract", message: `${c.module} is ${c.docent.name} in the design system, which does not export ${imp.name}.`, locations: [imp.at], requestIds: c.requestIds });
      }
    }
  }

  // --- CSS variables ---------------------------------------------------------------------------
  const varUses = new Map<string, Location[]>();
  for (const scan of scanned.values()) for (const v of scan.cssVariables) varUses.set(v.name, [...(varUses.get(v.name) ?? []), { file: scan.file, line: v.line }]);
  for (const [file, css] of stylesheets) for (const v of css.cssVariables) varUses.set(v.name, [...(varUses.get(v.name) ?? []), { file, line: v.line }]);
  const tokens: Evidence["tokens"] = [];
  for (const batch of batches([...varUses.keys()].sort(), (v) => v.length + 1)) {
    const answer = await ask({ question: `Which design tokens are these CSS variables: ${batch.join(" ")}`, domain: "tokens", audit: true });
    for (const variable of batch) {
      const token = answer.tokens.find((t) => t.cssVariable === variable);
      tokens.push({
        id: `T-${tokens.length + 1}`,
        variable,
        status: token ? "confirmed" : "unconfirmed",
        token: token ? { id: token.id, type: token.type, category: token.category, meaning: token.meaning, values: token.values } : null,
        uses: varUses.get(variable)!,
        requestId: answer.requestId,
      });
      if (!token) flag({ severity: "blocking", kind: "token-unconfirmed", message: `${variable} is not a token Docent can confirm.`, locations: varUses.get(variable)!, requestIds: [answer.requestId] });
    }
  }

  // --- Utility classes -------------------------------------------------------------------------
  const classUses = new Map<string, Location[]>();
  for (const scan of scanned.values()) {
    for (const { value, line } of scan.classes) {
      for (const cls of value.split(/\s+/)) {
        if (!UTILITY_LIKE.test(cls) || !cls.includes("-") || cls.startsWith("--")) continue;
        classUses.set(cls, [...(classUses.get(cls) ?? []), { file: scan.file, line }]);
      }
    }
  }
  const utilities: Evidence["utilities"] = [];
  for (const batch of batches([...classUses.keys()].sort(), (c) => c.length + 1)) {
    const answer = await ask({ question: `Which design tokens do these utility classes apply: ${batch.join(" ")}`, domain: "tokens", audit: true });
    for (const cls of batch) {
      const verdict = answer.utilityClasses.find((u) => u.class === cls);
      const uses = classUses.get(cls)!;
      utilities.push({ class: cls, kind: verdict?.kind ?? "unclassified", token: verdict?.token ?? null, uses, requestId: answer.requestId });
      if (verdict?.kind === "unknown-variable") flag({ severity: "blocking", kind: "utility-unknown-variable", message: `${cls} uses a CSS variable that is not a design token.`, locations: uses, requestIds: [answer.requestId] });
      if (verdict?.kind === "palette" || verdict?.kind === "arbitrary-color") flag({ severity: "advisory", kind: "utility-raw-color", message: `${cls} is a raw color, not a design token.`, locations: uses, requestIds: [answer.requestId] });
    }
  }

  // --- Governance, one audit per prototype file ---------------------------------------------
  const governance: Evidence["governance"] = [];
  for (const file of [...scanned.keys()].sort()) {
    const code = readFileSync(join(root, file), "utf8");
    const answer = await ask({ question: "Does this prototype file follow the design system's rules?", code, audit: true });
    if (!answer.governance) {
      flag({ severity: "blocking", kind: "governance-unavailable", message: `Docent returned no governance decision for ${file}; its rules could not be checked.`, locations: [{ file, line: 1 }], requestIds: [answer.requestId] });
      continue;
    }
    const g = answer.governance;
    governance.push({ file, outcome: g.outcome, findings: g.findings, notEvaluated: g.notEvaluated, requestId: answer.requestId });
    const locations = g.findings.map((f) => ({ file, line: f.line ?? 1 }));
    const summary = g.findings.map((f) => `${f.ruleId ?? f.check ?? f.basis} (${f.action}): ${f.evidence}`).join("; ");
    if (g.outcome === "disallowed") flag({ severity: "blocking", kind: "governance-rejected", message: `${file} breaks rules that reject it: ${summary}`, locations, requestIds: [answer.requestId] });
    else if (g.outcome === "needs-review") flag({ severity: "blocking", kind: "governance-escalated", message: `${file} needs a reviewer's decision: ${summary}`, locations, requestIds: [answer.requestId] });
    else if (g.outcome === "warn") flag({ severity: "advisory", kind: "governance-warning", message: `${file}: ${summary}`, locations, requestIds: [answer.requestId] });
  }

  if (!provenance) throw new DocentUnavailable("Docent was never asked anything, so nothing in the prototype could be confirmed.");
  const p = provenance as DocentAnswer["provenance"];
  return Evidence.parse({
    version: 1,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    prototype: { root, entries: options.entries, scanned: [...scanned.keys()].sort(), stylesheets: [...stylesheets.keys()].sort() },
    docent: { client: p.client, contractHash: p.contractHash, sourceCommit: p.sourceCommit },
    components: componentList,
    localModules: [...localModules].map(([file, m]) => ({ file, exports: [...m.exports].sort(), importedBy: m.importedBy })).sort((a, b) => a.file.localeCompare(b.file)),
    packages: [...packages].map(([name, importedBy]) => ({ name, importedBy })).sort((a, b) => a.name.localeCompare(b.name)),
    tokens,
    utilities,
    governance,
    flags: flags.map((f, i) => ({ ...f, id: `F-${i + 1}` })),
  });

  /** Near-match order: import path, then the project file, then each imported name. */
  async function resolveComponent(
    askDocent: typeof ask,
    module: string,
    target: string | null,
    importedNames: string[],
  ): Promise<ComponentEvidence> {
    const requestIds: string[] = [];
    const keys: { key: string; by: "path" | "name" }[] = [
      { key: module, by: "path" },
      ...(target ? [{ key: target, by: "path" as const }] : []),
      ...importedNames.filter((n) => /^[A-Z]/.test(n)).map((key) => ({ key, by: "name" as const })),
    ];
    for (const { key, by } of keys) {
      const answer = await askDocent({ question: "What is the contract for this component?", component: key, domain: "components", audit: true });
      requestIds.push(answer.requestId);
      if (answer.status === "clarification-needed" && answer.clarification) {
        return { id: "", module, status: "ambiguous", imports: [], docent: null, candidates: answer.clarification.options.map((o) => ({ id: o.id, name: o.name })), usage: [], requestIds };
      }
      const c = answer.status === "answered" && answer.components.length === 1 ? answer.components[0]! : null;
      if (!c) continue;
      answers.set(c.id, c);
      const status = c.allowed === false ? "not-in-inventory" : by === "name" && c.import?.path !== module ? "near-match" : "confirmed";
      return {
        id: "",
        module,
        status,
        imports: [],
        docent: { id: c.id, name: c.name, importPath: c.import?.path ?? null, allowed: c.allowed, intent: c.intent, parts: c.parts },
        candidates: [],
        usage: [],
        requestIds,
      };
    }
    return { id: "", module, status: "unconfirmed", imports: [], docent: null, candidates: [], usage: [], requestIds };
  }
}


/** Mirrors the shape Docent treats as a utility class. */
const UTILITY_LIKE = /^(?:[^\s:]+:)*!?-?[a-z][a-z0-9]*(?:-[a-z0-9.]+)*(?:-\[[^\]\s]+\])?(?:\/[\w.]+)?$/;

function batches<T>(items: T[], size: (t: T) => number): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    if (current.length && used + size(item) > QUESTION_BUDGET) {
      out.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += size(item);
  }
  if (current.length) out.push(current);
  return out;
}
