/** Derives component import paths from the repo's own tsconfig/jsconfig path aliases. */
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

export interface PathAlias {
  alias: string; // "@/"
  target: string; // "src/"
}

export function loadPathAliases(root: string): PathAlias[] {
  for (const name of ["tsconfig.json", "tsconfig.app.json", "jsconfig.json"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const { config } = ts.readConfigFile(path, ts.sys.readFile);
    const options = config?.compilerOptions;
    if (!options?.paths) continue;
    const baseUrl: string = options.baseUrl ?? ".";
    const aliases: PathAlias[] = [];
    for (const [pattern, targets] of Object.entries(options.paths as Record<string, string[]>)) {
      const target = targets[0];
      if (!pattern.endsWith("/*") || !target?.endsWith("/*")) continue;
      const normalized = posix.normalize(posix.join(baseUrl, target.slice(0, -1)));
      aliases.push({ alias: pattern.slice(0, -1), target: normalized === "./" || normalized === "." ? "" : normalized.replace(/^\.\//, "") });
    }
    if (aliases.length > 0) return aliases.sort((a, b) => b.target.length - a.target.length);
  }
  return [];
}

export function importPathFromAliases(file: string, aliases: PathAlias[]): string | null {
  const alias = aliases.find((a) => file.startsWith(a.target));
  if (!alias) return null;
  return (alias.alias + file.slice(alias.target.length)).replace(/\.[jt]sx?$/, "").replace(/\/index$/, "");
}

/** Resolves a relative or aliased import to a repo-relative path without extension. */
export function resolveSpecifier(fromFile: string, specifier: string, aliases: PathAlias[]): string | null {
  if (specifier.startsWith(".")) return posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const alias = aliases.find((a) => specifier.startsWith(a.alias));
  return alias ? alias.target + specifier.slice(alias.alias.length) : null;
}

export function importPathFromTemplate(file: string, template: string): string {
  const path = file.replace(/\.[jt]sx?$/, "");
  const basename = path.replace(/^.*\//, "");
  return template.replaceAll("{path}", path).replaceAll("{basename}", basename);
}
