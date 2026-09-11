import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/load.js";
import { buildContract } from "../../ingestion/ingest.js";
import { resolveSource } from "../../ingestion/source.js";
import type { ClientConfig } from "../../config/schema.js";
import { writeOutputs } from "../../ingestion/report.js";
import type { Contract } from "../../schema/contract.js";
import type { DocentResponse, FetchResponse, GetComponentInput } from "../../schema/response.js";
import { createDistributor } from "../../specialists/components/fetch.js";
import { EscalationPolicy } from "../../config/schema.js";
import { createComponentsSpecialist } from "../../specialists/components/index.js";
import type { Specialist } from "../../specialists/types.js";
import { Concierge, type AuditEntry, type CallerInfo } from "../concierge.js";
import { createMcpServer } from "../mcp.js";
import { JsonlAuditLog, loadContract, loadSources } from "../node.js";
import { validateFetch, validateResponse } from "../validate.js";

const caller: CallerInfo = { name: "test", client: null, transport: "test" };
const policy = EscalationPolicy.parse({});
let contract: Contract;
let sources: Record<string, string>;
let fixture: ClientConfig;

class MemoryLog {
  entries: AuditEntry[] = [];
  record(entry: AuditEntry) {
    this.entries.push(entry);
  }
}

function setup() {
  const audit = new MemoryLog();
  return { audit, concierge: new Concierge({ contract, audit, docentVersion: "test", sources }) };
}

beforeAll(async () => {
  const { config } = loadConfig(fileURLToPath(new URL("../../ingestion/test/fixtures/acme.yaml", import.meta.url)));
  fixture = config;
  ({ contract, sources } = await buildContract(config, resolveSource(config)));
});

describe("components specialist via the concierge", () => {
  it("answers with the contract for a named component", async () => {
    const { concierge } = setup();
    const r = await concierge.ask({ question: "What props and variants does Button take?" }, caller);
    expect(r.status).toBe("answered");
    expect(r.specialists).toEqual(["components"]);
    expect(r.routing.signals.map((x) => x.signal)).toContain("component-named");
    expect(r.validation.passed).toBe(true);
    expect(r.provenance.contractHash).toBe(contract.contentHash);

    const button = r.components[0]!;
    expect(r.components).toHaveLength(1);
    expect(button).toMatchObject({
      id: "button",
      inventoryId: "acme:button",
      allowed: true,
      intent: "Commit to the main action on a surface.",
      import: { path: "@/components/button", statement: 'import { Button, buttonVariants } from "@/components/button"' },
    });
    const props = Object.fromEntries(button.parts[0]!.props.map((p) => [p.name, p]));
    expect(props.tone).toMatchObject({ required: true, values: ["solid", "subtle"] });
    expect(props.intent).toMatchObject({ values: ["primary", "danger"], default: "primary", hint: "danger only for destructive actions." });
    expect(button.usage.forbiddenUsage).toEqual(["Two primary buttons in one region"]);
    expect(button.related).toEqual([{ id: "dialog", name: "Dialog", note: "Required companion for destructive actions" }]);
    expect(button.docentGaps.map((g) => g.kind)).toContain("spec-drift");
  });

  it("resolves the component argument, ids and multi-word names", async () => {
    const { concierge } = setup();
    expect((await concierge.ask({ question: "how do I use it?", component: "acme:dialog" }, caller)).components.map((c) => c.id)).toEqual(["dialog"]);
    expect((await concierge.ask({ question: "Dialog or IconButton?" }, caller)).components.map((c) => c.id)).toEqual(["dialog", "icon-button"]);
    expect((await concierge.ask({ question: "is an icon button accessible?" }, caller)).components.map((c) => c.id)).toEqual(["icon-button"]);
    expect((await concierge.ask({ question: "What goes inside DialogContent?" }, caller)).components.map((c) => c.id)).toEqual(["dialog"]);
  });

  it("refuses to invent components that are not in the design system", async () => {
    const { concierge, audit } = setup();
    const r = await concierge.ask({ question: "How do I configure the DatePicker?" }, caller);
    expect(r.status).toBe("not-found");
    expect(r.unresolved).toEqual(["DatePicker"]);
    expect(r.components).toEqual([]);
    expect(audit.entries[0]!.flags).toContain("requested-item-not-in-design-system");

    const mixed = await concierge.ask({ question: "Put a DatePicker inside a Dialog" }, caller);
    expect(mixed.status).toBe("answered");
    expect(mixed.components.map((c) => c.id)).toEqual(["dialog"]);
    expect(mixed.unresolved).toEqual(["DatePicker"]);
    expect(mixed.message).toContain('"DatePicker" is not in the Acme Fixture design system');

    const unknownArg = await concierge.ask({ question: "props?", component: "Carousel" }, caller);
    expect(unknownArg.status).toBe("not-found");
  });

  it("asks for clarification instead of guessing", async () => {
    const { concierge } = setup();
    const r = await concierge.ask({ question: "Help me with the thing on this page" }, caller);
    expect(r.status).toBe("clarification-needed");
    expect(r.routing.domains).toEqual([]);
    expect(r.clarification?.options.map((o) => o.kind)).toContain("domain");
    expect(r.components).toEqual([]);
  });

  it("lists the inventory with closed-world status", async () => {
    const { concierge } = setup();
    const r = await concierge.ask({ question: "list all components" }, caller);
    expect(r.inventory?.map((c) => [c.id, c.allowed])).toEqual([
      ["button", true],
      ["dialog", true],
      ["icon-button", false],
      ["stepper", false],
    ]);
    const blocked = await concierge.ask({ question: "Stepper props" }, caller);
    expect(blocked.components[0]?.allowed).toBe(false);
    expect(blocked.message).toContain("not in the component inventory");
  });
});

