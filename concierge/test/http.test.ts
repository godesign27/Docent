import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/load.js";
import { buildContract } from "../../ingestion/ingest.js";
import { resolveSource } from "../../ingestion/source.js";
import type { DocentResponse } from "../../schema/response.js";
import { Concierge, type AuditEntry } from "../concierge.js";
import { assertSafeBinding, startHttpServer } from "../http.js";
import type { Server } from "node:http";

const TOKEN = "test-token-abcdefghijklmnopqrstuvwxyz";
let server: Server;
let base: string;
const audit = { entries: [] as AuditEntry[], record(e: AuditEntry) { this.entries.push(e); } };

beforeAll(async () => {
  const { config } = loadConfig(fileURLToPath(new URL("../../ingestion/test/fixtures/acme.yaml", import.meta.url)));
  const { contract, sources } = await buildContract(config, resolveSource(config));
  const concierge = new Concierge({ contract, sources, audit, policy: config.escalation, docentVersion: "test" });
  server = await startHttpServer(concierge, { host: "127.0.0.1", port: 0, token: TOKEN, docentVersion: "test", health: { client: contract.client.id } });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("HTTP transport", () => {
  it("reports health without a token", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(await res.json()).toEqual({ status: "ok", client: "acme-fixture" });
  });

  it("rejects MCP requests without the right token", async () => {
    for (const auth of [undefined, "Bearer wrong", `Bearer ${TOKEN}x`]) {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: "{}" });
      expect(res.status).toBe(401);
    }
  });

  it("serves the MCP tools to an authorized client and logs it as http", async () => {
    const client = new Client({ name: "remote-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-docent-caller": "checkout-agent" } } }));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["ask", "check_review", "get_component", "get_foundation"]);
    const result = await client.callTool({ name: "ask", arguments: { question: "What variants does Button have?" } });
    expect((result.structuredContent as DocentResponse).components.map((c) => c.id)).toEqual(["button"]);
    expect(audit.entries.at(-1)!.caller).toMatchObject({ name: "checkout-agent", transport: "http" });
    await client.close();
  });

  it("refuses to listen beyond this machine without a strong token", () => {
    expect(() => assertSafeBinding("0.0.0.0", undefined)).toThrow(/without a token/);
    expect(() => assertSafeBinding("127.0.0.1", "short")).toThrow(/at least 24/);
    expect(() => assertSafeBinding("127.0.0.1", undefined)).not.toThrow();
    expect(() => assertSafeBinding("0.0.0.0", TOKEN)).not.toThrow();
  });
});
