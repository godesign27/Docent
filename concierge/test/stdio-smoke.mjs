// Manual smoke test: spawns `docent serve` exactly as an MCP client would and asks one question.
// Usage: node concierge/test/stdio-smoke.mjs <client-id> "<question>"
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [clientId = "agentic-ui-shadcn", question = "list all components"] = process.argv.slice(2);
const bin = fileURLToPath(new URL("../../bin/docent.js", import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [bin, "serve", "--client", clientId], stderr: "inherit" });
const client = new Client({ name: "stdio-smoke", version: "0.0.0" });

const started = Date.now();
await client.connect(transport);
const { tools } = await client.listTools();
const result = await client.callTool({ name: "ask", arguments: { question } });
const r = result.structuredContent;
console.log(JSON.stringify({ tools: tools.map((t) => t.name), status: r.status, validated: r.validation.passed, components: r.components.map((c) => c.id), unresolved: r.unresolved, ms: Date.now() - started }));
await client.close();
