import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { glob } from "tinyglobby";

const ALWAYS_IGNORED = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"];

/**
 * Glob for files inside the design-system root. Patterns may not escape the
 * root, and symlinks pointing outside it are dropped: ingestion only ever
 * reads what the config scoped it to.
 */
export async function findFiles(root: string, include: string[], exclude: string[] = []): Promise<string[]> {
  for (const pattern of [...include, ...exclude]) {
    if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
      throw new Error(`Glob "${pattern}" must be relative to the design-system root and may not contain ".."`);
    }
  }
  const realRoot = realpathSync(root);
  const files = await glob(include, {
    cwd: root,
    ignore: [...ALWAYS_IGNORED, ...exclude],
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  return files
    .filter((file) => {
      const rel = relative(realRoot, realpathSync(join(root, file)));
      return !rel.startsWith("..") && !isAbsolute(rel);
    })
    .map((file) => file.split(sep).join("/"))
    .sort();
}

export function readText(root: string, file: string): string {
  return readFileSync(join(root, file), "utf8");
}

export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
