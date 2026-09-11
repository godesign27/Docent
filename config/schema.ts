/**
 * Per-client configuration. Everything that differs between clients lives
 * here, so onboarding a client is a config change, not a code change.
 */
import { z } from "zod";

const Globs = z.array(z.string().min(1)).min(1);

const ReactTsxExtractor = z.object({
  extractor: z.literal("react-tsx"),
  include: Globs,
  exclude: z.array(z.string()).default([]),
  /**
   * Template for a component's import path. Tokens: {basename} (file name
   * without extension), {path} (path relative to the design-system root
   * without extension). Omit to fall back to the manifest or tsconfig paths.
   */
  importPath: z.string().optional(),
});

const CssVariablesExtractor = z.object({
  extractor: z.literal("css-variables"),
  include: Globs,
  exclude: z.array(z.string()).default([]),
  /** Maps a CSS selector to the theme mode its variables belong to. */
  modes: z.record(z.string(), z.string()).default({ ":root": "default" }),
});

const TailwindThemeExtractor = z.object({
  extractor: z.literal("tailwind-theme"),
  include: Globs,
  exclude: z.array(z.string()).default([]),
});

const DtcgJsonExtractor = z.object({
  extractor: z.literal("dtcg-json"),
  include: Globs,
  exclude: z.array(z.string()).default([]),
  /** Mode these files define, e.g. "dark". Use one entry per mode. */
  mode: z.string().default("default"),
});

const ManifestConfig = z.object({
  /** Path to the client's own machine-readable component inventory (JSON). */
  path: z.string(),
  /** Dot path to the array of entries inside the file, e.g. "components". */
  itemsPath: z.string().default(""),
  /** Which entry fields hold which information. */
  fields: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      files: z.string().optional(),
      status: z.string().optional(),
      category: z.string().optional(),
      importPath: z.string().optional(),
      notes: z.array(z.string()).default([]),
    })
    .default({ notes: [] }),
});

const SpecsConfig = z.object({
  /** Per-component structured spec files authored by the client, e.g. **\/*.agent.json. */
  include: Globs,
  exclude: z.array(z.string()).default([]),
  /** Field holding the component's source file path, used to pair a spec with its component. */
  sourceField: z.string().optional(),
  /** Field holding the inventory id, used when sourceField is absent or unmatched. */
  idField: z.string().optional(),
  /** Dot paths into the spec for each kind of guidance. Unmapped kinds are left empty. */
  fields: z
    .object({
      lifecycle: z.string().optional(),
      category: z.string().optional(),
      intent: z.string().optional(),
      description: z.string().optional(),
      forbiddenUsage: z.string().optional(),
      agentRules: z.string().optional(),
      structure: z.string().optional(),
      accessibility: z.string().optional(),
      experience: z.string().optional(),
      related: z.string().optional(),
      knownGaps: z.string().optional(),
      /** Array of { name, type, required, hint } — hints are kept, the rest is only drift-checked. */
      props: z.string().optional(),
      /** Checked against source for drift, never copied into the contract. */
      exports: z.string().optional(),
      variants: z.string().optional(),
      sizes: z.string().optional(),
    })
    .default({}),
});

const PatternsConfig = z.object({
  /** One pattern per JSON file, or an array of patterns per file with itemsPath. */
  include: Globs,
  exclude: z.array(z.string()).default([]),
  itemsPath: z.string().optional(),
  fields: z
    .object({
      id: z.string(),
      name: z.string().optional(),
      intent: z.string().optional(),
      requiredComponents: z.string().optional(),
      recommendedComponents: z.string().optional(),
      optionalComponents: z.string().optional(),
      sequence: z.string().optional(),
      rules: z.string().optional(),
      forbidden: z.string().optional(),
      example: z.string().optional(),
    }),
  /** Other fields copied verbatim into pattern metadata, e.g. aiBehavior. */
  keep: z.array(z.string()).default([]),
});

const RuleSource = z.object({
  include: Globs,
  /** JSON: dot path to the array of rules. Entries may be objects or plain strings. */
  itemsPath: z.string().default(""),
  /** Markdown: the heading whose bullet list holds the rules, e.g. "Rules of the road". */
  heading: z.string().optional(),
  /** Label used to group and route rules, e.g. forbidden, accessibility. */
  category: z.string(),
  fields: z
    .object({
      id: z.string().optional(),
      rule: z.string().optional(),
      severity: z.string().optional(),
      response: z.string().optional(),
      reference: z.string().optional(),
    })
    .default({}),
  /** Severity for entries that do not declare one. */
  severity: z.enum(["critical", "high", "medium", "low", "unspecified"]).default("unspecified"),
});

const GovernanceConfig = z.object({
  rules: z.array(RuleSource).default([]),
  /** Import prefixes generated code may use for design-system modules, e.g. @/components/ui/. */
  approvedImports: z.array(z.string()).default([]),
  /** Packages or scopes that may not be used, e.g. @mui/*, antd. */
  restrictedPackages: z.array(z.string()).default([]),
  /** Maps Docent's built-in checks to the client's own rule ids, so findings cite the client's rules. */
  checks: z.record(z.string(), z.string()).default({}),
  /** Also treat patterns' forbidden lists and components' forbidden usage as (unspecified-severity) rules. */
  includeAuthoredGuidance: z.boolean().default(true),
});

