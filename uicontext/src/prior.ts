/**
 * Phase 3: reading the file a person has already worked on.
 *
 * A regeneration must not cost anyone their work, so everything a person can write into the file —
 * answers in the Resolution column, sections they marked `<!-- human -->`, sign-offs — is read back
 * out before the new draft is rendered, and carried across untouched. The factual sections are
 * regenerated and diffed instead, so a change shows up as a flagged line rather than a silent edit.
 */
import { existsSync, readFileSync } from "node:fs";

export const HUMAN_MARKER = "<!-- human -->";

export interface PriorQuestion {
  question: string;
  priority: string;
  resolution: string;
}

export interface Prior {
  path: string;
  markdown: string;
  /** Resolutions people wrote, by normalised question text. */
  questions: Map<string, PriorQuestion>;
  /** Sections a person marked as theirs, kept byte for byte. */
  humanSections: Map<string, string>;
  approvals: { designVersion: string; product: string; ux: string; engineering: string; reviewer: string };
  sections: Map<string, string>;
}

export interface Change {
  section: string;
  kind: "added" | "removed" | "changed";
  key: string;
  detail: string;
}

export function loadPrior(path: string): Prior | null {
  if (!existsSync(path)) return null;
  return parsePrior(path, readFileSync(path, "utf8"));
}

export function parsePrior(path: string, markdown: string): Prior {
  const sections = sectionsOf(markdown);

  const questions = new Map<string, PriorQuestion>();
  for (const cells of tableRows(sections.get("Open questions") ?? "")) {
    const [, priority, question, , , resolution] = cells;
    if (!question) continue;
    questions.set(normalise(question), { question, priority: priority ?? "", resolution: (resolution ?? "").trim() });
  }

  const humanSections = new Map<string, string>();
  for (const [heading, body] of sections) if (body.includes(HUMAN_MARKER)) humanSections.set(heading, body);

  const field = (name: string) => markdown.match(new RegExp(`^\\s*${name}:\\s*"?([^"\\n]*)"?$`, "m"))?.[1]?.trim() ?? "";
  const metadata = tableRows(sections.get("Metadata") ?? "");
  return {
    path,
    markdown,
    questions,
    humanSections,
    approvals: {
      designVersion: field("approved_design_version"),
      product: field("product"),
      ux: field("ux"),
      engineering: field("engineering"),
      reviewer: metadata.find((r) => r[0] === "Reviewer / owner")?.[1] ?? "",
    },
    sections,
  };
}

/** Tables rendered from evidence: what a regeneration is allowed to change on its own. */
const FACTUAL = ["Component inventory", "Design tokens", "Utility classes", "Props API (primary components)"];

export function diffFactual(prior: Prior, markdown: string): Change[] {
  const next = sectionsOf(markdown);
  const changes: Change[] = [];
  for (const section of FACTUAL) {
    const before = keyed(prior.sections.get(section) ?? "");
    const after = keyed(next.get(section) ?? "");
    for (const [key, row] of after) {
      const was = before.get(key);
      if (was === undefined) changes.push({ section, kind: "added", key, detail: row });
      else if (was !== row) changes.push({ section, kind: "changed", key, detail: `was ${was} — now ${row}` });
    }
    for (const [key, row] of before) if (!after.has(key)) changes.push({ section, kind: "removed", key, detail: row });
  }
  return changes;
}

/** Rows by their name, ignoring the evidence id, which renumbers whenever the inventory changes. */
function keyed(section: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const cells of tableRows(section)) {
    const content = /^[CT]-\d+$/.test(cells[0] ?? "") ? cells.slice(1) : cells;
    if (!content[0]) continue;
    // A Docent request id is new on every run. It is provenance, not a fact about the design
    // system, so comparing it would report every row as changed on an unchanged prototype.
    out.set(content[0], content.slice(1).join(" | ").replace(/\(req [0-9a-f]+\)/g, "(req …)"));
  }
  return out;
}

export function sectionsOf(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const headings = [...markdown.matchAll(/^#{1,3} +(.+?) *$/gm)];
  headings.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < headings.length ? headings[i + 1]!.index! : markdown.length;
    // Drop the horizontal rule that ends a section: it belongs to the layout, not to the content,
    // and keeping it would grow another one every time a section is carried forward.
    out.set(m[1]!, markdown.slice(start, end).trim().replace(/\n*-{3,}$/, "").trim());
  });
  return out;
}

/** Body rows of the first markdown table in a section, as cells. */
export function tableRows(section: string): string[][] {
  return section
    .split("\n")
    .filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
    .slice(1)
    .map((l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()));
}

export function normalise(question: string): string {
  return question.toLowerCase().replace(/\s+/g, " ").replace(/[?.!,;:]+$/, "").trim();
}

/** Puts a person's own sections back, byte for byte, and keeps any they added that this draft has no place for. */
export function applyHumanSections(markdown: string, prior: Prior): string {
  let out = markdown;
  const current = sectionsOf(out);
  const orphans: string[] = [];
  for (const [heading, body] of prior.humanSections) {
    const existing = current.get(heading);
    if (existing === undefined) {
      orphans.push(`## ${heading}\n\n${body}`);
      continue;
    }
    if (existing === body) continue;
    out = out.replace(existing, body);
  }
  if (!orphans.length) return out;
  const anchor = out.indexOf("\n# Addendum");
  const block = `\n${orphans.join("\n\n---\n\n")}\n\n---\n`;
  return anchor === -1 ? `${out}\n${block}` : `${out.slice(0, anchor)}\n${block}${out.slice(anchor)}`;
}
