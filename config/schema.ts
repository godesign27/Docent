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
