/**
 * Finds per-component documentation in markdown by exact heading or file-name
 * match. Content is attached raw; nothing is summarized or inferred.
 */
import type { ComponentDocs } from "../schema/contract.js";

export interface MarkdownFile {
  file: string;
  text: string;
  sections: { heading: string; level: number; content: string }[];
}

export function parseMarkdown(file: string, text: string): MarkdownFile {
  const lines = text.split(/\r?\n/);
  const headings: { heading: string; level: number; index: number }[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) fence = fence === null ? f[1]! : line.trim().startsWith(fence) ? null : fence;
    if (fence !== null) return;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) headings.push({ heading: h[2]!, level: h[1]!.length, index });
  });
  const sections = headings.map((h, i) => {
    const end = headings.slice(i + 1).find((next) => next.level <= h.level)?.index ?? lines.length;
    return { heading: h.heading, level: h.level, content: lines.slice(h.index, end).join("\n").trim() };
  });
  return { file, text, sections };
}

export function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function findComponentDocs(files: MarkdownFile[], candidates: string[]): ComponentDocs[] {
  const keys = new Set(candidates.map(normalizeKey).filter(Boolean));
  const docs: ComponentDocs[] = [];
  for (const md of files) {
    const base = md.file.replace(/^.*\//, "").replace(/\.mdx?$/i, "");
    if (keys.has(normalizeKey(base))) {
      docs.push({ file: md.file, heading: md.sections[0]?.heading ?? base, content: md.text.trim() });
      continue;
    }
    for (const section of md.sections) {
      // Headings may name the file rather than the component: "`button.tsx`".
      const heading = section.heading.replace(/\.(tsx|jsx|ts|js|vue|svelte)\b/gi, "");
      if (keys.has(normalizeKey(heading))) {
        docs.push({ file: md.file, heading: section.heading, content: section.content });
      }
    }
  }
  return docs;
}
