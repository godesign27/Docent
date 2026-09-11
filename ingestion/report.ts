/** Writes a client's contract, a human-readable gap report, and an ingestion log entry. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DOCENT_ROOT, outputDir } from "../config/load.js";
import type { ClientConfig } from "../config/schema.js";
import type { Contract, Gap } from "../schema/contract.js";

export interface ContractDiff {
  firstRun: boolean;
  unchanged: boolean;
  components: { added: string[]; removed: string[] };
  tokens: { added: string[]; removed: string[] };
  gaps: { opened: string[]; resolved: string[] };
}

export interface WrittenOutputs {
  contractPath: string;
  reportPath: string;
  logPath: string;
  diff: ContractDiff;
}

export function writeOutputs(config: ClientConfig, contract: Contract): WrittenOutputs {
  const dir = outputDir(config);
  mkdirSync(dir, { recursive: true });
  const contractPath = join(dir, "contract.json");
  const reportPath = join(dir, "gaps.md");

  let previous: Partial<Contract> | null = null;
  if (existsSync(contractPath)) {
    try {
      previous = JSON.parse(readFileSync(contractPath, "utf8"));
    } catch {
      previous = null;
    }
  }
  const diff = diffContracts(previous, contract);

  writeFileSync(contractPath, JSON.stringify(contract, null, 2) + "\n");
  writeFileSync(reportPath, renderReport(contract, diff));

  // Audit trail of ingestion runs, kept per client like request logs will be.
  const logDir = join(DOCENT_ROOT, "logs", config.client.id);
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "ingestion.jsonl");
  appendFileSync(
    logPath,
    JSON.stringify({
      event: "ingestion",
      at: contract.generatedAt,
      client: contract.client.id,
      source: contract.source,
      contentHash: contract.contentHash,
      stats: contract.stats,
      changes: diff,
    }) + "\n",
  );

  return { contractPath, reportPath, logPath, diff };
}

export function diffContracts(previous: Partial<Contract> | null, next: Contract): ContractDiff {
  const ids = (items: { id: string }[] | undefined) => new Set((items ?? []).map((i) => i.id));
  const delta = (before: Set<string>, after: Set<string>) => ({
    added: [...after].filter((id) => !before.has(id)).sort(),
    removed: [...before].filter((id) => !after.has(id)).sort(),
  });
  const gapDelta = delta(ids(previous?.gaps), ids(next.gaps));
  return {
    firstRun: previous === null,
    unchanged: previous?.contentHash === next.contentHash,
    components: delta(ids(previous?.components), ids(next.components)),
    tokens: delta(ids(previous?.tokens), ids(next.tokens)),
    gaps: { opened: gapDelta.added, resolved: gapDelta.removed },
  };
}

export function renderReport(contract: Contract, diff: ContractDiff): string {
  const { stats, source } = contract;
  const out: string[] = [];
  out.push(`# Docent ingestion report — ${contract.client.name}`, "");
  out.push(`- **Source:** ${source.type} \`${source.location}\`${source.ref ? ` @ \`${source.ref}\`` : ""}${source.commit ? ` (commit \`${source.commit.slice(0, 12)}\`)` : ""}${source.subdir ? `, subdir \`${source.subdir}\`` : ""}`);
  out.push(`- **Generated:** ${contract.generatedAt} by Docent ${contract.docentVersion} (schema ${contract.schemaVersion})`);
  out.push(`- **Contract:** \`contract.json\` — \`${contract.contentHash}\``);
  out.push(`- **Modes:** ${contract.modes.join(", ") || "none"}`, "");

  out.push("## Summary", "");
  out.push("| | Count |", "|---|---|");
  out.push(`| Components | ${stats.components} (${stats.componentParts} exported parts) |`);
  out.push(`| Tokens | ${stats.tokens} |`);
  out.push(`| Gaps | ${stats.gaps.error} errors, ${stats.gaps.warning} warnings, ${stats.gaps.info} info |`);
  out.push(`| Files scanned | ${stats.filesScanned} |`, "");

  out.push("## Changes since last run", "");
  if (diff.firstRun) out.push("First ingestion for this client.", "");
  else if (diff.unchanged) out.push("No changes: the contract content is identical to the previous run.", "");
  else {
    const line = (label: string, items: string[]) => items.length && out.push(`- **${label} (${items.length}):** ${items.map((i) => `\`${i}\``).join(", ")}`);
    line("Components added", diff.components.added);
    line("Components removed", diff.components.removed);
    line("Tokens added", diff.tokens.added);
    line("Tokens removed", diff.tokens.removed);
    line("Gaps opened", diff.gaps.opened);
    line("Gaps resolved", diff.gaps.resolved);
    out.push("");
  }

  out.push("## Gaps", "");
  out.push("Docent reports what it could not establish from the repo instead of guessing. Each gap is something the design-system team can close.", "");
  const severities: [Gap["severity"], string][] = [
    ["error", "Errors"],
    ["warning", "Warnings"],
    ["info", "Info"],
  ];
  for (const [severity, title] of severities) {
    const gaps = contract.gaps.filter((g) => g.severity === severity);
    if (gaps.length === 0) continue;
    out.push(`### ${title} (${gaps.length})`, "");
    const byKind = new Map<string, Gap[]>();
    for (const gap of gaps) byKind.set(gap.kind, [...(byKind.get(gap.kind) ?? []), gap]);
    for (const [kind, items] of byKind) {
      out.push(`#### \`${kind}\` (${items.length})`, "");
      if (items[0]?.suggestion && items.every((g) => g.suggestion === items[0]!.suggestion)) {
        out.push(`_Suggested fix: ${items[0]!.suggestion}_`, "");
      }
      for (const gap of items) {
        const where = gap.location ? ` — \`${gap.location.file}${gap.location.line ? `:${gap.location.line}` : ""}\`` : "";
        out.push(`- **${gap.subject.id}**: ${gap.message}${where}`);
      }
      out.push("");
    }
  }
  if (contract.gaps.length === 0) out.push("No gaps found.", "");
  return out.join("\n");
}

export function consoleSummary(contract: Contract, outputs: WrittenOutputs): string {
  const { stats } = contract;
  const rel = (p: string) => relative(process.cwd(), p) || p;
  const lines = [
    `✔ ${contract.client.name}: ${stats.components} components (${stats.componentParts} parts), ${stats.tokens} tokens from ${stats.filesScanned} files`,
    `  Gaps: ${stats.gaps.error} errors, ${stats.gaps.warning} warnings, ${stats.gaps.info} info`,
  ];
  const { diff } = outputs;
  if (!diff.firstRun) {
    lines.push(
      diff.unchanged
        ? "  No changes since last run"
        : `  Since last run: components +${diff.components.added.length}/-${diff.components.removed.length}, tokens +${diff.tokens.added.length}/-${diff.tokens.removed.length}, gaps opened ${diff.gaps.opened.length}, resolved ${diff.gaps.resolved.length}`,
    );
  }
  lines.push(`  Contract: ${rel(outputs.contractPath)}`, `  Report:   ${rel(outputs.reportPath)}`);
  return lines.join("\n");
}
