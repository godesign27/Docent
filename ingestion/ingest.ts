/**
 * Ingestion pipeline: client repo -> normalized, validated contract.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCENT_ROOT } from "../config/load.js";
import type { ClientConfig } from "../config/schema.js";
import { CONTRACT_SCHEMA_VERSION, Contract, type ComponentContract } from "../schema/contract.js";
import { findComponentDocs, parseMarkdown, type MarkdownFile } from "./docs.js";
import { extractCssVariables } from "./extractors/css-variables.js";
import { extractDtcgJson } from "./extractors/dtcg-json.js";
import { extractReactModule, linkImportedVariants, toPascalCase, type ExtractedModule } from "./extractors/react-tsx.js";
import { extractTailwindTheme } from "./extractors/tailwind-theme.js";
import { findFiles, readText } from "./files.js";
import { GapCollector } from "./gaps.js";
import { importPathFromAliases, importPathFromTemplate, loadPathAliases, resolveSpecifier } from "./import-paths.js";
import { loadManifest, type ManifestEntry } from "./manifest.js";
import { resolveSource, type ResolvedSource } from "./source.js";
import { attachSpecs, loadSpecs } from "./specs.js";
import { buildDistribution } from "./distribution.js";
import { normalizeTokens } from "./tokens/normalize.js";
import { ClassIndex } from "./tokens/tailwind-classes.js";
import type { RawToken, TailwindEntry } from "./tokens/values.js";

export const DOCENT_VERSION: string = JSON.parse(readFileSync(join(DOCENT_ROOT, "package.json"), "utf8")).version;

export interface IngestOptions {
  log?: (message: string) => void;
}

export interface IngestResult {
  contract: Contract;
  /** Content of every file in contract.sourceFiles, at the ingested commit. */
  sources: Record<string, string>;
}

export async function ingest(config: ClientConfig, options: IngestOptions = {}): Promise<IngestResult> {
  const source = resolveSource(config, options.log);
  return buildContract(config, source, options);
}

