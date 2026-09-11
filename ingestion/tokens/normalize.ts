/** Merges raw token definitions from every extractor into token contracts. */
import type { TokenContract, TokenValue } from "../../schema/contract.js";
import type { GapCollector } from "../gaps.js";
import { exampleClasses, TAILWIND_SECTIONS } from "./tailwind-classes.js";
import {
  categoryFromName,
  categoryFromType,
  cssVarId,
  cssVarRefs,
  inferFromValue,
  valueFormat,
  type RawToken,
  type TailwindEntry,
} from "./values.js";
import type { TokenUsage } from "../extractors/css-variables.js";

export interface NormalizeInput {
  raw: RawToken[];
  tailwind: TailwindEntry[];
  defaultMode: string;
  /** Concatenated token documentation, or null when none is configured. */
  tokenDocs: string | null;
  ignoreCssVariablePrefixes: string[];
  /** How token CSS uses variables, e.g. hsl(var(--x)); weaker evidence than a Tailwind binding. */
  usages?: TokenUsage[];
}

/** `var(--x)`, `hsl(var(--x))`, `hsl(var(--x) / <alpha-value>)` */
const WRAPPED_VAR = /^(?:([a-z]+)\(\s*)?var\(\s*(--[\w-]+)\s*\)(?:\s*\/\s*<alpha-value>)?\s*(\))?$/i;

