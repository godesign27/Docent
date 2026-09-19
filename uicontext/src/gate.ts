/**
 * Phase 2: the completeness gate.
 *
 * The drafter does not decide whether its own draft is finished. This pass re-reads the rendered
 * file with deterministic checks, then asks a second model — fresh context, the inputs and the
 * rendered file only, never the drafter's reasoning — to judge what code cannot. Code alone sets
 * handoff.status: `ready` needs every blocking check to pass and no blocking finding; anything
 * else is `blocked`.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Evidence } from "./evidence.js";
import type { Inputs } from "./inputs.js";
import type { Model } from "./model.js";
import { sectionsOf as sections, tableRows as rows } from "./prior.js";
import type { Rendered } from "./render.js";

export const GATE_PURPOSE = "gate";

export const GraderReport = z.object({
  findings: z.array(
    z.object({
      check: z.enum(["coverage-honesty", "question-priority", "undesigned-ui", "scope-consistency", "other"]),
      severity: z.enum(["blocking", "advisory"]),
      section: z.string(),
      finding: z.string(),
      suggestedQuestion: z.string(),
    }),
  ),
  /** The grader's own opinion. Recorded, but the status is code's decision. */
  verdict: z.enum(["ready", "blocked"]),
});
export type GraderReport = z.infer<typeof GraderReport>;

export interface Check {
  id: string;
  title: string;
  passed: boolean;
  blocking: boolean;
  detail: string;
}

export interface GateResult {
  status: "ready" | "blocked";
  checks: Check[];
  grader: (GraderReport & { model: string }) | null;
  reasons: string[];
}

/** Sections a feature of each size must fill, cumulatively, from the template's size rubric. */
const XS = ["Metadata", "Scope", "State coverage matrix"];
const S = [...XS, "Component inventory"];
const M = [...S, "UX annotations", "Design tokens"];
const L = [...M, "Interaction rules", "Responsive behaviour", "Accessibility", "Data / API"];
const XL = [...L, "Props API (primary components)", "Auth / permissions", "Known prototype limitations", "Missing context"];
const SIZE_SECTIONS: Record<string, string[]> = { XS, S, M, L, XL };

/** UNKNOWN in these lines is the template telling people what to do, not a gap in this feature. */
const BOILERPLATE_UNKNOWN = /Do not invent|write UNKNOWN instead|marked UNKNOWN|approved_design_version|Reviewer \/ owner|resolves via Docent/;

/**
 * A section is unfilled only when the drafter gave nothing. "The prototype uses no CSS variables"
 * is a finding rendered from evidence, not a hole, so it must not read as missing.
 */
const NOT_DRAFTED = /^_No (?:states listed|annotations drafted)/;

