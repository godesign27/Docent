/**
 * Maps Tailwind theme sections to utility classes, so a component's class
 * strings can be traced back to the design tokens they use.
 */
import type { TokenCategory, TokenContract, TokenType } from "../../schema/contract.js";

interface SectionInfo {
  type?: TokenType;
  category: TokenCategory;
  prefixes: string[];
}

const SIDES = ["", "-x", "-y", "-t", "-r", "-b", "-l", "-s", "-e"];
const CORNERS = ["", "-t", "-r", "-b", "-l", "-s", "-e", "-tl", "-tr", "-br", "-bl", "-ss", "-se", "-ee", "-es"];
const COLOR_PREFIXES = [
  "bg", "text", ...SIDES.map((s) => `border${s}`), "ring", "ring-offset", "outline", "fill", "stroke",
  "divide", "placeholder", "accent", "caret", "decoration", "shadow", "from", "via", "to",
];
const SPACING_PREFIXES = [
  "p", "px", "py", "pt", "pr", "pb", "pl", "ps", "pe", "m", "mx", "my", "mt", "mr", "mb", "ml", "ms", "me",
  "gap", "gap-x", "gap-y", "space-x", "space-y", "w", "h", "size", "min-w", "min-h", "max-w", "max-h",
  "inset", "inset-x", "inset-y", "top", "right", "bottom", "left", "start", "end", "translate-x", "translate-y",
  "scroll-m", "scroll-p", "basis",
];

export const TAILWIND_SECTIONS: Record<string, SectionInfo> = {
  colors: { type: "color", category: "color", prefixes: COLOR_PREFIXES },
  backgroundColor: { type: "color", category: "color", prefixes: ["bg"] },
  textColor: { type: "color", category: "color", prefixes: ["text"] },
  borderColor: { type: "color", category: "color", prefixes: SIDES.map((s) => `border${s}`) },
  ringColor: { type: "color", category: "color", prefixes: ["ring"] },
  borderRadius: { type: "dimension", category: "radius", prefixes: CORNERS.map((c) => `rounded${c}`) },
  spacing: { type: "dimension", category: "spacing", prefixes: SPACING_PREFIXES },
  width: { type: "dimension", category: "layout", prefixes: ["w"] },
  height: { type: "dimension", category: "layout", prefixes: ["h"] },
  maxWidth: { type: "dimension", category: "layout", prefixes: ["max-w"] },
  minWidth: { type: "dimension", category: "layout", prefixes: ["min-w"] },
  maxHeight: { type: "dimension", category: "layout", prefixes: ["max-h"] },
  fontFamily: { type: "fontFamily", category: "typography", prefixes: ["font"] },
  fontSize: { type: "dimension", category: "typography", prefixes: ["text"] },
  fontWeight: { type: "fontWeight", category: "typography", prefixes: ["font"] },
  lineHeight: { category: "typography", prefixes: ["leading"] },
  letterSpacing: { type: "dimension", category: "typography", prefixes: ["tracking"] },
  boxShadow: { type: "shadow", category: "elevation", prefixes: ["shadow"] },
  dropShadow: { type: "shadow", category: "elevation", prefixes: ["drop-shadow"] },
  animation: { type: "animation", category: "motion", prefixes: ["animate"] },
  transitionDuration: { type: "duration", category: "motion", prefixes: ["duration"] },
  transitionTimingFunction: { category: "motion", prefixes: ["ease"] },
  screens: { type: "dimension", category: "breakpoint", prefixes: [] },
  zIndex: { type: "number", category: "layout", prefixes: ["z"] },
  opacity: { type: "number", category: "other", prefixes: ["opacity"] },
  borderWidth: { type: "dimension", category: "other", prefixes: SIDES.map((s) => `border${s}`) },
};

export function classFor(prefix: string, key: string): string {
  return key === "DEFAULT" ? prefix : `${prefix}-${key}`;
}

export function exampleClasses(section: string, key: string): string[] {
  if (section === "screens") return [`${key}:`];
  return (TAILWIND_SECTIONS[section]?.prefixes ?? []).slice(0, 3).map((p) => classFor(p, key));
}

