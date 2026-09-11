import { readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CLIENTS_DIR, ConfigError, loadConfig, resolveConfigPath } from "../config/load.js";
import { Concierge } from "../concierge/concierge.js";
import { createMcpServer } from "../concierge/mcp.js";
import { JsonlAuditLog, loadContract, requestLogPath } from "../concierge/node.js";
import { DOCENT_VERSION, ingest } from "../ingestion/ingest.js";
import { consoleSummary, writeOutputs } from "../ingestion/report.js";

const HELP = `Docent — design-system concierge

Usage:
  docent ingest (--client <id> | --config <path>) [--ref <git-ref>] [--fail-on error|warning] [--quiet]
  docent serve  (--client <id> | --config <path>)
  docent ask    (--client <id> | --config <path>) [--component <id>] "<question>"
  docent check-config (--client <id> | --config <path>)
  docent list-clients

Commands:
  ingest         Read the client's design system and write contracts/<client>/contract.json and gaps.md
  serve          Run the MCP server for one client over stdio (register this command in Cursor, Claude Code, …)
  ask            Ask the concierge a question from the terminal; prints the validated response
  check-config   Validate a client config without ingesting
  list-clients   List configs in config/clients/

Options:
  --client       Client id; loads config/clients/<id>.yaml
  --config       Path to a config file
  --ref          Override source.ref for a git source (e.g. test a branch before merging)
  --fail-on      Exit non-zero when gaps of this severity or worse are found (for CI)
  --component    For ask: the component id or name, when known
  --quiet        Only print the summary
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      client: { type: "string" },
      config: { type: "string" },
      ref: { type: "string" },
      "fail-on": { type: "string" },
      component: { type: "string" },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];

  if (values.help || !command) {
    console.log(HELP);
    return command ? 0 : 1;
  }

  if (command === "list-clients") {
    const clients = readdirSync(CLIENTS_DIR)
      .filter((f) => /\.(ya?ml|json)$/.test(f) && !f.startsWith("_"))
      .map((f) => f.replace(/\.(ya?ml|json)$/, ""));
    console.log(clients.length ? clients.join("\n") : "No client configs yet. Copy config/clients/_template.yaml to get started.");
    return 0;
  }

  const { config, path } = loadConfig(resolveConfigPath(values));

  if (command === "check-config") {
    console.log(`✔ ${path} is valid (client "${config.client.id}")`);
    return 0;
  }

  if (command === "ingest") {
    if (values.ref) {
      if (config.source.type !== "git") throw new ConfigError("--ref only applies to git sources");
      config.source.ref = values.ref;
    }
    const failOn = values["fail-on"];
    if (failOn && failOn !== "error" && failOn !== "warning") throw new ConfigError("--fail-on must be error or warning");

    const log = values.quiet ? undefined : (m: string) => console.log(`  ${m}`);
    const contract = await ingest(config, { log });
    const outputs = writeOutputs(config, contract);
    console.log(consoleSummary(contract, outputs));

    const { error, warning } = contract.stats.gaps;
    if ((failOn === "error" && error > 0) || (failOn === "warning" && error + warning > 0)) return 2;
    return 0;
  }

  if (command === "serve" || command === "ask") {
    const contract = loadContract(config);
    const concierge = new Concierge({
      contract,
      audit: new JsonlAuditLog(requestLogPath(config.client.id), config.client.id),
      docentVersion: DOCENT_VERSION,
    });

    if (command === "ask") {
      const question = positionals.slice(1).join(" ");
      if (!question) throw new ConfigError('ask needs a question, e.g. docent ask --client acme "What props does Button take?"');
      const response = await concierge.ask(
        { question, ...(values.component ? { component: values.component } : {}) },
        { name: "cli", client: null, transport: "cli" },
      );
      console.log(JSON.stringify(response, null, 2));
      return response.status === "error" ? 1 : 0;
    }

    // stdout belongs to the MCP protocol; everything human-readable goes to stderr.
    const server = createMcpServer(concierge, { docentVersion: DOCENT_VERSION, transport: "stdio" });
    await server.connect(new StdioServerTransport());
    console.error(`docent: serving ${contract.client.name} (${contract.stats.components} components, contract ${contract.contentHash.slice(0, 19)}…) over stdio`);
    process.stdin.on("close", () => process.exit(0));
    return new Promise<number>(() => {});
  }

  console.error(`Unknown command "${command}"\n\n${HELP}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof ConfigError ? `✖ ${err.message}` : err instanceof Error ? `✖ ${err.message}` : err);
    process.exit(1);
  },
);
