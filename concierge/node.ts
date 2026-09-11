/** Node adapters: contracts and audit logs on the local filesystem, one folder per client. */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DOCENT_ROOT, outputDir } from "../config/load.js";
import type { ClientConfig } from "../config/schema.js";
import { CONTRACT_SCHEMA_VERSION, Contract } from "../schema/contract.js";
import { ReviewRecord } from "../schema/response.js";
import type { AuditEntry, AuditLog, ReviewStore } from "./concierge.js";

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
