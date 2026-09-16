/**
 * The written inputs a draft is made from: the story, the companion intent-ux and the prototype's
 * own source. Everything here is read as text. Nothing in this file knows any design system —
 * design-system facts only ever come from evidence.json.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface Document {
  path: string;
  /** Front matter (--- … ---), or the first ```yaml block for files that use one. */
  data: Record<string, unknown>;
  /** Text under each "## " heading, in order, sub-headings included. */
  sections: { heading: string; body: string }[];
  /** Rows of the Metadata table, by field name. */
  fields: Record<string, string>;
  text: string;
}

export function loadDocument(path: string): Document {
  const text = readFileSync(path, "utf8");
  const frontMatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const yamlBlock = text.match(/```yaml\r?\n([\s\S]*?)```/);
  const raw = frontMatter?.[1] ?? yamlBlock?.[1];
  let data: Record<string, unknown> = {};
  if (raw) {
    const parsed = parseYaml(raw) as unknown;
    if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
  }

  const sections: Document["sections"] = [];
  const headings = [...text.matchAll(/^## +(.+?) *$/gm)];
  headings.forEach((match, i) => {
    const start = match.index! + match[0].length;
    const end = i + 1 < headings.length ? headings[i + 1]!.index! : text.length;
    sections.push({ heading: match[1]!, body: text.slice(start, end).trim() });
  });

  const metadata = sections.find((s) => s.heading.toLowerCase() === "metadata");
  return { path, data, sections, fields: metadata ? tableFields(metadata.body) : {}, text };
}

/** Field → value from a two-column "| Field | Value |" table, ignoring the header and rule rows. */
export function tableFields(markdown: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of markdown.split("\n")) {
    const cells = line.match(/^\s*\|(.+)\|\s*$/)?.[1]?.split("|");
    if (!cells || cells.length !== 2) continue;
    const [field, value] = cells.map((c) => c.trim());
    if (!field || /^-+:?$|^:?-+/.test(field) || field === "Field") continue;
    fields[field] = value ?? "";
  }
  return fields;
}

export interface HandoffName {
  product: string;
  feature: string;
  id: string;
  /** "{product}_{feature}_{id}" — the prefix every artifact in the set shares. */
  prefix: string;
  uicontext: string;
  intentUx: string;
  implementationPlan: string;
}

/** The naming convention, taken from the companion intent-ux file rather than guessed. */
export function handoffName(intentUxPath: string): HandoffName {
  const file = basename(intentUxPath);
  const match = file.match(/^(.+?)_(.+?)_(.+?)_intent-ux\.md$/);
  if (!match) {
    throw new Error(`The intent-ux file must be named {product}_{feature}_{id}_intent-ux.md, so the set shares one prefix; got "${file}".`);
  }
  const [, product, feature, id] = match as unknown as [string, string, string, string];
  const prefix = `${product}_${feature}_${id}`;
  return { product, feature, id, prefix, uicontext: `${prefix}_uicontext.md`, intentUx: file, implementationPlan: `${prefix}_implementation-plan.md` };
}

export interface PrototypeSource {
  file: string;
  text: string;
}

/** The prototype's own files, as the evidence run scanned them. */
export function loadPrototype(root: string, files: string[]): PrototypeSource[] {
  return files.map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
}

export interface Inputs {
  story: Document;
  intentUx: Document;
  name: HandoffName;
  prototype: PrototypeSource[];
}
