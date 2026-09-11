/**
 * Looks at a design-system repo and proposes a client config. Every choice
 * carries the evidence it was based on, and anything Docent can't decide is a
 * TODO for the person onboarding the client, not a guess written into config.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import postcss from "postcss";
import type { ClientConfig } from "../config/schema.js";
import { parseMarkdown } from "../ingestion/docs.js";
import { contextKeys } from "../ingestion/extractors/css-variables.js";
import { findFiles } from "../ingestion/files.js";
import { loadPathAliases } from "../ingestion/import-paths.js";
import { getPath } from "../ingestion/manifest.js";

type Ingestion = ClientConfig["ingestion"];
type Domain = ClientConfig["specialists"][number];

export interface Proposal {
  ingestion: Partial<Ingestion> & Pick<Ingestion, "components" | "tokens">;
  specialists: Domain[];
  /** What was found and why each part of the config looks the way it does. */
  evidence: string[];
  /** Decisions only a person can make. */
  todos: string[];
}

const IGNORE = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**", "**/coverage/**", "**/storybook-static/**"];
const NOT_COMPONENT_FILES = ["**/*.stories.tsx", "**/*.test.tsx", "**/*.spec.tsx", "**/__tests__/**", "**/*.d.ts"];
const UI_LIBRARIES = ["@mui/*", "@material-ui/*", "antd", "@ant-design/*", "@chakra-ui/*", "@mantine/*", "bootstrap", "react-bootstrap", "semantic-ui-react", "primereact"];

const readJson = (root: string, file: string): unknown => {
  try {
    return JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch {
    return undefined;
  }
};
const firstKey = (obj: unknown, candidates: string[]) =>
  obj && typeof obj === "object" ? candidates.find((k) => getPath(obj, k) !== undefined) : undefined;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** Union of several JSON objects' keys (nested objects merged), for reading field names. */
const mergeShapes = (items: unknown[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    for (const [k, v] of Object.entries(item)) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" ? mergeShapes([out[k], v]) : (out[k] ?? v);
    }
  }
  return out;
};

