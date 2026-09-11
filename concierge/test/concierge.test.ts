import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/load.js";
import { buildContract } from "../../ingestion/ingest.js";
import { resolveSource } from "../../ingestion/source.js";
import type { Contract } from "../../schema/contract.js";
import type { DocentResponse } from "../../schema/response.js";
import { createComponentsSpecialist } from "../../specialists/components/index.js";
import { Concierge, type AuditEntry, type CallerInfo } from "../concierge.js";
import { createMcpServer } from "../mcp.js";
import { JsonlAuditLog } from "../node.js";
import { validateResponse } from "../validate.js";

const caller: CallerInfo = { name: "test", client: null, transport: "test" };
let contract: Contract;

class MemoryLog {
  entries: AuditEntry[] = [];
  record(entry: AuditEntry) {
    this.entries.push(entry);
  }
}

function setup() {
  const audit = new MemoryLog();
  return { audit, concierge: new Concierge({ contract, audit, docentVersion: "test" }) };
}

beforeAll(async () => {
  const { config } = loadConfig(fileURLToPath(new URL("../../ingestion/test/fixtures/acme.yaml", import.meta.url)));
  contract = await buildContract(config, resolveSource(config));
});

describe("components specialist via the concierge", () => {
  it("answers with the contract for a named component", async () => {
    const { concierge } = setup();
    const r = await concierge.ask({ question: "What props and variants does Button take?" }, caller);
    expect(r.status).toBe("answered");
    expect(r.specialist).toBe("components");
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
    expect(audit.entries[0]!.flags).toContain("requested-component-not-in-design-system");

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
    const r = await concierge.ask({ question: "which component should commit the main action on a surface" }, caller);
    expect(r.status).toBe("clarification-needed");
    expect(r.clarification?.options.map((o) => o.id)).toContain("button");
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
  const failedChecks = (r: DocentResponse) => validateResponse(r, contract).checks.filter((c) => !c.passed).flatMap((c) => c.failures);

  it("passes an untouched answer", async () => {
    expect(validateResponse(await answered(), contract).passed).toBe(true);
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
    const lying = {
      name: "components" as const,
      handle: (input: Parameters<typeof real.handle>[0]) => {
        const draft = real.handle(input);
        draft.components[0]!.parts[0]!.props.push({ name: "size", type: '"xl"', required: false, values: ["xl"] });
        return draft;
      },
    };
    const concierge = new Concierge({ contract, audit, docentVersion: "test", specialist: lying });
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
      routing: { specialist: "components" },
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

describe("MCP server", () => {
  it("exposes one read-only ask tool that returns validated structured answers", async () => {
    const { concierge, audit } = setup();
    const server = createMcpServer(concierge, { docentVersion: "test", transport: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cursor", version: "9.9.9" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["ask"]);
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools[0]!.inputSchema.required).toEqual(["question"]);

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
