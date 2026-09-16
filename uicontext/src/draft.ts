/**
 * The draft pass: the one place a model writes anything.
 *
 * It fills the sections that need judgment — what each control does, which states are designed,
 * what is missing, what has to be asked. It never writes the component, token or props tables:
 * those are rendered from evidence. Whatever it says about the design system is checked afterwards
 * by the claim lint in render.ts, so a name it invents can't reach the file.
 */
import { z } from "zod";
import type { Evidence } from "./evidence.js";
import type { Inputs } from "./inputs.js";
import type { Model } from "./model.js";

export const DRAFT_PURPOSE = "draft";

const Cited = z.object({
  /** Evidence ids (C-1, T-2, F-3) behind anything said here about the design system. */
  evidence: z.array(z.string()),
});

export const Draft = z.object({
  summary: z.string(),
  scope: z.object({ inScope: z.array(z.string()), outOfScope: z.array(z.string()) }),
  annotations: z.array(
    Cited.extend({
      page: z.string(),
      target: z.string(),
      type: z.string(),
      behavior: z.string(),
      states: z.string(),
      notes: z.string(),
    }),
  ),
  coverage: z.array(
    Cited.extend({
      group: z.enum(["visual", "data-stress", "permissions", "system"]),
      state: z.string(),
      designed: z.boolean(),
      notes: z.string(),
    }),
  ),
  interactionRules: z.string(),
  responsive: z.string(),
  accessibility: z.string(),
  dataApi: z.string(),
  authPermissions: z.string(),
  acceptanceCriteria: z.array(z.string()),
  limitations: z.array(z.string()),
  missingContext: z.array(z.object({ item: z.string(), inPrototype: z.string(), productionNeed: z.string(), owner: z.string() })),
  openQuestions: z.array(z.object({ priority: z.enum(["Blocking", "Advisory"]), question: z.string(), detail: z.string(), resolutionPath: z.string() })),
});
export type Draft = z.infer<typeof Draft>;

const SYSTEM = `You write the judgment sections of a UIContext handoff file: the implementation contract an engineering agent reads before it writes code against a design system.

You are one step in a pipeline, not the author of the file. Code renders the file from what you return, and checks every design-system name in it. Work accordingly.

## What you are given

1. The story: what was asked for, its acceptance criteria and its open questions.
2. The companion intent-ux: the why, who and scope the design settled. Written before you; treat it as decided.
3. The prototype's source: the finished design. This is what was actually built.
4. EVIDENCE: the only record of what the design system contains. Every import, class and CSS variable in the prototype was checked against the design system, one item at a time, and the result is listed with an id.

## Rules

1. **Evidence only.** Every statement traces to the prototype, the story or the intent-ux. If none of them says it, the answer is UNKNOWN with an open question. Never supply a number, name, endpoint, role or date that isn't in your inputs.
2. **Never name a design-system component, token, utility class or import path that is not in EVIDENCE.** Cite the id instead, in the row's \`evidence\` array. Code replaces any unlisted name with UNKNOWN and raises a blocking question against your draft, so guessing costs you the sentence.
3. **Don't write the tables code owns.** The component inventory, design tokens and props tables are rendered from evidence. Your annotations describe behaviour, and cite ids.
4. **Not designed is a finding, not a hole to fill.** Where the story asks for something the prototype doesn't do, mark the state \`designed: false\` and say so plainly. Never describe UI that isn't there.
5. **Where the prototype contradicts the story, say so** in the notes and raise a question.
6. **Question priority.** \`Blocking\` means engineering would have to guess behaviour, data or permissions to build it. \`Advisory\` means it can be built while the question is open. Carry forward the intent-ux's open questions that still apply, and add what the prototype raised.
7. **Coverage rows.** Cover every state the feature plausibly has — default, hover, focus, loading, empty, error, long text, large datasets, each role, timeouts, offline, stale data — with \`designed: true\` only where the prototype designs it. A row you leave out is a state nobody checked.
8. **Plain language.** Short sentences. No marketing, no hedging, no restating the template.`;

