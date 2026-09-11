/** Reads the client's own component inventory, if they keep one. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ManifestConfig } from "../config/schema.js";
import { lineOf, readText } from "./files.js";
import type { GapCollector } from "./gaps.js";

export interface ManifestEntry {
  id: string | null;
  name: string | null;
  files: string[];
  status: string | null;
  category: string | null;
  importPath: string | null;
  notes: Record<string, string>;
  line: number | undefined;
}

export function loadManifest(root: string, config: ManifestConfig, gaps: GapCollector): ManifestEntry[] | null {
  const fail = (message: string) => {
    gaps.add({
      severity: "error",
      kind: "unresolvable-config-value",
      subject: { type: "ingestion", id: "manifest" },
      message,
      location: { file: config.path },
    });
    return null;
  };

  if (!existsSync(join(root, config.path))) return fail(`Manifest ${config.path} does not exist.`);
  const text = readText(root, config.path);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return fail(`Manifest ${config.path} is not valid JSON: ${(err as Error).message}`);
  }

  const items = config.itemsPath ? getPath(data, config.itemsPath) : data;
  if (!Array.isArray(items)) return fail(`"${config.itemsPath}" in ${config.path} is not an array.`);

  const { fields } = config;
  const str = (item: unknown, field: string | undefined) => {
    const v = field ? getPath(item, field) : undefined;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  return items.map((item) => {
    const id = str(item, fields.id);
    const rawFiles = fields.files ? getPath(item, fields.files) : undefined;
    const notes: Record<string, string> = {};
    for (const field of fields.notes) {
      const v = str(item, field);
      if (v) notes[field] = v;
    }
    const anchor = id ? text.indexOf(JSON.stringify(id)) : -1;
    return {
      id,
      name: str(item, fields.name),
      files: (Array.isArray(rawFiles) ? rawFiles : typeof rawFiles === "string" ? [rawFiles] : []).filter(
        (f): f is string => typeof f === "string",
      ),
      status: str(item, fields.status),
      category: str(item, fields.category),
      importPath: str(item, fields.importPath),
      notes,
      line: anchor >= 0 ? lineOf(text, anchor) : undefined,
    };
  });
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), value);
}
