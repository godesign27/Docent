/**
 * Rendering and the claim lint: where the PRD's hard rule is enforced.
 *
 * The component, token and props tables are built from evidence, never from model text. Every free-text
 * field the model wrote is scanned for anything shaped like a design-system name — PascalCase identifiers,
 * --variables, utility classes, @/… import paths. Anything Docent didn't confirm is replaced with UNKNOWN,
 * recorded in flags.json with the field it came from, and raised as a blocking open question that points
 * at the prototype, not at the unconfirmed name.
 */
import type { Draft } from "./draft.js";
import type { ComponentEvidence, Evidence, Flag } from "./evidence.js";
import type { HandoffName, Inputs } from "./inputs.js";

export interface Unconfirmed {
  /** Where in the draft it was written, e.g. "annotations[2].behavior". */
  field: string;
  /** The name itself. Kept here, never in the rendered file. */
  text: string;
  flag: string;
}

export interface Question {
  priority: "Blocking" | "Advisory";
  question: string;
  detail: string;
  resolutionPath: string;
}

export interface Rendered {
  markdown: string;
  flags: Flag[];
  questions: Question[];
  unconfirmed: Unconfirmed[];
  status: "draft" | "blocked";
}

export interface RenderOptions {
  inputs: Inputs;
  evidence: Evidence;
  draft: Draft;
  now: Date;
  route?: string;
  prototypeSource?: string;
}

/** Words that look like component names but are ordinary prose. */
const PROSE = new Set(["TypeScript", "JavaScript", "UIContext", "GitHub", "JSON", "README"]);

