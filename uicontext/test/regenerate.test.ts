/**
 * Phase 3 exit criterion: re-running never silently overwrites a person's work.
 *
 * The round trip is draft → a person edits → the prototype changes → regenerate. What the person
 * wrote must come back byte for byte, what the design system provides must be re-derived and the
 * difference flagged, and an unchanged prototype must produce no changes at all.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Evidence } from "../src/evidence.js";
import type { Inputs } from "../src/inputs.js";
import { parsePrior } from "../src/prior.js";
import { render } from "../src/render.js";
import { fixture, GOOD_DRAFT, NOW } from "./support.js";

const ANSWER = "Leads and admins only — agreed with Product on 2026-09-18.";
const LIMITATION_NOTE = `<!-- human -->
Reviewed on the prototype build of 18 September. The sample data hides how slow a real report run is;
engineering should assume a spinner is needed even though the design does not show one.`;
const REVIEW_NOTES = `<!-- human -->
Tech lead: happy with the dialog contract. Still want a decision on roles before we schedule this.`;

let evidence: Evidence;
let inputs: Inputs;
let first: string;
/** The file after a person has worked on it: answers, their own sections, sign-offs. */
let edited: string;

beforeAll(async () => {
  ({ evidence, inputs } = await fixture());
  first = render({ inputs, evidence, draft: GOOD_DRAFT, now: NOW }).markdown;

  const questionRow = first.split("\n").find((l) => l.includes("Which roles may run a report?"))!;
  const limitations = first.slice(first.indexOf("## Known prototype limitations"));
  const limitationBody = limitations.slice(limitations.indexOf("\n") + 1, limitations.indexOf("\n---")).trim();

  edited = first
    .replace(questionRow, questionRow.replace(/\|\s*\|$/, `| ${ANSWER} |`))
    .replace(limitationBody, LIMITATION_NOTE)
    .replace('  approved_design_version: "UNKNOWN"', '  approved_design_version: "prototype-2026-09-18"')
    .replace("    product: UNKNOWN", "    product: Dana Okoro")
    .replace("    ux: UNKNOWN", "    ux: Sam Reyes")
    .replace("| Reviewer / owner | UNKNOWN |", "| Reviewer / owner | Dana Okoro |")
    .replace("\n# Addendum", `\n## Review notes\n\n${REVIEW_NOTES}\n\n---\n\n# Addendum`);
});

/** The prototype moved on: a component is gone and a token's value changed. */
function movedOn(): Evidence {
  const next: Evidence = structuredClone(evidence);
  next.components = next.components.filter((c) => c.docent?.name !== "Button");
  next.tokens[0]!.token!.values = { ...next.tokens[0]!.token!.values, default: "#123456" };
  return next;
}

