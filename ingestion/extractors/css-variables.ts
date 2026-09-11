/**
 * Extracts CSS custom properties, mapping selectors to theme modes via config.
 * Variables inside a Tailwind v4 `@theme` block also define utilities
 * (`--color-brand` gives `bg-brand`), so they are returned as Tailwind bindings.
 */
import postcss, { type AtRule, type ChildNode, type Container } from "postcss";
import type { GapCollector } from "../gaps.js";
import { cssVarId, cssVarRefs, type RawToken, type TailwindEntry } from "../tokens/values.js";

/** Tailwind v4 theme variable namespaces and the theme section each one feeds. Longest prefix first. */
const THEME_NAMESPACES: [string, string][] = [
  ["--font-weight-", "fontWeight"],
  ["--drop-shadow-", "dropShadow"],
  ["--breakpoint-", "screens"],
  ["--container-", "maxWidth"],
  ["--tracking-", "letterSpacing"],
  ["--leading-", "lineHeight"],
  ["--animate-", "animation"],
  ["--spacing-", "spacing"],
  ["--radius-", "borderRadius"],
  ["--shadow-", "boxShadow"],
  ["--color-", "colors"],
  ["--text-", "fontSize"],
  ["--font-", "fontFamily"],
  ["--ease-", "transitionTimingFunction"],
];
const PURE_VAR = /^var\(\s*(--[\w-]+)\s*\)$/;

const TRANSPARENT_AT_RULES = new Set(["layer"]);

export function extractCssVariables(
  file: string,
  text: string,
  modes: Record<string, string>,
  ignorePrefixes: string[],
  gaps: GapCollector,
): { tokens: RawToken[]; tailwind: TailwindEntry[] } {
  let root: postcss.Root;
  try {
    root = postcss.parse(text, { from: file });
  } catch (err) {
    gaps.add({
      severity: "error",
      kind: "parse-error",
      subject: { type: "source", id: file },
      message: `Could not parse ${file}: ${(err as Error).message}`,
      location: { file },
    });
    return { tokens: [], tailwind: [] };
  }

  const normalize = (s: string) => s.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  const modeMap = new Map(Object.entries(modes).map(([k, v]) => [normalize(k), v]));
  const tokens: RawToken[] = [];
  const tailwind: TailwindEntry[] = [];
  const unmapped = new Map<string, number>();

  root.walkDecls((decl) => {
    if (!decl.prop.startsWith("--")) return;
    if (ignorePrefixes.some((p) => decl.prop.startsWith(p))) return;

    const contexts = contextKeys(decl.parent).map(normalize);
    const mode = contexts.map((c) => modeMap.get(c)).find((m) => m !== undefined);
    const line = decl.source?.start?.line;
    if (mode === undefined) {
      const key = contexts[0] ?? "(top level)";
      if (!unmapped.has(key)) unmapped.set(key, line ?? 0);
      return;
    }
    const source = line ? { file, line } : { file };
    const value = decl.value.trim();
    if (contexts.includes("@theme")) {
      const namespace = THEME_NAMESPACES.find(([prefix]) => decl.prop.startsWith(prefix));
      const key = namespace ? decl.prop.slice(namespace[0].length) : "";
      // `--text-body--line-height` is a property of the `text-body` utility, not a utility of its own.
      if (namespace && key && !key.includes("--")) {
        // `@theme inline { --color-primary: var(--primary) }` only wires a utility to an existing token.
        // A plain `@theme` alias (`--color-brand: var(--color-brand-400)`) is a named token of its own.
        const alias = inThemeInline(decl.parent) ? value.match(PURE_VAR)?.[1] : undefined;
        tailwind.push({ section: namespace[1], key, raw: `var(${alias ?? decl.prop})`, source });
        if (alias) return;
      }
    }
    tokens.push({
      id: cssVarId(decl.prop),
      name: decl.prop,
      cssVariable: decl.prop,
      mode,
      raw: value,
      source,
      references: cssVarRefs(decl.value)
        .filter((ref) => !ignorePrefixes.some((p) => ref.startsWith(p)))
        .map(cssVarId),
    });
  });

  for (const [context, line] of unmapped) {
    gaps.add({
      severity: "warning",
      kind: "unresolvable-config-value",
      subject: { type: "source", id: file },
      detail: context,
      message: `CSS variables under "${context}" in ${file} were skipped because that selector is not mapped to a mode.`,
      location: line ? { file, line } : { file },
      suggestion: `Add "${context}" to this extractor's modes if those variables are design tokens.`,
    });
  }
  return { tokens, tailwind };
}

function inThemeInline(parent: Container | undefined): boolean {
  for (let node: ChildNode | Container | undefined = parent; node && node.type !== "root"; node = node.parent as Container | undefined) {
    if (node.type === "atrule" && (node as AtRule).name === "theme") return /\binline\b/.test((node as AtRule).params);
  }
  return false;
}

/**
 * Candidate mode keys for a declaration's container, most specific first:
 * "@media (prefers-color-scheme: dark) :root", then ":root" for a bare rule,
 * and "@theme" for Tailwind v4 theme blocks.
 */
function contextKeys(parent: Container | undefined): string[] {
  if (!parent) return [];
  const atRules: string[] = [];
  let selector: string | undefined;
  for (let node: ChildNode | Container | undefined = parent; node && node.type !== "root"; node = node.parent as Container | undefined) {
    if (node.type === "rule" && selector === undefined) selector = (node as postcss.Rule).selector;
    if (node.type === "atrule") {
      const at = node as AtRule;
      if (at.name === "theme") atRules.unshift("@theme");
      else if (!TRANSPARENT_AT_RULES.has(at.name)) atRules.unshift(`@${at.name} ${at.params}`);
    }
  }
  const selectors = selector ? selector.split(",").map((s) => s.trim()) : [];
  const prefix = atRules.join(" ");
  if (selectors.length === 0) return prefix ? [prefix] : [];
  return selectors.flatMap((s) => (prefix ? [`${prefix} ${s}`] : [s]));
}