export function render(options: RenderOptions): Rendered {
  const { inputs, evidence, draft, now } = options;
  const name = inputs.name;
  const confirmed = confirmedNames(evidence);
  const flags = [...evidence.flags];
  const unconfirmed: Unconfirmed[] = [];
  let nextFlag = flags.length + 1;

  /** Every free-text field the model wrote passes through here before it can reach the file. */
  const clean = (value: string, field: string, cited: string[] = []): string => {
    const { text, names } = lintClaims(value, confirmed);
    for (const found of names) {
      const id = `F-${nextFlag++}`;
      const locations = citedLocations(evidence, cited);
      flags.push({
        id,
        severity: "blocking",
        kind: "unconfirmed-claim",
        message: `The draft named something in ${field} that Docent has not confirmed; it was replaced with UNKNOWN.`,
        locations: locations.length ? locations : [{ file: evidence.prototype.entries[0] ?? evidence.prototype.scanned[0] ?? "", line: 1 }],
        requestIds: [],
      });
      unconfirmed.push({ field, text: found, flag: id });
    }
    return text;
  };

  const cleanList = (values: string[], field: string) => values.map((v, i) => clean(v, `${field}[${i}]`));

  const summary = clean(draft.summary, "summary");
  const inScope = cleanList(draft.scope.inScope, "scope.inScope");
  const outOfScope = cleanList(draft.scope.outOfScope, "scope.outOfScope");
  const annotations = draft.annotations.map((a, i) => ({
    id: `A-${i + 1}`,
    page: clean(a.page, `annotations[${i}].page`, a.evidence),
    target: clean(a.target, `annotations[${i}].target`, a.evidence),
    type: clean(a.type, `annotations[${i}].type`, a.evidence),
    behavior: clean(a.behavior, `annotations[${i}].behavior`, a.evidence),
    states: clean(a.states, `annotations[${i}].states`, a.evidence),
    notes: clean(a.notes, `annotations[${i}].notes`, a.evidence),
  }));
  const coverage = draft.coverage.map((c, i) => ({
    group: c.group,
    state: clean(c.state, `coverage[${i}].state`, c.evidence),
    designed: c.designed,
    notes: clean(c.notes, `coverage[${i}].notes`, c.evidence),
  }));
  const contracts = {
    interactionRules: clean(draft.interactionRules, "interactionRules"),
    responsive: clean(draft.responsive, "responsive"),
    accessibility: clean(draft.accessibility, "accessibility"),
    dataApi: clean(draft.dataApi, "dataApi"),
    authPermissions: clean(draft.authPermissions, "authPermissions"),
  };
  const acceptanceCriteria = cleanList(draft.acceptanceCriteria, "acceptanceCriteria");
  const limitations = cleanList(draft.limitations, "limitations");
  const missingContext = draft.missingContext.map((m, i) => ({
    item: clean(m.item, `missingContext[${i}].item`),
    inPrototype: clean(m.inPrototype, `missingContext[${i}].inPrototype`),
    productionNeed: clean(m.productionNeed, `missingContext[${i}].productionNeed`),
    owner: clean(m.owner, `missingContext[${i}].owner`),
  }));

  // --- Questions: the model's, plus one for every UNKNOWN the file now carries ------------------
  const questions: Question[] = draft.openQuestions.map((q, i) => ({
    priority: q.priority,
    question: clean(q.question, `openQuestions[${i}].question`),
    detail: clean(q.detail, `openQuestions[${i}].detail`),
    resolutionPath: clean(q.resolutionPath, `openQuestions[${i}].resolutionPath`),
  }));
  for (const u of unconfirmed) {
    const flag = flags.find((f) => f.id === u.flag)!;
    const where = flag.locations.map((l) => `${l.file}:${l.line}`).join(", ");
    questions.push({
      priority: "Blocking",
      question: `What does the prototype use at ${where}, as the design system names it?`,
      detail: `The draft named something in ${u.field} that Docent could not confirm, so it reads UNKNOWN. The name is in flags.json (${u.flag}); it is deliberately not repeated here.`,
      resolutionPath: "UX + Engineering, against Docent",
    });
  }
  for (const flag of evidence.flags.filter((f) => f.severity === "blocking")) {
    const where = flag.locations.map((l) => `${l.file}:${l.line}`).join(", ") || evidence.prototype.entries.join(", ");
    questions.push({
      priority: "Blocking",
      question: `${flag.message} What should the prototype use instead?`,
      detail: `Docent flagged this while confirming the prototype (${flag.id}, ${flag.kind}) at ${where}.`,
      resolutionPath: "UX + Engineering, against Docent",
    });
  }

  const status: Rendered["status"] = questions.some((q) => q.priority === "Blocking") ? "blocked" : "draft";
  const inventory = componentRows(evidence);
  const meta = metadata({ inputs, evidence, now, route: options.route, prototypeSource: options.prototypeSource, status });

  const md: string[] = [];
  const push = (...lines: string[]) => md.push(...lines);
  const rule = () => push("", "---", "");

  push(`# UI context — ${featureTitle(inputs)}`, "");
  push("```yaml", "handoff:", "  version: 1.0", `  status: ${status}`, `  approved_design_version: "UNKNOWN"`, "  approved_by:", "    product: UNKNOWN", "    ux: UNKNOWN", "    engineering: pending", "```", "");
  push(`<!-- Instance: ${name.uicontext}`, `     Read ${name.intentUx} first.`, `     Drafted by the UIContext agent against ${evidence.docent.client.name}; every design-system name below was confirmed through Docent.`, `     Designed UI is the prototype; gaps stay UNKNOWN / not designed. -->`, "");
  push("## File naming", "", "```", "{product}_{feature}_{id}_uicontext.md", "```", "", `Shared prefix with \`${name.intentUx}\`.`);
  rule();

  push("## Metadata", "", table(["Field", "Value"], meta));
  rule();

  push("## Agent briefing index", "", "One file. Slices: `UX-BEHAVIOR` · `UI-SURFACE` · `CONTRACTS` · `VERIFY` · `PROTOTYPE`.", "");
  push(
    table(
      ["Agent", "Read", "Skip"],
      [
        ["**tech-lead**", "Metadata, Scope, this index, Open questions, `handoff:`", "Token tables, props detail"],
        ["**frontend-engineer**", "UX annotations → tokens + component inventory + props API", "File locations as production paths"],
        ["**backend-engineer**", "Data / API, Auth", "Visual annotations, tokens"],
        ["**test-writer**", "Acceptance criteria, a11y, state coverage, open questions", "Component detail, prototype paths"],
      ],
    ),
  );
  push("", "`status` gates readiness — see Completeness check at the end of this file.");
  rule();

  push("## Agent access", "", "Every claim below about the design system was confirmed through Docent before it was written down. Confirm the same way before changing one.", "");
  push(
    table(
      ["Need", "Docent call"],
      [
        ["Does this component exist? What are its props and variants?", "`ask` with `component` set to the import path or name"],
        ["Is this the right token for this use?", "`ask` naming the CSS variable or utility class"],
        ["Does this composition break a governance rule?", "`ask` with `code` set to the file"],
        ["What is the broader pattern for this kind of screen?", "`ask` a patterns question"],
        ["Give me the component's own code and setup", "`get_component` / `get_foundation`"],
      ],
    ),
  );
  push("", "**If Docent cannot confirm something, it stays `UNKNOWN` with an open question. Do not invent a name, value or rule to fill the gap.**");
  rule();

  push("## Scope", "", `${summary}`, "");
  push("**In scope:**", "", ...bullets(inScope), "");
  push("**Out of scope / not designed:**", "", ...bullets(outOfScope), "");
  push("**Do not invent:** component names, install paths, token values or API fields not confirmed via Docent. Use UNKNOWN.");
  rule();

  push("## State coverage matrix", "", "**✓** = designed in the prototype. **○** = not designed — do not invent UI.", "");
  for (const [group, heading] of [["visual", "Visual"], ["data-stress", "Data stress"], ["permissions", "Permissions"], ["system", "System"]] as const) {
    const rows = coverage.filter((c) => c.group === group).map((c) => [c.designed ? "✓" : "○", c.state, c.notes]);
    push(`### ${heading}`, "", rows.length ? table(["Coverage", "State", "Notes"], rows) : "_No states listed for this group._", "");
  }
  rule();

  push("# Part 1 — UX (designed experience)", "", "<!-- slice: UX-BEHAVIOR -->", "", `Job-level use cases live in ${name.intentUx} (\`UC-*\`). This part is designed behaviour.`, "");
  push("## UX annotations", "", annotations.length ? table(["ID", "Page", "Target (control / region)", "Type", "Behaviour (what happens)", "States that apply", "Notes"], annotations.map((a) => [a.id, a.page, a.target, a.type, a.behavior, a.states, a.notes])) : "_No annotations drafted._");
  rule();

  push("# Part 2 — UI surface (component inventory)", "", "<!-- slice: UI-SURFACE -->", "", "Rendered from Docent's answers, not written by hand. `req` is the Docent request behind each row.", "");
  push("## Component inventory", "", inventory.length ? table(["Component", "Confirmed via Docent?", "Variant used", "Notes"], inventory) : "_The prototype imports no design-system components._", "");
  push("## Design tokens", "", tokenRows(evidence).length ? table(["Token", "Confirmed via Docent?", "Usage", "Value reference"], tokenRows(evidence)) : "_The prototype uses no CSS variables._", "");
  push("## Utility classes", "", utilityRows(evidence).length ? table(["Kind", "Classes", "Meaning"], utilityRows(evidence)) : "_The prototype uses no utility classes._", "");
  push("## Props API (primary components)", "", propRows(evidence).length ? table(["Component", "Prop", "Type", "Required?", "Notes"], propRows(evidence)) : "_No props to report._");
  rule();

  push("# Part 3 — Contracts", "", "<!-- slice: CONTRACTS -->", "");
  push("## Interaction rules", "", contracts.interactionRules, "");
  push("## Responsive behaviour", "", contracts.responsive, "");
  push("## Accessibility", "", contracts.accessibility, "");
  push("## Data / API", "", contracts.dataApi, "");
  push("## Auth / permissions", "", contracts.authPermissions);
  rule();

  push("# Part 4 — Verify", "", "<!-- slice: VERIFY -->", "");
  push("## Acceptance criteria", "", ...acceptanceCriteria.map((c) => `- [ ] ${c}`), "- [ ] No hardcoded hex in new styles", "- [ ] Every component and token cited resolves via Docent — none marked UNKNOWN without a matching open question", "");
  push("**Definition of done**", "", "- [ ] Required sections filled for this feature's size (see Addendum)", "- [ ] Blocking questions listed, not silently guessed", "- [ ] Handoff page updated with both named downloads", "- [ ] Intent-ux metrics still valid");
  rule();

  push("## Known prototype limitations", "", ...bullets(limitations));
  rule();

  push("## Missing context", "", missingContext.length ? table(["Item", "In prototype?", "Production need", "Owner"], missingContext.map((m) => [m.item, m.inPrototype, m.productionNeed, m.owner])) : "_None recorded._");
  rule();

  push("## Open questions", "", questions.length ? table(["#", "Priority", "Question", "Detail", "Resolution path"], questions.map((q, i) => [`Q-${i + 1}`, q.priority, q.question, q.detail, q.resolutionPath])) : "_None._", "");
  push("_Priority is `Blocking` or `Advisory`. A `Blocking` question keeps `handoff.status` from being set to `ready`._");
  rule();

  push("## Downloads / export artifacts", "", table(["Artifact", "Path", "Description"], [["This file", `\`${name.uicontext}\``, "Canonical uicontext"], ["Intent-ux", `\`${name.intentUx}\``, "Why / who / jobs"], ["Flags", "`flags.json`", "Every unconfirmed claim, with the Docent requests behind the confirmations"]]));
  rule();

  push("## Links", "", `- Companion intent-ux: \`${name.intentUx}\``, `- Companion implementation-plan: \`${name.implementationPlan}\``, `- Prototype source: ${options.prototypeSource ?? evidence.prototype.root}`);
  rule();

  push("## Anti-patterns — never do these", "", "- Hardcoded hex in product or story styles", "- Citing a component, token or pattern name not confirmed via Docent", "- Inventing names when Docent returns no match — write UNKNOWN instead", "- Treating the prototype as production-complete", "- Setting `handoff.status: ready` with an open Blocking question");
  rule();

  push("# Addendum", "", "## Feature size", "", `This instance is **${inputs.intentUx.fields["Feature size"] ?? "UNKNOWN"}**, from ${name.intentUx}.`, "");
  push("## Completeness check", "", "1. Filename matches `{product}_{feature}_{id}_uicontext.md` and the paired intent-ux exists.", "2. Every component and token cited has been confirmed via Docent or is marked UNKNOWN with a logged open question.", "3. State coverage includes explicit ○ rows for anything not designed.", "4. No Blocking open questions remain if `handoff.status: ready`.", "5. This file is not a substitute for `implementation-plan.md`.", "");

  return { markdown: `${md.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`, flags, questions, unconfirmed, status };
}

