import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse as parseYaml } from "yaml";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CLIENTS_DIR, ConfigError, DOCENT_ROOT, loadConfig, resolveConfigPath } from "../config/load.js";
import { Concierge, type CallerInfo } from "../concierge/concierge.js";
import { createMcpServer } from "../concierge/mcp.js";
import { EvalBatch, runEval } from "../concierge/eval.js";
import { startHttpServer } from "../concierge/http.js";
import { checkIsolation } from "../concierge/isolation.js";
import { JsonlAuditLog, JsonlReviewStore, LiveConcierge, loadContract, loadSources, requestLogPath, reviewLogPath } from "../concierge/node.js";
import { DOCENT_VERSION, ingest } from "../ingestion/ingest.js";
import { consoleSummary, writeOutputs } from "../ingestion/report.js";
import { connectorAccess, SourceAccessBlocked } from "../ingestion/repo-connector.js";
import { resolveSource } from "../ingestion/source.js";
import { bundleClient } from "../onboarding/bundle.js";
import { detectRepo } from "../onboarding/detect.js";
import { renderConfig, renderEval, slugify, starterEval, titleCase, type ClientIdentity } from "../onboarding/render.js";

const HELP = `Docent — design-system concierge

Usage:
  docent init   --repo <git-url | path> [--id <id>] [--name <name>] [--ref <ref>] [--subdir <dir>] [--repo-connector <docent:org>] [--yes] [--force]
  docent onboard --client <id>
  docent ingest (--client <id> | --config <path>) [--ref <git-ref>] [--fail-on error|warning] [--quiet]
  docent serve  (--client <id> | --config <path>) [--http [--host 127.0.0.1] [--port 3333]]
  docent ask    (--client <id> | --config <path>) [--component <id>] "<question>"
  docent fetch  (--client <id> | --config <path>) [--json] (<component>... | --foundation)
  docent reviews (--client <id> | --config <path>) [--all]
  docent review  (--client <id> | --config <path>) <review-id> (--approve | --deny) --note "<why>" [--by <name>]
  docent eval   (--client <id> | --config <path>) [--file <batch.yaml>] [--verbose]
  docent check-config (--client <id> | --config <path>)
  docent isolation
  docent bundle (--client <id> | --config <path>) [--out <dir>] [--app <fly-app>] [--region <fly-region>]
  docent list-clients

Commands:
  init           Inspect a design-system repo and write a commented config/clients/<id>.yaml with TODOs
  onboard        Validate config, ingest, seed and run an eval batch, check isolation, print how to connect
  ingest         Read the client's design system and write contracts/<client>/contract.json and gaps.md
  serve          Run the MCP server for one client: stdio by default (register in Cursor, Claude Code, …),
                 or Streamable HTTP at /mcp with --http (bearer token from DOCENT_TOKEN)
  ask            Ask the concierge a question from the terminal; prints the validated response
  fetch          Preview what get_component / get_foundation would deliver
  reviews        List escalated requests waiting for a human decision
  review         Approve or deny an escalated request
  eval           Run a labelled batch of requests and report routing and outcome accuracy
  check-config   Validate a client config without ingesting
  isolation      Check that clients' contracts, snapshots, logs and reviews stay separate
  bundle         Build a deploy folder with Docent plus this client's config and contract only (default .deploy/<id>)
  list-clients   List configs in config/clients/

Options:
  --client       Client id; loads config/clients/<id>.yaml
  --config       Path to a config file
  --ref          Override source.ref for a git source (e.g. test a branch before merging)
  --fail-on      Exit non-zero when gaps of this severity or worse are found (for CI)
  --component    For ask: the component id or name, when known
  --code         For ask: path to a file of proposed code to check against governance rules
  --domain       For ask: force a specialist (components, tokens, patterns, governance)
  --repo         For init: git URL or local path of the design system
  --yes          For init: accept detected values without prompting
  --force        For init: overwrite an existing config
  --quiet        Only print the summary
  --repo-connector For init: fetch a private GitHub repo through repo-connector with this installation id (e.g. docent:acme)

Exit codes: 0 done, 1 error, 2 checks failed, 3 ingestion skipped because a repo-connector installation needs a person to act.
`;