describe("a regeneration against a changed prototype", () => {
  it("keeps every answer, section and sign-off a person wrote, byte for byte", () => {
    const prior = parsePrior("prior.md", edited);
    const again = render({ inputs, evidence: movedOn(), draft: GOOD_DRAFT, now: NOW, prior });

    expect(again.markdown).toContain(ANSWER);
    expect(again.carriedResolutions).toBe(1);
    expect(again.markdown).toContain(LIMITATION_NOTE);
    expect(again.markdown).toContain(REVIEW_NOTES);
    expect(again.markdown).toContain('approved_design_version: "prototype-2026-09-18"');
    expect(again.markdown).toContain("product: Dana Okoro");
    expect(again.markdown).toContain("ux: Sam Reyes");
    expect(again.markdown).toContain("| Reviewer / owner | Dana Okoro |");
  });

  it("re-derives the design-system tables and flags what moved", () => {
    const prior = parsePrior("prior.md", edited);
    const again = render({ inputs, evidence: movedOn(), draft: GOOD_DRAFT, now: NOW, prior });

    expect(again.changes.find((c) => c.section === "Component inventory" && c.kind === "removed")!.key).toBe("Button");
    expect(again.changes.some((c) => c.section === "Design tokens" && c.kind === "changed" && c.detail.includes("#123456"))).toBe(true);
    expect(again.markdown).toContain("## Changes since last draft");
    expect(again.markdown).toMatch(/\| Component inventory \| removed \| Button \|/);
    // The section says what was preserved, so a reviewer knows what was not regenerated.
    expect(again.markdown).toContain("Carried forward untouched:");
    expect(again.markdown).toContain("**Known prototype limitations**");
  });

  it("does not report a change merely because evidence ids renumbered", () => {
    const prior = parsePrior("prior.md", edited);
    const again = render({ inputs, evidence: movedOn(), draft: GOOD_DRAFT, now: NOW, prior });
    // Dropping Button renumbers Dialog from C-2 to C-1; its row is otherwise identical.
    expect(again.changes.filter((c) => c.key === "Dialog")).toEqual([]);
  });

  it("flags a question the person had answered that this draft raises again", () => {
    const prior = parsePrior("prior.md", edited);
    const again = render({ inputs, evidence: movedOn(), draft: GOOD_DRAFT, now: NOW, prior });
    expect(again.reopened).toEqual(["Which roles may run a report?"]);
    expect(again.markdown).toContain("Answered questions this draft raises again");
  });
});

describe("a regeneration against an unchanged prototype", () => {
  it("reports nothing when only Docent's request ids differ, because every run gets new ones", () => {
    const prior = parsePrior("prior.md", edited);
    const reasked: Evidence = structuredClone(evidence);
    let n = 0;
    const id = () => `${(n++).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
    for (const c of reasked.components) c.requestIds = c.requestIds.map(id);
    for (const token of reasked.tokens) token.requestId = id();
    const again = render({ inputs, evidence: reasked, draft: GOOD_DRAFT, now: NOW, prior });
    expect(again.changes).toEqual([]);
  });

  it("reports no changes at all", () => {
    const prior = parsePrior("prior.md", edited);
    const again = render({ inputs, evidence, draft: GOOD_DRAFT, now: NOW, prior });
    expect(again.changes).toEqual([]);
    expect(again.markdown).toContain("_Nothing the design system provides has changed since the last draft._");
  });

  it("still carries the person's work, so a no-op run is safe to make a habit of", () => {
    const prior = parsePrior("prior.md", edited);
    const again = render({ inputs, evidence, draft: GOOD_DRAFT, now: NOW, prior });
    expect(again.markdown).toContain(ANSWER);
    expect(again.markdown).toContain(LIMITATION_NOTE);
    expect(again.markdown).toContain(REVIEW_NOTES);

    // And a second regeneration from its own output is stable.
    const twice = render({ inputs, evidence, draft: GOOD_DRAFT, now: NOW, prior: parsePrior("prior.md", again.markdown) });
    expect(twice.changes).toEqual([]);
    expect(twice.markdown).toBe(again.markdown);
  });
});

describe("reading a prior file", () => {
  it("finds the answers, the human sections and the sign-offs, and nothing else", () => {
    const prior = parsePrior("prior.md", edited);
    expect([...prior.questions.values()].find((q) => q.resolution)!.resolution).toBe(ANSWER);
    expect([...prior.humanSections.keys()].sort()).toEqual(["Known prototype limitations", "Review notes"]);
    expect(prior.approvals).toMatchObject({ designVersion: "prototype-2026-09-18", product: "Dana Okoro", ux: "Sam Reyes", reviewer: "Dana Okoro" });
  });

  it("treats a file nobody has touched as having nothing to carry", () => {
    const prior = parsePrior("prior.md", first);
    expect(prior.humanSections.size).toBe(0);
    expect([...prior.questions.values()].every((q) => !q.resolution)).toBe(true);
    expect(render({ inputs, evidence, draft: GOOD_DRAFT, now: NOW, prior }).carriedResolutions).toBe(0);
  });
});
