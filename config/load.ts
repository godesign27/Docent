import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ClientConfig } from "./schema.js";

export const DOCENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLIENTS_DIR = join(DOCENT_ROOT, "config", "clients");

export interface LoadedConfig {
  config: ClientConfig;
  /** Absolute path of the config file that was loaded. */
  path: string;
}

export class ConfigError extends Error {}

export function resolveConfigPath(opts: { client?: string; config?: string }): string {
  if (opts.config) return resolve(opts.config);
  if (opts.client) {
    for (const ext of [".yaml", ".yml", ".json"]) {
      const candidate = join(CLIENTS_DIR, opts.client + ext);
      if (existsSync(candidate)) return candidate;
    }
    throw new ConfigError(`No config found for client "${opts.client}" in ${CLIENTS_DIR}`);
  }
  throw new ConfigError("Pass --client <id> or --config <path>");
}

export function loadConfig(path: string): LoadedConfig {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`Could not read ${path}: ${(err as Error).message}`);
  }
  const parsed = ClientConfig.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid config ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data;
  if (config.source.type === "local" && !isAbsolute(config.source.path)) {
    config.source.path = resolve(dirname(path), config.source.path);
  }
  return { config, path };
}

export function outputDir(config: ClientConfig): string {
  return resolve(DOCENT_ROOT, config.output.dir ?? join("contracts", config.client.id));
}
