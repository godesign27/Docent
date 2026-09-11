/**
 * Serves one client's Docent over MCP Streamable HTTP, so a team can share a
 * deployed instance instead of each developer running it locally. Stateless:
 * every request gets a fresh MCP server bound to the same concierge.
 *
 * A bearer token is required whenever the server is reachable beyond this
 * machine, and whenever DOCENT_TOKEN is set.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ConciergeService } from "./concierge.js";
import { createMcpServer } from "./mcp.js";

export interface HttpOptions {
  host: string;
  port: number;
  token: string | undefined;
  docentVersion: string;
  /** Contract identity reported by /healthz; a function when the contract can change while serving. */
  health: Record<string, unknown> | (() => Record<string, unknown>);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY = 1_000_000;

export function assertSafeBinding(host: string, token: string | undefined): void {
  if (!LOOPBACK.has(host) && !token) {
    throw new Error(`Refusing to serve on ${host} without a token. Set DOCENT_TOKEN, or bind to 127.0.0.1.`);
  }
  if (token !== undefined && token.length < 24) throw new Error("DOCENT_TOKEN must be at least 24 characters.");
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

export function startHttpServer(concierge: ConciergeService, options: HttpOptions): Promise<Server> {
  assertSafeBinding(options.host, options.token);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://docent");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };

    if (url.pathname === "/healthz" && req.method === "GET") return send(200, { status: "ok", ...(typeof options.health === "function" ? options.health() : options.health) });
    if (url.pathname !== "/mcp") return send(404, { error: "Not found. MCP is served at /mcp." });
    if (!authorized(req, options.token)) {
      res.setHeader("www-authenticate", 'Bearer realm="docent"');
      return send(401, { error: "Missing or invalid bearer token" });
    }
    if (req.method !== "POST") return send(405, { error: "This server is stateless; use POST /mcp." });

    try {
      const body = await readBody(req);
      const hint = [req.headers["x-docent-caller"], req.headers["user-agent"]].map((h) => (Array.isArray(h) ? h[0] : h)).find(Boolean);
      const mcp = createMcpServer(concierge, { docentVersion: options.docentVersion, transport: "http", ...(hint ? { callerHint: hint.slice(0, 200) } : {}) });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) send(400, { error: (err as Error).message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}