describe("validation", () => {
  async function answered(): Promise<DocentResponse> {
    return setup().concierge.ask({ question: "Button" }, caller);
  }
  const failedChecks = (r: DocentResponse) => validateResponse(r, contract, policy).checks.filter((c) => !c.passed).flatMap((c) => c.failures);

  it("passes an untouched answer", async () => {
    expect(validateResponse(await answered(), contract, policy).passed).toBe(true);
  });

  it("catches invented props, values, imports, rules and components", async () => {
    const cases: [string, (r: DocentResponse) => void, RegExp][] = [
      ["invented prop", (r) => r.components[0]!.parts[0]!.props.push({ name: "color", type: "string", required: false }), /has no prop color/],
      ["invented value", (r) => (r.components[0]!.parts[0]!.props.find((p) => p.name === "intent")!.values = ["primary", "danger", "ghost"]), /intent values do not match/],
      ["wrong import", (r) => (r.components[0]!.import = { path: "@acme/ui", statement: 'import { Button } from "@acme/ui"' }), /import path @acme\/ui/],
      ["phantom export", (r) => (r.components[0]!.import!.statement = 'import { Button, ButtonGroup } from "@/components/button"'), /names ButtonGroup/],
      ["invented rule", (r) => r.components[0]!.usage.agentRules.push("Always use three buttons"), /did not author/],
      ["invented related component", (r) => r.components[0]!.related.push({ id: "tooltip", name: "Tooltip", note: null }), /tooltip is not in the contract/],
      ["hidden inventory status", (r) => (r.components[0]!.allowed = null), /allowed is null/],
      ["false not-found", (r) => r.unresolved.push("Dialog"), /reported as not in the design system/],
      ["stale contract", (r) => (r.provenance.contractHash = "sha256:old"), /contractHash/],
    ];
    for (const [label, tamper, expected] of cases) {
      const r = await answered();
      tamper(r);
      expect(failedChecks(r).join("\n"), label).toMatch(expected);
    }
  });

  it("withholds an answer that fails validation and flags it", async () => {
    const audit = new MemoryLog();
    const real = createComponentsSpecialist(contract);
    const lying: Specialist = {
      domain: "components",
      handle: (request) => {
        const draft = real.handle(request);
        draft.components![0]!.parts[0]!.props.push({ name: "size", type: '"xl"', required: false, values: ["xl"] });
        return draft;
      },
    };
    const concierge = new Concierge({ contract, audit, docentVersion: "test", specialists: { components: lying } });
    const r = await concierge.ask({ question: "IconButton" }, caller);
    expect(r.status).toBe("error");
    expect(r.components).toEqual([]);
    expect(r.validation.passed).toBe(false);
    expect(audit.entries[0]).toMatchObject({ flagged: true, status: "error" });
    expect(audit.entries[0]!.flags).toContain("validation-failed");
  });
});

