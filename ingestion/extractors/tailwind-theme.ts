/**
 * Reads a Tailwind (v3-style) config's theme by walking its AST. The config is
 * never executed: anything that is not a static literal (spreads, function
 * calls, imported values) is reported as a gap instead of evaluated.
 */
import ts from "typescript";
import type { GapCollector } from "../gaps.js";
import type { TailwindEntry } from "../tokens/values.js";

/** Theme sections that describe animations' internals rather than tokens. */
const SKIPPED_SECTIONS = new Set(["keyframes", "container", "extend"]);

export function extractTailwindTheme(file: string, text: string, gaps: GapCollector): TailwindEntry[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const unresolvable = (node: ts.Node, what: string) =>
    gaps.add({
      severity: "info",
      kind: "unresolvable-config-value",
      subject: { type: "source", id: file },
      detail: `${what}@${line(node)}`,
      message: `${what} in ${file} is computed (${node.getText(sf).slice(0, 60).replace(/\s+/g, " ")}), so Docent cannot read it without executing the config.`,
      location: { file, line: line(node) },
      suggestion: "Inline the value, or move tokens to CSS variables or a tokens JSON file.",
    });

  const config = findConfigObject(sf);
  if (!config) {
    gaps.add({
      severity: "warning",
      kind: "unresolvable-config-value",
      subject: { type: "source", id: file },
      message: `No statically readable config object found in ${file}.`,
      location: { file },
    });
    return [];
  }

  const theme = getProp(config, "theme");
  if (!theme) return [];
  if (!ts.isObjectLiteralExpression(theme)) {
    unresolvable(theme, "theme");
    return [];
  }

  const entries: TailwindEntry[] = [];
  const walkSection = (section: string, node: ts.Expression, path: string[]) => {
    node = unwrapExpr(node);
    const literal = literalValue(node);
    if (literal !== undefined) {
      walkSectionValue(section, path, literal, node);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      // fontFamily: ["Inter", "sans-serif"] / fontSize: ["0.875rem", { lineHeight: "1.25rem" }]
      const first = node.elements[0] ? literalValue(unwrapExpr(node.elements[0])) : undefined;
      const allLiteral = node.elements.every((el) => literalValue(unwrapExpr(el)) !== undefined);
      if (allLiteral && first !== undefined) {
        walkSectionValue(section, path, node.elements.map((el) => literalValue(unwrapExpr(el))!).join(", "), node);
        return;
      }
      if (first !== undefined && node.elements.slice(1).every((el) => ts.isObjectLiteralExpression(unwrapExpr(el)))) {
        walkSectionValue(section, path, first, node);
        return;
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const name = propName(prop.name);
          if (name === undefined) unresolvable(prop, `${section}.${path.join(".")}`);
          else walkSection(section, prop.initializer, [...path, name]);
        } else {
          unresolvable(prop, `${[section, ...path].join(".")}`);
        }
      }
      return;
    }
    unresolvable(node, [section, ...path].join("."));
  };
  const walkSectionValue = (section: string, path: string[], raw: string, node: ts.Node) => {
    const key = path.filter((p) => p !== "DEFAULT").join("-") || "DEFAULT";
    entries.push({ section, key, raw, source: { file, line: line(node) } });
  };

  const walkTheme = (obj: ts.ObjectLiteralExpression) => {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        unresolvable(prop, "theme");
        continue;
      }
      const section = propName(prop.name);
      if (!section) continue;
      if (section === "extend") {
        const ext = unwrapExpr(prop.initializer);
        if (ts.isObjectLiteralExpression(ext)) walkTheme(ext);
        else unresolvable(ext, "theme.extend");
        continue;
      }
      if (SKIPPED_SECTIONS.has(section)) continue;
      walkSection(section, prop.initializer, []);
    }
  };
  walkTheme(theme);
  return entries;
}

function findConfigObject(sf: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  const locals = new Map<string, ts.Expression>();
  let exported: ts.Expression | undefined;
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) locals.set(d.name.text, d.initializer);
      }
    } else if (ts.isExportAssignment(st)) {
      exported = st.expression;
    } else if (
      ts.isExpressionStatement(st) &&
      ts.isBinaryExpression(st.expression) &&
      st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      st.expression.left.getText(sf) === "module.exports"
    ) {
      exported = st.expression.right;
    }
  }
  let node = exported;
  for (let i = 0; node && i < 5; i++) {
    node = unwrapExpr(node);
    if (ts.isObjectLiteralExpression(node)) return node;
    if (ts.isIdentifier(node)) node = locals.get(node.text);
    else if (ts.isCallExpression(node) && node.arguments.length === 1) node = node.arguments[0]; // defineConfig({...})
    else return undefined;
  }
  return undefined;
}

function unwrapExpr(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function getProp(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propName(p.name) === key) return unwrapExpr(p.initializer);
  }
  return undefined;
}

function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function literalValue(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}