/** Everything Docent confirmed, by the exact strings a draft is allowed to use. */
export function confirmedNames(e: Evidence): Set<string> {
  const names = new Set<string>(PROSE);
  for (const c of e.components) {
    if (c.status === "unconfirmed" || c.status === "ambiguous") continue;
    names.add(c.module);
    if (!c.docent) continue;
    names.add(c.docent.name);
    if (c.docent.importPath) names.add(c.docent.importPath);
    for (const part of c.docent.parts) names.add(part.name);
  }
  for (const m of e.localModules) {
    names.add(m.file);
    for (const exported of m.exports) names.add(exported);
  }
  for (const p of e.packages) names.add(p.name);
  for (const f of e.prototype.scanned) names.add(f);
  for (const f of e.prototype.stylesheets) names.add(f);
  for (const t of e.tokens) {
    if (t.status !== "confirmed") continue;
    names.add(t.variable);
    if (t.token) names.add(t.token.id);
  }
  for (const u of e.utilities) if (u.kind !== "unknown-variable") names.add(u.class);
  return names;
}

const COMPONENT_LIKE = /\b[A-Z][A-Za-z0-9]*\b/g;
const CSS_VARIABLE = /--[A-Za-z][\w-]*/g;
const ALIAS_PATH = /@\/[\w./-]+/g;
const CODE_SPAN = /`([^`]+)`/g;
const UTILITY_IN_CODE = /^!?-?[a-z][a-z0-9]*(?:[:-][a-z0-9.[\]/-]+)+$/;

/** Replaces every design-system-shaped name the evidence doesn't contain with UNKNOWN. */
export function lintClaims(value: string, confirmed: Set<string>): { text: string; names: string[] } {
  const candidates = new Set<string>();
  for (const m of value.matchAll(CSS_VARIABLE)) candidates.add(m[0]);
  for (const m of value.matchAll(ALIAS_PATH)) candidates.add(m[0]);
  for (const m of value.matchAll(COMPONENT_LIKE)) {
    const word = m[0];
    // A component name, not a capitalized word: at least two capitals and one lowercase letter.
    if ((word.match(/[A-Z]/g) ?? []).length >= 2 && /[a-z]/.test(word)) candidates.add(word);
  }
  for (const m of value.matchAll(CODE_SPAN)) {
    const inner = m[1]!.trim();
    if (UTILITY_IN_CODE.test(inner) || inner.startsWith("--") || inner.startsWith("@/")) candidates.add(inner);
  }

  const names: string[] = [];
  let text = value;
  // Longest first, so a path is replaced whole rather than through a name inside it.
  for (const candidate of [...candidates].sort((a, b) => b.length - a.length)) {
    if (confirmed.has(candidate)) continue;
    if (!text.includes(candidate)) continue;
    names.push(candidate);
    text = text.split(candidate).join("UNKNOWN");
  }
  return { text: text.replace(/`UNKNOWN`/g, "UNKNOWN"), names };
}

function citedLocations(e: Evidence, cited: string[]): { file: string; line: number }[] {
  const locations: { file: string; line: number }[] = [];
  for (const id of cited) {
    const component = e.components.find((c) => c.id === id);
    if (component) locations.push(...component.usage.map((u) => u.at).slice(0, 1), ...(component.usage.length ? [] : component.imports.map((i) => i.at).slice(0, 1)));
    const token = e.tokens.find((t) => t.id === id);
    if (token) locations.push(token.uses[0]!);
    const flag = e.flags.find((f) => f.id === id);
    if (flag) locations.push(...flag.locations.slice(0, 1));
  }
  return locations.slice(0, 3);
}

function componentRows(e: Evidence): string[][] {
  return e.components.map((c) => {
    const req = c.requestIds[0] ? `req ${c.requestIds[0].slice(0, 8)}` : "no request";
    const where = c.imports.map((i) => `${i.at.file}:${i.at.line}`)[0] ?? "";
    const variants = c.docent?.parts.flatMap((p) => p.variants.map((v) => v.name)) ?? [];
    const used = [...new Set(c.usage.flatMap((u) => u.props.filter((p) => p.value && variants.includes(p.name)).map((p) => `${p.name}=${p.value}`)))];
    switch (c.status) {
      case "confirmed":
        return [c.docent!.name, `Yes (${req})`, used.join(", ") || "default", `\`${c.module}\` · used ${c.usage.length}×`];
      case "near-match":
        return [c.docent!.name, `Yes, by name (${req})`, used.join(", ") || "default", `Imported from \`${c.module}\`; the design system's path is \`${c.docent!.importPath}\``];
      case "not-in-inventory":
        return [c.docent!.name, `Exists, but not in the inventory (${req})`, "—", `Not available for use; imported at ${where}`];
      case "ambiguous":
        return ["UNKNOWN", `No — several components share the name (${req})`, "—", `Import at ${where}; candidates are in flags.json`];
      default:
        return ["UNKNOWN", `No (${req})`, "—", `Import at ${where}; Docent confirmed nothing for it`];
    }
  });
}

