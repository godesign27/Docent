import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ClientConfig } from "../config/schema.js";
import { DOCENT_ROOT } from "../config/load.js";

export interface ResolvedSource {
  /** Absolute path of the design-system root that globs are resolved against. */
  root: string;
  type: "local" | "git";
  location: string;
  ref: string | null;
  commit: string | null;
  subdir: string | null;
}

/** A short-lived credential for a private git source, from repo-connector. Held in memory only, never written. */
export interface SourceAccess {
  token: string;
  expiresAt: string;
  /** The connector installation it came from, e.g. docent:acme. */
  via: string;
}

/** Answers git's credential prompts from the environment, so the token is never written or put in a URL. */
export const ASKPASS = `#!/bin/sh
case "$1" in
  Username*) echo x-access-token ;;
  *) printf '%s\\n' "$DOCENT_GIT_TOKEN" ;;
esac
`;

function git(args: string[], cwd?: string, access: SourceAccess | null = null): string {
  if (!access) return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  // The token reaches git through this one command's environment: never the URL, the remote or a credential store.
  const dir = mkdtempSync(join(tmpdir(), "docent-askpass-"));
  const askpass = join(dir, "askpass.sh");
  writeFileSync(askpass, ASKPASS, { mode: 0o700 });
  try {
    return execFileSync("git", ["-c", "credential.helper=", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0", DOCENT_GIT_TOKEN: access.token },
    }).trim();
  } catch (err) {
    throw new Error(String((err as Error).message).split(access.token).join("[token]"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function tryCommit(dir: string): string | null {
  try {
    return git(["rev-parse", "HEAD"], dir);
  } catch {
    return null;
  }
}

function withSubdir(base: string, subdir: string | undefined): string {
  if (!subdir) return base;
  const root = resolve(base, subdir);
  const rel = relative(base, root);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`source.subdir "${subdir}" must stay inside the repository`);
  }
  return root;
}

/**
 * Makes the client's design system available on disk. Git sources are shallow
 * cloned into .docent/sources/<client-id>, one directory per client, and are
 * only ever read.
 */
export function resolveSource(config: ClientConfig, log: (msg: string) => void = () => {}, access: SourceAccess | null = null): ResolvedSource {
  const { source } = config;
  if (source.type === "git" && source.githubAccess === "repo-connector" && !access) {
    throw new Error(`${config.client.id} is fetched through repo-connector; ingest it with ingest(), which checks the installation first. Docent never falls back to public access.`);
  }

  if (source.type === "local") {
    if (!existsSync(source.path) || !statSync(source.path).isDirectory()) {
      throw new Error(`source.path ${source.path} is not a directory`);
    }
    const root = withSubdir(source.path, source.subdir);
    if (!existsSync(root)) throw new Error(`source.subdir ${source.subdir} does not exist in ${source.path}`);
    return {
      root,
      type: "local",
      location: source.path,
      ref: null,
      commit: tryCommit(source.path),
      subdir: source.subdir ?? null,
    };
  }

  const checkout = join(DOCENT_ROOT, ".docent", "sources", config.client.id);
  if (!existsSync(join(checkout, ".git"))) {
    log(`Cloning ${source.url}${source.ref ? ` (${source.ref})` : ""}${access ? ` via ${access.via}` : ""}…`);
    mkdirSync(join(DOCENT_ROOT, ".docent", "sources"), { recursive: true });
    git(["clone", "--depth", "1", ...(source.ref ? ["--branch", source.ref] : []), "--", source.url, checkout], undefined, access);
  } else {
    log(`Updating ${source.url}${source.ref ? ` (${source.ref})` : ""}…`);
    git(["remote", "set-url", "origin", source.url], checkout);
    git(["fetch", "--depth", "1", "origin", source.ref ?? "HEAD"], checkout, access);
    git(["reset", "--hard", "FETCH_HEAD"], checkout);
    git(["clean", "-fdx"], checkout);
  }

  const root = withSubdir(checkout, source.subdir);
  if (!existsSync(root)) throw new Error(`source.subdir ${source.subdir} does not exist in ${source.url}`);
  return {
    root,
    type: "git",
    location: source.url,
    ref: source.ref ?? null,
    commit: tryCommit(checkout),
    subdir: source.subdir ?? null,
  };
}
