/**
 * Works out what a consuming project needs to install each component: the
 * component's own files, the local files they import (utils, hooks), the other
 * components they import, and npm packages with versions. Also snapshots those
 * files, hashed, so Docent can later hand out exactly what was ingested.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import ts from "typescript";
import type { ComponentContract, ComponentInstall, Foundation, PackageRequirement, SourceFile } from "../schema/contract.js";
import { findFiles, readText } from "./files.js";
import type { GapCollector } from "./gaps.js";
import { resolveSpecifier, type PathAlias } from "./import-paths.js";

export interface DistributionInput {
  root: string;
  components: ComponentContract[];
  aliases: PathAlias[];
  foundation: { files: string[]; packages: string[] } | undefined;
  packageJson: string;
  scanned: Set<string>;
  gaps: GapCollector;
}

export interface Distribution {
  installs: Map<string, ComponentInstall>;
  sourceFiles: SourceFile[];
  foundation: Foundation | null;
  /** path -> file content, for every entry in sourceFiles */
  sources: Record<string, string>;
}

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".css", ".json"];
/** The host app provides these; pinning them from the design system could downgrade the consumer. */
const HOST_PACKAGES = new Set(["react", "react-dom"]);
const BUILTINS = new Set(builtinModules);

export async function buildDistribution(input: DistributionInput): Promise<Distribution> {
  const { root, components, aliases, gaps } = input;
  const realRoot = realpathSync(root);
  const manifest = readPackageJson(root, input.packageJson, gaps);
  const componentByFile = new Map(components.flatMap((c) => c.files.map((f) => [f, c.id] as const)));
  const sources: Record<string, string> = {};
  const roles = new Map<string, SourceFile["role"]>();

  const read = (file: string) => (sources[file] ??= readText(root, file));

  const requirement = (name: string, owner: { type: "component" | "source"; id: string }): PackageRequirement => {
    for (const [section, dev] of [["dependencies", false], ["peerDependencies", false], ["devDependencies", true]] as const) {
      const version = manifest?.[section]?.[name];
      if (typeof version === "string") return { name, version, dev };
    }
    if (manifest) {
      gaps.add({
        severity: "warning",
        kind: "dependency-not-declared",
        subject: owner,
        detail: name,
        message: `${owner.id} imports "${name}", which ${input.packageJson} does not declare, so no version can be given to consumers.`,
        suggestion: `Add ${name} to ${input.packageJson}.`,
      });
    }
    return { name, version: null, dev: false };
  };

  const resolveLocal = (from: string, specifier: string): string | null => {
    const base = resolveSpecifier(from, specifier, aliases);
    if (base === null) return null;
    for (const candidate of [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => `${base}/index${e}`)]) {
      const abs = join(root, candidate);
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      const rel = relative(realRoot, realpathSync(abs));
      if (rel.startsWith("..") || isAbsolute(rel)) return null;
      return rel.split("\\").join("/");
    }
    return null;
  };

  /** Follows local imports from the start files; returns what they need beyond themselves. */
  const walk = (start: string[], owner: { type: "component" | "source"; id: string }, walkRole: "component" | "foundation") => {
    const own = new Set(start);
    const support = new Set<string>();
    const componentDeps = new Set<string>();
    const packages = new Map<string, PackageRequirement>();
    const queue = [...start];

    while (queue.length > 0) {
      const file = queue.shift()!;
      input.scanned.add(file);
      const role: SourceFile["role"] = componentByFile.has(file) ? "component" : walkRole === "foundation" ? "foundation" : "support";
      if (!roles.has(file) || role === "component") roles.set(file, role);

      for (const specifier of importSpecifiers(file, read(file))) {
        const isLocal = specifier.startsWith(".") || aliases.some((a) => specifier.startsWith(a.alias)) || /^[~#]\/|^@\//.test(specifier);
        if (!isLocal) {
          if (specifier.startsWith("node:") || /^(https?|data):/.test(specifier)) continue;
          const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
          if (BUILTINS.has(name) || HOST_PACKAGES.has(name) || packages.has(name)) continue;
          packages.set(name, requirement(name, owner));
          continue;
        }
        const target = resolveLocal(file, specifier);
        if (!target) {
          gaps.add({
            severity: "warning",
            kind: "unresolved-import",
            subject: owner,
            detail: `${file}:${specifier}`,
            message: `${file} imports "${specifier}", which does not resolve to a file in the repository, so it cannot be delivered with ${owner.id}.`,
            location: { file },
          });
          continue;
        }
        if (own.has(target) || support.has(target)) continue;
        const dependency = componentByFile.get(target);
        if (dependency && walkRole === "component") {
          componentDeps.add(dependency);
          continue;
        }
        support.add(target);
        queue.push(target);
      }
    }
    return { support, componentDeps, packages };
  };

  const installs = new Map<string, ComponentInstall>();
  for (const component of components) {
    const result = walk(component.files, { type: "component", id: component.id }, "component");
    result.componentDeps.delete(component.id);
    installs.set(component.id, {
      supportFiles: [...result.support].sort(),
      componentDependencies: [...result.componentDeps].sort(),
      packages: [...result.packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
    });
  }

  let foundation: Foundation | null = null;
  if (input.foundation) {
    // Config order is import order for stylesheets (tokens before the files that use them), so it is kept.
    const files: string[] = [];
    for (const pattern of input.foundation.files) {
      for (const file of await findFiles(root, [pattern])) if (!files.includes(file)) files.push(file);
    }
    if (files.length === 0) {
      gaps.add({
        severity: "error",
        kind: "foundation-not-configured",
        subject: { type: "ingestion", id: "foundation" },
        message: `ingestion.foundation.files (${input.foundation.files.join(", ")}) matched no files, so consumers cannot be given the theme and build setup.`,
      });
    }
    const result = walk(files, { type: "source", id: "foundation" }, "foundation");
    for (const name of input.foundation.packages) {
      if (!result.packages.has(name)) result.packages.set(name, requirement(name, { type: "source", id: "foundation" }));
    }
    foundation = {
      files: [...files, ...[...result.support].filter((f) => !files.includes(f)).sort()],
      packages: [...result.packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
      pathAliases: aliases.map((a) => ({ alias: a.alias, target: a.target })),
    };
  } else {
    gaps.add({
      severity: "info",
      kind: "foundation-not-configured",
      subject: { type: "ingestion", id: "foundation" },
      message: "No ingestion.foundation is configured, so a new project fetching components gets no theme tokens or Tailwind setup and components may render unstyled.",
      suggestion: "Configure ingestion.foundation.files with the token CSS and Tailwind config.",
    });
  }

  const sourceFiles: SourceFile[] = Object.keys(sources)
    .filter((path) => roles.has(path))
    .sort()
    .map((path) => ({
      path,
      sha256: sha256(sources[path]!),
      bytes: Buffer.byteLength(sources[path]!),
      role: roles.get(path)!,
    }));
  const delivered = Object.fromEntries(sourceFiles.map((f) => [f.path, sources[f.path]!]));

  return { installs, sourceFiles, foundation, sources: delivered };
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function importSpecifiers(file: string, text: string): string[] {
  if (file.endsWith(".css")) {
    return [...text.matchAll(/@(?:import|plugin)\s+(?:url\(\s*)?["']([^"']+)["']/g)].map((m) => m[1]!);
  }
  if (file.endsWith(".json")) return [];
  return ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
}

type PackageManifest = Partial<Record<"dependencies" | "devDependencies" | "peerDependencies", Record<string, string>>>;

function readPackageJson(root: string, path: string, gaps: GapCollector): PackageManifest | null {
  const abs = join(root, path);
  if (!existsSync(abs)) {
    gaps.add({
      severity: "warning",
      kind: "unresolvable-config-value",
      subject: { type: "ingestion", id: "packageJson" },
      message: `${path} not found, so package versions cannot be given to consumers.`,
    });
    return null;
  }
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as PackageManifest;
  } catch (err) {
    gaps.add({
      severity: "warning",
      kind: "unresolvable-config-value",
      subject: { type: "ingestion", id: "packageJson" },
      message: `${path} is not valid JSON: ${(err as Error).message}`,
    });
    return null;
  }
}
