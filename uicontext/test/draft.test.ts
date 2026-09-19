/**
 * Phase 1 exit criterion: a draft fills every section of the template, and no name Docent hasn't
 * confirmed can reach the file — a scripted model that writes an invented component, token and
 * import path produces a file with none of them, a flag for each, and a Blocking question for each.
 *
 * The model here is scripted, so these tests are deterministic and cost nothing.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DRAFT_PURPOSE, draftUiContext, evidenceDigest } from "../src/draft.js";
import type { Evidence } from "../src/evidence.js";
import { handoffName, type Inputs } from "../src/inputs.js";
import { ModelUnavailable, ScriptedModel } from "../src/model.js";
import { confirmedNames, flagsFile, lintClaims, render } from "../src/render.js";
import { fixture, GOOD_DRAFT, INVENTING_DRAFT, NOW, STORY } from "./support.js";

let evidence: Evidence;
let inputs: Inputs;

beforeAll(async () => {
  ({ evidence, inputs } = await fixture());
});

describe("inputs", () => {
  it("takes the naming convention from the companion intent-ux, and refuses a file that doesn't follow it", () => {
    expect(inputs.name).toMatchObject({ product: "acme", feature: "reports", id: "acme-7", uicontext: "acme_reports_acme-7_uicontext.md" });
    expect(() => handoffName("/tmp/notes.md")).toThrow(/must be named/);
  });

  it("reads the story's fields and the intent-ux's metadata table", () => {
    expect(inputs.story.data).toMatchObject({ key: "ACME-7", epic: "ACME-1 Reporting" });
    expect(inputs.intentUx.fields).toMatchObject({ "Feature size": "M", "Work type": "`new`" });
    expect(inputs.intentUx.sections.map((s) => s.heading)).toContain("Problem statement");
  });
});

describe("the draft pass", () => {
  it("gives the model the inputs and the evidence, and nothing else it could quote a design system from", async () => {
    const model = new ScriptedModel({ [DRAFT_PURPOSE]: GOOD_DRAFT });
    await draftUiContext({ model, inputs, evidence });
    const [request] = model.requests;
    expect(request!.prompt).toContain("C-1");
    expect(request!.prompt).toContain(STORY.trim().split("\n")[1]!);
    expect(request!.prompt).toContain("export default function Reports");
    expect(request!.system).toContain("Never name a design-system component");
  });

  it("lists every confirmed component, token and utility for the model, with its id", () => {
    const digest = evidenceDigest(evidence);
    expect(digest).toMatch(/C-1 \[confirmed\] Button/);
    expect(digest).toContain("--primary");
    expect(digest).toContain("gap-4");
  });

  it("stops when the model has nothing to give", async () => {
    await expect(draftUiContext({ model: new ScriptedModel({}), inputs, evidence })).rejects.toThrow(ModelUnavailable);
  });
});

describe("rendering from evidence", () => {
  let file: string;
  let rendered: ReturnType<typeof render>;

  beforeAll(() => {
    rendered = render({ inputs, evidence, draft: GOOD_DRAFT, now: NOW });
    file = rendered.markdown;
  });

  it("fills every section of the template", () => {
    for (const heading of ["## File naming", "## Metadata", "## Agent briefing index", "## Agent access", "## Scope", "## State coverage matrix", "## UX annotations", "## Component inventory", "## Design tokens", "## Props API", "## Interaction rules", "## Responsive behaviour", "## Accessibility", "## Data / API", "## Auth / permissions", "## Acceptance criteria", "## Known prototype limitations", "## Missing context", "## Open questions", "## Downloads / export artifacts", "## Links", "## Anti-patterns", "## Completeness check"]) {
      expect(file, `missing ${heading}`).toContain(heading);
    }
    expect(file).toMatch(/^# UI context — Reports page with a run dialog\n/);
    expect(file).toContain("| Story ID | ACME-7 |");
    expect(file).toContain("| Feature size | M |");
  });

  it("builds the component, token and props tables from Docent's answers, with the request behind each row", () => {
    expect(file).toMatch(/\| C-\d+ \| Button \| Yes \(req [0-9a-f]{8}\) \|/);
    expect(file).toMatch(/\| T-\d+ \| `--primary` \| Yes \(req [0-9a-f]{8}\) \|/);
    expect(file).toContain("| Button | `intent` |");
    expect(file).toContain("`gap-4`");
  });

  it("does not call a variant chosen in code the default", () => {
    const dynamic = structuredClone(evidence);
    const button = dynamic.components.find((c) => c.docent?.name === "Button")!;
    for (const use of button.usage) for (const prop of use.props) if (prop.name === "intent") prop.value = null;
    const markdown = render({ inputs, evidence: dynamic, draft: GOOD_DRAFT, now: NOW }).markdown;
    expect(markdown).toContain("| intent set in code |");
    expect(markdown).not.toMatch(/\| C-1 \| Button \|[^|]+\| default \|/);
  });

  it("marks what is not designed with ○ and never invents UI for it", () => {
    expect(file).toContain("| ○ | Error | Not designed; the prototype has no error state. |");
    expect(file).toContain("| ✓ | Default |");
  });

  it("points the agent at Docent's real tools, not at names Docent doesn't have", () => {
    expect(file).toContain("`ask` with `component`");
    for (const invented of ["get_contract", "search_patterns", "get_governance", "get_strategy"]) expect(file).not.toContain(invented);
  });

  it("writes the naming convention and the companion file into the frontmatter and metadata", () => {
    // Phase 1 never writes `ready`: a draft with nothing blocking stays `draft` until the Phase 2 gate.
    expect(file).toContain("status: draft");
    expect(rendered.status).toBe("draft");
    expect(file).toContain("`acme_reports_acme-7_uicontext.md`");
    expect(file).toContain("`acme_reports_acme-7_intent-ux.md`");
  });
});

describe("the claim lint", () => {
  it("replaces an invented component, token and import path with UNKNOWN, and raises one flag and one Blocking question for each", () => {
    const rendered = render({ inputs, evidence, draft: INVENTING_DRAFT, now: NOW });

    for (const invented of ["ReportRunnerPanel", "--report-gap", "@/components/report-runner"]) {
      expect(rendered.markdown, `${invented} reached the file`).not.toContain(invented);
    }
    expect(rendered.markdown).toContain("Runs the report inside a UNKNOWN and closes the dialog.");

    const claims = rendered.flags.filter((f) => f.kind === "unconfirmed-claim");
    expect(claims).toHaveLength(3);
    expect(claims.every((f) => f.severity === "blocking")).toBe(true);
    expect(rendered.unconfirmed.map((u) => u.text).sort()).toEqual(["--report-gap", "@/components/report-runner", "ReportRunnerPanel"]);
    expect(rendered.unconfirmed.map((u) => u.field)).toEqual(expect.arrayContaining(["annotations[0].behavior", "interactionRules", "limitations[0]"]));

    const questions = rendered.questions.filter((q) => q.detail.includes("flags.json"));
    expect(questions).toHaveLength(3);
    expect(questions.every((q) => q.priority === "Blocking")).toBe(true);
    // The question points at the prototype, never at the name that could not be confirmed.
    expect(questions[0]!.question).toMatch(/src\/pages\/\w+\.tsx:\d+/);
    for (const q of questions) for (const invented of ["ReportRunnerPanel", "--report-gap", "@/components/report-runner"]) expect(q.question + q.detail).not.toContain(invented);

    expect(rendered.status).toBe("blocked");
  });

  it("keeps the names out of the file but keeps them in flags.json, with where each came from", () => {
    const rendered = render({ inputs, evidence, draft: INVENTING_DRAFT, now: NOW });
    const flags = flagsFile(rendered, evidence, inputs, NOW);
    expect(flags.counts.unconfirmedClaims).toBe(3);
    expect(flags.unconfirmedClaims[0]).toMatchObject({ field: expect.any(String), text: expect.any(String), flag: expect.stringMatching(/^F-\d+$/) });
    expect(JSON.stringify(flags)).toContain("ReportRunnerPanel");
    expect(flags.handoff).toEqual({ file: "acme_reports_acme-7_uicontext.md", status: "blocked" });
  });

  it("lets the web platform's own names through: an ARIA attribute is not a design-system claim", () => {
    const confirmed = confirmedNames(evidence);
    for (const text of ["The launcher exposes `aria-expanded`.", "The panel is named by `aria-labelledby`.", "Each row carries `data-state`.", "The container sets a `max-width`."]) {
      expect(lintClaims(text, confirmed).names, text).toEqual([]);
    }
    // A utility class the prototype never uses is still a claim, and still goes.
    expect(lintClaims("Spacing uses `gap-99`.", confirmed).names).toEqual(["gap-99"]);
  });

  it("lets through what Docent confirmed, prose, and framework utilities the design system doesn't own", () => {
    const confirmed = confirmedNames(evidence);
    for (const text of ["Button opens the Dialog.", "Spacing uses `gap-4`, a framework default.", "The colour comes from `--primary`.", "ReportCard is the prototype's own component.", "Written in TypeScript."]) {
      expect(lintClaims(text, confirmed).names, text).toEqual([]);
    }
    expect(lintClaims("Uses the MysteryWidget component.", confirmed).text).toBe("Uses the UNKNOWN component.");
  });

  it("pairs every blocking evidence flag with a question, so no UNKNOWN in the file stands alone", () => {
    const rendered = render({ inputs, evidence, draft: GOOD_DRAFT, now: NOW });
    for (const flag of evidence.flags.filter((f) => f.severity === "blocking")) {
      expect(rendered.questions.some((q) => q.detail.includes(flag.id)), `${flag.id} has no question`).toBe(true);
    }
  });
});