function clientIds(): string[] {
  return readdirSync(CLIENTS_DIR)
    .filter((f) => /\.(ya?ml|json)$/.test(f) && !f.startsWith("_") && !f.includes(".eval."))
    .map((f) => f.replace(/\.(ya?ml|json)$/, ""));
}

/** Reads an eval batch, naming the case and field of anything invalid. */
function readEvalBatch(file: string): EvalBatch {
  const raw = parseYaml(readFileSync(file, "utf8")) as unknown;
  const parsed = EvalBatch.safeParse(raw);
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map((issue) => {
    const [index, ...path] = issue.path;
    const name = typeof index === "number" && Array.isArray(raw) ? (raw[index] as { name?: string } | undefined)?.name : undefined;
    const where = typeof index === "number" ? `case ${index + 1}${name ? ` "${name}"` : ""}` : "batch";
    return `  ${where}${path.length ? `, ${path.join(".")}` : ""}: ${issue.message}`;
  });
  throw new ConfigError(`Invalid eval batch ${file}:\n${lines.join("\n")}`);
}

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
      repo: { type: "string" },
      http: { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
      id: { type: "string" },
      name: { type: "string" },
      subdir: { type: "string" },
      yes: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      foundation: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      out: { type: "string" },
      app: { type: "string" },
      region: { type: "string" },
      "repo-connector": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];

  if (values.help || !command) {
    console.log(HELP);
    return command ? 0 : 1;
  }

  if (command === "list-clients") {
    const clients = clientIds();
    console.log(clients.length ? clients.join("\n") : "No client configs yet. Copy config/clients/_template.yaml to get started.");
    return 0;
  }

  if (command === "init") {
    if (!values.repo) throw new ConfigError("init needs --repo <git-url | path>");
    const isGit = /^(https?:|git@|ssh:)/.test(values.repo) || values.repo.endsWith(".git");
    let id = values.id ?? slugify(basename(values.repo));
    let name = values.name ?? titleCase(id);
    if (process.stdin.isTTY && !values.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      id = slugify((await rl.question(`Client id [${id}]: `)) || id);
      name = (await rl.question(`Client name [${name}]: `)) || name;
      rl.close();
    }
    const path = join(CLIENTS_DIR, `${id}.yaml`);
    if (existsSync(path) && !values.force) throw new ConfigError(`${path} already exists; pass --force to overwrite it`);
    const connectorId = values["repo-connector"];
    if (connectorId && !isGit) throw new ConfigError("--repo-connector needs a git URL such as https://github.com/<org>/<repo>.git");
    const source: ClientIdentity["source"] = isGit
      ? {
          type: "git",
          url: values.repo,
          ...(values.ref ? { ref: values.ref } : {}),
          ...(values.subdir ? { subdir: values.subdir } : {}),
          githubAccess: connectorId ? "repo-connector" : "public",
          ...(connectorId ? { repoConnectorClientId: connectorId } : {}),
        }
      : { type: "local", path: resolve(values.repo), ...(values.subdir ? { subdir: values.subdir } : {}) };
    const identity: ClientIdentity = { id, name, source };

    const started = Date.now();
    const probe = { client: { id, name }, source } as Parameters<typeof resolveSource>[0];
    const access = await connectorAccess(probe, { log: (m) => console.log(`  ${m}`) });
    const resolved = resolveSource(probe, (m) => console.log(`  ${m}`), access);
    const proposal = await detectRepo(resolved.root);
    writeFileSync(path, renderConfig(identity, proposal));
    loadConfig(path);

    console.log(`\n✔ Wrote ${path} in ${((Date.now() - started) / 1000).toFixed(1)}s\n\nDetected:`);
    proposal.evidence.forEach((e) => console.log(`  - ${e}`));
    if (proposal.todos.length) {
      console.log("\nTODO (also written at the top of the config):");
      proposal.todos.forEach((t) => console.log(`  - ${t}`));
    }
    console.log(`\nNext: review the config, then run  npm run docent -- onboard --client ${id}`);
    return 0;
  }

  if (command === "onboard") {
    const id = values.client;
    if (!id) throw new ConfigError("onboard needs --client <id>");
    const timings: [string, number][] = [];
    const step = async <T>(label: string, run: () => Promise<T> | T): Promise<T> => {
      const t = Date.now();
      console.log(`\n▸ ${label}`);
      const result = await run();
      timings.push([label, Date.now() - t]);
      return result;
    };

    const { config, path } = await step("Check config", () => loadConfig(resolveConfigPath({ client: id })));
    console.log(`  ✔ ${path}`);

    const { contract } = await step("Ingest", async () => {
      const built = await ingest(config, { log: (m) => console.log(`  ${m}`) });
      const outputs = writeOutputs(config, built.contract, built.sources);
      console.log(consoleSummary(built.contract, outputs).replace(/^/gm, "  "));
      return built;
    });
    const byKind = new Map<string, number>();
    for (const g of contract.gaps.filter((x) => x.severity !== "info")) byKind.set(`${g.severity} ${g.kind}`, (byKind.get(`${g.severity} ${g.kind}`) ?? 0) + 1);
    if (byKind.size) console.log(`  Gaps to triage: ${[...byKind].map(([k, n]) => `${n} ${k}`).join(", ")}`);

    const evalPassed = await step("Routing evaluation", async () => {
      const file = join(CLIENTS_DIR, `${id}.eval.yaml`);
      if (!existsSync(file)) {
        writeFileSync(file, renderEval(config.client, starterEval(contract, config)));
        console.log(`  Wrote a starter batch to ${file}; replace it with real requests.`);
      }
      const results = await runEval(contract, config.escalation, readEvalBatch(file), DOCENT_VERSION, config.specialists);
      for (const r of results.filter((x) => !x.passed)) console.log(`  ✖ ${r.case.name ?? r.case.ask}: ${r.failures.join("; ")}`);
      const passed = results.filter((x) => x.passed).length;
      console.log(`  ${passed}/${results.length} passed`);
      return passed === results.length;
    });

    const isolationPassed = await step("Isolation across all clients", async () => {
      const results = await checkIsolation(clientIds().map((c) => loadConfig(resolveConfigPath({ client: c }))), { docentVersion: DOCENT_VERSION });
      for (const r of results.filter((x) => !x.passed)) console.log(`  ✖ ${r.check}${r.client ? ` [${r.client}]` : ""}: ${r.detail}`);
      console.log(`  ${results.filter((x) => x.passed).length}/${results.length} checks passed`);
      return results.every((x) => x.passed);
    });

    const bin = join(DOCENT_ROOT, "bin", "docent.js");
    // Prefer a stable path (e.g. /opt/homebrew/bin/node) over a version-specific one that breaks on upgrade.
    const node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].find((p) => existsSync(p) && realpathSync(p) === realpathSync(process.execPath)) ?? process.execPath;
    console.log(`\n▸ Connect an agent (local)\n  Cursor ~/.cursor/mcp.json or Claude Code:\n  "docent-${id}": { "command": "${node}", "args": ["${bin}", "serve", "--client", "${id}"] }`);
    console.log(`  claude mcp add docent-${id} -- ${node} ${bin} serve --client ${id}`);
    console.log(`\n▸ Deploy for a team\n  DOCENT_TOKEN=<secret> node ${bin} serve --client ${id} --http --host 0.0.0.0 --port 8080   (see docs/ONBOARDING.md)`);

    const total = timings.reduce((sum, [, ms]) => sum + ms, 0);
    console.log(`\nTimings: ${timings.map(([l, ms]) => `${l} ${(ms / 1000).toFixed(1)}s`).join(" · ")} · total ${(total / 1000).toFixed(1)}s`);
    console.log(evalPassed && isolationPassed ? `✔ ${config.client.name} is onboarded.` : "✖ Onboarding is not complete; fix the failures above and rerun.");
    return evalPassed && isolationPassed ? 0 : 2;
  }

  if (command === "isolation") {
    const configs = clientIds().map((id) => loadConfig(resolveConfigPath({ client: id })));
    const results = await checkIsolation(configs, { docentVersion: DOCENT_VERSION });
    for (const r of results) console.log(`${r.passed ? "✔" : "✖"} ${r.check}${r.client ? ` [${r.client}]` : ""}: ${r.detail}`);
    const failed = results.filter((r) => !r.passed).length;
    console.log(`\n${results.length - failed}/${results.length} isolation checks passed`);
    return failed ? 2 : 0;
  }

  const { config, path } = loadConfig(resolveConfigPath(values));

  if (command === "bundle") {
    const id = config.client.id;
    loadSources(config, loadContract(config)); // refuse to bundle a contract that doesn't load
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: DOCENT_ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
    const out = resolve(values.out ?? join(DOCENT_ROOT, ".deploy", id));
    const result = bundleClient({ root: DOCENT_ROOT, clientId: id, allClientIds: clientIds(), trackedFiles: tracked, out, app: values.app, region: values.region });
    // The bundle is built from tracked files: anything uncommitted would be missing from the image.
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: DOCENT_ROOT, encoding: "utf8" })
      .split("\0")
      .filter((f) => f && !f.startsWith(".deploy/") && !/^(contracts|logs|config\/clients)\//.test(f));
    console.log(`✔ Bundled ${config.client.name} into ${out}: ${result.files.length} files, no other client's config, contract or logs.`);
    if (untracked.length) {
      console.log(`  ! ${untracked.length} file(s) are not committed and were left out: ${untracked.slice(0, 5).join(", ")}${untracked.length > 5 ? ", …" : ""}`);
      console.log("    Commit them first, or the deployed server will be missing them.");
    }
    console.log(`  fly.toml ${result.flyToml === "kept" ? "kept from the previous bundle" : "written from fly.toml.example"}.`);
    console.log(`\nDeploy from that folder (see docs/ONBOARDING.md step 8):\n  cd ${out}\n  fly deploy`);
    return 0;
  }

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
    const batch = readEvalBatch(file);
    const results = await runEval(loadContract(config), config.escalation, batch, DOCENT_VERSION, config.specialists);
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
      domains: config.specialists,
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

    // A server stays up across re-ingestion, so it reloads the contract when ingestion rewrites it.
    const live = new LiveConcierge(
      config,
      {
        audit: new JsonlAuditLog(requestLogPath(config.client.id), config.client.id),
        reviews: new JsonlReviewStore(reviewLogPath(config.client.id), config.client.id),
        policy: config.escalation,
        domains: config.specialists,
        docentVersion: DOCENT_VERSION,
      },
      (message) => console.error(`docent: ${message}`),
    );

    if (values.http) {
      const host = values.host ?? "127.0.0.1";
      const port = Number(values.port ?? process.env.PORT ?? 3333);
      await startHttpServer(live, {
        host,
        port,
        token: process.env.DOCENT_TOKEN,
        docentVersion: DOCENT_VERSION,
        health: () => ({ ...live.contractInfo, docentVersion: DOCENT_VERSION }),
      });
      console.error(`docent: serving ${contract.client.name} at http://${host}:${port}/mcp${process.env.DOCENT_TOKEN ? " (bearer token required)" : ""}`);
      return new Promise<number>(() => {});
    }

    // stdout belongs to the MCP protocol; everything human-readable goes to stderr.
    const server = createMcpServer(live, { docentVersion: DOCENT_VERSION, transport: "stdio" });
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
    if (err instanceof SourceAccessBlocked) {
      console.error(`⏸ ${err.message}`);
      process.exit(err.exitCode);
    }
    console.error(err instanceof ConfigError ? `✖ ${err.message}` : err instanceof Error ? `✖ ${err.message}` : err);
    process.exit(1);
  },
);