export async function buildContract(config: ClientConfig, source: ResolvedSource, options: IngestOptions = {}): Promise<IngestResult> {
  const log = options.log ?? (() => {});
  const { root } = source;
  const { ingestion } = config;
  const gaps = new GapCollector();
  const scanned = new Set<string>();

  // --- Components ------------------------------------------------------------
  const modules: { mod: ExtractedModule; importTemplate: string | undefined }[] = [];
  for (const extractor of ingestion.components) {
    const files = await findFiles(root, extractor.include, extractor.exclude);
    log(`react-tsx: ${files.length} files`);
    for (const file of files) {
      scanned.add(file);
      const mod = extractReactModule(file, readText(root, file), gaps);
      if (mod) modules.push({ mod, importTemplate: extractor.importPath });
    }
  }
  const idCounts = new Map<string, number>();
  for (const { mod } of modules) idCounts.set(mod.id, (idCounts.get(mod.id) ?? 0) + 1);
  for (const { mod } of modules) {
    if (idCounts.get(mod.id)! > 1) mod.id = mod.file.replace(/\.[jt]sx?$/, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
  }
  const aliases = loadPathAliases(root);
  const byPath = new Map(modules.map(({ mod }) => [mod.file.replace(/\.[jt]sx?$/, "").replace(/\/index$/, ""), mod]));
  linkImportedVariants(
    modules.map((m) => m.mod),
    (fromFile, specifier) => {
      const path = resolveSpecifier(fromFile, specifier, aliases);
      return path ? (byPath.get(path) ?? byPath.get(`${path}/index`)) : undefined;
    },
  );

  // --- Tokens ----------------------------------------------------------------
  const rawTokens: RawToken[] = [];
  const tailwind: TailwindEntry[] = [];
  for (const extractor of ingestion.tokens) {
    const files = await findFiles(root, extractor.include, extractor.exclude);
    log(`${extractor.extractor}: ${files.length} files`);
    for (const file of files) {
      scanned.add(file);
      const text = readText(root, file);
      if (extractor.extractor === "css-variables") {
        rawTokens.push(...extractCssVariables(file, text, extractor.modes, ingestion.ignoreCssVariablePrefixes, gaps));
      } else if (extractor.extractor === "tailwind-theme") {
        tailwind.push(...extractTailwindTheme(file, text, gaps));
      } else {
        rawTokens.push(...extractDtcgJson(file, text, extractor.mode, gaps));
      }
    }
  }

  const componentDocs = await loadMarkdown(root, ingestion.docs.components, "components", scanned, gaps);
  const tokenDocs = await loadMarkdown(root, ingestion.docs.tokens, "tokens", scanned, gaps);

  const tokens = normalizeTokens(
    {
      raw: rawTokens,
      tailwind,
      defaultMode: ingestion.defaultMode,
      tokenDocs: ingestion.docs.tokens.length > 0 ? tokenDocs.map((d) => d.text).join("\n\n") : null,
      ignoreCssVariablePrefixes: ingestion.ignoreCssVariablePrefixes,
    },
    gaps,
  );
  const classIndex = new ClassIndex(tokens, ingestion.ignoreCssVariablePrefixes);

  // --- Cross-reference components with manifest, docs and tokens -------------
  const manifest = ingestion.manifest ? loadManifest(root, ingestion.manifest, gaps) : null;
  if (ingestion.manifest && manifest) scanned.add(ingestion.manifest.path);
  const matchedEntries = new Set<ManifestEntry>();
  const isPlaceholder = (value: string) =>
    ingestion.placeholders.some((p) => p.trim().toLowerCase() === value.trim().toLowerCase());

  const components: ComponentContract[] = modules.map(({ mod, importTemplate }) => {
    const primary = mod.parts.find((p) => p.primary);
    const name = primary?.name ?? toPascalCase(mod.id);
    const subject = { type: "component" as const, id: mod.id };

    // Manifest
    const entry =
      manifest?.find((e) => e.files.includes(mod.file)) ??
      manifest?.find((e) => !matchedEntries.has(e) && (e.name === name || e.id === mod.id || e.id?.endsWith(`:${mod.id}`)));
    let manifestInfo: ComponentContract["manifest"] = null;
    if (entry && ingestion.manifest) {
      matchedEntries.add(entry);
      const placeholderFields: string[] = [];
      const clean = (field: string, value: string | null) => {
        if (value !== null && isPlaceholder(value)) {
          placeholderFields.push(field);
          return null;
        }
        return value;
      };
      manifestInfo = {
        id: entry.id,
        status: clean("status", entry.status),
        category: clean("category", entry.category),
        notes: Object.fromEntries(Object.entries(entry.notes).filter(([field, value]) => clean(field, value) !== null)),
        source: entry.line ? { file: ingestion.manifest.path, line: entry.line } : { file: ingestion.manifest.path },
      };
      if (placeholderFields.length > 0) {
        gaps.add({
          severity: "info",
          kind: "placeholder-documentation",
          subject,
          message: `The component inventory entry for ${name} has placeholder values in ${placeholderFields.join(", ")}; they were left out of the contract.`,
          location: manifestInfo.source,
          suggestion: `Replace the placeholder ${placeholderFields.join(", ")} for ${entry.id ?? name} with real guidance.`,
        });
      }
    } else if (manifest) {
      gaps.add({
        severity: "warning",
        kind: "not-in-manifest",
        subject,
        message: `${name} (${mod.file}) exists in source but is not in the component inventory ${ingestion.manifest!.path}.`,
        location: { file: mod.file },
        suggestion: "Add it to the inventory, or remove it if agents must not use it.",
      });
    }

    // Import path
    let importPath: string | null = null;
    let importPathSource: ComponentContract["importPathSource"] = null;
    if (importTemplate) {
      importPath = importPathFromTemplate(mod.file, importTemplate);
      importPathSource = "config";
    } else if (entry?.importPath && !isPlaceholder(entry.importPath)) {
      importPath = entry.importPath;
      importPathSource = "manifest";
    } else {
      importPath = importPathFromAliases(mod.file, aliases);
      if (importPath) importPathSource = "tsconfig-paths";
    }
    if (!importPath) {
      gaps.add({
        severity: "warning",
        kind: "import-path-unknown",
        subject,
        message: `No import path could be determined for ${name}.`,
        location: { file: mod.file },
        suggestion: "Set importPath on the react-tsx extractor, or add path aliases to tsconfig.json.",
      });
    }

    // Documentation
    const docs = findComponentDocs(componentDocs, [mod.id, name, entry?.id ?? "", entry?.name ?? ""]);
    const description = primary?.description ?? null;
    if (docs.length === 0) {
      gaps.add({
        severity: "warning",
        kind: "missing-usage-docs",
        subject,
        message:
          componentDocs.length > 0
            ? `No usage documentation found for ${name}: no configured markdown file or heading matches ${[mod.id, name, entry?.id].filter(Boolean).join(" / ")}.`
            : `No usage documentation found for ${name}: no component docs are configured.`,
        location: { file: mod.file },
        suggestion: `Document when to use ${name}, and when not to.`,
      });
    }

    // Tokens
    const analysis = classIndex.analyze(mod.classStrings);
    if (analysis.nonTokenValues.size > 0) {
      gaps.add({
        severity: "warning",
        kind: "non-token-value",
        subject,
        message: `${name} styles with values that are not design tokens: ${[...analysis.nonTokenValues].map(([cls, line]) => `${cls} (line ${line})`).join(", ")}.`,
        location: { file: mod.file, line: [...analysis.nonTokenValues.values()][0]! },
        suggestion: "Replace with a token utility, or add a token for this value.",
      });
    }
    if (analysis.unknownVariables.size > 0) {
      gaps.add({
        severity: "info",
        kind: "unresolved-token-reference",
        subject,
        message: `${name} references CSS variables that are not tokens in this contract: ${[...analysis.unknownVariables].map(([v, line]) => `${v} (line ${line})`).join(", ")}.`,
        location: { file: mod.file, line: [...analysis.unknownVariables.values()][0]! },
      });
    }

    return {
      id: mod.id,
      name,
      importPath,
      importPathSource,
      files: [mod.file],
      parts: mod.parts,
      otherExports: mod.otherExports,
      typeExports: mod.typeExports,
      dependencies: mod.dependencies,
      tokenRefs: [...analysis.tokenRefs].sort(),
      description,
      docs,
      manifest: manifestInfo,
      guidance: null,
      install: { supportFiles: [], componentDependencies: [], packages: [] },
    };
  });

  if (ingestion.specs) {
    attachSpecs(components, await loadSpecs(root, ingestion.specs, isPlaceholder, scanned, gaps), gaps);
  }
  for (const component of components) {
    if (component.docs.length === 0 || component.description || component.guidance?.description || component.guidance?.intent) continue;
    gaps.add({
      severity: "info",
      kind: "missing-description",
      subject: { type: "component", id: component.id },
      message: `${component.name} has usage docs but no summary: no JSDoc on its primary export and no description in a spec.`,
      location: component.parts.find((p) => p.primary)?.source ?? { file: component.files[0]! },
    });
  }

  for (const entry of manifest ?? []) {
    if (matchedEntries.has(entry)) continue;
    gaps.add({
      severity: "warning",
      kind: "manifest-entry-without-source",
      subject: { type: "component", id: entry.id ?? entry.name ?? "unknown" },
      message: `The component inventory lists ${entry.id ?? entry.name}${entry.files.length ? ` (${entry.files.join(", ")})` : ""}, but no matching component was found in the scanned source.`,
      location: entry.line ? { file: ingestion.manifest!.path, line: entry.line } : { file: ingestion.manifest!.path },
      suggestion: "Remove the entry, or add the component's files to the react-tsx include globs.",
    });
  }

  // --- Distribution ----------------------------------------------------------
  const distribution = await buildDistribution({
    root,
    components,
    aliases,
    foundation: ingestion.foundation,
    packageJson: ingestion.packageJson,
    scanned,
    gaps,
  });
  for (const component of components) component.install = distribution.installs.get(component.id)!;

  // --- Ingestion-level gaps --------------------------------------------------
  if (ingestion.components.length > 0 && components.length === 0) {
    gaps.add({
      severity: "error",
      kind: "no-components-found",
      subject: { type: "ingestion", id: "components" },
      message: "Component extractors are configured but found no components.",
      suggestion: "Check the react-tsx include globs.",
    });
  }
  if (ingestion.tokens.length > 0 && tokens.length === 0) {
    gaps.add({
      severity: "error",
      kind: "no-tokens-found",
      subject: { type: "ingestion", id: "tokens" },
      message: "Token extractors are configured but found no tokens.",
      suggestion: "Check the token extractor include globs and modes.",
    });
  }
  if (ingestion.tokens.some((t) => t.extractor === "tailwind-theme")) {
    gaps.add({
      severity: "info",
      kind: "framework-defaults-not-captured",
      subject: { type: "ingestion", id: "tailwind" },
      message:
        "Tailwind's default theme (spacing scale, font sizes, default palette) is not defined in this repo and is not in the contract. Utilities such as p-4 or text-sm are framework defaults, not client tokens.",
    });
  }

  // --- Assemble --------------------------------------------------------------
  components.sort((a, b) => a.id.localeCompare(b.id));
  const gapList = gaps.list();
  const modes = [...new Set(tokens.flatMap((t) => Object.keys(t.values)))].sort((a, b) =>
    a === ingestion.defaultMode ? -1 : b === ingestion.defaultMode ? 1 : a.localeCompare(b),
  );
  const body = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    modes,
    components,
    tokens,
    sourceFiles: distribution.sourceFiles,
    foundation: distribution.foundation,
    patterns: [],
    governance: [],
    gaps: gapList,
  };
  const contentHash = "sha256:" + createHash("sha256").update(JSON.stringify(body)).digest("hex");

  const contract = Contract.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    docentVersion: DOCENT_VERSION,
    client: config.client,
    source: {
      type: source.type,
      location: source.location,
      ref: source.ref,
      commit: source.commit,
      subdir: source.subdir,
    },
    generatedAt: new Date().toISOString(),
    contentHash,
    modes,
    components,
    tokens,
    sourceFiles: distribution.sourceFiles,
    foundation: distribution.foundation,
    patterns: [],
    governance: [],
    gaps: gapList,
    stats: {
      components: components.length,
      componentParts: components.reduce((n, c) => n + c.parts.length, 0),
      tokens: tokens.length,
      gaps: {
        error: gapList.filter((g) => g.severity === "error").length,
        warning: gapList.filter((g) => g.severity === "warning").length,
        info: gapList.filter((g) => g.severity === "info").length,
      },
      filesScanned: scanned.size,
    },
  });
  return { contract, sources: distribution.sources };
}

async function loadMarkdown(
  root: string,
  globs: string[],
  label: string,
  scanned: Set<string>,
  gaps: GapCollector,
): Promise<MarkdownFile[]> {
  if (globs.length === 0) return [];
  const files = await findFiles(root, globs);
  if (files.length === 0) {
    gaps.add({
      severity: "warning",
      kind: "unresolvable-config-value",
      subject: { type: "ingestion", id: `docs.${label}` },
      message: `docs.${label} globs (${globs.join(", ")}) matched no files.`,
    });
  }
  return files.map((file) => {
    scanned.add(file);
    return parseMarkdown(file, readText(root, file));
  });
}