export function normalizeTokens(input: NormalizeInput, gaps: GapCollector): TokenContract[] {
  const tokens = new Map<string, TokenContract>();
  const categoryHints = new Map<string, TokenContract["category"]>();

  // 1. Raw definitions (CSS variables, token JSON), later definitions win like the cascade.
  for (const raw of input.raw) {
    let token = tokens.get(raw.id);
    if (!token) {
      token = {
        id: raw.id,
        name: raw.name,
        cssVariable: raw.cssVariable,
        type: "unknown",
        typeEvidence: null,
        category: "uncategorized",
        values: {},
        references: [],
        tailwind: [],
        description: null,
        role: null,
        documented: null,
      };
      tokens.set(raw.id, token);
    }
    const existing = token.values[raw.mode];
    if (existing && existing.raw !== raw.raw) {
      gaps.add({
        severity: "warning",
        kind: "conflicting-token-definition",
        subject: { type: "token", id: raw.id },
        detail: raw.mode,
        message: `${raw.name} is defined more than once for mode "${raw.mode}" with different values (${existing.source.file}${existing.source.line ? `:${existing.source.line}` : ""} and ${raw.source.file}${raw.source.line ? `:${raw.source.line}` : ""}); the later definition is used.`,
        location: raw.source,
      });
    }
    const value: TokenValue = { raw: raw.raw, source: raw.source };
    const format = valueFormat(raw.raw);
    if (format) value.format = format;
    token.values[raw.mode] = value;
    token.references = unique([...token.references, ...raw.references]);
    if (raw.declaredType && token.typeEvidence !== "declared") {
      token.type = raw.declaredType;
      token.typeEvidence = "declared";
    }
    if (raw.description && !token.description) token.description = raw.description;
    if (raw.category) categoryHints.set(raw.id, raw.category);
  }

  for (const token of tokens.values()) {
    if (token.typeEvidence) continue;
    const inferred = Object.values(token.values).map((v) => inferFromValue(v.raw)).find(Boolean);
    if (inferred) {
      token.type = inferred.type;
      token.typeEvidence = "value-format";
    }
  }

  // 2. Tailwind theme entries: bind to the variable they wrap, or stand alone.
  for (const entry of input.tailwind) {
    const section = TAILWIND_SECTIONS[entry.section];
    const binding = {
      section: entry.section,
      key: entry.key,
      exampleClasses: exampleClasses(entry.section, entry.key),
      source: entry.source,
    };
    const wrapped = entry.raw.trim().match(WRAPPED_VAR);
    const variable = wrapped && Boolean(wrapped[1]) === Boolean(wrapped[3]) ? wrapped[2]! : undefined;
    const target = variable ? tokens.get(cssVarId(variable)) : undefined;

    if (target) {
      target.tailwind.push(binding);
      // A declared $type wins; otherwise the first Tailwind section beats value syntax.
      if (section?.type && target.typeEvidence !== "declared" && target.typeEvidence !== "tailwind-section") {
        target.type = section.type;
        target.typeEvidence = "tailwind-section";
      }
      continue;
    }

    const id = `tailwind.${entry.section}.${entry.key}`;
    const references = cssVarRefs(entry.raw)
      .filter((v) => !input.ignoreCssVariablePrefixes.some((p) => v.startsWith(p)))
      .map(cssVarId);
    const inferred = inferFromValue(entry.raw);
    const value: TokenValue = { raw: entry.raw, source: entry.source };
    const format = valueFormat(entry.raw);
    if (format) value.format = format;
    tokens.set(id, {
      id,
      name: `${entry.section}.${entry.key}`,
      cssVariable: null,
      type: section?.type ?? inferred?.type ?? "unknown",
      typeEvidence: section?.type ? "tailwind-section" : inferred ? "value-format" : null,
      category: "uncategorized",
      values: { [input.defaultMode]: value },
      references,
      tailwind: [binding],
      description: null,
      role: null,
      documented: null,
    });
  }

  for (const usage of input.usages ?? []) {
    const token = tokens.get(cssVarId(usage.variable));
    if (token && !token.typeEvidence) {
      token.type = usage.type;
      token.typeEvidence = "css-usage";
    }
  }

  const all = [...tokens.values()];

  // 3. Aliases inherit the type of the token they point at.
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const token of all) {
      if (token.type !== "unknown" || token.references.length !== 1) continue;
      const pureAlias = Object.values(token.values).every((v) => /^(var\(\s*--[\w-]+\s*\)|\{[^{}]+\})$/.test(v.raw.trim()));
      const target = tokens.get(token.references[0]!);
      if (pureAlias && target && target.type !== "unknown") {
        token.type = target.type;
        token.typeEvidence = target.typeEvidence;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 4. Categories and gaps.
  const anyDefaultMode = all.some((t) => t.values[input.defaultMode]);
  if (all.length > 0 && !anyDefaultMode) {
    gaps.add({
      severity: "warning",
      kind: "unresolvable-config-value",
      subject: { type: "ingestion", id: "defaultMode" },
      message: `ingestion.defaultMode is "${input.defaultMode}", but no token has a value in that mode (modes found: ${unique(all.flatMap((t) => Object.keys(t.values))).join(", ")}).`,
      suggestion: "Set ingestion.defaultMode to the base theme mode.",
    });
  }

  for (const token of all) {
    const section = token.tailwind.map((b) => TAILWIND_SECTIONS[b.section]?.category).find(Boolean);
    token.category =
      section ?? categoryHints.get(token.id) ?? categoryFromName(token.name) ?? categoryFromType(token.type) ?? "uncategorized";

    for (const ref of token.references) {
      if (tokens.has(ref)) continue;
      gaps.add({
        severity: "error",
        kind: "unresolved-token-reference",
        subject: { type: "token", id: token.id },
        detail: ref,
        message: `${token.name} references "${ref}", which is not defined as a token.`,
        location: Object.values(token.values)[0]?.source,
        suggestion: `Define ${ref} or correct the reference.`,
      });
    }

    if (anyDefaultMode && !token.values[input.defaultMode]) {
      gaps.add({
        severity: "warning",
        kind: "missing-default-mode",
        subject: { type: "token", id: token.id },
        message: `${token.name} is only defined for ${Object.keys(token.values).join(", ")}, not the default mode "${input.defaultMode}".`,
        location: Object.values(token.values)[0]?.source,
      });
    }

    if (token.type === "unknown") {
      gaps.add({
        severity: "info",
        kind: "unknown-token-type",
        subject: { type: "token", id: token.id },
        message: `The type of ${token.name} (${Object.values(token.values)[0]?.raw}) cannot be determined from its value, a declared $type, or a Tailwind binding.`,
        location: Object.values(token.values)[0]?.source,
        suggestion: "Bind it in the Tailwind theme, declare a $type, or use a self-describing value.",
      });
    }

    if (input.tokenDocs !== null) {
      const needles = [token.cssVariable, token.cssVariable ? null : token.name, ...token.tailwind.flatMap((b) => b.exampleClasses)].filter(
        (n): n is string => Boolean(n) && !n!.endsWith(":"),
      );
      token.documented = needles.some((n) => mentions(input.tokenDocs!, n));
      if (!token.documented) {
        gaps.add({
          severity: "info",
          kind: "undocumented-token",
          subject: { type: "token", id: token.id },
          message: `${token.name} is not mentioned in the configured token documentation.`,
          location: Object.values(token.values)[0]?.source,
        });
      }
    }
  }

  return all.sort((a, b) => a.id.localeCompare(b.id));
}

function mentions(text: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
