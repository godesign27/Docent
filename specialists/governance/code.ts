/**
 * Deterministic checks on proposed code. Each check proves a specific kind of
 * violation from the code itself; what it cannot prove is listed as not
 * evaluated rather than silently passed.
 */
import ts from "typescript";
import { collectClassStrings } from "../../ingestion/extractors/react-tsx.js";
import { ARBITRARY_COLOR, PALETTE } from "../../ingestion/tokens/tailwind-classes.js";
import type { ComponentContract, GovernanceCheck } from "../../schema/contract.js";
import type { ContractIndex } from "../context.js";

export interface CodeFinding {
  check: GovernanceCheck;
  evidence: string;
  line: number;
}

const RAW_COLOR = /(#[0-9a-f]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d)/i;
const PASSTHROUGH_PROP = /^(key|ref|className|style|children|id|role|title|tabIndex|hidden|lang|dir|data-[\w-]+|aria-[\w-]+|on[A-Z]\w*)$/;

export const CODE_CHECKS: GovernanceCheck[] = [
  "restricted-package",
  "unapproved-import",
  "unindexed-component",
  "invalid-prop-value",
  "compound-structure",
  "bespoke-duplicate",
  "raw-color",
  "palette-utility",
];

export function checkCode(code: string, index: ContractIndex): { findings: CodeFinding[]; notEvaluated: string[] } {
  const { contract } = index;
  const sf = ts.createSourceFile("proposed.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: CodeFinding[] = [];
  const notEvaluated: string[] = [
    "Accessibility behaviour, composition rules beyond part nesting, AI attribution and namespace choice are not checked automatically.",
  ];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (check: GovernanceCheck, evidence: string, node: ts.Node) => {
    const line = lineOf(node);
    if (!findings.some((f) => f.check === check && f.evidence === evidence)) findings.push({ check, evidence, line });
  };

  const parseErrors = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseErrors.length) notEvaluated.push(`The code has ${parseErrors.length} syntax error(s); checks ran on what could be parsed.`);

  const approved = contract.governance.approvedImportPrefixes;
  const aliasRoots = [...new Set(approved.map((p) => p.split("/")[0] + "/"))];
  const inventory = contract.components.some((c) => c.manifest !== null);
  const byImportPath = new Map(contract.components.filter((c) => c.importPath).map((c) => [c.importPath!, c]));
  const designSystemImports = new Map<string, { component: ComponentContract; exportName: string }>();
  const otherImports = new Set<string>();
  const locals = new Set<string>();
  let relativeImports = 0;

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const spec = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      const named = bindings && ts.isNamedImports(bindings) ? bindings.elements : [];
      const localNames = [statement.importClause?.name?.text, bindings && ts.isNamespaceImport(bindings) ? bindings.name.text : undefined, ...named.map((e) => e.name.text)].filter(
        (n): n is string => Boolean(n),
      );

      if (spec.startsWith(".")) {
        relativeImports++;
        localNames.forEach((n) => otherImports.add(n));
        continue;
      }
      const isAlias = aliasRoots.some((root) => spec.startsWith(root));
      if (!isAlias) {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        if (index.isRestricted(pkg)) add("restricted-package", `import from "${spec}"`, statement);
        localNames.forEach((n) => otherImports.add(n));
        continue;
      }
      if (approved.length && !approved.some((p) => spec.startsWith(p))) {
        add("unapproved-import", `import from "${spec}" is outside the approved paths (${approved.join(", ")})`, statement);
        localNames.forEach((n) => otherImports.add(n));
        continue;
      }
      const component = byImportPath.get(spec);
      if (!component || (inventory && component.manifest === null)) {
        if (/\/components\//.test(spec)) add("unindexed-component", `"${spec}" is not a component in the inventory`, statement);
        localNames.forEach((n) => otherImports.add(n));
        continue;
      }
      const exported = new Set([...component.parts.map((p) => p.name), ...component.otherExports, ...component.typeExports]);
      for (const element of named) {
        const exportName = (element.propertyName ?? element.name).text;
        if (!exported.has(exportName)) add("unindexed-component", `${exportName} is not exported by "${spec}" (${component.name})`, element);
        else designSystemImports.set(element.name.text, { component, exportName });
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      locals.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name)) locals.add(d.name.text);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      locals.add(statement.name.text);
    }
  }
  if (relativeImports) notEvaluated.push(`${relativeImports} relative import(s) point at project files Docent cannot see.`);

  // Local components that re-create something the design system already has.
  for (const name of locals) {
    if (!/^[A-Z]/.test(name)) continue;
    const existing = index.components.get(name);
    const sameName = existing && (existing.name === name || existing.parts.some((p) => p.name === name));
    if (existing && sameName && (!inventory || existing.manifest !== null)) {
      const decl = sf.statements.find((s) => (ts.isFunctionDeclaration(s) && s.name?.text === name) || (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)));
      add("bespoke-duplicate", `${name} is defined locally, but ${existing.manifest?.id ?? existing.id} already provides it`, decl ?? sf);
    }
  }

  const hasImports = designSystemImports.size + otherImports.size + relativeImports > 0;
  const visit = (node: ts.Node, ancestors: string[]) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText(sf);
      const root = tag.split(".")[0]!;
      const ds = designSystemImports.get(root);
      const resolvedName = ds && !tag.includes(".") ? ds.exportName : tag;

      if (ds && !tag.includes(".")) {
        const part = ds.component.parts.find((p) => p.name === ds.exportName);
        if (part) {
          for (const attr of opening.attributes.properties) {
            if (!ts.isJsxAttribute(attr)) continue;
            const name = attr.name.getText(sf);
            const prop = part.props.find((p) => p.name === name);
            const value = literalValue(attr.initializer);
            if (prop?.values && value !== undefined && !prop.values.includes(value)) {
              add("invalid-prop-value", `<${tag} ${name}="${value}">: ${name} must be one of ${prop.values.join(", ")}`, attr);
            } else if (!prop && part.extends.length === 0 && !PASSTHROUGH_PROP.test(name)) {
              add("invalid-prop-value", `<${tag}> has no prop "${name}"`, attr);
            }
          }
        }
        const structure = ds.component.guidance?.structure as { parts?: { name?: string; parent?: string }[] } | null | undefined;
        const declared = structure?.parts?.find((p) => p.name === ds.exportName);
        if (declared?.parent && !ancestors.includes(declared.parent)) {
          add("compound-structure", `<${tag}> must be inside <${declared.parent}>`, opening);
        }
      } else if (/^[A-Z]/.test(root) && !otherImports.has(root) && !locals.has(root) && hasImports) {
        const known = index.components.get(root);
        add(
          "unindexed-component",
          known ? `<${tag}> is used without importing it from ${known.importPath}` : `<${tag}> is not a component in the design system`,
          opening,
        );
      }

      for (const attr of opening.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== "style" || !attr.initializer) continue;
        attr.initializer.forEachChild(function colors(n): void {
          if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && RAW_COLOR.test(n.text)) add("raw-color", `style uses the raw color ${n.text}`, n);
          n.forEachChild(colors);
        });
      }

      const next = [...ancestors, resolvedName];
      if (ts.isJsxElement(node)) node.children.forEach((child) => visit(child, next));
      else opening.attributes.forEachChild((child) => visit(child, next));
      return;
    }
    node.forEachChild((child) => visit(child, ancestors));
  };
  visit(sf, []);

  for (const { value, line } of collectClassStrings(sf)) {
    for (const cls of value.split(/\s+/)) {
      const stem = cls.replace(/^(?:[\w-]+(?:\[[^\]]*\])?:)*!?/, "").replace(/\/\d+$/, "");
      if (PALETTE.test(stem)) pushLine("palette-utility", `class "${cls}" is a Tailwind palette color, not a token`, line);
      else if (ARBITRARY_COLOR.test(stem)) pushLine("raw-color", `class "${cls}" hard-codes a color`, line);
    }
  }
  function pushLine(check: GovernanceCheck, evidence: string, line: number) {
    if (!findings.some((f) => f.check === check && f.evidence === evidence)) findings.push({ check, evidence, line });
  }

  return { findings: findings.sort((a, b) => a.line - b.line), notEvaluated };
}

function literalValue(initializer: ts.JsxAttribute["initializer"]): string | undefined {
  if (!initializer) return undefined;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer) && initializer.expression) {
    const e = initializer.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return undefined;
}