describe("audit log", () => {
  it("records who asked, what was asked, what was returned and whether it was flagged", async () => {
    const { concierge, audit } = setup();
    const r = await concierge.ask({ question: "Button", caller: "checkout-agent" }, { ...caller, name: "checkout-agent" });
    const entry = audit.entries[0]!;
    expect(entry).toMatchObject({
      event: "request",
      requestId: r.requestId,
      client: "acme-fixture",
      caller: { name: "checkout-agent" },
      input: { question: "Button", caller: "checkout-agent" },
      routing: { domains: ["components"] },
      status: "answered",
      componentIds: ["button"],
      contractHash: contract.contentHash,
    });
    expect(entry.response).toEqual(r);
    expect(entry.validation.passed).toBe(true);
  });

  it("logs invalid requests too", async () => {
    const { concierge, audit } = setup();
    const r = await concierge.ask({ question: "" }, caller);
    expect(r.status).toBe("error");
    expect(audit.entries[0]!.flags).toEqual(["invalid-input"]);
  });

  it("keeps each client's requests in that client's log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docent-"));
    const path = join(dir, "requests.jsonl");
    await new Concierge({ contract, audit: new JsonlAuditLog(path, "acme-fixture"), docentVersion: "test" }).ask({ question: "Button" }, caller);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);

    const wrongLog = new JsonlAuditLog(join(dir, "other.jsonl"), "another-client");
    const concierge = new Concierge({ contract, audit: wrongLog, docentVersion: "test" });
    await expect(concierge.ask({ question: "Button" }, caller)).rejects.toThrow(/Refusing to write a acme-fixture request/);
  });
});

describe("fetching source", () => {
  const disk = (path: string) => readFileSync(fileURLToPath(new URL(`../../ingestion/test/fixtures/acme-ds/${path}`, import.meta.url)), "utf8");

  it("delivers the foundation", async () => {
    const r = await setup().concierge.getFoundation({}, caller);
    expect(r).toMatchObject({ tool: "get_foundation", status: "delivered", pathAliases: [{ alias: "@/", target: "src/" }] });
    expect(r.validation.passed).toBe(true);
    expect(r.files.map((f) => [f.path, f.role])).toEqual([
      ["src/styles/tokens.css", "foundation"],
      ["tailwind.config.ts", "foundation"],
    ]);
    expect(r.files[0]!.content).toBe(disk("src/styles/tokens.css"));
    expect(r.packages).toEqual([{ name: "tailwindcss", version: "^3.4.0", dev: true }]);
    expect(r.instructions.join("\n")).toContain('npm install -D "tailwindcss@^3.4.0"');
  });

  it("delivers a component with its dependencies in install order", async () => {
    const { concierge, audit } = setup();
    const r = await concierge.getComponent({ components: ["Dialog"] }, caller);
    expect(r.status).toBe("delivered");
    expect(r.validation.passed).toBe(true);
    expect(r.components.map((c) => [c.id, c.reason])).toEqual([
      ["button", "dependency of Dialog"],
      ["dialog", "requested"],
    ]);
    expect(r.files.map((f) => f.path)).toEqual(["src/lib/utils.ts", "src/components/button.tsx", "src/components/dialog.tsx"]);
    for (const f of r.files) expect(f.content).toBe(disk(f.path));
    expect(r.packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      "@radix-ui/react-dialog@^1.1.0",
      "@radix-ui/react-slot@^1.2.0",
      "class-variance-authority@^0.7.1",
      "clsx@^2.0.0",
      "tailwind-merge@null",
    ]);
    expect(r.instructions[0]).toContain("get_foundation");

    const entry = audit.entries[0]!;
    expect(entry).toMatchObject({ tool: "get_component", componentIds: ["button", "dialog"], flagged: false });
    expect(entry.filesDelivered.map((f) => f.path)).toEqual(r.files.map((f) => f.path));
    expect(JSON.stringify(entry.response)).not.toContain("twMerge(clsx(inputs))");
  });

  it("skips what the project already has", async () => {
    const r = await setup().concierge.getComponent({ components: ["dialog"], installed: ["Button", "src/lib/utils.ts"] }, caller);
    expect(r.components.map((c) => c.id)).toEqual(["dialog"]);
    expect(r.files.map((f) => f.path)).toEqual(["src/components/dialog.tsx"]);
    const nothing = await setup().concierge.getComponent({ components: ["Button"], installed: ["acme:button"] }, caller);
    expect(nothing).toMatchObject({ status: "delivered", files: [], message: "Everything requested is already installed in this project." });
  });

  it("refuses unknown components and components outside the inventory", async () => {
    const { concierge, audit } = setup();
    const unknown = await concierge.getComponent({ components: ["DatePicker"] }, caller);
    expect(unknown).toMatchObject({ status: "not-found", unresolved: ["DatePicker"], files: [] });
    const blocked = await concierge.getComponent({ components: ["Stepper"] }, caller);
    expect(blocked).toMatchObject({ status: "rejected", files: [] });
    expect(blocked.rejected.map((r) => r.id)).toEqual(["stepper"]);
    const mixed = await concierge.getComponent({ components: ["Dialog", "DatePicker"] }, caller);
    expect(mixed.status).toBe("delivered");
    expect(mixed.unresolved).toEqual(["DatePicker"]);
    expect(audit.entries.map((e) => e.flags)).toEqual([
      ["requested-item-not-in-design-system"],
      ["component-outside-inventory"],
      ["requested-item-not-in-design-system"],
    ]);
  });

  it("validation catches altered content, out-of-scope files and wrong packages", async () => {
    const input: GetComponentInput = { components: ["Dialog"] };
    const fresh = () => setup().concierge.getComponent(input, caller);
    const failures = async (r: FetchResponse) =>
      (await validateFetch(r, contract, { tool: "get_component", input })).checks.filter((c) => !c.passed).flatMap((c) => c.failures).join("\n");

    const altered = await fresh();
    altered.files[1]!.content += "\nexport const backdoor = true";
    expect(await failures(altered)).toMatch(/button.tsx content does not match/);

    const extra = await fresh();
    extra.files.push({ path: "src/components/stepper.tsx", content: sources["src/components/stepper.tsx"]!, sha256: contract.sourceFiles.find((f) => f.path === "src/components/stepper.tsx")!.sha256, role: "component", component: "stepper" });
    expect(await failures(extra)).toMatch(/stepper.tsx was not part of this request/);

    const unknownFile = await fresh();
    unknownFile.files.push({ path: ".env", content: "SECRET=1", sha256: "x", role: "support", component: null });
    expect(await failures(unknownFile)).toMatch(/\.env is not a file recorded in the contract/);

    const missing = await fresh();
    missing.components = missing.components.filter((c) => c.id !== "button");
    expect(await failures(missing)).toMatch(/button is required but missing/);

    const pkg = await fresh();
    pkg.packages[0]!.version = "^9.9.9";
    expect(await failures(pkg)).toMatch(/version or kind differs/);
  });

  it("withholds a delivery that fails validation", async () => {
    const audit = new MemoryLog();
    const real = createDistributor(contract, sources);
    const tampering = {
      getFoundation: () => real.getFoundation(),
      getComponent: (input: GetComponentInput) => {
        const draft = real.getComponent(input);
        draft.files[0]!.content = "export const cn = () => 'owned'";
        return draft;
      },
    };
    const concierge = new Concierge({ contract, audit, docentVersion: "test", sources, distributor: tampering });
    const r = await concierge.getComponent({ components: ["Button"] }, caller);
    expect(r).toMatchObject({ status: "error", files: [], components: [] });
    expect(audit.entries[0]!.flags).toEqual(["validation-failed"]);
  });

  it("loads a snapshot only if it matches the contract hashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docent-out-"));
    const config: ClientConfig = { ...fixture, output: { dir } };
    writeOutputs(config, contract, sources);
    expect(loadContract(config).contentHash).toBe(contract.contentHash);
    expect(Object.keys(loadSources(config, contract))).toHaveLength(contract.sourceFiles.length);

    const snapshotPath = join(dir, "sources.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    snapshot.files["src/lib/utils.ts"] += "// changed";
    writeFileSync(snapshotPath, JSON.stringify(snapshot));
    expect(() => loadSources(config, contract)).toThrow(/src\/lib\/utils.ts is missing or does not match/);
  });
});

