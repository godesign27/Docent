/**
 * Phase 2 exit criterion: the status is decided by checks, not by the drafter. A suite of seeded
 * defective drafts is gated `blocked`, each for its own reason, and a clean draft is `ready`.
 *
 * The grader is scripted here, so what is being tested is the gate's own logic: which defects it
 * catches deterministically, and that a grader finding alone can block a file that passes every
 * mechanical check.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Draft } from "../src/draft.js";
import type { Evidence } from "../src/evidence.js";
import { applyGate, gate, GATE_PURPOSE, type GraderReport, runChecks } from "../src/gate.js";
import type { Inputs } from "../src/inputs.js";
import { ScriptedModel } from "../src/model.js";
import { flagsFile, render } from "../src/render.js";
import { fixture, GOOD_DRAFT, INVENTING_DRAFT, NOW } from "./support.js";

let evidence: Evidence;
let inputs: Inputs;

const CLEAN_GRADE: GraderReport = { findings: [], verdict: "ready" };
const BLOCKING_GRADE: GraderReport = {
  findings: [{ check: "coverage-honesty", severity: "blocking", section: "State coverage matrix", finding: "Loading is marked ○, but the prototype renders a spinner while the report runs.", suggestedQuestion: "Which loading states are designed?" }],
  verdict: "blocked",
};

/** Runs the whole pass the way the CLI does: render, then gate, then write the decision in. */
async function run(draft: Draft, grade: GraderReport = CLEAN_GRADE, used: Evidence = evidence) {
  const rendered = render({ inputs, evidence: used, draft, now: NOW });
  const model = new ScriptedModel({ [GATE_PURPOSE]: grade });
  const result = await gate({ model, inputs, evidence: used, rendered, markdown: rendered.markdown });
  return { rendered, result, model, markdown: applyGate(rendered.markdown, result) };
}

const failed = (result: Awaited<ReturnType<typeof run>>["result"]) => result.checks.filter((c) => !c.passed).map((c) => c.id);

beforeAll(async () => {
  ({ evidence, inputs } = await fixture());
});

describe("a clean draft", () => {
  it("is ready, with every check passed and the decision written into the file", async () => {
    const { result, markdown } = await run(GOOD_DRAFT);
    expect(failed(result)).toEqual([]);
    expect(result.status).toBe("ready");
    expect(result.reasons).toEqual([]);
    expect(markdown).toContain("  status: ready");
    expect(markdown).toContain("> **Gate: ready.**");
    // The summary sits above the content, not buried at the end.
    expect(markdown.indexOf("> **Gate:")).toBeLessThan(markdown.indexOf("## File naming"));
  });

  it("checks the things the template's own completeness list asks for", async () => {
    const { result } = await run(GOOD_DRAFT);
    expect(result.checks.map((c) => c.id)).toEqual([
      "naming",
      "confirmed-claims",
      "unknowns-have-questions",
      "coverage-complete",
      "coverage-explicit",
      "size-sections",
      "no-blocking-questions",
      "governance",
      "answered-questions",
      "evidence-clean",
    ]);
  });
});

