/**
 * Private repos through repo-connector, against a fake connector and a local bare repo that git reaches
 * as https://github.com/acme/design-system.git (via url.insteadOf). Every state but "approved" must skip
 * ingestion before the source is touched, and the token must never reach disk.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DOCENT_ROOT, loadConfig } from "../../config/load.js";
import { ClientConfig } from "../../config/schema.js";
import { ingest } from "../ingest.js";
import { ConnectorUnavailable, repoFullName, SourceAccessBlocked } from "../repo-connector.js";
import { ASKPASS, resolveSource } from "../source.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const TOKEN = "ghs_fake_installation_token_0123456789abcdef";
const API_KEY = "test-connector-api-key-0123456789";
const CLIENT_ID = `connector-test-${process.pid}`;
const REPO_URL = "https://github.com/acme/design-system.git";
const checkout = () => join(DOCENT_ROOT, ".docent", "sources", CLIENT_ID);

type Status = "not_found" | "pending" | "approved" | "rejected" | "revoked";
let state: { status: Status; repos: string[]; tokenError: string | null };
const calls: { method: string; path: string; actor: string | undefined }[] = [];
const gitEnvKeys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
const gitEnvBefore = Object.fromEntries(gitEnvKeys.map((k) => [k, process.env[k]]));
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "docent-connector-"));
  const work = join(tmp, "work");
  cpSync(fixture("acme-ds"), work, { recursive: true });
  const run = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "ignore" });
  run(["init", "-q", "-b", "main"], work);
  run(["add", "-A"], work);
  run(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "fixture"], work);
  const remotes = join(tmp, "remote");
  execFileSync("git", ["clone", "-q", "--bare", work, join(remotes, "acme", "design-system.git")], { stdio: "ignore" });
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.file://${remotes}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";

  server = createServer((req, res) => {
    const path = req.url ?? "";
    calls.push({ method: req.method ?? "", path, actor: req.headers["x-actor"] as string | undefined });
    const send = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return send(401, { error: "UNAUTHORIZED", message: "invalid api key" });
    const m = path.match(/^\/v1\/installations\/([^/]+)(\/request|\/token|\/repos)?$/);
    if (!m) return send(404, {});
    const clientId = decodeURIComponent(m[1]!);
    const notApproved = () => (state.status === "approved" ? null : send(409, { error: "INSTALLATION_NOT_APPROVED", message: "not approved", status: state.status }));
    switch (m[2]) {
      case undefined:
        return send(200, { clientId, provider: "github", status: state.status, accountLogin: "acme", permissionsExcess: false, bound: true });
      case "/request":
        state.status = "pending";
        return send(200, { clientId, provider: "github", installUrl: "https://github.com/apps/godesign-docent/installations/new?state=test", status: "pending" });
      case "/repos":
        return notApproved() ?? send(200, { repos: state.repos.map((fullName, i) => ({ id: String(i), fullName, defaultBranch: "main", private: true })) });
      case "/token":
        return (
          notApproved() ??
          (state.tokenError
            ? send(403, { error: state.tokenError, message: "refused" })
            : send(200, { token: TOKEN, tokenType: "installation", provider: "github", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }))
        );
    }
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server?.close();
  for (const k of gitEnvKeys) {
    if (gitEnvBefore[k] === undefined) delete process.env[k];
    else process.env[k] = gitEnvBefore[k];
  }
  rmSync(checkout(), { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  state = { status: "approved", repos: ["acme/design-system", "acme/docs"], tokenError: null };
  rmSync(checkout(), { recursive: true, force: true });
});

function config(source: Record<string, unknown> = {}): ClientConfig {
  const { config: acme } = loadConfig(fixture("acme.yaml"));
  return ClientConfig.parse({
    ...acme,
    client: { ...acme.client, id: CLIENT_ID },
    source: { type: "git", url: REPO_URL, githubAccess: "repo-connector", repoConnectorClientId: "docent:acme", ...source },
  });
}
const run = (c: ClientConfig) => ingest(c, { connector: { baseUrl, apiKey: API_KEY } });
const blocked = (c: ClientConfig) => run(c).then(() => null, (err: unknown) => err as SourceAccessBlocked);

/** Every file under a directory, as text, to prove a secret isn't in any of them. */
function allText(dir: string): string {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .map((p) => (statSync(p).isDirectory() ? allText(p) : readFileSync(p).toString("latin1")))
    .join("\n");
}

