/**
 * Private GitHub repos through GO Design's repo-connector: short-lived, read-only installation tokens that
 * exist only after a person approves the install. Docent uses the connector's public HTTP interface and
 * nothing else. Every state but "approved" skips ingestion; nothing ever falls back to public access.
 */
import type { ClientConfig } from "../config/schema.js";
import type { SourceAccess } from "./source.js";

export type InstallationStatus = "not_found" | "pending" | "approved" | "rejected" | "revoked";

export interface ConnectorOptions {
  /** Defaults to REPO_CONNECTOR_URL. */
  baseUrl?: string;
  /** Defaults to REPO_CONNECTOR_API_KEY. */
  apiKey?: string;
  /** Where the defaults are read from: process.env unless given. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

/** Ingestion can't go ahead until a person acts. The CLI exits 3 and leaves the last contract in place. */
export class SourceAccessBlocked extends Error {
  readonly exitCode = 3;
  constructor(
    message: string,
    readonly status: InstallationStatus | "repo-not-granted" | "token-refused",
    readonly installUrl: string | null = null,
  ) {
    super(message);
    this.name = "SourceAccessBlocked";
  }
}

/** Docent couldn't ask the connector at all: settings missing, connector unreachable, or API key refused. */
export class ConnectorUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorUnavailable";
  }
}

interface Refusal {
  error: string | null;
  message: string | null;
  status: InstallationStatus | null;
  httpStatus: number;
}

class ConnectorHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async call<T>(method: "GET" | "POST", clientId: string, suffix = ""): Promise<{ body: T } | { refusal: Refusal }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/installations/${encodeURIComponent(clientId)}${suffix}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(method === "POST" ? { "Content-Type": "application/json", "X-Actor": "docent-ingestion" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify({ provider: "github" }) } : {}),
      });
    } catch (err) {
      throw new ConnectorUnavailable(`Could not reach repo-connector at ${this.baseUrl}: ${(err as Error).message}`);
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 401) {
      throw new ConnectorUnavailable(`repo-connector at ${this.baseUrl} refused Docent's API key. Check REPO_CONNECTOR_API_KEY.`);
    }
    if (response.ok) return { body: body as T };
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    return { refusal: { error: text(body.error), message: text(body.message), status: text(body.status) as InstallationStatus | null, httpStatus: response.status } };
  }
}

/**
 * Returns a credential for a client whose repo is fetched through repo-connector, or null for public and
 * local sources, which never call the connector. Throws SourceAccessBlocked when a person has to act.
 */
export async function connectorAccess(config: ClientConfig, options: ConnectorOptions = {}): Promise<SourceAccess | null> {
  const { source } = config;
  if (source.type !== "git" || source.githubAccess !== "repo-connector") return null;

  const env = options.env ?? process.env;
  const baseUrl = (options.baseUrl ?? env.REPO_CONNECTOR_URL)?.replace(/\/$/, "");
  const apiKey = options.apiKey ?? env.REPO_CONNECTOR_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new ConnectorUnavailable(`${config.client.id} fetches its repo through repo-connector, but REPO_CONNECTOR_URL and REPO_CONNECTOR_API_KEY are not both set.`);
  }
  const log = options.log ?? (() => {});
  const http = new ConnectorHttp(baseUrl, apiKey, options.fetch ?? fetch);
  const clientId = source.repoConnectorClientId!;
  const repo = repoFullName(source.url);
  const admin = `${baseUrl}/admin`;
  const skipped = `Ingestion of ${config.client.id} was skipped; its last contract is unchanged.`;

  const snapshot = await http.call<{ status: InstallationStatus }>("GET", clientId);
  const status: InstallationStatus =
    "body" in snapshot ? snapshot.body.status : snapshot.refusal.error === "INSTALLATION_NOT_FOUND" ? "not_found" : unavailable(snapshot.refusal);

  if (status === "not_found") {
    const requested = await http.call<{ installUrl: string }>("POST", clientId, "/request");
    if (!("body" in requested)) unavailable(requested.refusal);
    const { installUrl } = (requested as { body: { installUrl: string } }).body;
    throw new SourceAccessBlocked(
      `There is no repo-connector installation for ${clientId} yet. Install the GitHub App for ${repo.split("/")[0]} at ${installUrl}, then a connector admin approves it at ${admin}. ${skipped}`,
      "not_found",
      installUrl,
    );
  }
  if (status !== "approved") {
    const why = { pending: "is waiting for a connector admin to approve it", rejected: "was rejected by a connector admin", revoked: "was revoked by a connector admin" }[status];
    throw new SourceAccessBlocked(`The repo-connector installation ${clientId} ${why} at ${admin}. ${skipped}`, status);
  }

  const repos = await http.call<{ repos: { fullName: string }[] }>("GET", clientId, "/repos");
  if (!("body" in repos)) throw refused(repos.refusal);
  if (!repos.body.repos.some((r) => r.fullName.toLowerCase() === repo.toLowerCase())) {
    const readable = repos.body.repos.map((r) => r.fullName);
    throw new SourceAccessBlocked(
      `The repo-connector installation ${clientId} is approved but can't read ${repo}${readable.length ? ` (it can read ${readable.slice(0, 5).join(", ")}${readable.length > 5 ? ", …" : ""})` : ""}. Grant the GitHub App access to ${repo} in the organization's settings. ${skipped}`,
      "repo-not-granted",
    );
  }

  const minted = await http.call<{ token: string; expiresAt: string }>("GET", clientId, "/token");
  if (!("body" in minted)) throw refused(minted.refusal);
  const { token, expiresAt } = minted.body;
  if (!token || !(Date.parse(expiresAt) > Date.now())) {
    throw new SourceAccessBlocked(`repo-connector returned no usable token for ${clientId}. ${skipped}`, "token-refused");
  }
  log(`repo-connector: ${clientId} is approved and can read ${repo}; token valid until ${expiresAt}`);
  return { token, expiresAt, via: clientId };

  function refused(r: Refusal): SourceAccessBlocked {
    if (r.error === "INSTALLATION_NOT_APPROVED") {
      const state = r.status && r.status !== "approved" ? r.status : "pending";
      return new SourceAccessBlocked(`The repo-connector installation ${clientId} is ${state} at ${admin}. ${skipped}`, state);
    }
    const why: Record<string, string> = {
      EXCESSIVE_PERMISSIONS: "the GitHub App was installed with more than read-only access; reinstall it with contents:read and metadata:read only",
      INSTALLATION_NOT_BOUND: "the approved installation isn't bound to a GitHub account yet",
    };
    return new SourceAccessBlocked(`repo-connector won't issue a token for ${clientId}: ${why[r.error ?? ""] ?? r.message ?? `HTTP ${r.httpStatus}`}. ${skipped}`, "token-refused");
  }

  function unavailable(r: Refusal): never {
    throw new ConnectorUnavailable(`repo-connector couldn't report on ${clientId}: ${r.error ?? `HTTP ${r.httpStatus}`}${r.message ? ` (${r.message})` : ""}.`);
  }
}

/** "https://github.com/acme/design-system.git" → "acme/design-system". */
export function repoFullName(url: string): string {
  const match = url.match(/^https:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error(`repo-connector needs an https GitHub URL such as https://github.com/acme/design-system.git, not ${url}`);
  return `${match[1]}/${match[2]}`;
}
