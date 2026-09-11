/** Exposes the concierge as an MCP server with a single tool. Transport-agnostic. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AskInput, DocentResponse } from "../schema/response.js";
import type { CallerInfo, Concierge } from "./concierge.js";

export function createMcpServer(concierge: Concierge, options: { docentVersion: string; transport: CallerInfo["transport"] }): McpServer {
  const system = concierge.clientName;
  const server = new McpServer(
    { name: "docent", version: options.docentVersion },
    {
      instructions:
        `Docent answers questions about the ${system} design system from its validated contract. ` +
        "Ask before writing UI with it. Use only the components, props, variants and import paths Docent returns; " +
        "if Docent says something is not in the design system, do not build or approximate it.",
    },
  );

  server.registerTool(
    "ask",
    {
      title: `Ask the ${system} design system`,
      description:
        `Look up components in the ${system} design system: import path, exported parts, props (types, required, defaults), ` +
        "variants, required nesting, forbidden usage, agent rules, accessibility obligations and known gaps. " +
        "Every answer is validated against the design-system contract and logged. " +
        "Name components as they appear in code (Button, AlertDialog) or pass the component argument. " +
        'Ask "list all components" for the inventory. Status "not-found" means the component does not exist here and must not be invented; ' +
        '"clarification-needed" means ask again with component set to one of the options.',
      inputSchema: AskInput.shape,
      outputSchema: DocentResponse.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const client = server.server.getClientVersion();
      const response = await concierge.ask(args, {
        name: args.caller ?? client?.name ?? "unknown",
        client: client ? { name: client.name, version: client.version } : null,
        transport: options.transport,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
        isError: response.status === "error",
      };
    },
  );

  return server;
}
