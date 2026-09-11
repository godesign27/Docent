/**
 * The agent's only way to learn anything about a design system: Docent over MCP.
 * Anything short of a well-formed answer is an error, so a run can never proceed on a claim Docent didn't make.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

export type DocentConnection =
  | { kind: "stdio"; command: string; args: string[]; cwd?: string }
  | { kind: "http"; url: string; token?: string };

export class DocentUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocentUnavailable";
  }
}

// Only the parts of Docent's response this agent relies on; everything else passes through untouched.
const Prop = z.object({ name: z.string(), type: z.string(), required: z.boolean(), values: z.array(z.string()).optional(), default: z.string().optional() });
const Part = z.object({ name: z.string(), primary: z.boolean(), props: z.array(Prop), variants: z.array(z.object({ name: z.string(), values: z.array(z.string()) })) });
export const DocentComponent = z.object({
  id: z.string(),
  name: z.string(),
  allowed: z.boolean().nullable(),
  intent: z.string().nullable(),
  import: z.object({ path: z.string(), statement: z.string() }).nullable(),
  parts: z.array(Part),
  helpers: z.array(z.string()),
  typeExports: z.array(z.string()),
});
export const DocentToken = z.object({
  id: z.string(),
  name: z.string(),
  cssVariable: z.string().nullable(),
  type: z.string(),
  category: z.string(),
  meaning: z.string().nullable(),
  values: z.record(z.string(), z.string()),
  utilities: z.array(z.string()),
});
const Finding = z.object({
  ruleId: z.string().nullable(),
  rule: z.string().nullable(),
  severity: z.string(),
  basis: z.string(),
  check: z.string().nullable(),
  action: z.enum(["reject", "escalate", "warn"]),
  evidence: z.string(),
  line: z.number().optional(),
});
export const DocentAnswer = z.object({
  requestId: z.string(),
  status: z.enum(["answered", "clarification-needed", "not-found", "rejected", "escalated", "error"]),
  message: z.string(),
  components: z.array(DocentComponent),
  unresolved: z.array(z.string()),
  clarification: z.object({ question: z.string(), options: z.array(z.object({ kind: z.string(), id: z.string(), name: z.string() })) }).nullable(),
  alternatives: z.array(z.object({ id: z.string(), name: z.string() })),
  tokens: z.array(DocentToken),
  utilityClasses: z
    .array(z.object({ class: z.string(), token: z.string().nullable(), kind: z.enum(["token", "palette", "arbitrary-color", "unknown-variable", "unbound"]) }))
    .default([]),
  patterns: z.array(z.object({ id: z.string(), name: z.string() })),
  governance: z
    .object({ outcome: z.enum(["no-conflict", "warn", "needs-review", "disallowed"]), findings: z.array(Finding), notEvaluated: z.array(z.string()) })
    .nullable(),
  review: z.object({ id: z.string(), status: z.string() }).nullable(),
  validation: z.object({ passed: z.boolean() }),
  provenance: z.object({ client: z.object({ id: z.string(), name: z.string() }), contractHash: z.string(), sourceCommit: z.string().nullable() }),
});
export type DocentAnswer = z.infer<typeof DocentAnswer>;
export type DocentComponent = z.infer<typeof DocentComponent>;
export type DocentToken = z.infer<typeof DocentToken>;

export interface AskInput {
  question: string;
  component?: string;
  domain?: "components" | "tokens" | "patterns" | "governance";
  code?: string;
  /** Report what the rules decide without opening a review. */
  audit?: boolean;
}

export class DocentClient {
  private constructor(private readonly client: Client) {}

  static async connect(connection: DocentConnection): Promise<DocentClient> {
    const transport: Transport =
      connection.kind === "stdio"
        ? new StdioClientTransport({ command: connection.command, args: connection.args, cwd: connection.cwd, stderr: "ignore" })
        : new StreamableHTTPClientTransport(new URL(connection.url), {
            requestInit: { headers: { "X-Docent-Caller": "uicontext-agent", ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}) } },
          });
    return DocentClient.overTransport(transport);
  }

  /** Connects over any MCP transport and checks this really is a Docent that can answer. */
  static async overTransport(transport: Transport): Promise<DocentClient> {
    const client = new Client({ name: "uicontext-agent", version: "0.1.0" });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools.map((t) => t.name);
      if (!tools.includes("ask")) throw new DocentUnavailable(`The MCP server has no "ask" tool (tools: ${tools.join(", ") || "none"}); it is not a Docent instance.`);
    } catch (err) {
      await client.close().catch(() => {});
      if (err instanceof DocentUnavailable) throw err;
      throw new DocentUnavailable(`Could not reach Docent: ${(err as Error).message}`);
    }
    return new DocentClient(client);
  }

  async ask(input: AskInput): Promise<DocentAnswer> {
    let result;
    try {
      result = await this.client.callTool({ name: "ask", arguments: { ...input, caller: "uicontext-agent" } });
    } catch (err) {
      throw new DocentUnavailable(`Docent did not answer "${input.question.slice(0, 80)}": ${(err as Error).message}`);
    }
    const parsed = DocentAnswer.safeParse(result.structuredContent);
    if (!parsed.success) throw new DocentUnavailable(`Docent's answer to "${input.question.slice(0, 80)}" was not a valid response: ${parsed.error.issues[0]?.message}`);
    if (parsed.data.status === "error" || !parsed.data.validation.passed) {
      throw new DocentUnavailable(`Docent could not give a validated answer to "${input.question.slice(0, 80)}": ${parsed.data.message}`);
    }
    return parsed.data;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
