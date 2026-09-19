/**
 * One fixture both phases' tests build on: a small prototype checked against a real Docent, plus the
 * drafts a well-behaved and a badly-behaved model would return for it.
 *
 * Tests may import Docent to stand up a fixture server; the agent's own code may not.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Concierge, MemoryReviewStore } from "../../concierge/concierge.js";
import { createMcpServer } from "../../concierge/mcp.js";
import { loadConfig } from "../../config/load.js";
import { buildContract } from "../../ingestion/ingest.js";
import { resolveSource } from "../../ingestion/source.js";
import { DocentClient } from "../src/docent.js";
import type { Draft } from "../src/draft.js";
import { type Evidence, gatherEvidence } from "../src/evidence.js";
import { handoffName, loadDocument, loadPrototype, type Inputs } from "../src/inputs.js";

const here = dirname(fileURLToPath(import.meta.url));
export const DOCENT = join(here, "../..");
export const NOW = new Date("2026-09-16T09:00:00Z");

export const PROTOTYPE: Record<string, string> = {
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

export const STORY = `---
key: ACME-7
epic: ACME-1 Reporting
summary: Reports page with a run dialog
---

# ACME-7 · Reports page

## Acceptance criteria

**AC-1** A lead can open the reports page and run a report.
`;

export const INTENT_UX = `# Intent / UX — Reports

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
export const GOOD_DRAFT: Draft = {
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
  accessibility: "Keyboard access to the run control is designed; focus return on close is not.",
  dataApi: "The prototype uses fixed sample data; no endpoint is called.",
  authPermissions: "Every user sees the same page in the prototype.",
  acceptanceCriteria: ["A lead can run a report from the dialog (AC-1)."],
  limitations: ["Sample data only."],
  missingContext: [{ item: "Report data source", inPrototype: "No", productionNeed: "An endpoint for report runs", owner: "Engineering" }],
  openQuestions: [{ priority: "Advisory", question: "Which roles may run a report?", detail: "Not settled in the story.", resolutionPath: "Product" }],
};

/** The same draft from a model that invented a component, a token and an import path. */
export const INVENTING_DRAFT: Draft = {
  ...GOOD_DRAFT,
  annotations: [{ ...GOOD_DRAFT.annotations[0]!, behavior: "Runs the report inside a ReportRunnerPanel and closes the dialog.", evidence: ["C-1"] }],
  interactionRules: "Spacing follows `--report-gap` throughout the dialog.",
  limitations: ["The panel is imported from `@/components/report-runner`, which the prototype stubs."],
};

export function writeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "uicontext-fixture-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

export async function fixtureDocent(): Promise<DocentClient> {
  const { config } = loadConfig(join(DOCENT, "ingestion/test/fixtures/acme.yaml"));
  const { contract } = await buildContract(config, resolveSource(config));
  const concierge = new Concierge({ contract, audit: { record() {} }, reviews: new MemoryReviewStore(), docentVersion: "test", policy: config.escalation });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(concierge, { docentVersion: "test", transport: "stdio" }).connect(serverSide);
  return DocentClient.overTransport(clientSide);
}

/** Evidence for the fixture prototype, and the inputs a draft of it is written from. */
export async function fixture(): Promise<{ evidence: Evidence; inputs: Inputs; root: string; handoffDir: string }> {
  const docent = await fixtureDocent();
  const root = writeTree(PROTOTYPE);
  const evidence = await gatherEvidence({ root, entries: ["src/pages/Reports.tsx"], docent, now: () => NOW });
  await docent.close();

  const handoffDir = writeTree({ "jira/ACME-7.md": STORY, "acme_reports_acme-7_intent-ux.md": INTENT_UX });
  const inputs: Inputs = {
    story: loadDocument(join(handoffDir, "jira/ACME-7.md")),
    intentUx: loadDocument(join(handoffDir, "acme_reports_acme-7_intent-ux.md")),
    name: handoffName(join(handoffDir, "acme_reports_acme-7_intent-ux.md")),
    prototype: loadPrototype(root, evidence.prototype.scanned),
  };
  return { evidence, inputs, root, handoffDir };
}