export function runChecks(o: { inputs: Inputs; evidence: Evidence; rendered: Rendered; markdown: string }): Check[] {
  const { inputs, evidence, rendered, markdown } = o;
  const body = sections(markdown);
  const checks: Check[] = [];
  const add = (id: string, title: string, blocking: boolean, passed: boolean, detail: string) => checks.push({ id, title, passed, blocking, detail });

  // Template completeness 1
  const companion = join(dirname(inputs.intentUx.path), inputs.name.intentUx);
  add("naming", "Filename follows the convention and the companion intent-ux exists", true, existsSync(companion) && markdown.includes(inputs.name.uicontext),
    existsSync(companion) ? `Companion ${inputs.name.intentUx} is beside the draft.` : `No ${inputs.name.intentUx} beside the draft.`);

  // Template completeness 2
  add("confirmed-claims", "Every design-system name in the file was confirmed by Docent", true, rendered.unconfirmed.length === 0,
    rendered.unconfirmed.length === 0 ? "No unconfirmed names reached the file." : `${rendered.unconfirmed.length} replaced with UNKNOWN, from ${rendered.unconfirmed.map((u) => u.field).join(", ")}.`);

  const gaps = markdown.split("\n").filter((l) => l.includes("UNKNOWN") && !BOILERPLATE_UNKNOWN.test(l));
  add("unknowns-have-questions", "Every UNKNOWN is paired with an open question", true, gaps.length === 0 || rendered.questions.length > 0,
    gaps.length === 0 ? "The file records no gaps." : `${gaps.length} line(s) carry UNKNOWN, with ${rendered.questions.length} open question(s).`);

  // Template completeness 3
  const groups = ["Visual", "Data stress", "Permissions", "System"];
  const empty = groups.filter((g) => !rows(body.get(g) ?? "").length);
  const blank = groups.flatMap((g) => rows(body.get(g) ?? "").filter((r) => !r[2]?.trim()).map(() => g));
  add("coverage-complete", "Every state coverage group has rows, and every row says something", true, empty.length === 0 && blank.length === 0,
    empty.length || blank.length ? `${empty.length ? `no rows under ${empty.join(", ")}` : ""}${empty.length && blank.length ? "; " : ""}${blank.length ? `${blank.length} row(s) with an empty note` : ""}.` : "All four groups have rows with notes.");

  const undesigned = groups.flatMap((g) => rows(body.get(g) ?? "")).filter((r) => r[0]?.includes("○"));
  add("coverage-explicit", "States that are not designed are listed as ○ rather than omitted", false, undesigned.length > 0,
    undesigned.length ? `${undesigned.length} ○ row(s).` : "No ○ rows: either everything is designed, or omissions are silent. The grader judges this.");

  const size = (inputs.intentUx.fields["Feature size"] ?? "").replace(/[^A-Za-z]/g, "").toUpperCase();
  const required = SIZE_SECTIONS[size];
  const missing = (required ?? []).filter((s) => {
    const text = body.get(s);
    return !text || !text.trim() || NOT_DRAFTED.test(text.trim());
  });
  add("size-sections", `Sections a ${size || "UNKNOWN"}-size feature must fill are filled`, true, Boolean(required) && missing.length === 0,
    !required ? `The intent-ux gives no feature size, so the required set is unknown.` : missing.length ? `Empty: ${missing.join(", ")}.` : `All ${required.length} sections required at ${size} are filled.`);

  // Template completeness 4
  const blocking = rendered.questions.filter((q) => q.priority === "Blocking");
  add("no-blocking-questions", "No Blocking open questions remain", true, blocking.length === 0,
    blocking.length ? `${blocking.length} Blocking question(s): ${blocking.slice(0, 3).map((q) => q.question).join(" · ")}${blocking.length > 3 ? " …" : ""}` : "No Blocking questions.");

  const rejected = evidence.governance.filter((g) => g.outcome === "disallowed");
  const review = evidence.governance.filter((g) => g.outcome === "needs-review");
  add("governance", "The prototype breaks no rule that rejects it or needs a reviewer", true, rejected.length === 0 && review.length === 0,
    rejected.length || review.length ? `${[...rejected, ...review].map((g) => `${g.file}: ${g.outcome}`).join("; ")}.` : "Docent's rules are satisfied for every prototype file.");

  add("answered-questions", "No question a person had answered has come back", false, rendered.reopened.length === 0,
    rendered.reopened.length ? `${rendered.reopened.length} answered question(s) raised again; the answers are kept, but check they still hold.` : "Nothing a person answered has been raised again.");

  const blockingFlags = evidence.flags.filter((f) => f.severity === "blocking");
  add("evidence-clean", "Docent confirmed everything the prototype uses", true, blockingFlags.length === 0,
    blockingFlags.length ? `${blockingFlags.length} blocking flag(s): ${blockingFlags.slice(0, 3).map((f) => f.kind).join(", ")}.` : "No blocking flags.");

  return checks;
}

