/**
 * Docent contract schema.
 *
 * The contract is the normalized, inspectable representation of one client's
 * design system. Ingestion writes it; the concierge and specialists only ever
 * read it. This module must stay runtime-agnostic (no Node APIs) so the same
 * schema can be bundled into a Cloudflare Worker.
 *
 * Guiding rule: every value is either extracted from the client repo with a
 * recorded source location, or it is null and a Gap explains why. Ingestion
 * never fills a field with a guess.
 */
import { z } from "zod";

export const CONTRACT_SCHEMA_VERSION = "0.2.0";

export const SourceLocation = z.object({
  file: z.string().describe("Path relative to the design-system root"),
  line: z.number().int().positive().optional(),
});
export type SourceLocation = z.infer<typeof SourceLocation>;

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

export const GapSeverity = z.enum(["error", "warning", "info"]);
export type GapSeverity = z.infer<typeof GapSeverity>;

export const GapKind = z.enum([
  // ingestion-level
  "parse-error",
  "no-components-found",
  "no-tokens-found",
  "unresolvable-config-value",
  "framework-defaults-not-captured",
  // components
  "missing-description",
  "missing-usage-docs",
  "placeholder-documentation",
  "no-primary-export",
  "props-not-resolved",
  "inherited-props-not-expanded",
  "import-path-unknown",
  "not-in-manifest",
  "manifest-entry-without-source",
  "non-token-value",
  "spec-missing",
  "spec-drift",
  "spec-without-source",
  // tokens
  "unknown-token-type",
  "unresolved-token-reference",
  "missing-default-mode",
  "conflicting-token-definition",
  "undocumented-token",
]);
export type GapKind = z.infer<typeof GapKind>;

export const Gap = z.object({
  id: z.string().describe("Stable identifier: kind + subject, so gaps can be diffed across runs"),
  severity: GapSeverity,
  kind: GapKind,
  subject: z.object({
    type: z.enum(["component", "token", "source", "ingestion"]),
    id: z.string(),
  }),
  message: z.string(),
  location: SourceLocation.optional(),
  suggestion: z.string().optional().describe("What the design-system team could add to close the gap"),
});
export type Gap = z.infer<typeof Gap>;

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export const PropContract = z.object({
  name: z.string(),
  type: z.string().describe("Type as written in source"),
  required: z.boolean(),
  values: z.array(z.string()).optional().describe("Allowed literal values, when the type is a closed set"),
  default: z.string().optional(),
  description: z.string().optional(),
  origin: z.enum(["declared", "variant"]).describe("declared = written in a props type; variant = derived from a variant definition (e.g. cva)"),
});
export type PropContract = z.infer<typeof PropContract>;

export const VariantAxis = z.object({
  name: z.string(),
  values: z.array(z.string()),
  default: z.string().optional(),
  source: SourceLocation,
});
export type VariantAxis = z.infer<typeof VariantAxis>;

export const ComponentPart = z.object({
  name: z.string().describe("Exported identifier, e.g. CardHeader"),
  primary: z.boolean().describe("True for the part the module is named after"),
  element: z.string().optional().describe("Rendered host element or primitive when statically visible"),
  props: z.array(PropContract),
  extends: z.array(z.string()).describe("Types whose props are inherited but not expanded, e.g. React.ButtonHTMLAttributes<HTMLButtonElement>"),
  variants: z.array(VariantAxis),
  description: z.string().nullable(),
  source: SourceLocation,
});
export type ComponentPart = z.infer<typeof ComponentPart>;

export const ComponentDocs = z.object({
  file: z.string(),
  heading: z.string(),
  content: z.string().describe("Raw markdown of the matched section, unparsed"),
});
export type ComponentDocs = z.infer<typeof ComponentDocs>;

/**
 * Guidance the client's design-system team authored for agents (e.g. a
 * per-component .agent.json). It covers what source code cannot say: intent,
 * forbidden usage, accessibility obligations. Mechanical facts (props,
 * variants, exports) always come from source; specs that disagree are
 * reported as spec-drift gaps.
 */
export const ComponentGuidance = z.object({
  source: SourceLocation,
  id: z.string().nullable(),
  lifecycle: z.string().nullable(),
  category: z.string().nullable(),
  intent: z.string().nullable(),
  description: z.string().nullable(),
  forbiddenUsage: z.array(z.string()),
  agentRules: z.array(z.string()),
  propHints: z.record(z.string(), z.string()).describe("Prop name -> authored usage hint"),
  structure: z.unknown().nullable().describe("Required nesting of compound parts, as authored"),
  accessibility: z.record(z.string(), z.unknown()).nullable(),
  experience: z.record(z.string(), z.unknown()).nullable().describe("AI autonomy and accountability metadata, when declared"),
  related: z.array(z.object({ id: z.string(), note: z.string().nullable() })),
  knownGaps: z.array(z.string()).describe("Limitations the client declared themselves"),
});
export type ComponentGuidance = z.infer<typeof ComponentGuidance>;

