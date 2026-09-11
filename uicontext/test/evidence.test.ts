/**
 * Phase 0 exit criterion, on fixtures: every design-system import, token and utility a prototype uses
 * is confirmed with a Docent request id or flagged with a reason, every file is audited, and a missing
 * or broken Docent stops the run.
 *
 * Tests may import Docent to stand up a fixture server; the agent's own code may not (see the last test).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeAll, describe, expect, it } from "vitest";
import { Concierge, MemoryReviewStore } from "../../concierge/concierge.js";
import { createMcpServer } from "../../concierge/mcp.js";
import { loadConfig } from "../../config/load.js";
import { buildContract } from "../../ingestion/ingest.js";
import { resolveSource } from "../../ingestion/source.js";
import type { Contract } from "../../schema/contract.js";
import { DocentClient, DocentUnavailable } from "../src/docent.js";
import { type Evidence, gatherEvidence } from "../src/evidence.js";

const here = dirname(fileURLToPath(import.meta.url));
const DOCENT = join(here, "../..");

const PROTOTYPE: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
  "src/pages/Reports.tsx": `import { Button } from "@/components/button"
import { Dialog, DialogContent, DialogFooter } from "@/components/dialog"
import { IconButton } from "@/components/icon-button"
import { Button as PrimaryButton } from "@/ui/primary-button"
import { LegacyButton } from "@/legacy/button"
import { Mystery } from "@/components/mystery"
import { ReportCard } from "./ReportCard"
import "./reports.css"

export default function Reports() {
  return (
    <Dialog>
      <DialogContent>
        <Button intent="primary" className="bg-primary text-[--overlay] gap-4 border-[--missing]" style={{ color: "var(--nope)" }}>Run</Button>
        <PrimaryButton intent="danger" />
        <LegacyButton />
        <IconButton />
        <Mystery />
        <ReportCard title="Q1" />
      </DialogContent>
    </Dialog>
  )
}
`,
  "src/pages/ReportCard.tsx": `import { Button } from "@/components/button"

export function ReportCard({ title }: { title: string }) {
  return (
    <section className="bg-slate-100 rounded-lg">
      {title}
      <Button intent="danger" />
    </section>
  )
}
`,
  "src/pages/reports.css": `.reports { --local: 1px; color: var(--primary); background: var(--undefined-token); margin: var(--local); }\n`,
};

let contract: Contract;
let reviews: MemoryReviewStore;
let evidence: Evidence;

function writeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "uicontext-prototype-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

async function fixtureDocent(c: Contract, store = new MemoryReviewStore()): Promise<DocentClient> {
  const concierge = new Concierge({ contract: c, audit: { record() {} }, reviews: store, docentVersion: "test", policy: loadConfig(join(DOCENT, "ingestion/test/fixtures/acme.yaml")).config.escalation });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(concierge, { docentVersion: "test", transport: "stdio" }).connect(serverSide);
  return DocentClient.overTransport(clientSide);
}

beforeAll(async () => {
  const { config } = loadConfig(join(DOCENT, "ingestion/test/fixtures/acme.yaml"));
  contract = (await buildContract(config, resolveSource(config))).contract;
  // A second, inventoried component named Button, so the name alone is ambiguous.
  const button = contract.components.find((c) => c.id === "button")!;
  contract.components.push({ ...structuredClone(button), id: "legacy-button", importPath: "@/legacy/button-v1", files: ["src/legacy/button-v1.tsx"] });
  for (const part of contract.components.at(-1)!.parts) if (part.name === "Button") part.name = "LegacyButton";
  contract.components.at(-1)!.name = "LegacyButton";
  contract.components.push({ ...structuredClone(button), id: "legacy-button-2", name: "LegacyButton", importPath: "@/legacy/button-v2", files: ["src/legacy/button-v2.tsx"] });
  contract.components.at(-1)!.parts[0]!.name = "LegacyButton";

  reviews = new MemoryReviewStore();
  const docent = await fixtureDocent(contract, reviews);
  evidence = await gatherEvidence({ root: writeTree(PROTOTYPE), entries: ["src/pages/Reports.tsx"], docent, now: () => new Date("2026-09-11T12:00:00Z") });
  await docent.close();
});

const component = (module: string) => evidence.components.find((c) => c.module === module)!;
const flagsOf = (kind: string) => evidence.flags.filter((f) => f.kind === kind);

describe("walking the prototype", () => {
  it("scans the prototype's own files and stylesheets, and stops at design-system components", () => {
    expect(evidence.prototype.scanned).toEqual(["src/pages/ReportCard.tsx", "src/pages/Reports.tsx"]);
    expect(evidence.prototype.stylesheets).toEqual(["src/pages/reports.css"]);
    expect(evidence.localModules).toEqual([{ file: "src/pages/ReportCard.tsx", exports: ["ReportCard"], importedBy: [{ file: "src/pages/Reports.tsx", line: 7 }] }]);
    expect(evidence.docent.contractHash).toBe(contract.contentHash);
  });
});

describe("components", () => {
  it("confirms design-system imports by import path, with usage and the Docent request behind it", () => {
    const button = component("@/components/button");
    expect(button).toMatchObject({ status: "confirmed", docent: { id: "button", name: "Button", importPath: "@/components/button", allowed: true } });
    expect(button.usage.map((u) => `${u.at.file}:${u.at.line} ${u.props.map((p) => `${p.name}=${p.value}`).join(" ")}`)).toEqual([
      "src/pages/Reports.tsx:14 intent=primary className=bg-primary text-[--overlay] gap-4 border-[--missing] style=null",
      "src/pages/ReportCard.tsx:7 intent=danger",
    ]);
    expect(button.requestIds).toHaveLength(1);
    expect(button.docent!.parts[0]!.props.find((p) => p.name === "intent")!.values).toEqual(["primary", "danger"]);
  });

  it("flags an export the component doesn't have", () => {
    expect(component("@/components/dialog").status).toBe("confirmed");
    expect(flagsOf("export-not-in-contract").map((f) => [f.message, f.locations])).toEqual([["@/components/dialog is Dialog in the design system, which does not export DialogFooter.", [{ file: "src/pages/Reports.tsx", line: 2 }]]]);
  });

  it("flags components outside the inventory, unknown ones and shared names as blocking", () => {
    expect(component("@/components/icon-button").status).toBe("not-in-inventory");
    expect(component("@/components/mystery")).toMatchObject({ status: "unconfirmed", docent: null });
    expect(component("@/components/mystery").requestIds.length).toBeGreaterThan(0);
    expect(component("@/legacy/button")).toMatchObject({ status: "ambiguous", candidates: [{ id: "legacy-button" }, { id: "legacy-button-2" }] });
    for (const kind of ["component-not-in-inventory", "component-unconfirmed", "component-ambiguous"]) {
      expect(flagsOf(kind)).toHaveLength(1);
      expect(flagsOf(kind)[0]!.severity).toBe("blocking");
    }
  });

  it("confirms a component imported under another path by its name, as an advisory near-match", () => {
    expect(component("@/ui/primary-button")).toMatchObject({ status: "near-match", docent: { id: "button" } });
    expect(component("@/ui/primary-button").usage.map((u) => u.part)).toEqual(["Button"]);
    expect(flagsOf("component-near-match")).toMatchObject([{ severity: "advisory" }]);
  });
});

describe("tokens and utilities", () => {
  it("confirms CSS variables the prototype uses, ignoring ones it declares itself", () => {
    expect(evidence.tokens.map((t) => [t.variable, t.status, t.token?.id ?? null])).toEqual([
      ["--nope", "unconfirmed", null],
      ["--primary", "confirmed", "primary"],
      ["--undefined-token", "unconfirmed", null],
    ]);
    expect(flagsOf("token-unconfirmed").map((f) => f.locations[0])).toEqual([
      { file: "src/pages/Reports.tsx", line: 14 },
      { file: "src/pages/reports.css", line: 1 },
    ]);
  });

  it("classifies every utility class through Docent", () => {
    expect(evidence.utilities.map((u) => [u.class, u.kind, u.token])).toEqual([
      ["bg-primary", "token", "primary"],
      ["bg-slate-100", "palette", null],
      ["border-[--missing]", "unknown-variable", null],
      ["gap-4", "unbound", null],
      ["rounded-lg", "token", "radius"],
      ["text-[--overlay]", "token", "overlay"],
    ]);
    expect(flagsOf("utility-unknown-variable")).toMatchObject([{ severity: "blocking" }]);
    expect(flagsOf("utility-raw-color")).toMatchObject([{ severity: "advisory", locations: [{ file: "src/pages/ReportCard.tsx", line: 5 }] }]);
  });
});

describe("governance", () => {
  it("audits every prototype file without opening reviews", async () => {
    expect(evidence.governance.map((g) => [g.file, g.outcome])).toEqual([
      ["src/pages/ReportCard.tsx", "needs-review"],
      ["src/pages/Reports.tsx", "disallowed"],
    ]);
    expect(flagsOf("governance-escalated")[0]!.message).toContain("NO_RAW_COLORS");
    expect(flagsOf("governance-rejected")[0]!.message).toContain("INDEXED_ONLY");
    expect(await reviews.list()).toEqual([]);
  });

  it("gives every confirmation and flag a Docent request id", () => {
    const ids = [...evidence.components.flatMap((c) => c.requestIds), ...evidence.tokens.map((t) => t.requestId), ...evidence.utilities.map((u) => u.requestId), ...evidence.governance.map((g) => g.requestId)];
    expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
    expect(evidence.flags.every((f) => f.requestIds.length > 0)).toBe(true);
  });
});

describe("failing loud", () => {
  it("refuses an MCP server that isn't Docent", async () => {
    const other = new McpServer({ name: "not-docent", version: "1" });
    other.registerTool("hello", { description: "hi" }, async () => ({ content: [{ type: "text", text: "hi" }] }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await other.connect(serverSide);
    await expect(DocentClient.overTransport(clientSide)).rejects.toThrow(DocentUnavailable);
  });

  it("stops the run when Docent stops answering", async () => {
    const docent = await fixtureDocent(contract);
    await docent.close();
    await expect(gatherEvidence({ root: writeTree(PROTOTYPE), entries: ["src/pages/Reports.tsx"], docent })).rejects.toThrow(DocentUnavailable);
  });

  it("exits 2 and writes nothing when Docent can't be started", () => {
    const out = join(mkdtempSync(join(tmpdir(), "uicontext-out-")), "evidence.json");
    const run = spawnSync(process.execPath, [join(DOCENT, "node_modules/tsx/dist/cli.mjs"), join(DOCENT, "uicontext/src/cli.ts"), "evidence", "--prototype", writeTree(PROTOTYPE), "--entry", "src/pages/Reports.tsx", "--docent-client", "no-such-client", "--out", out], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Docent is unavailable");
    expect(existsSync(out)).toBe(false);
  });
});

describe("boundary", () => {
  it("the agent reaches Docent only over MCP: its source imports nothing from Docent", () => {
    const src = join(DOCENT, "uicontext/src");
    for (const file of readdirSync(src).filter((f) => f.endsWith(".ts"))) {
      for (const [, spec] of readFileSync(join(src, file), "utf8").matchAll(/from\s+"([^"]+)"/g)) {
        if (!spec!.startsWith(".")) continue;
        expect(posix.normalize(posix.join("uicontext/src", spec!)).startsWith("uicontext/src/"), `${file} imports ${spec}`).toBe(true);
      }
    }
  });
});