const TokenSemanticsConfig = z.object({
  path: z.string(),
  /** Object whose keys are role groups and values are arrays of token roles. */
  rolesPath: z.string().optional(),
  roleFields: z.object({ token: z.string(), meaning: z.string().optional() }).default({ token: "token", meaning: "meaning" }),
  decisionsPath: z.string().optional(),
  decisionFields: z.object({ need: z.string(), use: z.string() }).default({ need: "need", use: "use" }),
  forbiddenPath: z.string().optional(),
});

/** What happens when a request conflicts with the design system's rules. */
export const EscalationPolicy = z.object({
  /** Action when evidence shows a request or code breaks a rule of this severity. */
  onViolation: z
    .object({
      critical: z.enum(["reject", "escalate", "warn"]).default("reject"),
      high: z.enum(["reject", "escalate", "warn"]).default("escalate"),
      medium: z.enum(["reject", "escalate", "warn"]).default("warn"),
      low: z.enum(["reject", "escalate", "warn"]).default("warn"),
      unspecified: z.enum(["reject", "escalate", "warn"]).default("warn"),
    })
    .default({ critical: "reject", high: "escalate", medium: "warn", low: "warn", unspecified: "warn" }),
  /**
   * Action when a request only resembles a critical or high rule (matched on its wording,
   * not proven by a check). Docent never rejects on a resemblance; it warns with the rule, or escalates.
   */
  onPossibleViolation: z.enum(["escalate", "warn"]).default("warn"),
  /** Action when a request asks to bypass, override or be excused from a rule. */
  onExceptionRequest: z.enum(["reject", "escalate"]).default("escalate"),
  /** Shown to calling agents so they know who decides. */
  reviewers: z.array(z.string()).default([]),
});
export type EscalationPolicy = z.infer<typeof EscalationPolicy>;

export const ClientConfig = z.object({
  client: z.object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "client.id must be lowercase letters, digits and dashes"),
    name: z.string(),
  }),
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("local"),
      /** Absolute, or relative to the config file. */
      path: z.string(),
      subdir: z.string().optional(),
    }),
    z.object({
      type: z.literal("git"),
      url: z.string(),
      ref: z.string().optional(),
      subdir: z.string().optional(),
    }),
  ]),
  ingestion: z.object({
    components: z.array(ReactTsxExtractor).default([]),
    tokens: z.array(z.discriminatedUnion("extractor", [CssVariablesExtractor, TailwindThemeExtractor, DtcgJsonExtractor])).default([]),
    manifest: ManifestConfig.optional(),
    specs: SpecsConfig.optional(),
    patterns: PatternsConfig.optional(),
    governance: GovernanceConfig.optional(),
    tokenSemantics: TokenSemanticsConfig.optional(),
    /** What a consuming project needs besides component files. */
    foundation: z
      .object({
        /** Theme tokens and build config every component relies on, e.g. src/index.css, tailwind.config.js. */
        files: Globs,
        /** Packages the host project needs that no file imports directly, e.g. tailwindcss, postcss. */
        packages: z.array(z.string()).default([]),
      })
      .optional(),
    /** Package manifest used to look up dependency versions. */
    packageJson: z.string().default("package.json"),
    docs: z
      .object({
        /** Markdown files searched for per-component usage documentation. */
        components: z.array(z.string()).default([]),
        /** Markdown files that document tokens; used to flag undocumented tokens. */
        tokens: z.array(z.string()).default([]),
      })
      .default({ components: [], tokens: [] }),
    /** Mode treated as the base theme; tokens missing from it are flagged. */
    defaultMode: z.string().default("default"),
    /**
     * Documentation values that mean "nobody filled this in". They are dropped
     * from the contract and reported as gaps instead of being passed to agents.
     */
    placeholders: z.array(z.string()).default(["TBD", "TODO", "Unknown", "N/A"]),
    /** CSS variables that are runtime plumbing, not design tokens. */
    ignoreCssVariablePrefixes: z.array(z.string()).default(["--tw-", "--radix-"]),
  }),
  escalation: EscalationPolicy.default(EscalationPolicy.parse({})),
  /** Specialists this client gets. Leave one out when the design system has no data for it. */
  specialists: z.array(z.enum(["components", "tokens", "patterns", "governance"])).min(1).default(["components", "tokens", "patterns", "governance"]),
  output: z
    .object({
      /** Relative to the Docent repo root. Defaults to contracts/<client.id>. */
      dir: z.string().optional(),
    })
    .default({}),
});
export type ClientConfig = z.infer<typeof ClientConfig>;
export type ReactTsxExtractorConfig = z.infer<typeof ReactTsxExtractor>;
export type CssVariablesExtractorConfig = z.infer<typeof CssVariablesExtractor>;
export type TailwindThemeExtractorConfig = z.infer<typeof TailwindThemeExtractor>;
export type DtcgJsonExtractorConfig = z.infer<typeof DtcgJsonExtractor>;
export type ManifestConfig = z.infer<typeof ManifestConfig>;
export type SpecsConfig = z.infer<typeof SpecsConfig>;
export type PatternsConfig = z.infer<typeof PatternsConfig>;
export type GovernanceConfig = z.infer<typeof GovernanceConfig>;
export type TokenSemanticsConfig = z.infer<typeof TokenSemanticsConfig>;
