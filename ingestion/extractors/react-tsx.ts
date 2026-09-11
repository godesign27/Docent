/**
 * Extracts component contracts from React TSX/JSX modules by static parsing.
 * Client code is never executed or type-checked against node_modules, so
 * props inherited from external types are recorded but not expanded.
 */
import ts from "typescript";
import type { ComponentPart, PropContract, VariantAxis } from "../../schema/contract.js";
import type { GapCollector } from "../gaps.js";

export interface ExtractedModule {
  id: string;
  file: string;
  parts: ComponentPart[];
  otherExports: string[];
  dependencies: string[];
  /** Class-name strings used for styling, for token cross-referencing. */
  classStrings: { value: string; line: number }[];
  /** Variant definitions (cva/tv) declared in this module, by variable name. */
  variantDefs: Map<string, VariantAxis[]>;
  /** Imported local name -> module specifier. */
  imports: Map<string, string>;
}

const CLASS_HELPERS = new Set(["cn", "clsx", "cx", "classnames", "classNames", "twMerge", "cva", "tv"]);
const REACT_WRAPPERS = new Set(["forwardRef", "memo"]);

export function toPascalCase(slug: string): string {
  return slug
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

export function extractReactModule(file: string, text: string, gaps: GapCollector): ExtractedModule | null {
  const kind = file.endsWith(".jsx") ? ts.ScriptKind.JSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const id = file.replace(/^.*\//, "").replace(/\.[jt]sx?$/, "");
  const loc = (node: ts.Node) => ({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });

  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0]!;
    gaps.add({
      severity: "error",
      kind: "parse-error",
      subject: { type: "source", id: file },
      message: `Could not parse ${file}: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
      location: { file, line: sf.getLineAndCharacterOfPosition(first.start ?? 0).line + 1 },
    });
    return null;
  }

  // --- Top-level declarations, imports and exports -------------------------
  const values = new Map<string, { node: ts.Node; statement: ts.Statement }>();
  const types = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  const exported = new Map<string, string>(); // exported name -> local name
  const imports = new Map<string, string>(); // local name -> module specifier
  const dependencies = new Set<string>();

  const hasExport = (node: ts.Node) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const spec = statement.moduleSpecifier.text;
      if (!spec.startsWith(".") && !/^[@~#]\//.test(spec)) {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
        if (pkg !== "react" && pkg !== "react-dom") dependencies.add(pkg);
      }
      const clause = statement.importClause;
      if (clause?.name) imports.set(clause.name.text, spec);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) imports.set(clause.namedBindings.name.text, spec);
        else for (const el of clause.namedBindings.elements) imports.set(el.name.text, spec);
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        values.set(decl.name.text, { node: decl.initializer, statement });
        if (hasExport(statement)) exported.set(decl.name.text, decl.name.text);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      values.set(statement.name.text, { node: statement, statement });
      if (hasExport(statement)) exported.set(statement.name.text, statement.name.text);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      values.set(statement.name.text, { node: statement, statement });
      if (hasExport(statement)) exported.set(statement.name.text, statement.name.text);
    } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      types.set(statement.name.text, statement);
    } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && !statement.isTypeOnly) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) {
          if (el.isTypeOnly) continue;
          exported.set(el.name.text, (el.propertyName ?? el.name).text);
        }
      }
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      exported.set("default", statement.expression.text);
    }
  }

  // --- Variant definitions (cva / tailwind-variants) ------------------------
  const variantDefs = new Map<string, VariantAxis[]>();
  for (const [name, { node }] of values) {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) continue;
    const callee = node.expression.text;
    const configArg = callee === "cva" ? node.arguments[1] : callee === "tv" ? node.arguments[0] : undefined;
    if (!configArg || !ts.isObjectLiteralExpression(configArg)) continue;
    variantDefs.set(name, readVariantConfig(configArg, loc));
  }

  // --- Components -----------------------------------------------------------
  const parts: ComponentPart[] = [];
  const otherExports: string[] = [];
  const inheritedFrom = new Set<string>();

  for (const [exportName, localName] of [...exported].sort(([a], [b]) => a.localeCompare(b))) {
    const decl = values.get(localName);
    const name = exportName === "default" ? localName : exportName;
    if (!decl) continue;
    const shape = componentShape(decl.node, imports);
    if (!/^[A-Z]/.test(name) || !shape) {
      otherExports.push(name);
      continue;
    }

    const resolved: ResolvedProps = { props: [], extends: [], variants: [], resolved: false };
    if (shape.kind === "alias") {
      resolved.extends.push(`React.ComponentProps<typeof ${shape.target}>`);
      resolved.resolved = true;
      inheritedFrom.add(imports.get(shape.target.split(".")[0]!) ?? shape.target);
    } else if (shape.propsType) {
      resolveTypeNode(shape.propsType, { types, variantDefs, sf, loc }, resolved, 0);
      resolved.resolved = true;
    } else if (shape.fn && shape.fn.parameters.length === 0) {
      resolved.resolved = true; // takes no props
    }
    for (const ext of resolved.extends) {
      if (ext.startsWith("VariantProps<")) continue; // linked across modules later
      const root = ext.match(/typeof\s+([A-Za-z_$][\w$]*)/)?.[1];
      if (root && imports.has(root)) inheritedFrom.add(imports.get(root)!);
    }

    const defaults = shape.fn ? destructuredDefaults(shape.fn, sf) : new Map<string, string>();
    const props = mergeVariantProps(resolved, defaults);

    if (!resolved.resolved) {
      gaps.add({
        severity: "warning",
        kind: "props-not-resolved",
        subject: { type: "component", id },
        detail: name,
        message: `${name} has no statically readable props type, so its props are not in the contract.`,
        location: loc(decl.node),
        suggestion: `Annotate ${name}'s props with a type or interface.`,
      });
    }

    parts.push({
      name,
      primary: false,
      element: shape.kind === "alias" ? shape.target : shape.fn ? renderedElement(shape.fn, sf) : undefined,
      props,
      extends: resolved.extends,
      variants: resolved.variants,
      description: jsDocText(decl.statement),
      source: loc(decl.node),
    });
  }

  if (parts.length === 0) return null;

  const expected = toPascalCase(id);
  const primary =
    parts.find((p) => p.name.toLowerCase() === expected.toLowerCase()) ?? (parts.length === 1 ? parts[0] : undefined);
  if (primary) primary.primary = true;
  else {
    gaps.add({
      severity: "info",
      kind: "no-primary-export",
      subject: { type: "component", id },
      message: `${file} exports ${parts.length} components and none is named ${expected}; the module is treated as a family with no primary part.`,
      location: { file },
    });
  }

  if (inheritedFrom.size > 0) {
    gaps.add({
      severity: "info",
      kind: "inherited-props-not-expanded",
      subject: { type: "component", id },
      message: `Some parts inherit props from ${[...inheritedFrom].sort().join(", ")}; those inherited props are listed under "extends" but not expanded.`,
      location: { file },
    });
  }

  return {
    id,
    file,
    parts,
    otherExports: otherExports.sort(),
    dependencies: [...dependencies].sort(),
    classStrings: collectClassStrings(sf),
    variantDefs,
    imports,
  };
}