export const PALETTE = new RegExp(
  `^(${COLOR_PREFIXES.join("|")})-(black|white|(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|[1-9]00|950))$`,
);
export const ARBITRARY_COLOR = new RegExp(`^(${COLOR_PREFIXES.join("|")})-\\[(#[0-9a-fA-F]{3,8}|(rgba?|hsla?|oklch|oklab)\\((?!.*var\\().*\\))\\]$`);

/** What one utility class is, as far as the design system is concerned. */
export interface ClassVerdict {
  class: string;
  /** The token the class applies, when it applies one. */
  token: string | null;
  kind: "token" | "palette" | "arbitrary-color" | "unknown-variable" | "unbound";
}

export interface ClassAnalysis {
  tokenRefs: Set<string>;
  nonTokenValues: Map<string, number>;
  unknownVariables: Map<string, number>;
}

export class ClassIndex {
  private readonly byClass = new Map<string, string>();
  private readonly byVariable = new Map<string, string>();

  constructor(tokens: TokenContract[], private readonly ignoredVariablePrefixes: string[]) {
    for (const token of tokens) {
      if (token.cssVariable) this.byVariable.set(token.cssVariable, token.id);
      for (const binding of token.tailwind) {
        for (const prefix of TAILWIND_SECTIONS[binding.section]?.prefixes ?? []) {
          this.byClass.set(classFor(prefix, binding.key), token.id);
        }
      }
    }
  }

  get hasTailwindBindings(): boolean {
    return this.byClass.size > 0;
  }

  /** `hover:bg-primary/90` → token primary; `bg-slate-100` → palette; `gap-3` → unbound (not a design-system token). */
  classify(cls: string): ClassVerdict {
    const utility = lastSegment(cls).replace(/^!/, "").replace(/^-/, "");
    const stem = utility.includes("[") ? utility : utility.replace(/\/[\w.]+$/, "");
    const bound = this.byClass.get(stem);
    if (bound) return { class: cls, token: bound, kind: "token" };
    const variables = (utility.match(/--[\w-]+/g) ?? []).filter((v) => !this.ignoredVariablePrefixes.some((p) => v.startsWith(p)));
    if (variables.length) {
      const id = variables.map((v) => this.byVariable.get(v)).find(Boolean);
      return id ? { class: cls, token: id, kind: "token" } : { class: cls, token: null, kind: "unknown-variable" };
    }
    if (PALETTE.test(stem)) return { class: cls, token: null, kind: "palette" };
    if (ARBITRARY_COLOR.test(stem)) return { class: cls, token: null, kind: "arbitrary-color" };
    return { class: cls, token: null, kind: "unbound" };
  }

  analyze(classStrings: { value: string; line: number }[]): ClassAnalysis {
    const result: ClassAnalysis = { tokenRefs: new Set(), nonTokenValues: new Map(), unknownVariables: new Map() };
    for (const { value, line } of classStrings) {
      for (const cls of value.split(/\s+/)) {
        if (!cls) continue;
        const utility = lastSegment(cls).replace(/^!/, "").replace(/^-/, "");
        const stem = utility.includes("[") ? utility : utility.replace(/\/[\w.]+$/, "");

        const token = this.byClass.get(stem);
        if (token) result.tokenRefs.add(token);

        for (const variable of utility.match(/--[\w-]+/g) ?? []) {
          const id = this.byVariable.get(variable);
          if (id) result.tokenRefs.add(id);
          else if (!this.ignoredVariablePrefixes.some((p) => variable.startsWith(p)) && !result.unknownVariables.has(variable)) {
            result.unknownVariables.set(variable, line);
          }
        }

        if (!token && (PALETTE.test(stem) || ARBITRARY_COLOR.test(stem)) && !result.nonTokenValues.has(cls)) {
          result.nonTokenValues.set(cls, line);
        }
      }
    }
    return result;
  }
}

/** `data-[state=open]:hover:bg-accent/50` -> `bg-accent/50` (colons inside brackets are kept). */
function lastSegment(cls: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < cls.length; i++) {
    const ch = cls[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ":" && depth === 0) start = i + 1;
  }
  return cls.slice(start);
}
