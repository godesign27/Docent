/** Exposes the concierge as an MCP server. Transport-agnostic. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AskInput, CheckReviewInput, DocentResponse, FetchResponse, GetComponentInput, GetFoundationInput, ReviewResponse } from "../schema/response.js";
import type { CallerInfo, Concierge } from "./concierge.js";

export function createMcpServer(
  concierge: Concierge,
  options: { docentVersion: string; transport: CallerInfo["transport"]; /** e.g. from an HTTP header, when the MCP handshake isn't visible */ callerHint?: string },
): McpServer {
  const system = concierge.clientName;
  const server = new McpServer(
    { name: "docent", version: options.docentVersion },
    {
      instructions:
        `Docent is the front door to the ${system} design system. Every result is validated against the design-system contract and logged.\n` +
        (concierge.canDistribute
          ? "Workflow for a project that does not contain the design system yet:\n" +
            "1. Call get_foundation once and apply it (theme tokens, Tailwind/PostCSS config, path alias).\n" +
            "2. Before using a component, call ask for its props, variants and usage rules.\n" +
            "3. Call get_component to fetch its source and dependencies, write the files exactly as delivered, and install the listed packages.\n"
          : "Before using a component, call ask for its props, variants and usage rules.\n") +
        "Use only components Docent returns. If Docent says something is not in the design system, do not build, install or approximate it.\n" +
        'Before shipping UI, call ask with the code to check it against the rules. Status "rejected" means do not proceed; "escalated" means a human must decide first: call check_review with the review id and wait for approval.',
    },
  );

  const callerFor = (caller: string | undefined): CallerInfo => {
    const client = server.server.getClientVersion();
    return {
      name: caller ?? client?.name ?? options.callerHint ?? "unknown",
      client: client ? { name: client.name, version: client.version } : null,
      transport: options.transport,
    };
  };
  const result = (response: DocentResponse | FetchResponse | ReviewResponse) => ({
    content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
    structuredContent: response,
    isError: response.status === "error",
  });

  server.registerTool(
    "ask",
    {
      title: `Ask the ${system} design system`,
      description:
        `Single entry point to the ${system} design system. Docent routes the question to the right specialist(s): ` +
        [
          concierge.domains.includes("components") && "components (props, variants, imports, structure)",
          concierge.domains.includes("tokens") && "tokens (colors, spacing, typography, theme values and which token to use)",
          concierge.domains.includes("patterns") && "patterns (which component to use and how to compose a flow)",
          concierge.domains.includes("governance") && "governance (whether something is allowed; pass code to check it before shipping)",
        ]
          .filter(Boolean)
          .join(", ") +
        ". " +
        "Every answer is validated against the design-system contract and logged. " +
        'Statuses: "answered"; "clarification-needed" (ask again naming one of the options); "not-found" (it does not exist here, do not invent it); ' +
        '"rejected" (the rules disallow it, do not proceed); "escalated" (a human must decide first, poll check_review).',
      inputSchema: AskInput.shape,
      outputSchema: DocentResponse.shape,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => result(await concierge.ask(args, callerFor(args.caller))),
  );

  server.registerTool(
    "check_review",
    {
      title: "Check an escalated request's review",
      description: "Look up the human decision on a request Docent escalated. Returns pending, approved or denied, with the reviewer's note.",
      inputSchema: CheckReviewInput.shape,
      outputSchema: ReviewResponse.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => result(await concierge.checkReview(args, callerFor(args.caller))),
  );

  if (concierge.canDistribute) {
    server.registerTool(
      "get_component",
      {
        title: `Fetch component source from ${system}`,
        description:
          `Fetch the source code of ${system} components so a project can use them without a copy of the design-system repo. ` +
          "Returns every file to write (the components, the components they depend on, and shared files such as lib/utils), " +
          "the npm packages to install with versions, the path alias the source expects, and step-by-step instructions. " +
          "Files are byte-identical to the design system at the contract's commit. Pass installed to skip components already in the project. " +
          "Names in unresolved do not exist, so do not build them; a name in ambiguous is exported by several components, so request one of its candidates by import path. " +
          "Call get_foundation first in a new project.",
        inputSchema: GetComponentInput.shape,
        outputSchema: FetchResponse.shape,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => result(await concierge.getComponent(args, callerFor(args.caller))),
    );

    server.registerTool(
      "get_foundation",
      {
        title: `Fetch the ${system} project setup`,
        description:
          `Fetch what a project needs once before using any ${system} component: the theme token CSS, Tailwind and PostCSS config, ` +
          "required packages and the import alias. Without it components render unstyled.",
        inputSchema: GetFoundationInput.shape,
        outputSchema: FetchResponse.shape,
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => result(await concierge.getFoundation(args, callerFor(args.caller))),
    );
  }

  return server;
}