export async function draftUiContext(options: { model: Model; inputs: Inputs; evidence: Evidence }): Promise<Draft> {
  const { model, inputs, evidence } = options;
  return model.complete({
    purpose: DRAFT_PURPOSE,
    schemaName: "UIContext draft",
    system: SYSTEM,
    schema: Draft,
    prompt: [
      `# Feature\n\n${inputs.name.prefix} — drafting ${inputs.name.uicontext}.`,
      `# Story (${inputs.story.path})\n\n${inputs.story.text}`,
      `# Companion intent-ux (${inputs.intentUx.path})\n\n${inputs.intentUx.text}`,
      `# Prototype source\n\n${inputs.prototype.map((f) => `## ${f.file}\n\n\`\`\`tsx\n${f.text}\n\`\`\``).join("\n\n")}`,
      `# EVIDENCE — the design system, as Docent confirmed it\n\n${evidenceDigest(evidence)}`,
      `# Your task\n\nReturn the UIContext draft for ${inputs.name.prefix}. Name design-system items only by citing the ids above.`,
    ].join("\n\n---\n\n"),
  });
}

/** Evidence as the model sees it: ids, what each one is, and where it is used. */
export function evidenceDigest(e: Evidence): string {
  const lines: string[] = [];
  const at = (l: { file: string; line: number }) => `${l.file}:${l.line}`;

  lines.push(`Design system: ${e.docent.client.name}, contract ${e.docent.contractHash.slice(0, 19)}…`);
  lines.push(`Prototype: ${e.prototype.entries.join(", ")} (${e.prototype.scanned.length} files scanned)`);

  lines.push("\n## Components");
  lines.push("Only these design-system components exist. A component listed as anything but `confirmed` may not be named in your draft.");
  for (const c of e.components) {
    const name = c.docent && c.status !== "unconfirmed" && c.status !== "ambiguous" ? c.docent.name : "(name not confirmed)";
    const parts = c.docent?.parts.map((p) => p.name).join(", ") ?? "";
    lines.push(`- ${c.id} [${c.status}] ${name}${parts && parts !== name ? ` (parts: ${parts})` : ""} — imported at ${c.imports.map((i) => at(i.at)).join(", ")}; used ${c.usage.length}× ${c.usage.map((u) => at(u.at)).slice(0, 6).join(", ")}`);
    for (const part of c.docent?.parts.filter((p) => p.props.length) ?? []) {
      lines.push(`    ${part.name} props: ${part.props.map((p) => `${p.name}${p.required ? "*" : ""}: ${p.values?.join("|") ?? p.type}`).join("; ")}`);
    }
    const props = c.usage.flatMap((u) => u.props.filter((p) => p.value !== null).map((p) => `${p.name}="${p.value}"`));
    if (props.length) lines.push(`    used with: ${[...new Set(props)].slice(0, 12).join(", ")}`);
  }

  lines.push("\n## Prototype-local components (the prototype's own code, not the design system's)");
  for (const m of e.localModules) lines.push(`- ${m.file} exports ${m.exports.join(", ") || "(default)"}`);

  lines.push("\n## Tokens (CSS variables the prototype uses)");
  for (const t of e.tokens) lines.push(`- ${t.id} [${t.status}] ${t.variable}${t.token ? ` — ${t.token.type}/${t.token.category}${t.token.meaning ? `: ${t.token.meaning}` : ""}` : ""} — ${t.uses.map(at).slice(0, 4).join(", ")}`);

  lines.push("\n## Utility classes");
  for (const kind of ["token", "unbound", "palette", "arbitrary-color", "unknown-variable", "unclassified"]) {
    const group = e.utilities.filter((u) => u.kind === kind);
    if (!group.length) continue;
    const meaning = { token: "apply a design token", unbound: "framework defaults, not the design system's", palette: "raw palette colors", "arbitrary-color": "raw colors", "unknown-variable": "use a variable that is not a token", unclassified: "Docent did not classify these" }[kind];
    lines.push(`- ${kind} (${meaning}): ${group.map((u) => u.class).join(", ")}`);
  }

  lines.push("\n## Governance (Docent's check of each prototype file)");
  for (const g of e.governance) {
    lines.push(`- ${g.file}: ${g.outcome}${g.findings.length ? ` — ${g.findings.map((f) => `${f.ruleId ?? f.check ?? "rule"} (${f.action}): ${f.evidence}`).join("; ")}` : ""}`);
    if (g.notEvaluated.length) lines.push(`    not checked automatically: ${g.notEvaluated.join("; ")}`);
  }

  lines.push("\n## Flags (what could not be confirmed)");
  for (const f of e.flags) lines.push(`- ${f.id} [${f.severity}] ${f.message}${f.locations.length ? ` — ${f.locations.map(at).slice(0, 4).join(", ")}` : ""}`);

  return lines.join("\n");
}