function tokenRows(e: Evidence): string[][] {
  return e.tokens.map((t) => {
    const where = t.uses.map((u) => `${u.file}:${u.line}`).slice(0, 3).join(", ");
    if (t.status !== "confirmed") return ["UNKNOWN", `No (req ${t.requestId.slice(0, 8)})`, where, "Not a token Docent can confirm"];
    const values = Object.entries(t.token!.values).map(([mode, v]) => `${mode}: ${v}`).join("; ");
    return [`\`${t.variable}\``, `Yes (req ${t.requestId.slice(0, 8)})`, `${t.token!.category}${t.token!.meaning ? ` — ${t.token!.meaning}` : ""} · ${where}`, values || `\`var(${t.variable})\``];
  });
}

function utilityRows(e: Evidence): string[][] {
  const meaning: Record<string, string> = {
    token: "Applies a design token",
    unbound: "Framework default, not owned by the design system",
    palette: "Raw palette colour — not a token",
    "arbitrary-color": "Raw colour — not a token",
    "unknown-variable": "Uses a variable that is not a design token",
    unclassified: "Docent did not classify it",
  };
  return Object.entries(
    e.utilities.reduce<Record<string, string[]>>((acc, u) => ((acc[u.kind] = [...(acc[u.kind] ?? []), u.class]), acc), {}),
  ).map(([kind, classes]) => [kind, classes.map((c) => `\`${c}\``).join(", "), meaning[kind] ?? ""]);
}

