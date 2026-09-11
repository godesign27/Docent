/**
 * Reads prototype source as text: imports, JSX usage, class strings, CSS variables and raw colors,
 * each with its line. Nothing is executed and nothing here knows any design system.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

export interface ScannedImport {
  module: string;
  /** The exported name: "default" for a default import, "*" for a namespace or side-effect import. */
  imported: string;
  local: string;
  typeOnly: boolean;
  line: number;
}

export interface ScannedElement {
  tag: string;
  line: number;
  /** Literal string props keep their value; expressions are null. */
  props: { name: string; value: string | null }[];
}

export interface ScannedFile {
  file: string;
  imports: ScannedImport[];
  elements: ScannedElement[];
  classes: { value: string; line: number }[];
  /** var(--x) references; custom properties the file sets itself are excluded. Utility classes like bg-[--x] are classified with the classes. */
  cssVariables: { name: string; line: number }[];
  rawColors: { value: string; line: number }[];
}

export interface PathAlias {
  alias: string;
  target: string;
}

const CLASS_HELPERS = new Set(["cn", "clsx", "cx", "classnames", "classNames", "twMerge", "cva", "tv"]);
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(\s*[\d.]/g;

export function scanFile(root: string, file: string): ScannedFile {
  const text = readFileSync(join(root, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const out: ScannedFile = { file, imports: [], elements: [], classes: [], cssVariables: [], rawColors: [] };
  const setLocally = new Set<string>();

  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    const line = lineOf(statement);
    if (!clause) {
      out.imports.push({ module, imported: "*", local: "", typeOnly: false, line });
      continue;
    }
    if (clause.name) out.imports.push({ module, imported: "default", local: clause.name.text, typeOnly: clause.isTypeOnly, line });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) out.imports.push({ module, imported: "*", local: bindings.name.text, typeOnly: clause.isTypeOnly, line });
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        out.imports.push({ module, imported: (el.propertyName ?? el.name).text, local: el.name.text, typeOnly: clause.isTypeOnly || el.isTypeOnly, line: lineOf(el) });
      }
    }
  }

  const classStrings = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) return classStrings(node.initializer);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.classes.push({ value: node.text, line: lineOf(node) });
    else if (ts.isTemplateExpression(node)) out.classes.push({ value: [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" "), line: lineOf(node) });
    ts.forEachChild(node, classStrings);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const props: ScannedElement["props"] = [];
      for (const attr of opening.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue;
        const name = attr.name.getText(sf);
        const init = attr.initializer;
        const literal = !init ? "true" : ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression) ? init.expression.text : null;
        props.push({ name, value: literal });
        if (name === "className" && init) classStrings(init);
      }
      out.elements.push({ tag: opening.tagName.getText(sf), line: lineOf(opening), props });
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CLASS_HELPERS.has(node.expression.text)) node.arguments.forEach(classStrings);
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith("--")) setLocally.add(node.name.text);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const line = lineOf(node);
      if (!ts.isImportDeclaration(node.parent)) {
        for (const m of node.text.matchAll(/var\(\s*(--[\w-]+)/g)) out.cssVariables.push({ name: m[1]!, line });
        for (const m of node.text.matchAll(RAW_COLOR)) out.rawColors.push({ value: m[0], line });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  out.cssVariables = out.cssVariables.filter((v) => !setLocally.has(v.name));
  return out;
}

/** CSS a prototype file imports: var(--x) uses of variables it doesn't declare itself. */
export function scanCss(root: string, file: string): Pick<ScannedFile, "cssVariables" | "rawColors"> {
  const lines = readFileSync(join(root, file), "utf8").split("\n");
  const declared = new Set(lines.flatMap((l) => [...l.matchAll(/(?:^|[{;\s])(--[\w-]+)\s*:/g)].map((m) => m[1]!)));
  const cssVariables: ScannedFile["cssVariables"] = [];
  const rawColors: ScannedFile["rawColors"] = [];
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/var\(\s*(--[\w-]+)/g)) if (!declared.has(m[1]!)) cssVariables.push({ name: m[1]!, line: i + 1 });
    if (!/^\s*--/.test(l)) for (const m of l.replace(/\/\*.*?\*\//g, "").matchAll(RAW_COLOR)) rawColors.push({ value: m[0], line: i + 1 });
  });
  return { cssVariables, rawColors };
}

/** Path aliases from tsconfig.json / tsconfig.app.json / jsconfig.json, e.g. "@/" → "src/". */
export function loadAliases(root: string): PathAlias[] {
  const aliases: PathAlias[] = [];
  for (const name of ["tsconfig.json", "tsconfig.app.json", "jsconfig.json"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const { config } = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
    const options = config?.compilerOptions ?? {};
    const base: string = options.baseUrl ?? ".";
    for (const [pattern, targets] of Object.entries((options.paths ?? {}) as Record<string, string[]>)) {
      const first = targets[0];
      if (!pattern.endsWith("*") || !first?.endsWith("*")) continue;
      const alias = pattern.slice(0, -1);
      const target = posix.normalize(posix.join(base, first.slice(0, -1))).replace(/^\.\/?/, "");
      if (!aliases.some((a) => a.alias === alias)) aliases.push({ alias, target });
    }
  }
  return aliases;
}

const EXTENSIONS = ["", ".tsx", ".ts", ".jsx", ".js", ".css", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];

export function isPackage(module: string, aliases: PathAlias[]): boolean {
  return !module.startsWith(".") && !module.startsWith("/") && !aliases.some((a) => module.startsWith(a.alias));
}

/** The project file an import points at, or null for a package or a file that isn't there. */
export function resolveImport(root: string, fromFile: string, module: string, aliases: PathAlias[]): string | null {
  let base: string;
  if (module.startsWith(".")) base = posix.join(posix.dirname(fromFile), module);
  else {
    const alias = aliases.find((a) => module.startsWith(a.alias));
    if (!alias) return null;
    base = posix.join(alias.target, module.slice(alias.alias.length));
  }
  for (const ext of EXTENSIONS) {
    const candidate = posix.normalize(base + ext);
    const full = join(root, candidate);
    if (existsSync(full) && statSync(full).isFile()) return candidate;
  }
  return null;
}
