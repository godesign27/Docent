/**
 * Client isolation checks. One Docent codebase serves several clients, each
 * from its own config; these checks confirm that no client's contract,
 * snapshot, logs or reviews reach another client, on disk or at runtime.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { DOCENT_ROOT, outputDir, type LoadedConfig } from "../config/load.js";
import type { Contract } from "../schema/contract.js";
import { Concierge, MemoryReviewStore, type AuditEntry } from "./concierge.js";
import { JsonlAuditLog, loadContract, loadSources } from "./node.js";

export interface IsolationResult {
  check: string;
  client: string | null;
  passed: boolean;
  detail: string;
}

/** True when b is a or lives inside a. */
const nested = (a: string, b: string) => {
  const rel = relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export interface IsolationOptions {
  docentVersion: string;
  /** Where a git source is checked out. Defaults to .docent/sources/<client>. */
  checkoutDir?: (clientId: string) => string;
  /** Where a client's logs live. Defaults to logs/<client>. */
  logDir?: (clientId: string) => string;
}

export async function checkIsolation(configs: LoadedConfig[], options: IsolationOptions = { docentVersion: "isolation" }): Promise<IsolationResult[]> {
  const results: IsolationResult[] = [];
  const add = (check: string, client: string | null, passed: boolean, detail: string) => results.push({ check, client, passed, detail });
  const ids = configs.map((c) => c.config.client.id);
  const checkout = options.checkoutDir ?? ((id: string) => join(DOCENT_ROOT, ".docent", "sources", id));
  const logDirFor = options.logDir ?? ((id: string) => join(DOCENT_ROOT, "logs", id));

  // --- Configuration ----------------------------------------------------------
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  add("unique-client-ids", null, duplicates.length === 0, duplicates.length ? `duplicate ids: ${[...new Set(duplicates)].join(", ")}` : `${ids.length} clients: ${ids.join(", ")}`);

  for (const [i, a] of configs.entries()) {
    for (const b of configs.slice(i + 1)) {
      const [outA, outB] = [outputDir(a.config), outputDir(b.config)];
      const overlap = nested(outA, outB) || nested(outB, outA);
      add("separate-output-dirs", null, !overlap, `${a.config.client.id} → ${relative(DOCENT_ROOT, outA)}, ${b.config.client.id} → ${relative(DOCENT_ROOT, outB)}`);
    }
  }

  // --- On disk ------------------------------------------------------------------
  const loaded = new Map<string, { contract: Contract; sources: Record<string, string> }>();
  for (const { config } of configs) {
    const id = config.client.id;
    const contractPath = join(outputDir(config), "contract.json");
    if (!existsSync(contractPath)) {
      add("contract-owner", id, true, "not ingested yet");
      continue;
    }
    let contract: Contract;
    try {
      contract = loadContract(config);
    } catch (err) {
      // A contract that exists but can't be loaded for this client (e.g. it belongs to another client) is a failure.
      add("contract-owner", id, false, (err as Error).message);
      continue;
    }
    const location = config.source.type === "git" ? config.source.url : config.source.path;
    const owned = contract.client.id === id && contract.source.location === location;
    add("contract-owner", id, owned, owned ? `contract belongs to ${id} and was built from ${location}` : `contract says ${contract.client.id} from ${contract.source.location}`);

    try {
      const sources = loadSources(config, contract);
      loaded.set(id, { contract, sources });
      add("snapshot-matches-contract", id, true, `${Object.keys(sources).length} files match their contract hashes`);
    } catch (err) {
      add("snapshot-matches-contract", id, false, (err as Error).message);
      continue;
    }

    // The snapshot must come from this client's own checkout, not another client's.
    const root = config.source.type === "git" ? checkout(id) : config.source.path;
    const base = config.source.subdir ? join(root, config.source.subdir) : root;
    if (existsSync(base)) {
      const foreign = contract.sourceFiles.filter((f) => {
        const path = join(base, f.path);
        return !existsSync(path) || createHash("sha256").update(readFileSync(path, "utf8")).digest("hex") !== f.sha256;
      });
      add(
        "snapshot-from-own-source",
        id,
        foreign.length === 0,
        foreign.length ? `${foreign.length} snapshot file(s) differ from ${id}'s checkout (re-ingest if the source moved on): ${foreign.slice(0, 3).map((f) => f.path).join(", ")}` : `every snapshot file matches ${id}'s own checkout`,
      );
    } else {
      add("snapshot-from-own-source", id, true, "checkout not present locally; skipped");
    }

    const logDir = logDirFor(id);
    const strays: string[] = [];
    let entries = 0;
    for (const file of existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith(".jsonl")) : []) {
      for (const [n, raw] of readJsonl(join(logDir, file)).entries()) {
        entries++;
        const e = raw as { client?: string; type?: string; review?: { client?: string }; response?: { provenance?: { client?: { id?: string } } } };
        const owners = [e.client, e.review?.client, e.response?.provenance?.client?.id].filter((x): x is string => Boolean(x));
        if (owners.length === 0 && e.type !== "decided") strays.push(`${file}:${n + 1} has no client`);
        for (const owner of owners) if (owner !== id) strays.push(`${file}:${n + 1} belongs to ${owner}`);
      }
    }
    add("logs-single-client", id, strays.length === 0, strays.length ? strays.slice(0, 5).join("; ") : `${entries} log entries, all for ${id}`);
  }

  // --- At runtime -----------------------------------------------------------------
  for (const [idA, a] of loaded) {
    const config = configs.find((c) => c.config.client.id === idA)!.config;
    const audit = { entries: [] as AuditEntry[], record(e: AuditEntry) { this.entries.push(e); } };
    const concierge = new Concierge({
      contract: a.contract,
      audit,
      policy: config.escalation,
      domains: config.specialists,
      docentVersion: options.docentVersion,
      reviews: new MemoryReviewStore(),
      sources: a.sources,
    });
    const ownNames = new Set(a.contract.components.flatMap((c) => [c.id, c.name, ...c.parts.map((p) => p.name)].map((n) => n.toLowerCase())));

    for (const [idB, b] of loaded) {
      if (idA === idB) continue;
      const foreign = b.contract.components.filter((c) => !ownNames.has(c.name.toLowerCase()) && !ownNames.has(c.id.toLowerCase())).slice(0, 5);
      const leaks: string[] = [];
      for (const c of foreign) {
        const answer = await concierge.ask({ question: `What props does ${c.name} take?`, component: c.name }, { name: "isolation-check", client: null, transport: "test" });
        if (answer.components.some((x) => x.name === c.name)) leaks.push(`ask answered ${c.name}`);
        const fetched = await concierge.getComponent({ components: [c.name] }, { name: "isolation-check", client: null, transport: "test" });
        if (fetched.files.length) leaks.push(`get_component delivered ${c.name}`);
      }
      for (const r of readJsonl(join(logDirFor(idB), "reviews.jsonl"))) {
        const review = (r as { type?: string; review?: { id: string } }).review;
        if (!review) continue;
        const looked = await concierge.checkReview({ reviewId: review.id }, { name: "isolation-check", client: null, transport: "test" });
        if (looked.status !== "not-found") leaks.push(`check_review found ${idB}'s review ${review.id}`);
      }
      add(
        "no-cross-client-answers",
        idA,
        leaks.length === 0,
        leaks.length ? leaks.join("; ") : `${idA} does not answer, deliver or reveal reviews for ${foreign.length} components and the reviews unique to ${idB}`,
      );
    }
    if (audit.entries.some((e) => e.client !== idA)) add("runtime-audit-client", idA, false, "an audit entry was recorded for another client");
  }

  // Loggers refuse to write another client's entries (tried against a scratch file, never a real log).
  const scratch = mkdtempSync(join(tmpdir(), "docent-isolation-"));
  for (const id of ids) {
    const other = ids.find((x) => x !== id);
    if (!other) break;
    let refused = false;
    try {
      new JsonlAuditLog(join(scratch, `${id}.jsonl`), id).record({ client: other } as AuditEntry);
    } catch {
      refused = true;
    }
    add("audit-log-refuses-foreign-entries", id, refused, refused ? `${id}'s request log refused an entry for ${other}` : `${id}'s request log accepted an entry for ${other}`);
  }

  return results;
}
