/**
 * uicontext — drafts UIContext.md from a prototype, confirming every design-system claim through Docent.
 *
 *   npm run uicontext -- evidence --prototype <dir> --entry <file> [--entry <file>…]
 *                                 (--docent-client <id> | --docent-url <url>) [--out evidence.json]
 *
 *   npm run uicontext -- draft --prototype <dir> --entry <file> [--entry <file>…]
 *                              --story <file> --intent-ux <file>
 *                              (--docent-client <id> | --docent-url <url>) [--out-dir <dir>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type DocentConnection, DocentClient, DocentUnavailable } from "./docent.js";
import { draftUiContext } from "./draft.js";
import { type GateResult, applyGate, gate } from "./gate.js";
import { Evidence, gatherEvidence } from "./evidence.js";
import { handoffName, loadDocument, loadPrototype } from "./inputs.js";
import { ClaudeModel, ModelUnavailable } from "./model.js";
import { loadPrior } from "./prior.js";
import { flagsFile, render } from "./render.js";

const DOCENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const HELP = `uicontext — draft UIContext.md from a prototype, confirmed against Docent

  evidence  --prototype <dir> --entry <file> [--entry <file>…] [--out <file>]
  draft     --prototype <dir> --entry <file> [--entry <file>…]
            --story <file> --intent-ux <file> [--out-dir <dir>] [--evidence <file>]
            [--route <path>] [--model <model-id>]   (drafting needs ANTHROPIC_API_KEY)

  Docent over stdio:  --docent-client <client-id> [--docent-root <path to Docent>]
  Docent over HTTP:   --docent-url <https://…/mcp>   (token from DOCENT_TOKEN)

Exit codes: 0 written (flags may still block), 2 Docent unavailable, 3 the model was unavailable,
1 other error. Nothing is written on 1, 2 or 3.`;

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      prototype: { type: "string" },
      entry: { type: "string", multiple: true },
      out: { type: "string" },
      "out-dir": { type: "string" },
      story: { type: "string" },
      "intent-ux": { type: "string" },
      evidence: { type: "string" },
      route: { type: "string" },
      model: { type: "string" },
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
  if (command !== "evidence" && command !== "draft") {
    console.error(`Unknown command "${command}"\n\n${HELP}`);
    return 1;
  }
  if (!values.prototype || !values.entry?.length) throw new Error(`${command} needs --prototype and at least one --entry.`);
  const root = resolve(values.prototype);

  // Drafting reads its inputs and checks its credentials before spending anything on Docent.
  const drafting = command === "draft";
  let inputs: ReturnType<typeof loadInputs> | null = null;
  let model: ClaudeModel | null = null;
  if (drafting) {
    if (!values.story || !values["intent-ux"]) throw new Error("draft needs --story and --intent-ux.");
    inputs = loadInputs(values.story, values["intent-ux"]);
    try {
      model = new ClaudeModel({ model: values.model });
    } catch (err) {
      console.error(`✖ ${(err as Error).message}\n  Nothing was written.`);
      return 3;
    }
  }

  const started = Date.now();
  const reuse = values.evidence && existsSync(resolve(values.evidence)) ? resolve(values.evidence) : null;
  let evidence: Evidence;

  if (reuse) {
    evidence = Evidence.parse(JSON.parse(readFileSync(reuse, "utf8")));
    console.log(`Using the evidence in ${reuse} (gathered ${evidence.generatedAt}).`);
  } else {
    const connection = docentConnection(values);
    if (!connection) throw new Error("Say which Docent to use: --docent-client <id> or --docent-url <url>.");
    let docent: DocentClient;
    try {
      docent = await DocentClient.connect(connection);
    } catch (err) {
      console.error(`✖ Docent is unavailable, so nothing can be confirmed and nothing was written.\n  ${(err as Error).message}`);
      return 2;
    }
    try {
      evidence = await gatherEvidence({ root, entries: values.entry, docent });
    } catch (err) {
      if (err instanceof DocentUnavailable) {
        console.error(`✖ Docent stopped answering, so the evidence is incomplete and nothing was written.\n  ${err.message}`);
        return 2;
      }
      throw err;
    } finally {
      await docent.close();
    }
  }

  if (!drafting) {
    const out = resolve(values.out ?? "evidence.json");
    writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`);
    printEvidence(evidence, out, Date.now() - started);
    return 0;
  }

  const now = new Date();
  const full = { ...inputs!, prototype: loadPrototype(root, evidence.prototype.scanned) };
  let draft;
  try {
    draft = await draftUiContext({ model: model!, inputs: full, evidence });
  } catch (err) {
    if (err instanceof ModelUnavailable) {
      console.error(`✖ ${err.message}\n  Nothing was written.`);
      return 3;
    }
    throw err;
  }

  const outDir = resolve(values["out-dir"] ?? dirname(resolve(values["intent-ux"]!)));
  const file = join(outDir, full.name.uicontext);
  const prior = loadPrior(file);
  if (prior) console.log(`Regenerating ${basename(file)}: answers, sign-offs and sections marked <!-- human --> are carried forward.`);

  const rendered = render({ inputs: full, evidence, draft, now, route: values.route, prototypeSource: basename(root), prior });

  // The drafter does not grade its own draft: a second pass decides the status.
  let gated: GateResult;
  try {
    gated = await gate({ model: model!, inputs: full, evidence, rendered, markdown: rendered.markdown });
  } catch (err) {
    if (err instanceof ModelUnavailable) {
      console.error(`✖ ${err.message}\n  The draft was not written, because nothing decided whether it is complete.`);
      return 3;
    }
    throw err;
  }

  writeFile(file, applyGate(rendered.markdown, gated));
  writeFile(join(outDir, "flags.json"), `${JSON.stringify(flagsFile(rendered, evidence, full, now, gated), null, 2)}\n`);
  if (!reuse && values.evidence) writeFile(resolve(values.evidence), `${JSON.stringify(evidence, null, 2)}\n`);
  printDraft(rendered, gated, evidence, file, Date.now() - started, model!.name);
  return 0;
}

function loadInputs(storyPath: string, intentUxPath: string) {
  const story = loadDocument(resolve(storyPath));
  const intentUx = loadDocument(resolve(intentUxPath));
  return { story, intentUx, name: handoffName(resolve(intentUxPath)) };
}

function docentConnection(values: Record<string, unknown>): DocentConnection | null {
  const url = values["docent-url"] as string | undefined;
  const client = values["docent-client"] as string | undefined;
  if (url) return { kind: "http", url, token: process.env.DOCENT_TOKEN };
  if (client) return { kind: "stdio", command: process.execPath, args: [resolve((values["docent-root"] as string) ?? DOCENT_ROOT, "bin/docent.js"), "serve", "--client", client] };
  return null;
}

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const count = (items: Record<string, unknown>[], key: string) =>
  Object.entries(items.reduce<Record<string, number>>((acc, i) => ((acc[String(i[key])] = (acc[String(i[key])] ?? 0) + 1), acc), {}))
    .map(([k, n]) => `${n} ${k}`)
    .join(", ") || "none";

function printEvidence(e: Evidence, out: string, ms: number) {
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

function printDraft(rendered: ReturnType<typeof render>, gated: GateResult, e: Evidence, file: string, ms: number, model: string) {
  const failed = gated.checks.filter((c) => !c.passed);
  console.log(`Drafted ${basename(file)} against ${e.docent.client.name} (contract ${e.docent.contractHash.slice(0, 19)}…, drafted and graded by ${model})`);
  console.log(`  Components:     ${count(e.components, "status")}`);
  console.log(`  Status:         ${gated.status} (${gated.checks.length - failed.length}/${gated.checks.length} checks passed)`);
  for (const check of failed) console.log(`    ${check.blocking ? "✖" : "!"} ${check.title}: ${check.detail}`);
  for (const finding of gated.grader?.findings ?? []) console.log(`    ${finding.severity === "blocking" ? "✖" : "!"} grader — ${finding.section}: ${finding.finding}`);
  console.log(`  Questions:      ${rendered.questions.filter((q) => q.priority === "Blocking").length} blocking, ${rendered.questions.filter((q) => q.priority === "Advisory").length} advisory`);
  console.log(`  Unconfirmed claims replaced with UNKNOWN: ${rendered.unconfirmed.length}`);
  if (rendered.changes.length || rendered.carriedResolutions || rendered.reopened.length) {
    console.log(`  Since the last draft: ${rendered.changes.length} factual change(s), ${rendered.carriedResolutions} answer(s) carried forward, ${rendered.reopened.length} answered question(s) raised again`);
    for (const change of rendered.changes.slice(0, 8)) console.log(`    · ${change.section}: ${change.kind} ${change.key}`);
  }
  for (const u of rendered.unconfirmed) console.log(`    ✖ ${u.flag} ${u.field} (the name is in flags.json)`);
  console.log(`  Wrote ${file} and flags.json in ${(ms / 1000).toFixed(1)}s`);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`✖ ${(err as Error).message}`);
    process.exit(1);
  },
);