const GRADER_SYSTEM = `You are grading a finished UIContext handoff file — the implementation contract an engineering agent reads before building a feature. You did not write it and you do not know how it was produced. Judge only what is in front of you.

You are given the story, the companion intent-ux, the prototype's source, and the rendered file. Code has already checked the mechanical things: naming, section presence, whether design-system names were confirmed, whether questions exist. Do not repeat that work.

Judge what code cannot:

1. **Are the ○ rows honest?** A row marked ○ (not designed) that the prototype clearly does design is wrong, and so is a ✓ on something the prototype does not do. Read the source before claiming either.
2. **Is a state missing entirely?** A state the story asks for that appears in neither the ✓ nor the ○ rows is a silent omission — worse than an honest ○.
3. **Should a question be Blocking?** Advisory means engineering can build while it is open. If engineering would have to guess behaviour, data or permissions, it is Blocking and being marked Advisory is a finding.
4. **Does the file describe UI that does not exist?** Anything asserted about the design that the prototype does not do.
5. **Is the scope consistent** with the story and the intent-ux — nothing quietly dropped, nothing added that was never asked for.

Severity: \`blocking\` if an engineer would build the wrong thing, or a reviewer would be misled about what is designed. \`advisory\` otherwise. Cite the section you are judging. Report nothing you cannot point at in the file or the prototype — a clean file returns an empty findings list.`;

export async function gate(options: { model: Model; inputs: Inputs; evidence: Evidence; rendered: Rendered; markdown: string }): Promise<GateResult> {
  const { model, inputs, rendered, markdown } = options;
  const checks = runChecks(options);

  const grader = await model.complete({
    purpose: GATE_PURPOSE,
    schemaName: "gate report",
    system: GRADER_SYSTEM,
    schema: GraderReport,
    prompt: [
      `# Story (${inputs.story.path})\n\n${inputs.story.text}`,
      `# Companion intent-ux (${inputs.intentUx.path})\n\n${inputs.intentUx.text}`,
      `# Prototype source\n\n${inputs.prototype.map((f) => `## ${f.file}\n\n\`\`\`tsx\n${f.text}\n\`\`\``).join("\n\n")}`,
      `# The rendered file to grade\n\n${markdown}`,
      `# Your task\n\nGrade the rendered file against the story, the intent-ux and the prototype. Return findings, most serious first.`,
    ].join("\n\n---\n\n"),
  });

  const failed = checks.filter((c) => c.blocking && !c.passed);
  const blockingFindings = grader.findings.filter((f) => f.severity === "blocking");
  const reasons = [...failed.map((c) => c.detail), ...blockingFindings.map((f) => `${f.section}: ${f.finding}`)];
  return {
    status: failed.length === 0 && blockingFindings.length === 0 ? "ready" : "blocked",
    checks,
    grader: { ...grader, model: model.name },
    reasons,
  };
}

/** Writes the decision into the file: the frontmatter status, and a short summary above the content. */
export function applyGate(markdown: string, result: GateResult): string {
  const failed = result.checks.filter((c) => !c.passed);
  const blockingFindings = result.grader?.findings.filter((f) => f.severity === "blocking") ?? [];
  const advisory = result.grader?.findings.filter((f) => f.severity === "advisory") ?? [];
  const lines = [
    `> **Gate: ${result.status}.** ${result.checks.length - failed.length} of ${result.checks.length} checks passed${result.grader ? `, graded by ${result.grader.model}` : ""}. Set by the checks, not by the drafter. Full report in \`flags.json\`.`,
  ];
  for (const check of failed) lines.push(`> - ${check.blocking ? "✖" : "!"} ${check.title} — ${check.detail}`);
  for (const finding of blockingFindings) lines.push(`> - ✖ ${finding.section}: ${finding.finding}`);
  if (advisory.length) lines.push(`> - ! ${advisory.length} advisory finding(s) from the grader, in \`flags.json\`.`);

  const withStatus = markdown.replace(/^ {2}status: \w+$/m, `  status: ${result.status}`);
  const anchor = withStatus.indexOf("\n## File naming");
  if (anchor === -1) return `${withStatus}\n${lines.join("\n")}\n`;
  return `${withStatus.slice(0, anchor)}\n\n${lines.join("\n")}\n${withStatus.slice(anchor)}`;
}