function propRows(e: Evidence): string[][] {
  const rows: string[][] = [];
  for (const c of e.components) {
    if (c.status === "unconfirmed" || c.status === "ambiguous" || !c.docent) continue;
    const used = new Set(c.usage.flatMap((u) => u.props.map((p) => p.name)));
    for (const part of c.docent.parts) {
      for (const prop of part.props) {
        if (!used.has(prop.name) && !prop.required) continue;
        rows.push([part.name, `\`${prop.name}\``, `\`${prop.values?.join(" \\| ") ?? prop.type}\``, prop.required ? "Yes" : "No", [prop.default ? `default \`${prop.default}\`` : "", used.has(prop.name) ? "used in the prototype" : ""].filter(Boolean).join("; ")]);
      }
    }
  }
  return rows;
}

function metadata(o: { inputs: Inputs; evidence: Evidence; now: Date; route?: string; prototypeSource?: string; status: string }): string[][] {
  const { inputs, evidence } = o;
  const story = inputs.story.data as Record<string, string>;
  const intent = inputs.intentUx.fields;
  const value = (v: string | undefined) => (v && v.trim() ? v.trim() : "UNKNOWN");
  return [
    ["Canonical filename", `\`${inputs.name.uicontext}\``],
    ["Companion intent-ux", `\`${inputs.name.intentUx}\``],
    ["Product slug", inputs.name.product],
    ["Feature slug", inputs.name.feature],
    ["Feature / story id", inputs.name.id],
    ["Story ID", value(story.key)],
    ["Epic / Feature", value(story.epic)],
    ["Feature size", value(intent["Feature size"])],
    ["Work type", value(intent["Work type"])],
    ["Screen(s) in scope", evidence.prototype.entries.map((e) => `\`${e}\``).join(", ")],
    ["This repo", value(intent["This repo"])],
    ["Prototype source", o.prototypeSource ?? evidence.prototype.root],
    ["Prototype route", value(o.route)],
    ["Design system", `${evidence.docent.client.name}, queried via Docent — contract \`${evidence.docent.contractHash.slice(0, 19)}…\`${evidence.docent.sourceCommit ? `, source \`${evidence.docent.sourceCommit.slice(0, 8)}\`` : ""}`],
    ["Companion implementation-plan", `Engineering fills \`${inputs.name.implementationPlan}\``],
    ["Author", "UX (UIContext agent)"],
    ["Reviewer / owner", "UNKNOWN"],
    ["Last updated", o.now.toISOString().slice(0, 10)],
    ["Status", `\`${o.status}\``],
  ];
}

function featureTitle(inputs: Inputs): string {
  const summary = (inputs.story.data as Record<string, string>).summary;
  if (summary) return summary;
  return inputs.name.feature.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function bullets(items: string[]): string[] {
  return items.length ? items.map((i) => `- ${i}`) : ["- UNKNOWN"];
}

function table(headers: string[], rows: string[][]): string {
  const cell = (v: string) => v.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

/** What a run writes beside the file: everything that could not be stated as fact. */
export function flagsFile(rendered: Rendered, evidence: Evidence, inputs: Inputs, now: Date) {
  return {
    version: 1,
    generatedAt: now.toISOString(),
    handoff: { file: inputs.name.uicontext, status: rendered.status },
    docent: evidence.docent,
    counts: {
      blocking: rendered.flags.filter((f) => f.severity === "blocking").length,
      advisory: rendered.flags.filter((f) => f.severity === "advisory").length,
      unconfirmedClaims: rendered.unconfirmed.length,
      blockingQuestions: rendered.questions.filter((q) => q.priority === "Blocking").length,
    },
    unconfirmedClaims: rendered.unconfirmed,
    flags: rendered.flags,
    openQuestions: rendered.questions,
  };
}
