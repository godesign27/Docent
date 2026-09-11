/**
 * uicontext — drafts UIContext.md from a prototype, confirming every design-system claim through Docent.
 *
 * Phase 0 command:
 *   npm run uicontext -- evidence --prototype <dir> --entry <file> [--entry <file>…]
 *                                 (--docent-client <id> | --docent-url <url>) [--out evidence.json]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type DocentConnection, DocentClient, DocentUnavailable } from "./docent.js";
import { type Evidence, gatherEvidence } from "./evidence.js";

const DOCENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const HELP = `uicontext — draft UIContext.md from a prototype, confirmed against Docent

  evidence  --prototype <dir> --entry <file> [--entry <file>…] [--out <file>]
            Docent over stdio:  --docent-client <client-id> [--docent-root <path to Docent>]
            Docent over HTTP:   --docent-url <https://…/mcp>   (token from DOCENT_TOKEN)

Exit codes: 0 evidence written (flags may still block), 2 Docent unavailable (nothing written), 1 other error.`;

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      prototype: { type: "string" },
      entry: { type: "string", multiple: true },
      out: { type: "string" },
      "docent-client": { type: "string" },
      "docent-root": { type: "string" },
      "docent-url": { type: "string" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (!command || values.help) {
    console.log(HELP);
    return command ? 0 : 1;
  }
  if (command !== "evidence") {
    console.error(`Unknown command "${command}"\n\n${HELP}`);
    return 1;
  }
  if (!values.prototype || !values.entry?.length) throw new Error("evidence needs --prototype and at least one --entry.");

  const connection: DocentConnection | null = values["docent-url"]
    ? { kind: "http", url: values["docent-url"], token: process.env.DOCENT_TOKEN }
    : values["docent-client"]
      ? { kind: "stdio", command: process.execPath, args: [resolve(values["docent-root"] ?? DOCENT_ROOT, "bin/docent.js"), "serve", "--client", values["docent-client"]] }
      : null;
  if (!connection) throw new Error("Say which Docent to use: --docent-client <id> or --docent-url <url>.");

  const started = Date.now();
  let docent: DocentClient;
  try {
    docent = await DocentClient.connect(connection);
  } catch (err) {
    console.error(`✖ Docent is unavailable, so nothing can be confirmed and nothing was written.\n  ${(err as Error).message}`);
    return 2;
  }

  let evidence: Evidence;
  try {
    evidence = await gatherEvidence({ root: resolve(values.prototype), entries: values.entry, docent });
  } catch (err) {
    if (err instanceof DocentUnavailable) {
      console.error(`✖ Docent stopped answering, so the evidence is incomplete and nothing was written.\n  ${err.message}`);
      return 2;
    }
    throw err;
  } finally {
    await docent.close();
  }

  const out = resolve(values.out ?? "evidence.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  printSummary(evidence, out, Date.now() - started);
  return 0;
}

function printSummary(e: Evidence, out: string, ms: number) {
  const count = <T extends string>(items: { [k: string]: unknown }[], key: string) =>
    Object.entries(items.reduce<Record<string, number>>((acc, i) => ((acc[i[key] as T] = (acc[i[key] as T] ?? 0) + 1), acc), {}))
      .map(([k, n]) => `${n} ${k}`)
      .join(", ") || "none";
  console.log(`Evidence for ${e.prototype.entries.join(", ")} against ${e.docent.client.name} (contract ${e.docent.contractHash.slice(0, 19)}…)`);
  console.log(`  Files scanned:  ${e.prototype.scanned.length} (${e.localModules.length} prototype-local modules, ${e.packages.length} packages)`);
  console.log(`  Components:     ${count(e.components, "status")}`);
  console.log(`  CSS variables:  ${count(e.tokens, "status")}`);
  console.log(`  Utilities:      ${count(e.utilities, "kind")}`);
  console.log(`  Governance:     ${count(e.governance, "outcome")}`);
  const blocking = e.flags.filter((f) => f.severity === "blocking");
  const advisory = e.flags.filter((f) => f.severity === "advisory");
  console.log(`  Flags:          ${blocking.length} blocking, ${advisory.length} advisory`);
  for (const f of [...blocking, ...advisory]) {
    const where = f.locations[0] ? ` (${f.locations[0].file}:${f.locations[0].line}${f.locations.length > 1 ? ` +${f.locations.length - 1}` : ""})` : "";
    console.log(`    ${f.severity === "blocking" ? "✖" : "!"} ${f.id} ${f.kind}: ${f.message}${where}`);
  }
  console.log(`  Wrote ${out} in ${(ms / 1000).toFixed(1)}s`);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`✖ ${(err as Error).message}`);
    process.exit(1);
  },
);
