import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
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

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
export function resolveSource(config: ClientConfig, log: (msg: string) => void = () => {}): ResolvedSource {
  const { source } = config;

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
    log(`Cloning ${source.url}${source.ref ? ` (${source.ref})` : ""}…`);
    mkdirSync(join(DOCENT_ROOT, ".docent", "sources"), { recursive: true });
    git(["clone", "--depth", "1", ...(source.ref ? ["--branch", source.ref] : []), "--", source.url, checkout]);
  } else {
    log(`Updating ${source.url}${source.ref ? ` (${source.ref})` : ""}…`);
    git(["remote", "set-url", "origin", source.url], checkout);
    git(["fetch", "--depth", "1", "origin", source.ref ?? "HEAD"], checkout);
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