describe("MCP server", () => {
  it("exposes only ask and check_review when no source snapshot is loaded", async () => {
    const concierge = new Concierge({ contract, audit: new MemoryLog(), docentVersion: "test" });
    const server = createMcpServer(concierge, { docentVersion: "test", transport: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cursor", version: "9.9.9" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["ask", "check_review"]);
    await client.close();
  });

  it("exposes read-only ask, check_review, get_component and get_foundation tools", async () => {
    const { concierge, audit } = setup();
    const server = createMcpServer(concierge, { docentVersion: "test", transport: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cursor", version: "9.9.9" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["ask", "check_review", "get_component", "get_foundation"]);
    for (const tool of tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools[0]!.inputSchema.required).toEqual(["question"]);
    expect(tools[1]!.inputSchema.required).toEqual(["reviewId"]);
    expect(tools[2]!.inputSchema.required).toEqual(["components"]);

    const fetched = await client.callTool({ name: "get_component", arguments: { components: ["Dialog"] } });
    expect((fetched.structuredContent as FetchResponse).files.map((f) => f.path)).toEqual(["src/lib/utils.ts", "src/components/button.tsx", "src/components/dialog.tsx"]);
    audit.entries.length = 0;

    const result = await client.callTool({ name: "ask", arguments: { question: "What variants does Button have?" } });
    const response = result.structuredContent as DocentResponse;
    expect(result.isError).toBe(false);
    expect(response.status).toBe("answered");
    expect(response.validation.passed).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(response);
    expect(audit.entries[0]!.caller).toEqual({ name: "cursor", client: { name: "cursor", version: "9.9.9" }, transport: "test" });

    await client.close();
  });
});