/**
 * Resolves `VariantProps<typeof x>` where x is imported from another scanned
 * module (e.g. ToggleGroup reusing toggleVariants from toggle.tsx).
 */
export function linkImportedVariants(
  modules: ExtractedModule[],
  resolveImport: (fromFile: string, specifier: string) => ExtractedModule | undefined,
): void {
  for (const mod of modules) {
    for (const part of mod.parts) {
      part.extends = part.extends.filter((ext) => {
        const variable = ext.match(/^VariantProps<typeof ([A-Za-z_$][\w$]*)>$/)?.[1];
        const specifier = variable ? mod.imports.get(variable) : undefined;
        const axes = specifier ? resolveImport(mod.file, specifier)?.variantDefs.get(variable!) : undefined;
        if (!axes) return true;
        part.variants.push(...axes);
        part.props = mergeVariantProps({ props: part.props, extends: [], variants: axes, resolved: true }, new Map());
        return false;
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Component shape
// ---------------------------------------------------------------------------

type FunctionLike = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;
type Shape =
  | { kind: "function"; fn: FunctionLike | undefined; propsType: ts.TypeNode | undefined }
  | { kind: "alias"; target: string; fn?: undefined; propsType?: undefined };

function unwrap(node: ts.Node): ts.Node {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function componentShape(node: ts.Node, imports: Map<string, string>): Shape | undefined {
  node = unwrap(node);
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return { kind: "function", fn: node, propsType: node.parameters[0]?.type };
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name && REACT_WRAPPERS.has(name)) {
      const inner = node.arguments[0] ? componentShape(node.arguments[0], imports) : undefined;
      if (name === "forwardRef" && node.typeArguments?.[1]) {
        return { kind: "function", fn: inner?.fn, propsType: node.typeArguments[1] };
      }
      return inner ?? { kind: "function", fn: undefined, propsType: undefined };
    }
    return undefined;
  }
  // `const Dialog = DialogPrimitive.Root` or `const Form = FormProvider`
  if (ts.isPropertyAccessExpression(node) || ts.isIdentifier(node)) {
    const text = node.getText();
    const root = text.split(".")[0]!;
    if (imports.has(root) && /^[A-Z]/.test(text.split(".").pop()!)) return { kind: "alias", target: text };
  }
  if (ts.isClassDeclaration(node)) {
    const heritage = node.heritageClauses?.flatMap((h) => h.types) ?? [];
    const base = heritage.find((t) => /(Pure)?Component$/.test(t.expression.getText()));
    if (base) return { kind: "function", fn: undefined, propsType: base.typeArguments?.[0] };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ResolvedProps {
  props: PropContract[];
  extends: string[];
  variants: VariantAxis[];
  resolved: boolean;
}

interface ResolveContext {
  types: Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>;
  variantDefs: Map<string, VariantAxis[]>;
  sf: ts.SourceFile;
  loc: (node: ts.Node) => { file: string; line: number };
}

function resolveTypeNode(node: ts.TypeNode, ctx: ResolveContext, out: ResolvedProps, depth: number): void {
  if (depth > 8) {
    out.extends.push(node.getText(ctx.sf));
    return;
  }
  if (ts.isParenthesizedTypeNode(node)) return resolveTypeNode(node.type, ctx, out, depth + 1);
  if (ts.isIntersectionTypeNode(node)) {
    for (const t of node.types) resolveTypeNode(t, ctx, out, depth + 1);
    return;
  }
  if (ts.isTypeLiteralNode(node)) {
    readMembers(node.members, ctx, out);
    return;
  }
  if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
    const name = ts.isTypeReferenceNode(node) ? node.typeName.getText(ctx.sf) : node.expression.getText(ctx.sf);
    const args = node.typeArguments ?? [];
    if (name === "VariantProps" && args[0] && ts.isTypeQueryNode(args[0])) {
      const defs = ctx.variantDefs.get(args[0].exprName.getText(ctx.sf));
      if (defs) {
        out.variants.push(...defs);
        return;
      }
    }
    const local = ctx.types.get(name);
    if (local && ts.isInterfaceDeclaration(local)) {
      for (const clause of local.heritageClauses ?? []) {
        for (const t of clause.types) resolveTypeNode(t, ctx, out, depth + 1);
      }
      readMembers(local.members, ctx, out);
      return;
    }
    if (local && ts.isTypeAliasDeclaration(local)) return resolveTypeNode(local.type, ctx, out, depth + 1);
  }
  out.extends.push(node.getText(ctx.sf).replace(/\s+/g, " "));
}

function readMembers(members: ts.NodeArray<ts.TypeElement>, ctx: ResolveContext, out: ResolvedProps): void {
  for (const member of members) {
    if (!(ts.isPropertySignature(member) || ts.isMethodSignature(member)) || !member.name) continue;
    const name = member.name.getText(ctx.sf).replace(/^["']|["']$/g, "");
    let type = "unknown";
    if (ts.isPropertySignature(member) && member.type) type = member.type.getText(ctx.sf);
    if (ts.isMethodSignature(member)) {
      type = `(${member.parameters.map((p) => p.getText(ctx.sf)).join(", ")}) => ${member.type?.getText(ctx.sf) ?? "void"}`;
    }
    const prop: PropContract = {
      name,
      type: type.replace(/\s+/g, " "),
      required: !member.questionToken,
      origin: "declared",
    };
    const values = ts.isPropertySignature(member) && member.type ? literalUnion(member.type) : undefined;
    if (values) prop.values = values;
    const description = jsDocText(member);
    if (description) prop.description = description;
    out.props = out.props.filter((p) => p.name !== name);
    out.props.push(prop);
  }
}

function literalUnion(node: ts.TypeNode): string[] | undefined {
  const members = ts.isUnionTypeNode(node) ? node.types : [node];
  const values: string[] = [];
  for (const m of members) {
    if (ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal)) values.push(m.literal.text);
    else if (ts.isLiteralTypeNode(m) && m.literal.kind === ts.SyntaxKind.NullKeyword) continue;
    else if (m.kind === ts.SyntaxKind.UndefinedKeyword) continue;
    else return undefined;
  }
  return values.length > 0 ? values : undefined;
}

function mergeVariantProps(resolved: ResolvedProps, defaults: Map<string, string>): PropContract[] {
  const props = [...resolved.props];
  for (const axis of resolved.variants) {
    if (props.some((p) => p.name === axis.name)) continue;
    const prop: PropContract = {
      name: axis.name,
      type: axis.values.map((v) => JSON.stringify(v)).join(" | "),
      required: false,
      values: axis.values,
      origin: "variant",
    };
    if (axis.default !== undefined) prop.default = axis.default;
    props.push(prop);
  }
  for (const prop of props) {
    const d = defaults.get(prop.name);
    if (d !== undefined) prop.default = d.replace(/^["']|["']$/g, "");
  }
  return props.sort((a, b) => a.name.localeCompare(b.name));
}

function destructuredDefaults(fn: FunctionLike, sf: ts.SourceFile): Map<string, string> {
  const defaults = new Map<string, string>();
  const param = fn.parameters[0];
  if (param && ts.isObjectBindingPattern(param.name)) {
    for (const el of param.name.elements) {
      if (el.initializer && !el.dotDotDotToken) {
        defaults.set((el.propertyName ?? el.name).getText(sf), el.initializer.getText(sf));
      }
    }
  }
  return defaults;
}

function readVariantConfig(config: ts.ObjectLiteralExpression, loc: ResolveContext["loc"]): VariantAxis[] {
  const prop = (obj: ts.ObjectLiteralExpression, key: string) =>
    obj.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propertyKey(p.name) === key,
    )?.initializer;

  const variants = prop(config, "variants");
  const defaults = prop(config, "defaultVariants");
  if (!variants || !ts.isObjectLiteralExpression(variants)) return [];

  const axes: VariantAxis[] = [];
  for (const axis of variants.properties) {
    if (!ts.isPropertyAssignment(axis) || !ts.isObjectLiteralExpression(axis.initializer)) continue;
    const name = propertyKey(axis.name);
    if (!name) continue;
    const values = axis.initializer.properties
      .map((p) => (p.name ? propertyKey(p.name) : undefined))
      .filter((v): v is string => v !== undefined);
    const entry: VariantAxis = { name, values, source: loc(axis) };
    const def = defaults && ts.isObjectLiteralExpression(defaults) ? prop(defaults, name) : undefined;
    if (def) entry.default = def.getText().replace(/^["']|["']$/g, "");
    axes.push(entry);
  }
  return axes;
}

function propertyKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function jsDocText(node: ts.Node): string | null {
  const docs = (node as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
  const text = docs
    ?.map((d) => ts.getTextOfJSDocComment(d.comment))
    .filter(Boolean)
    .join("\n")
    .trim();
  return text ? text : null;
}

function renderedElement(fn: FunctionLike, sf: ts.SourceFile): string | undefined {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(node)) found = node.openingElement.tagName.getText(sf);
    else if (ts.isJsxSelfClosingElement(node)) found = node.tagName.getText(sf);
    else if (ts.isJsxFragment(node)) found = "Fragment";
    else ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  if (!found || !/^[a-z_$][\w$]*$/i.test(found) || !fn.body) return found;

  // `const Comp = asChild ? Slot : "button"` -> Slot | "button"
  let dynamic: string | undefined;
  const findLocal = (node: ts.Node): void => {
    if (dynamic) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === found && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isConditionalExpression(init)) dynamic = `${init.whenTrue.getText(sf)} | ${init.whenFalse.getText(sf)}`;
    } else ts.forEachChild(node, findLocal);
  };
  findLocal(fn.body);
  return dynamic ?? found;
}

function collectClassStrings(sf: ts.SourceFile): { value: string; line: number }[] {
  const out: { value: string; line: number }[] = [];
  const push = (node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): void => {
    out.push({ value: node.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  };

  const collectStrings = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) return collectStrings(node.initializer); // skip keys
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return push(node);
    if (ts.isTemplateExpression(node)) {
      out.push({ value: [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" "), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    ts.forEachChild(node, collectStrings);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CLASS_HELPERS.has(node.expression.text)) {
      node.arguments.forEach(collectStrings);
      return;
    }
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === "className" && node.initializer) {
      collectStrings(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