export const ComponentContract = z.object({
  id: z.string().describe("Stable slug derived from the source file name"),
  name: z.string(),
  importPath: z.string().nullable(),
  importPathSource: z.enum(["manifest", "config", "tsconfig-paths"]).nullable(),
  files: z.array(z.string()),
  parts: z.array(ComponentPart),
  otherExports: z.array(z.string()).describe("Non-component value exports, e.g. buttonVariants"),
  typeExports: z.array(z.string()).describe("Exported TypeScript types and interfaces, e.g. ButtonProps"),
  dependencies: z.array(z.string()).describe("External packages imported by the component"),
  tokenRefs: z.array(z.string()).describe("Ids of design tokens referenced by the component's styles"),
  description: z.string().nullable(),
  docs: z.array(ComponentDocs),
  manifest: z
    .object({
      id: z.string().nullable(),
      status: z.string().nullable(),
      category: z.string().nullable(),
      notes: z.record(z.string(), z.string()),
      source: SourceLocation,
    })
    .nullable()
    .describe("What the client's own component inventory says about this component, placeholders removed"),
  guidance: ComponentGuidance.nullable(),
});
export type ComponentContract = z.infer<typeof ComponentContract>;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export const TokenType = z.enum([
  "color",
  "dimension",
  "number",
  "fontFamily",
  "fontWeight",
  "duration",
  "cubicBezier",
  "shadow",
  "animation",
  "other",
  "unknown",
]);
export type TokenType = z.infer<typeof TokenType>;

export const TokenCategory = z.enum([
  "color",
  "typography",
  "spacing",
  "radius",
  "elevation",
  "motion",
  "breakpoint",
  "layout",
  "other",
  "uncategorized",
]);
export type TokenCategory = z.infer<typeof TokenCategory>;

export const TokenValue = z.object({
  raw: z.string().describe("Value exactly as written in source"),
  format: z.string().optional().describe("Value encoding when known, e.g. hsl-channels"),
  source: SourceLocation,
});
export type TokenValue = z.infer<typeof TokenValue>;

export const TailwindBinding = z.object({
  section: z.string().describe("Tailwind theme section, e.g. colors, borderRadius"),
  key: z.string().describe("Utility key, e.g. primary-foreground"),
  exampleClasses: z.array(z.string()),
  source: SourceLocation,
});
export type TailwindBinding = z.infer<typeof TailwindBinding>;

export const TokenContract = z.object({
  id: z.string(),
  name: z.string().describe("Name as authored, e.g. --primary or color.brand.primary"),
  cssVariable: z.string().nullable(),
  type: TokenType,
  typeEvidence: z.enum(["declared", "tailwind-section", "value-format"]).nullable(),
  category: TokenCategory,
  values: z.record(z.string(), TokenValue).describe("Keyed by mode, e.g. light / dark / default"),
  references: z.array(z.string()).describe("Ids of tokens this token's value depends on"),
  tailwind: z.array(TailwindBinding),
  description: z.string().nullable(),
  documented: z.boolean().nullable().describe("Whether token docs mention this token; null when no token docs are configured"),
});
export type TokenContract = z.infer<typeof TokenContract>;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const Contract = z.object({
  schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
  docentVersion: z.string(),
  client: z.object({ id: z.string(), name: z.string() }),
  source: z.object({
    type: z.enum(["local", "git"]),
    location: z.string(),
    ref: z.string().nullable(),
    commit: z.string().nullable(),
    subdir: z.string().nullable(),
  }),
  generatedAt: z.string(),
  contentHash: z.string().describe("sha256 of the contract body excluding generatedAt; changes only when the extracted design system changes"),
  modes: z.array(z.string()),
  components: z.array(ComponentContract),
  tokens: z.array(TokenContract),
  patterns: z.array(z.unknown()).describe("Reserved: populated from Phase 2"),
  governance: z.array(z.unknown()).describe("Reserved: populated from Phase 2"),
  gaps: z.array(Gap),
  stats: z.object({
    components: z.number(),
    componentParts: z.number(),
    tokens: z.number(),
    gaps: z.object({ error: z.number(), warning: z.number(), info: z.number() }),
    filesScanned: z.number(),
  }),
});
export type Contract = z.infer<typeof Contract>;
