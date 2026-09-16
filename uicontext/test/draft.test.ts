/**
 * Phase 1 exit criterion: a draft fills every section of the template, and no name Docent hasn't
 * confirmed can reach the file — a scripted model that writes an invented component, token and
 * import path produces a file with none of them, a flag for each, and a Blocking question for each.
 *
 * The model here is scripted, so these tests are deterministic and cost nothing.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { Concierge, MemoryReviewStore } from "../../concierge/concierge.js";
import { createMcpServer } from "../../concierge/mcp.js";
import { loadConfig } from "../../config/load.js";
import { buildContract } from "../../ingestion/ingest.js";
import { resolveSource } from "../../ingestion/source.js";
import { DocentClient } from "../src/docent.js";
import { type Draft, DRAFT_PURPOSE, draftUiContext, evidenceDigest } from "../src/draft.js";
import { type Evidence, gatherEvidence } from "../src/evidence.js";
import { handoffName, loadDocument, loadPrototype, type Inputs } from "../src/inputs.js";
import { ModelUnavailable, ScriptedModel } from "../src/model.js";
import { flagsFile, lintClaims, render, confirmedNames } from "../src/render.js";

const here = dirname(fileURLToPath(import.meta.url));
const DOCENT = join(here, "../..");
const NOW = new Date("2026-09-16T09:00:00Z");

const PROTOTYPE: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
  "src/pages/Reports.tsx": `import { Button } from "@/components/button"
import { Dialog, DialogContent } from "@/components/dialog"
import { ReportCard } from "./ReportCard"

export default function Reports() {
  return (
    <Dialog>
      <DialogContent>
        <Button intent="primary" className="bg-primary gap-4">Run</Button>
        <ReportCard title="Q1" />
      </DialogContent>
    </Dialog>
  )
}
`,
  "src/pages/ReportCard.tsx": `export function ReportCard({ title }: { title: string }) {
  return <section className="rounded-lg" style={{ color: "var(--primary)" }}>{title}</section>
}
`,
};

const STORY = `---
key: ACME-7
epic: ACME-1 Reporting
summary: Reports page with a run dialog
---

# ACME-7 · Reports page

## Acceptance criteria

**AC-1** A lead can open the reports page and run a report.
`;

const INTENT_UX = `# Intent / UX — Reports

\`\`\`yaml
handoff:
  version: 1.0
  status: blocked
\`\`\`

## Metadata

| Field | Value |
|---|---|
| Feature size | M |
| Work type | \`new\` |
| This repo | https://example.invalid/acme |

## Problem statement

Leads cannot run a report without leaving the workspace.
`;

/** What a well-behaved drafter returns: judgment only, design-system items cited by evidence id. */
const GOOD_DRAFT: Draft = {
  summary: "The prototype is a reports page with a dialog for running a report.",
  scope: { inScope: ["Running a report from the reports page (AC-1)"], outOfScope: ["Scheduling reports"] },
  annotations: [
    { page: "Reports", target: "Run control in the dialog", type: "click", behavior: "Runs the report and closes the dialog.", states: "Default, hover, focus", notes: "Confirmed component C-1.", evidence: ["C-1"] },
  ],
  coverage: [
    { group: "visual", state: "Default", designed: true, notes: "Designed in the prototype.", evidence: ["C-1"] },
    { group: "visual", state: "Error", designed: false, notes: "Not designed; the prototype has no error state.", evidence: [] },
    { group: "data-stress", state: "Long report titles", designed: false, notes: "Not designed.", evidence: [] },
    { group: "permissions", state: "Viewer", designed: false, notes: "Not designed.", evidence: [] },
    { group: "system", state: "API timeout", designed: false, notes: "Not designed.", evidence: [] },
  ],
  interactionRules: "The dialog traps focus while open and returns focus to the control that opened it.",
  responsive: "Not verified below 768 px in the prototype.",
  accessibility: "Keyboard access to the run control; focus return on close is UNKNOWN.",
  dataApi: "The prototype uses fixed sample data; no endpoint is called.",
  authPermissions: "Every user sees the same page in the prototype.",
  acceptanceCriteria: ["A lead can run a report from the dialog (AC-1)."],
  limitations: ["Sample data only."],
  missingContext: [{ item: "Report data source", inPrototype: "No", productionNeed: "An endpoint for report runs", owner: "Engineering" }],
  openQuestions: [{ priority: "Advisory", question: "Which roles may run a report?", detail: "Not settled in the story.", resolutionPath: "Product" }],
};

/** The same draft from a model that invented a component, a token and an import path. */
const INVENTING_DRAFT: Draft = {
  ...GOOD_DRAFT,
  annotations: [
    { ...GOOD_DRAFT.annotations[0]!, behavior: "Runs the report inside a ReportRunnerPanel and closes the dialog.", evidence: ["C-1"] },
  ],
  interactionRules: "Spacing follows `--report-gap` throughout the dialog.",
  limitations: ["The panel is imported from `@/components/report-runner`, which the prototype stubs."],
};

let evidence: Evidence;
let inputs: Inputs;

function writeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "uicontext-draft-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

beforeAll(async () => {
  const { config } = loadConfig(join(DOCENT, "ingestion/test/fixtures/acme.yaml"));
  const { contract } = await buildContract(config, resolveSource(config));
  const concierge = new Concierge({ contract, audit: { record() {} }, reviews: new MemoryReviewStore(), docentVersion: "test", policy: config.escalation });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(concierge, { docentVersion: "test", transport: "stdio" }).connect(serverSide);
  const docent = await DocentClient.overTransport(clientSide);

  const root = writeTree(PROTOTYPE);
  evidence = await gatherEvidence({ root, entries: ["src/pages/Reports.tsx"], docent, now: () => NOW });
  await docent.close();

  const handoff = writeTree({ "jira/ACME-7.md": STORY, "acme_reports_acme-7_intent-ux.md": INTENT_UX });
  inputs = {
    story: loadDocument(join(handoff, "jira/ACME-7.md")),
    intentUx: loadDocument(join(handoff, "acme_reports_acme-7_intent-ux.md")),
    name: handoffName(join(handoff, "acme_reports_acme-7_intent-ux.md")),
    prototype: loadPrototype(root, evidence.prototype.scanned),
  };
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
    expect(file).toMatch(/\| Button \| Yes \(req [0-9a-f]{8}\) \|/);
    expect(file).toMatch(/\| `--primary` \| Yes \(req [0-9a-f]{8}\) \|/);
    expect(file).toContain("| Button | `intent` |");
    expect(file).toContain("`gap-4`");
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
