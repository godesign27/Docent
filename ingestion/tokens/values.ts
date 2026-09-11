import type { SourceLocation, TokenCategory, TokenType } from "../../schema/contract.js";

/** A single token definition as found in one file, before normalization. */
export interface RawToken {
  id: string;
  name: string;
  cssVariable: string | null;
  mode: string;
  raw: string;
  source: SourceLocation;
  declaredType?: TokenType;
  category?: TokenCategory;
  description?: string;
  references: string[];
}

/** One leaf of a Tailwind theme, before it is bound to a token. */
export interface TailwindEntry {
  section: string;
  key: string;
  raw: string;
  source: SourceLocation;
}

const COLOR_FUNCTIONS = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const HSL_CHANNELS = /^-?\d*\.?\d+(deg)?\s+\d*\.?\d+%\s+\d*\.?\d+%(\s*\/\s*\d*\.?\d+%?)?$/;

/** Infers a type only when the value's own syntax makes it unambiguous. */
export function inferFromValue(raw: string): { type: TokenType; format?: string } | null {
  const v = raw.trim();
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return { type: "color", format: "hex" };
  const fn = v.match(COLOR_FUNCTIONS);
  if (fn) return { type: "color", format: fn[1]!.toLowerCase() };
  if (HSL_CHANNELS.test(v)) return null; // encoding is recognizable, but only usage says it is a color
  if (/^-?\d*\.?\d+(px|rem|em|%|vh|vw|vmin|vmax|ch|ex|pt)$/.test(v)) return { type: "dimension" };
  if (/^-?\d*\.?\d+m?s$/.test(v)) return { type: "duration" };
  if (/^cubic-bezier\(/.test(v)) return { type: "cubicBezier" };
  if (/^-?\d*\.?\d+$/.test(v)) return { type: "number" };
  return null;
}

export function valueFormat(raw: string): string | undefined {
  if (HSL_CHANNELS.test(raw.trim())) return "hsl-channels";
  return inferFromValue(raw)?.format;
}

/** Names of CSS custom properties referenced via var(--name). */
export function cssVarRefs(raw: string): string[] {
  return [...raw.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!);
}

export function cssVarId(name: string): string {
  return name.replace(/^--/, "");
}

const CATEGORY_WORDS: [RegExp, TokenCategory][] = [
  [/^(colou?rs?|palette)$/i, "color"],
  [/^(font|fonts|typography|type|text|leading|tracking|letter-?spacing|line-?height)$/i, "typography"],
  [/^(space|spacing|spacings|size|sizes|sizing|gap)$/i, "spacing"],
  [/^(radius|radii|rounded|border-?radius|corner)$/i, "radius"],
  [/^(shadow|shadows|elevation|box-?shadow)$/i, "elevation"],
  [/^(motion|animation|animate|duration|easing|ease|transition)$/i, "motion"],
  [/^(breakpoint|breakpoints|screen|screens)$/i, "breakpoint"],
];

/** Category from an authored name segment, e.g. --radius or spacing.4. */
export function categoryFromName(name: string): TokenCategory | undefined {
  const first = name.replace(/^--/, "").split(/[.\-_/]/)[0] ?? "";
  return CATEGORY_WORDS.find(([re]) => re.test(first))?.[1];
}

export function categoryFromType(type: TokenType): TokenCategory | undefined {
  switch (type) {
    case "color":
      return "color";
    case "fontFamily":
    case "fontWeight":
      return "typography";
    case "shadow":
      return "elevation";
    case "duration":
    case "cubicBezier":
    case "animation":
      return "motion";
    default:
      return undefined;
  }
}