describe("config", () => {
  it("defaults git sources to public access", () => {
    expect(config({ githubAccess: undefined, repoConnectorClientId: undefined }).source).toMatchObject({ githubAccess: "public" });
  });

  it("requires a connector id with repo-connector, only then, and an https URL", () => {
    expect(() => config({ repoConnectorClientId: undefined })).toThrow(/needs repoConnectorClientId/);
    expect(() => config({ githubAccess: "public" })).toThrow(/only applies with githubAccess: repo-connector/);
    expect(() => config({ url: "git@github.com:acme/design-system.git" })).toThrow(/HTTPS/);
  });

  it("reads the repo from an https URL", () => {
    expect(repoFullName("https://github.com/Acme/Design-System.git")).toBe("Acme/Design-System");
    expect(repoFullName("https://github.com/acme/ds")).toBe("acme/ds");
  });
});

describe("public git sources", () => {
  it("clone in the open and never call the connector", async () => {
    const { contract } = await run(config({ githubAccess: "public", repoConnectorClientId: undefined }));
    expect(contract.components.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });
});

describe("repo-connector sources", () => {
  it("request an installation when there is none, and skip ingestion", async () => {
    state.status = "not_found";
    const err = await blocked(config());
    expect(err).toBeInstanceOf(SourceAccessBlocked);
    expect(err).toMatchObject({ status: "not_found", exitCode: 3, installUrl: expect.stringContaining("github.com/apps/") });
    expect(err!.message).toContain(`${baseUrl}/admin`);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/installations/docent%3Aacme", "POST /v1/installations/docent%3Aacme/request"]);
    expect(calls[1]!.actor).toBe("docent-ingestion");
    expect(existsSync(checkout())).toBe(false);
  });

  it.each(["pending", "rejected", "revoked"] as const)("skip ingestion while the installation is %s, without asking for a token", async (status) => {
    state.status = status;
    const err = await blocked(config());
    expect(err).toMatchObject({ name: "SourceAccessBlocked", status });
    expect(calls.map((c) => c.path)).toEqual(["/v1/installations/docent%3Aacme"]);
    expect(existsSync(checkout())).toBe(false);
  });

  it("skip ingestion when the approved installation can't read the configured repo", async () => {
    state.repos = ["acme/docs"];
    const err = await blocked(config());
    expect(err).toMatchObject({ status: "repo-not-granted" });
    expect(err!.message).toContain("acme/design-system");
    expect(calls.some((c) => c.path.endsWith("/token"))).toBe(false);
    expect(existsSync(checkout())).toBe(false);
  });

  it("skip ingestion when the connector refuses a token", async () => {
    state.tokenError = "EXCESSIVE_PERMISSIONS";
    const err = await blocked(config());
    expect(err).toMatchObject({ status: "token-refused" });
    expect(err!.message).toMatch(/read-only/);
    expect(existsSync(checkout())).toBe(false);
  });

  it("stop when Docent can't ask the connector at all", async () => {
    await expect(ingest(config(), { connector: { baseUrl, apiKey: "wrong-key" } })).rejects.toThrow(ConnectorUnavailable);
    await expect(ingest(config(), { connector: { env: {} } })).rejects.toThrow(/REPO_CONNECTOR_URL/);
  });

  it("never fetch a connector source without going through the connector", () => {
    expect(() => resolveSource(config())).toThrow(/never falls back to public access/);
  });

  it("ingest with an approved token that never reaches disk", async () => {
    const first = await run(config());
    expect(first.contract.components.length).toBeGreaterThan(0);
    expect(first.contract.source).toMatchObject({ type: "git", location: REPO_URL });
    expect(readFileSync(join(checkout(), ".git", "config"), "utf8")).toContain(`url = ${REPO_URL}`);

    // A second run refreshes the existing checkout the same way.
    const second = await run(config());
    for (const text of [allText(join(checkout(), ".git")), JSON.stringify(first), JSON.stringify(second)]) {
      expect(text.includes(TOKEN)).toBe(false);
    }
    expect(calls.every((c) => !c.path.includes(TOKEN))).toBe(true);
  });
});

describe("the credential prompt script", () => {
  it("answers git's username and password prompts from the environment only", () => {
    const dir = mkdtempSync(join(tmpdir(), "docent-askpass-test-"));
    const script = join(dir, "askpass.sh");
    writeFileSync(script, ASKPASS, { mode: 0o700 });
    const answer = (prompt: string) => execFileSync("sh", [script, prompt], { encoding: "utf8", env: { ...process.env, DOCENT_GIT_TOKEN: TOKEN } });
    expect(answer("Username for 'https://github.com': ")).toBe("x-access-token\n");
    expect(answer("Password for 'https://x-access-token@github.com': ")).toBe(`${TOKEN}\n`);
    expect(ASKPASS.includes(TOKEN)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
