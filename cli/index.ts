import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CLIENTS_DIR, ConfigError, loadConfig, resolveConfigPath } from "../config/load.js";
import { Concierge, type CallerInfo } from "../concierge/concierge.js";
import { createMcpServer } from "../concierge/mcp.js";
import { EvalBatch, runEval } from "../concierge/eval.js";
import { JsonlAuditLog, JsonlReviewStore, loadContract, loadSources, requestLogPath, reviewLogPath } from "../concierge/node.js";
import { DOCENT_VERSION, ingest } from "../ingestion/ingest.js";
import { consoleSummary, writeOutputs } from "../ingestion/report.js";

const HELP = `Docent — design-system concierge

Usage:
  docent ingest (--client <id> | --config <path>) [--ref <git-ref>] [--fail-on error|warning] [--quiet]
  docent serve  (--client <id> | --config <path>)
  docent ask    (--client <id> | --config <path>) [--component <id>] "<question>"
  docent fetch  (--client <id> | --config <path>) [--json] (<component>... | --foundation)
  docent reviews (--client <id> | --config <path>) [--all]
  docent review  (--client <id> | --config <path>) <review-id> (--approve | --deny) --note "<why>" [--by <name>]
  docent eval   (--client <id> | --config <path>) [--file <batch.yaml>] [--verbose]
  docent check-config (--client <id> | --config <path>)
  docent list-clients

Commands:
  ingest         Read the client's design system and write contracts/<client>/contract.json and gaps.md
  serve          Run the MCP server for one client over stdio (register this command in Cursor, Claude Code, …)
  ask            Ask the concierge a question from the terminal; prints the validated response
  fetch          Preview what get_component / get_foundation would deliver
  reviews        List escalated requests waiting for a human decision
  review         Approve or deny an escalated request
  eval           Run a labelled batch of requests and report routing and outcome accuracy
  check-config   Validate a client config without ingesting
  list-clients   List configs in config/clients/

Options:
  --client       Client id; loads config/clients/<id>.yaml
  --config       Path to a config file
  --ref          Override source.ref for a git source (e.g. test a branch before merging)
  --fail-on      Exit non-zero when gaps of this severity or worse are found (for CI)
  --component    For ask: the component id or name, when known
  --code         For ask: path to a file of proposed code to check against governance rules
  --domain       For ask: force a specialist (components, tokens, patterns, governance)
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
      code: { type: "string" },
      domain: { type: "string" },
      file: { type: "string" },
      approve: { type: "boolean", default: false },
      deny: { type: "boolean", default: false },
      note: { type: "string" },
      by: { type: "string" },
      all: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      foundation: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
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
      .filter((f) => /\.(ya?ml|json)$/.test(f) && !f.startsWith("_") && !f.includes(".eval."))
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
    const { contract, sources } = await ingest(config, { log });
    const outputs = writeOutputs(config, contract, sources);
    console.log(consoleSummary(contract, outputs));

    const { error, warning } = contract.stats.gaps;
    if ((failOn === "error" && error > 0) || (failOn === "warning" && error + warning > 0)) return 2;
    return 0;
  }

  if (command === "reviews" || command === "review") {
    const store = new JsonlReviewStore(reviewLogPath(config.client.id), config.client.id);
    if (command === "reviews") {
      const reviews = store.list().filter((r) => values.all || r.status === "pending");
      if (reviews.length === 0) console.log(values.all ? "No reviews yet." : "No pending reviews.");
      for (const r of reviews) {
        console.log(`${r.id}  ${r.status.toUpperCase()}  ${r.createdAt}  from ${r.caller}`);
        console.log(`  question: ${r.request.question}`);
        if (r.request.code) console.log(`  code: ${r.request.code.split("\n").length} lines`);
        for (const f of r.findings) console.log(`  - ${f.ruleId ?? f.check ?? "exception"} (${f.severity}, ${f.basis}, ${f.action}): ${f.evidence}`);
        if (r.decision) console.log(`  decision by ${r.decision.by} at ${r.decision.at}: ${r.decision.note}`);
      }
      return 0;
    }
    const id = positionals[1];
    if (!id || values.approve === values.deny || !values.note) throw new ConfigError('review needs a review id, exactly one of --approve or --deny, and --note "<why>"');
    const decided = store.decide(id, { status: values.approve ? "approved" : "denied", by: values.by ?? process.env.USER ?? "reviewer", note: values.note });
    console.log(`✔ ${decided.id} ${decided.status} by ${decided.decision!.by}`);
    return 0;
  }

  if (command === "eval") {
    const file = values.file ?? join(CLIENTS_DIR, `${config.client.id}.eval.yaml`);
    if (!existsSync(file)) throw new ConfigError(`No eval batch at ${file}`);
    const batch = EvalBatch.parse(parseYaml(readFileSync(file, "utf8")));
    const results = await runEval(loadContract(config), config.escalation, batch, DOCENT_VERSION);
    for (const r of results) {
      const label = r.case.name ?? r.case.ask;
      console.log(`${r.passed ? "✔" : "✖"} ${label}`);
      console.log(`    → ${r.response.routing.domains.join(" + ") || "clarify"} · ${r.response.status}${r.response.governance ? ` · ${r.response.governance.outcome}` : ""}`);
      if (values.verbose || !r.passed) {
        for (const f of r.failures) console.log(`    ✖ ${f}`);
        console.log(`    signals: ${r.response.routing.signals.map((s) => `${s.domain}:${s.signal}`).join(", ") || "none"}`);
      }
    }
    const passed = results.filter((r) => r.passed).length;
    console.log(`\n${passed}/${results.length} passed`);
    return passed === results.length ? 0 : 2;
  }

  if (command === "serve" || command === "ask" || command === "fetch") {
    const contract = loadContract(config);
    const concierge = new Concierge({
      contract,
      audit: new JsonlAuditLog(requestLogPath(config.client.id), config.client.id),
      reviews: new JsonlReviewStore(reviewLogPath(config.client.id), config.client.id),
      policy: config.escalation,
      docentVersion: DOCENT_VERSION,
      sources: loadSources(config, contract),
    });

    if (command === "fetch") {
      const names = positionals.slice(1);
      if (!values.foundation && names.length === 0) throw new ConfigError("fetch needs component names, or --foundation");
      const caller: CallerInfo = { name: "cli", client: null, transport: "cli" };
      const response = values.foundation ? await concierge.getFoundation({}, caller) : await concierge.getComponent({ components: names }, caller);
      if (values.json) console.log(JSON.stringify(response, null, 2));
      else {
        console.log(`${response.status}: ${response.message}`);
        console.log(`validation: ${response.validation.passed ? "passed" : "FAILED"} (${response.validation.checks.map((c) => c.id).join(", ")})`);
        for (const c of response.components) console.log(`  component ${c.name} (${c.reason}) → ${c.importPath}`);
        for (const f of response.files) console.log(`  file      ${f.path} (${f.role}, ${f.content.length} chars)`);
        for (const p of response.packages) console.log(`  package   ${p.name}@${p.version ?? "?"}${p.dev ? " (dev)" : ""}`);
        response.instructions.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
      }
      return response.status === "error" ? 1 : 0;
    }

    if (command === "ask") {
      const question = positionals.slice(1).join(" ");
      if (!question) throw new ConfigError('ask needs a question, e.g. docent ask --client acme "What props does Button take?"');
      const response = await concierge.ask(
        {
          question,
          ...(values.component ? { component: values.component } : {}),
          ...(values.domain ? { domain: values.domain } : {}),
          ...(values.code ? { code: readFileSync(values.code, "utf8") } : {}),
        },
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