/** A markdown section's own lines, up to its first sub-heading. */
export const directLines = (content: string) => {
  const lines = content.split("\n").slice(1);
  const end = lines.findIndex((l) => /^#{1,6}\s/.test(l));
  return end === -1 ? lines : lines.slice(0, end);
};

export async function detectRepo(root: string): Promise<Proposal> {
  const evidence: string[] = [];
  const todos: string[] = [];
  const files = async (include: string[], exclude: string[] = []) => findFiles(root, include, [...IGNORE, ...exclude]);
  const pkg = readJson(root, "package.json") as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };

  // --- Components -----------------------------------------------------------------------------
  const tsx = await files(["**/*.tsx", "**/*.jsx"], NOT_COMPONENT_FILES);
  const dirs = new Map<string, number>();
  for (const f of tsx) dirs.set(dirname(f), (dirs.get(dirname(f)) ?? 0) + 1);
  const uiDirs = [...dirs.keys()].filter((d) => /(^|\/)components\/(ui|ai|primitives|core)$/.test(d) || /(^|\/)(ui|primitives)$/.test(d));
  const siblingDs = [...dirs.keys()].filter((d) => uiDirs.some((u) => dirname(u) === dirname(d)) && /\/(layout|patterns|ai)$/.test(d));
  let componentGlobs: string[];
  if (uiDirs.length) {
    componentGlobs = [...new Set([...uiDirs, ...siblingDs])].sort().map((d) => `${d}/**/*.tsx`);
    evidence.push(`Components: ${[...new Set([...uiDirs, ...siblingDs])].map((d) => `${d} (${count(dirs.get(d) ?? 0, "file")})`).join(", ")}.`);
  } else {
    const top = [...dirs.entries()].filter(([d]) => /(^|\/)components(\/|$)/.test(d)).sort((a, b) => b[1] - a[1])[0];
    const base = top ? top[0].replace(/(\/components)(\/.*)?$/, "$1") : "src";
    componentGlobs = [`${base}/**/*.tsx`];
    evidence.push(`Components: no ui/ or primitives/ folder, so all of ${base} (${count(tsx.filter((f) => f.startsWith(base)).length, "file")}).`);
    todos.push(`Narrow ingestion.components to the design-system components; ${base} may include product code.`);
  }
  const components: Ingestion["components"] = [{ extractor: "react-tsx", include: componentGlobs, exclude: NOT_COMPONENT_FILES }];

  // --- Tokens: CSS variables -----------------------------------------------------------------
  const tokens: Ingestion["tokens"] = [];
  const cssFiles: { file: string; vars: number; contexts: Set<string>; tailwindEntry: boolean }[] = [];
  // Demo and documentation styles aren't the design system's theme.
  for (const file of await files(["**/*.css"], ["**/preview/**", "**/examples/**", "**/stories/**", "**/docs/**", "**/public/**", "**/ui-kit/**", "**/playground/**", "**/demo/**"])) {
    const text = readFileSync(join(root, file), "utf8");
    const info = { file, vars: 0, contexts: new Set<string>(), tailwindEntry: /@tailwind\s+base|@import\s+["']tailwindcss["']/.test(text) };
    try {
      postcss.parse(text).walkDecls((decl) => {
        if (!decl.prop.startsWith("--")) return;
        info.vars++;
        contextKeys(decl.parent).forEach((c) => info.contexts.add(c));
      });
    } catch {
      continue;
    }
    if (info.vars >= 3) cssFiles.push(info);
  }
  const contexts = new Set(cssFiles.flatMap((f) => [...f.contexts]));
  const hasTheme = contexts.has("@theme");
  const modes: Record<string, string> = {};
  const darkSelectors = [...contexts].filter((c) => /\.dark\b|data-theme=["']?dark|data-mode=["']?dark|prefers-color-scheme:\s*dark/.test(c));
  const base = hasTheme ? "base" : darkSelectors.length ? "light" : "default";
  if (hasTheme) modes["@theme"] = base;
  if (contexts.has(":root")) modes[":root"] = base;
  for (const d of darkSelectors) modes[d] = "dark";
  const unmapped = [...contexts].filter((c) => !(c in modes));
  if (cssFiles.length) {
    tokens.push({ extractor: "css-variables", include: cssFiles.map((f) => f.file), exclude: [], modes });
    evidence.push(`Tokens: CSS variables in ${cssFiles.map((f) => `${f.file} (${f.vars})`).join(", ")}; modes ${Object.entries(modes).map(([k, v]) => `${k} → ${v}`).join(", ")}.`);
    if (unmapped.length) todos.push(`CSS variables also appear under ${unmapped.slice(0, 5).map((c) => `"${c}"`).join(", ")}; add them to modes if they are themes, or leave them out.`);
  }

  // --- Tokens: Tailwind v3 config --------------------------------------------------------------
  const tailwindConfig = await files(["tailwind.config.{js,ts,cjs,mjs}"]);
  if (tailwindConfig.length) {
    tokens.push({ extractor: "tailwind-theme", include: tailwindConfig, exclude: [] });
    evidence.push(`Tokens: Tailwind theme in ${tailwindConfig.join(", ")}.`);
  }

  // --- Tokens: DTCG / Style Dictionary JSON ----------------------------------------------------
  const jsonCandidates = await files(["**/*.json"], ["package.json", "package-lock.json", "**/tsconfig*.json", "**/.vscode/**", "**/*.agent.json"]);
  const tokenJson = jsonCandidates.filter((f) => {
    const text = readFileSync(join(root, f), "utf8");
    return /"\$value"\s*:/.test(text) || (/"value"\s*:/.test(text) && /"type"\s*:\s*"(color|dimension|spacing|fontFamily|fontWeight|shadow|duration)"/.test(text));
  });
  if (tokenJson.length && !cssFiles.length) {
    tokens.push({ extractor: "dtcg-json", include: tokenJson, exclude: [], mode: "default" });
    evidence.push(`Tokens: design-token JSON in ${tokenJson.join(", ")}.`);
  } else if (tokenJson.length) {
    evidence.push(`Tokens: ${tokenJson.join(", ")} looks like token source JSON; the CSS it generates is used instead, since that is what ships.`);
    todos.push(`Token descriptions in ${tokenJson[0]} are not linked to the CSS tokens. If they matter more than utility bindings, ingest the JSON with dtcg-json instead.`);
  }
  if (!tokens.length) todos.push("No token source found. Add a css-variables, tailwind-theme or dtcg-json extractor if the design system has tokens.");

  const ingestion: Proposal["ingestion"] = {
    components,
    tokens,
    defaultMode: base,
  };

  // --- Component inventory ------------------------------------------------------------------------
  for (const file of jsonCandidates) {
    const data = readJson(root, file);
    const itemsPath = Array.isArray(data) ? "" : firstKey(data, ["components", "items", "entries", "inventory"]);
    const items = itemsPath === undefined ? undefined : itemsPath ? getPath(data, itemsPath) : data;
    if (!Array.isArray(items) || items.length < 2 || typeof items[0] !== "object") continue;
    const sample = items[0] as object;
    const id = firstKey(sample, ["id", "key", "slug"]);
    const name = firstKey(sample, ["name", "title", "displayName"]);
    const filesField = firstKey(sample, ["files", "paths", "source", "file"]);
    if (!(id || name) || !filesField) continue;
    const notes = ["intent", "description", "summary", "usage"].filter((k) => k in sample);
    ingestion.manifest = {
      path: file,
      itemsPath: itemsPath ?? "",
      fields: {
        ...(id ? { id } : {}),
        ...(name ? { name } : {}),
        files: filesField,
        ...(firstKey(sample, ["status", "lifecycle"]) ? { status: firstKey(sample, ["status", "lifecycle"])! } : {}),
        ...(firstKey(sample, ["category", "group"]) ? { category: firstKey(sample, ["category", "group"])! } : {}),
        ...(firstKey(sample, ["importPath", "import"]) ? { importPath: firstKey(sample, ["importPath", "import"])! } : {}),
        notes,
      },
    };
    evidence.push(`Inventory: ${file} lists ${count(items.length, "component")}; components outside it will be treated as not allowed.`);
    break;
  }

  // --- Per-component specs ----------------------------------------------------------------------
  const specFiles = await files(["**/*.agent.json", "**/*.spec.json"]);
  // Field names from every spec, since optional fields (e.g. compound structure) appear only in some.
  const specSample = specFiles.length ? mergeShapes(specFiles.map((f) => readJson(root, f))) : undefined;
  if (specSample && (firstKey(specSample, ["id"]) || firstKey(specSample, ["name"]))) {
    const pick = (candidates: string[]) => firstKey(specSample, candidates);
    const fields = Object.fromEntries(
      Object.entries({
        lifecycle: pick(["status", "lifecycle"]),
        category: pick(["category"]),
        intent: pick(["intent", "purpose"]),
        description: pick(["description", "summary"]),
        forbiddenUsage: pick(["rules.forbiddenUsage", "forbiddenUsage", "dont", "whenNotToUse"]),
        agentRules: pick(["rules.agentRules", "agentRules", "rules"]),
        structure: pick(["compound", "structure", "anatomy"]),
        accessibility: pick(["accessibility", "a11y"]),
        experience: pick(["experienceMetadata", "experience"]),
        related: pick(["relatedComponents", "related"]),
        knownGaps: pick(["gaps", "knownGaps"]),
        props: pick(["props"]),
        exports: pick(["exports"]),
        variants: pick(["variants"]),
        sizes: pick(["sizes"]),
      }).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;
    const sourceField = pick(["authority.source", "source", "file", "path"]);
    ingestion.specs = { include: ["**/*.agent.json", "**/*.spec.json"].filter((g) => specFiles.some((f) => f.endsWith(g.slice(4)))), exclude: [], ...(sourceField ? { sourceField } : {}), idField: pick(["id"]) ?? "name", fields };
    evidence.push(`Specs: ${count(specFiles.length, "component spec")} (${specFiles[0]}, …) mapped by field name.`);
  }

  // --- Patterns -----------------------------------------------------------------------------------
  const patternFiles = (await files(["**/patterns/**/*.json"])).filter((f) => {
    const d = readJson(root, f) as object | undefined;
    return d && firstKey(d, ["intent", "purpose"]) && firstKey(d, ["sequence", "steps", "requiredComponents", "uses"]);
  });
  if (patternFiles.length) {
    const sample = mergeShapes(patternFiles.map((f) => readJson(root, f)));
    const pick = (c: string[]) => firstKey(sample, c);
    ingestion.patterns = {
      include: [...new Set(patternFiles.map((f) => `${dirname(f)}/*.json`))],
      exclude: [],
      fields: Object.fromEntries(
        Object.entries({
          id: pick(["id", "name", "slug"]) ?? "name",
          name: pick(["title", "name"]),
          intent: pick(["intent", "purpose"]),
          requiredComponents: pick(["requiredComponents", "uses", "components"]),
          recommendedComponents: pick(["shouldInclude", "recommendedComponents"]),
          optionalComponents: pick(["optionalComponents"]),
          sequence: pick(["sequence", "steps"]),
          rules: pick(["requiredRules", "rules", "do"]),
          forbidden: pick(["forbiddenRules", "forbidden", "dont"]),
          example: pick(["codeSketch", "example"]),
        }).filter(([, v]) => v !== undefined),
      ) as NonNullable<Ingestion["patterns"]>["fields"],
      keep: [],
    };
    evidence.push(`Patterns: ${count(patternFiles.length, "pattern file")} in ${[...new Set(patternFiles.map(dirname))].join(", ")}.`);
  }

  // --- Semantic token roles -------------------------------------------------------------------------
  for (const file of jsonCandidates) {
    const data = readJson(root, file) as Record<string, unknown> | undefined;
    const roles = data && firstKey(data, ["roles"]);
    const decisions = data && firstKey(data, ["decisionTable", "decisions"]);
    if (!roles && !decisions) continue;
    const firstRole = roles ? Object.values(getPath(data, roles) as Record<string, unknown[]>)[0]?.[0] : undefined;
    ingestion.tokenSemantics = {
      path: file,
      ...(roles ? { rolesPath: roles } : {}),
      roleFields: { token: firstKey(firstRole, ["token", "name"]) ?? "token", meaning: firstKey(firstRole, ["meaning", "means", "description"]) ?? "meaning" },
      ...(decisions ? { decisionsPath: decisions } : {}),
      decisionFields: { need: "need", use: "use" },
      ...(firstKey(data, ["forbidden"]) ? { forbiddenPath: "forbidden" } : {}),
    };
    evidence.push(`Token semantics: ${file}.`);
    break;
  }

  // --- Governance ---------------------------------------------------------------------------------------
  const rules: NonNullable<Ingestion["governance"]>["rules"] = [];
  // Priority decides which rule a check maps to: explicit forbidden lists first, prose last.
  const ruleTexts: { id: string; text: string; priority: number }[] = [];
  const priorityOf = (file: string) => (/forbidden/.test(file) ? 0 : /rules?/.test(file) ? 1 : /validation|checks?/.test(file) ? 2 : 3);
  for (const file of jsonCandidates.filter((f) => /(^|\/)rules?\/|rules?\.json$|forbidden\.json$|validation\.json$/.test(f))) {
    const data = readJson(root, file);
    const itemsPath = Array.isArray(data) ? "" : firstKey(data, ["rules", "forbidden", "checks", "requirements", "structuralConstraints"]);
    const items = itemsPath === undefined ? undefined : itemsPath ? getPath(data, itemsPath) : data;
    if (!Array.isArray(items) || !items.length) continue;
    const sample = items[0];
    const category = basename(file, ".json");
    if (typeof sample === "string") {
      rules.push({ include: [file], itemsPath: itemsPath ?? "", category, fields: {}, severity: "medium" });
      items.forEach((t, i) => ruleTexts.push({ id: `${category}-${i + 1}`, text: String(t), priority: priorityOf(file) }));
      continue;
    }
    const textField = firstKey(sample, ["rule", "text", "description", "message"]);
    if (!textField) continue;
    const idField = firstKey(sample, ["id", "key", "code"]);
    rules.push({
      include: [file],
      itemsPath: itemsPath ?? "",
      category,
      fields: {
        ...(idField ? { id: idField } : {}),
        rule: textField,
        ...(firstKey(sample, ["severity", "level"]) ? { severity: firstKey(sample, ["severity", "level"])! } : {}),
        ...(firstKey(sample, ["agentResponse", "response", "say", "message"]) && firstKey(sample, ["agentResponse", "response", "say", "message"]) !== textField
          ? { response: firstKey(sample, ["agentResponse", "response", "say", "message"])! }
          : {}),
        ...(firstKey(sample, ["source", "reference"]) ? { reference: firstKey(sample, ["source", "reference"])! } : {}),
      },
      severity: "medium",
    });
    items.forEach((item, i) =>
      ruleTexts.push({ id: idField ? String((item as Record<string, unknown>)[idField]) : `${category}-${i + 1}`, text: String(getPath(item, textField)), priority: priorityOf(file) }),
    );
  }
  // System-wide rule documents only; per-component "don't" lists are component guidance, read through specs.
  const ruleDocs = await files(["{AGENTS,AGENT_RULES,agent-instruction,agent-instructions,AGENT_INSTRUCTIONS,CONTRIBUTING,GUIDELINES}.md", "{docs,design-library,design-system}/*.md"]);
  for (const file of ruleDocs) {
    const md = parseMarkdown(file, readFileSync(join(root, file), "utf8"));
    for (const section of md.sections) {
      // A document's title heading covers the whole file; only sections count.
      if (section.level < 2 || !/\b(rules?|do not|don'?ts?|forbidden|must|guardrails?)\b/i.test(section.heading)) continue;
      const bullets = directLines(section.content).filter((l) => /^\s{0,3}(?:[-*+]|\d+\.)\s+/.test(l));
      if (bullets.length < 2) continue;
      const category = section.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      rules.push({ include: [file], itemsPath: "", heading: section.heading, category, fields: {}, severity: "medium" });
      bullets.forEach((b, i) => ruleTexts.push({ id: `${category}-${i + 1}`, text: b, priority: 4 }));
      evidence.push(`Rules: ${count(bullets.length, "bullet")} under "${section.heading}" in ${file}.`);
    }
  }
  if (rules.some((r) => !r.heading)) evidence.push(`Rules: ${rules.filter((r) => !r.heading).map((r) => r.include[0]).join(", ")}.`);

  // Map Docent's checks to whichever rule's wording covers them.
  const checkWords: [string, RegExp][] = [
    ["restricted-package", /third[- ]party|external ui|ui librar|material ui|ant design|chakra|bootstrap/i],
    ["unindexed-component", /not (be )?(listed|indexed)|closed[- ]world|inventory|components?_index|only components? (in|from|listed)/i],
    ["unapproved-import", /imports? (outside|from)|approved (import|path)|import paths?/i],
    ["raw-color", /hard[- ]?cod|raw (colou?r|hex|value)|hex\b|literal colou?r|value that exists as a token/i],
    ["palette-utility", /palette|bg-slate|text-gray|tailwind colou?r|value that exists as a token/i],
    ["invalid-prop-value", /props?,? (and|or) variants?|variants? (declared|not present)|invent(ing)? props?/i],
    ["compound-structure", /compound|parts? (must|inside)|inside (its|their) (root|parent)/i],
    ["bespoke-duplicate", /bespoke|custom markup|duplicate.*component|re-?implement/i],
    ["base-mutation", /edits? to src\/components|modify(ing)? base|base component/i],
    ["new-dependencies", /npm install|new dependenc|package\.json edit|build tooling/i],
  ];
  const checks: Record<string, string> = {};
  ruleTexts.sort((a, b) => a.priority - b.priority);
  for (const [check, re] of checkWords) {
    const hit = ruleTexts.find((r) => re.test(r.text));
    if (hit) checks[check] = hit.id;
  }
  const aliases = loadPathAliases(root);
  const approvedImports = aliases.length
    ? [...new Set(componentGlobs.map((g) => g.replace(/\/\*\*\/\*\.tsx$/, "")).flatMap((d) => aliases.filter((a) => d.startsWith(a.target)).map((a) => `${a.alias}${d.slice(a.target.length)}/`)))]
        .concat(aliases.flatMap((a) => ["lib", "hooks"].filter((d) => existsSync(join(root, a.target, d))).map((d) => `${a.alias}${d}/`)))
    : [];
  ingestion.governance = {
    rules,
    approvedImports,
    restrictedPackages: UI_LIBRARIES.filter((p) => !Object.keys(deps).some((d) => (p.endsWith("/*") ? d.startsWith(p.slice(0, -1)) : d === p))),
    checks,
    includeAuthoredGuidance: true,
  };
  if (rules.length) {
    todos.push(
      `Rules were read with severity "medium" where they don't declare one, which only warns. Raise the ones that must block to "high" (escalate) or "critical" (reject).`,
    );
    todos.push(`Confirm governance.checks: ${Object.entries(checks).map(([c, r]) => `${c} → ${r}`).join(", ") || "no check matched a rule's wording"}.`);
  } else {
    todos.push("No machine-readable or markdown rules found. Checks will run but can only warn until they are mapped to rules.");
  }

  // --- Docs -----------------------------------------------------------------------------------------------
  const componentDocs = await files(["{docs,design-library,design-system}/**/*.{md,mdx}", "COMPONENTS*.md", "src/components/**/*.md"]);
  const tokenDocs = componentDocs.filter((f) => /token|theme|design\.md|brand|foundation|color/i.test(f));
  const rootTokenDocs = await files(["{TOKENS,THEME,BRAND,DESIGN}*.md"]);
  ingestion.docs = { components: componentDocs, tokens: [...new Set([...tokenDocs, ...rootTokenDocs])] };
  if (componentDocs.length) evidence.push(`Docs: ${count(componentDocs.length, "markdown file")} for component usage.`);
  else todos.push("No component docs found; every component will get a missing-usage-docs gap. Point docs.components at wherever usage guidance lives.");

  // --- Foundation --------------------------------------------------------------------------------------------
  const entryCss = cssFiles.find((f) => f.tailwindEntry)?.file ?? (await files(["src/{index,globals,global,app,main}.css", "app/globals.css", "styles/globals.css"]))[0];
  if (entryCss) {
    const foundationFiles = [entryCss, ...tailwindConfig, ...(await files(["postcss.config.{js,cjs,mjs}"]))];
    const buildPackages = ["tailwindcss", "postcss", "autoprefixer", "@tailwindcss/vite", "@tailwindcss/postcss"].filter((p) => p in deps);
    ingestion.foundation = { files: foundationFiles, packages: buildPackages };
    evidence.push(`Foundation: ${foundationFiles.join(", ")}; build packages ${buildPackages.join(", ") || "none"}.`);
  } else {
    todos.push("No global CSS entry found for ingestion.foundation; fetched components may render unstyled in new projects.");
  }

  const specialists: Domain[] = ["components"];
  if (tokens.length) specialists.push("tokens");
  if (ingestion.patterns) specialists.push("patterns");
  specialists.push("governance");
  evidence.push(`Specialists: ${specialists.join(", ")}${ingestion.patterns ? "" : " (no pattern data, so no patterns specialist)"}.`);

  return { ingestion, specialists, evidence, todos };
}