describe("seeded defective drafts", () => {
  it("blocks a draft that omits a whole coverage group", async () => {
    const draft: Draft = { ...GOOD_DRAFT, coverage: GOOD_DRAFT.coverage.filter((c) => c.group !== "system") };
    const { result, markdown } = await run(draft);
    expect(result.status).toBe("blocked");
    expect(failed(result)).toContain("coverage-complete");
    expect(markdown).toContain("  status: blocked");
    expect(markdown).toMatch(/> - ✖ Every state coverage group has rows/);
  });

  it("blocks a draft whose ○ rows are dishonest, on the grader's finding alone", async () => {
    const { result, markdown } = await run(GOOD_DRAFT, BLOCKING_GRADE);
    // Every mechanical check still passes: only the second pass caught this.
    expect(failed(result)).toEqual([]);
    expect(result.status).toBe("blocked");
    expect(result.reasons[0]).toContain("renders a spinner");
    expect(markdown).toContain("> - ✖ State coverage matrix:");
  });

  it("blocks a draft that leaves an UNKNOWN with no open question", async () => {
    const draft: Draft = { ...GOOD_DRAFT, accessibility: "Focus return on close is UNKNOWN.", openQuestions: [] };
    const { result } = await run(draft);
    expect(result.status).toBe("blocked");
    expect(failed(result)).toContain("unknowns-have-questions");
  });

  it("blocks a draft with a Blocking question", async () => {
    const draft: Draft = { ...GOOD_DRAFT, openQuestions: [{ priority: "Blocking", question: "Who may run a report?", detail: "Roles are undecided.", resolutionPath: "Product" }] };
    const { result } = await run(draft);
    expect(result.status).toBe("blocked");
    expect(failed(result)).toContain("no-blocking-questions");
  });

  it("blocks a draft that named something Docent could not confirm", async () => {
    const { result } = await run(INVENTING_DRAFT);
    expect(result.status).toBe("blocked");
    expect(failed(result)).toContain("confirmed-claims");
    expect(result.checks.find((c) => c.id === "confirmed-claims")!.detail).toContain("3");
  });

  it("blocks a clean draft when Docent's rules reject the prototype", async () => {
    const rejected: Evidence = structuredClone(evidence);
    rejected.governance[0]!.outcome = "disallowed";
    const { result } = await run(GOOD_DRAFT, CLEAN_GRADE, rejected);
    expect(result.status).toBe("blocked");
    expect(failed(result)).toContain("governance");
  });

  it("blocks a clean draft when the evidence itself carries a blocking flag", async () => {
    const flagged: Evidence = structuredClone(evidence);
    flagged.flags.push({ id: "F-99", severity: "blocking", kind: "component-unconfirmed", message: "@/components/mystery is not a design-system component Docent can confirm.", locations: [{ file: "src/pages/Reports.tsx", line: 3 }], requestIds: ["r"] });
    const { result } = await run(GOOD_DRAFT, CLEAN_GRADE, flagged);
    expect(result.status).toBe("blocked");
    expect(failed(result)).toContain("evidence-clean");
  });
});

describe("the grader pass", () => {
  it("sees the inputs and the rendered file, and nothing of how the draft was made", async () => {
    const { model, rendered } = await run(GOOD_DRAFT);
    const [request] = model.requests;
    expect(request!.purpose).toBe(GATE_PURPOSE);
    expect(request!.prompt).toContain(rendered.markdown);
    expect(request!.prompt).toContain("ACME-7 · Reports page");
    expect(request!.prompt).toContain("export default function Reports");
    // Not the drafter's evidence digest, its schema, or its instructions.
    expect(request!.prompt).not.toContain("EVIDENCE — the design system");
    expect(request!.prompt).not.toContain("Never name a design-system component");
    expect(request!.system).toContain("You did not write it");
  });

  it("is asked to judge what code cannot, not to repeat the mechanical checks", async () => {
    const { model } = await run(GOOD_DRAFT);
    expect(model.requests[0]!.system).toContain("Do not repeat that work");
    expect(model.requests[0]!.system).toMatch(/Are the ○ rows honest/);
  });
});

describe("the report", () => {
  it("records the whole decision in flags.json, including the grader's advisory findings", async () => {
    const advisory: GraderReport = { findings: [{ check: "question-priority", severity: "advisory", section: "Open questions", finding: "Q-1 could be Blocking.", suggestedQuestion: "Is the role source known?" }], verdict: "ready" };
    const { rendered, result, markdown } = await run(GOOD_DRAFT, advisory);
    const report = flagsFile(rendered, evidence, inputs, NOW, result);
    expect(report.handoff.status).toBe("ready");
    expect(report.gate!.checks).toHaveLength(10);
    expect(report.gate!.grader!.findings[0]!.check).toBe("question-priority");
    expect(report.gate!.grader!.model).toBe("scripted");
    expect(markdown).toContain("> - ! 1 advisory finding(s) from the grader");
  });

  it("runs its deterministic checks without a model at all", () => {
    const rendered = render({ inputs, evidence, draft: GOOD_DRAFT, now: NOW });
    expect(runChecks({ inputs, evidence, rendered, markdown: rendered.markdown }).every((c) => c.passed)).toBe(true);
  });
});
