/**
 * Extracts tokens from W3C Design Tokens Community Group JSON ($value/$type)
 * and the older Style Dictionary shape (value/type).
 */
import type { TokenType } from "../../schema/contract.js";
import type { GapCollector } from "../gaps.js";
import { lineOf } from "../files.js";
import { categoryFromName, type RawToken } from "../tokens/values.js";

const DTCG_TYPES: Record<string, TokenType> = {
  color: "color",
  dimension: "dimension",
  number: "number",
  fontFamily: "fontFamily",
  fontWeight: "fontWeight",
  duration: "duration",
  cubicBezier: "cubicBezier",
  shadow: "shadow",
};

export function extractDtcgJson(file: string, text: string, mode: string, gaps: GapCollector): RawToken[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    gaps.add({
      severity: "error",
      kind: "parse-error",
      subject: { type: "source", id: file },
      message: `Could not parse ${file}: ${(err as Error).message}`,
      location: { file },
    });
    return [];
  }

  const tokens: RawToken[] = [];
  const walk = (node: unknown, path: string[], inheritedType: string | undefined) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    const isDtcg = "$value" in obj;
    const isLegacy = !isDtcg && "value" in obj && path.length > 0;
    const groupType = typeof obj.$type === "string" ? obj.$type : inheritedType;

    if (isDtcg || isLegacy) {
      const value = isDtcg ? obj.$value : obj.value;
      const typeName = (isDtcg ? obj.$type : obj.type) ?? inheritedType;
      const description = isDtcg ? obj.$description : obj.description;
      const raw = typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value);
      const id = path.join(".");
      const needle = JSON.stringify(path[path.length - 1]);
      const token: RawToken = {
        id,
        name: id,
        cssVariable: null,
        mode,
        raw,
        source: { file, line: lineOf(text, Math.max(0, text.indexOf(needle))) },
        references: [...raw.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!),
      };
      if (typeof typeName === "string") token.declaredType = DTCG_TYPES[typeName] ?? "other";
      if (typeof description === "string" && description.trim()) token.description = description.trim();
      const category = categoryFromName(id);
      if (category) token.category = category;
      tokens.push(token);
      return;
    }
    for (const [key, child] of Object.entries(obj)) {
      if (key.startsWith("$")) continue;
      walk(child, [...path, key], groupType);
    }
  };
  walk(data, [], undefined);
  return tokens;
}
