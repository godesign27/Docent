/** Node adapters: contracts and audit logs on the local filesystem, one folder per client. */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DOCENT_ROOT, outputDir } from "../config/load.js";
import type { ClientConfig } from "../config/schema.js";
import { CONTRACT_SCHEMA_VERSION, Contract } from "../schema/contract.js";
import { ReviewRecord } from "../schema/response.js";
import { Concierge, type AuditEntry, type AuditLog, type ConciergeOptions, type ConciergeService, type ReviewStore } from "./concierge.js";

export function loadContract(config: ClientConfig): Contract {
  const path = join(outputDir(config), "contract.json");
  if (!existsSync(path)) {
    throw new Error(`No contract for ${config.client.id} at ${path}. Run: npm run ingest -- --client ${config.client.id}`);
  }
  const parsed = Contract.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`${path} does not match contract schema ${CONTRACT_SCHEMA_VERSION}; re-run ingestion. ${parsed.error.issues[0]?.message ?? ""}`);
  }
  if (parsed.data.client.id !== config.client.id) {
    throw new Error(`${path} belongs to client ${parsed.data.client.id}, not ${config.client.id}`);
  }
  return parsed.data;
}

/**
 * Loads the source snapshot written at ingestion and refuses it unless every
 * file matches the hash recorded in the contract.
 */
export function loadSources(config: ClientConfig, contract: Contract): Record<string, string> {
  const path = join(outputDir(config), "sources.json");
  if (!existsSync(path)) {
    throw new Error(`No source snapshot for ${config.client.id} at ${path}. Run: npm run ingest -- --client ${config.client.id}`);
  }
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as { contractHash?: string; files?: Record<string, string> };
  if (snapshot.contractHash !== contract.contentHash) {
    throw new Error(`${path} was written for a different contract; re-run ingestion.`);
  }
  const files = snapshot.files ?? {};
  for (const file of contract.sourceFiles) {
    const content = files[file.path];
    if (content === undefined || createHash("sha256").update(content).digest("hex") !== file.sha256) {
      throw new Error(`${path}: ${file.path} is missing or does not match its contract hash; re-run ingestion.`);
    }
  }
  return Object.fromEntries(contract.sourceFiles.map((f) => [f.path, files[f.path]!]));
}

export function requestLogPath(clientId: string): string {
  return join(DOCENT_ROOT, "logs", clientId, "requests.jsonl");
}

export class JsonlAuditLog implements AuditLog {
  constructor(
    private readonly path: string,
    private readonly clientId: string,
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  record(entry: AuditEntry): void {
    if (entry.client !== this.clientId) {
      throw new Error(`Refusing to write a ${entry.client} request into the ${this.clientId} audit log`);
    }
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }
}

export function reviewLogPath(clientId: string): string {
  return join(DOCENT_ROOT, "logs", clientId, "reviews.jsonl");
}

/**
 * Reviews as an append-only event log: a "created" event when a request is
 * escalated and a "decided" event when a human rules on it. Current state is
 * replayed from the log, so the history can't be rewritten silently.
 */
export class JsonlReviewStore implements ReviewStore {
  constructor(
    private readonly path: string,
    private readonly clientId: string,
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  private replay(): Map<string, ReviewRecord> {
    const reviews = new Map<string, ReviewRecord>();
    if (!existsSync(this.path)) return reviews;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { type: "created"; review: ReviewRecord } | { type: "decided"; id: string; status: "approved" | "denied"; decision: ReviewRecord["decision"] };
      if (event.type === "created") reviews.set(event.review.id, ReviewRecord.parse(event.review));
      else {
        const r = reviews.get(event.id);
        if (r) Object.assign(r, { status: event.status, decision: event.decision });
      }
    }
    return reviews;
  }

  create(review: ReviewRecord): void {
    if (review.client !== this.clientId) throw new Error(`Refusing to store a ${review.client} review in the ${this.clientId} review log`);
    appendFileSync(this.path, JSON.stringify({ type: "created", review }) + "\n");
  }

  get(id: string): ReviewRecord | null {
    return this.replay().get(id) ?? null;
  }

  list(): ReviewRecord[] {
    return [...this.replay().values()];
  }

  decide(id: string, decision: { status: "approved" | "denied"; by: string; note: string }): ReviewRecord {
    const review = this.get(id);
    if (!review) throw new Error(`No review ${id} for ${this.clientId}`);
    if (review.status !== "pending") throw new Error(`Review ${id} was already ${review.status} by ${review.decision?.by}`);
    const record = { by: decision.by, at: new Date().toISOString(), note: decision.note };
    appendFileSync(this.path, JSON.stringify({ type: "decided", id, status: decision.status, decision: record }) + "\n");
    return { ...review, status: decision.status, decision: record };
  }
}

/**
 * A concierge that picks up a re-ingested contract without a restart, so a long-running server
 * (an MCP client keeps one open for days) never answers from a design system that has since changed.
 * Checked on every request; a half-written ingestion (contract and snapshot disagree) keeps the old one.
 */
export class LiveConcierge implements ConciergeService {
  private current: Concierge;
  private stamp: string;

  constructor(
    private readonly config: ClientConfig,
    private readonly options: Omit<ConciergeOptions, "contract" | "sources">,
    private readonly onReload: (message: string) => void = () => {},
  ) {
    this.current = this.build();
    this.stamp = this.fileStamp();
  }

  private fileStamp(): string {
    const dir = outputDir(this.config);
    return ["contract.json", "sources.json"].map((f) => (existsSync(join(dir, f)) ? statSync(join(dir, f)).mtimeMs : 0)).join(":");
  }

  private build(): Concierge {
    const contract = loadContract(this.config);
    return new Concierge({ ...this.options, contract, sources: loadSources(this.config, contract) });
  }

  private fresh(): Concierge {
    const stamp = this.fileStamp();
    if (stamp === this.stamp) return this.current;
    try {
      const next = this.build();
      const before = this.current.contractInfo.contractHash;
      this.current = next;
      this.stamp = stamp;
      if (next.contractInfo.contractHash !== before) {
        this.onReload(`reloaded contract ${next.contractInfo.contractHash.slice(0, 19)}… (source ${next.contractInfo.sourceCommit?.slice(0, 7) ?? "unknown"})`);
      }
    } catch (err) {
      this.onReload(`kept the previous contract: ${(err as Error).message}`);
    }
    return this.current;
  }

  get clientName() {
    return this.fresh().clientName;
  }
  get canDistribute() {
    return this.fresh().canDistribute;
  }
  get domains() {
    return this.fresh().domains;
  }
  get contractInfo() {
    return this.fresh().contractInfo;
  }
  ask: Concierge["ask"] = (...args) => this.fresh().ask(...args);
  getComponent: Concierge["getComponent"] = (...args) => this.fresh().getComponent(...args);
  getFoundation: Concierge["getFoundation"] = (...args) => this.fresh().getFoundation(...args);
  checkReview: Concierge["checkReview"] = (...args) => this.fresh().checkReview(...args);
}
