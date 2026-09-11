/**
 * Reads per-component specs the client authored for agents (JSON), attaches
 * their guidance to component contracts, and reports where a spec disagrees
 * with the source. Source is authoritative; specs never override it.
 */
import type { SpecsConfig } from "../config/schema.js";
import type { ComponentContract, ComponentGuidance } from "../schema/contract.js";
import { findFiles, lineOf, readText } from "./files.js";
import type { GapCollector } from "./gaps.js";
import { getPath } from "./manifest.js";

export interface LoadedSpec {
  file: string;
  id: string | null;
  sourceFile: string | null;
  guidance: ComponentGuidance;
  specProps: { name: string; type: string; required: boolean }[];
  exports: string[] | null;
  variants: string[] | null;
  sizes: string[] | null;
}

export async function loadSpecs(
  root: string,
  config: SpecsConfig,
  isPlaceholder: (value: string) => boolean,
  scanned: Set<string>,
  gaps: GapCollector,
): Promise<LoadedSpec[]> {
  const files = await findFiles(root, config.include, config.exclude);
  const specs: LoadedSpec[] = [];
  for (const file of files) {
    scanned.add(file);
    const text = readText(root, file);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      gaps.add({
        severity: "error",
        kind: "parse-error",
        subject: { type: "source", id: file },
        message: `Could not parse ${file}: ${(err as Error).message}`,
        location: { file },
      });
      continue;
    }

    const f = config.fields;
    const field = (path: string | undefined) => (path ? getPath(data, path) : undefined);
    const str = (path: string | undefined) => {
      const v = field(path);
      return typeof v === "string" && v.trim() && !isPlaceholder(v) ? v.trim() : null;
    };
    const strings = (path: string | undefined) => {
      const v = field(path);
      return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "" && !isPlaceholder(s)) : [];
    };
    const record = (path: string | undefined) => {
      const v = field(path);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    };
    const rawProps = field(f.props);
    const specProps = (Array.isArray(rawProps) ? rawProps : []).filter(
      (p): p is { name: string; type?: unknown; required?: unknown; hint?: unknown } =>
        Boolean(p) && typeof p === "object" && typeof (p as { name?: unknown }).name === "string",
    );
    const related = field(f.related);
    const optionalStrings = (path: string | undefined) => (path && Array.isArray(field(path)) ? strings(path) : null);

    const id = config.idField ? str(config.idField) : null;
    specs.push({
      file,
      id,
      sourceFile: config.sourceField ? str(config.sourceField) : null,
      guidance: {
        source: { file, line: 1 },
        id,
        lifecycle: str(f.lifecycle),
        category: str(f.category),
        intent: str(f.intent),
        description: str(f.description),
        forbiddenUsage: strings(f.forbiddenUsage),
        agentRules: strings(f.agentRules),
        propHints: Object.fromEntries(
          specProps
            .filter((p) => typeof p.hint === "string" && p.hint.trim() && !isPlaceholder(p.hint))
            .map((p) => [p.name, (p.hint as string).trim()]),
        ),
        structure: field(f.structure) ?? null,
        accessibility: record(f.accessibility),
        experience: record(f.experience),
        related: (Array.isArray(related) ? related : [])
          .map((r) => (typeof r === "string" ? { id: r, note: null } : r && typeof r === "object" ? { id: (r as { id?: unknown }).id, note: (r as { note?: unknown }).note } : null))
          .filter((r): r is { id: string; note: unknown } => Boolean(r) && typeof r!.id === "string")
          .map((r) => ({ id: r.id, note: typeof r.note === "string" ? r.note : null })),
        knownGaps: strings(f.knownGaps),
      },
      specProps: specProps.map((p) => ({ name: p.name, type: typeof p.type === "string" ? p.type : "", required: p.required === true })),
      exports: optionalStrings(f.exports),
      variants: optionalStrings(f.variants),
      sizes: optionalStrings(f.sizes),
    });
    if (id) specs[specs.length - 1]!.guidance.source.line = lineOf(text, Math.max(0, text.indexOf(JSON.stringify(id))));
  }
  return specs;
}

export function attachSpecs(components: ComponentContract[], specs: LoadedSpec[], gaps: GapCollector): void {
  const unmatched = new Set(specs);
  for (const component of components) {
    const spec =
      specs.find((s) => s.sourceFile !== null && component.files.includes(s.sourceFile)) ??
      specs.find((s) => s.id !== null && (s.id === component.manifest?.id || s.id === component.id));
    const subject = { type: "component" as const, id: component.id };
    if (!spec) {
      gaps.add({
        severity: "warning",
        kind: "spec-missing",
        subject,
        message: `${component.name} has no agent spec, so there is no authored guidance (intent, forbidden usage, accessibility) for it.`,
        location: { file: component.files[0]! },
        suggestion: "Add a spec for this component.",
      });
      continue;
    }
    unmatched.delete(spec);
    component.guidance = spec.guidance;
    checkDrift(component, spec, gaps);
  }

  for (const spec of unmatched) {
    gaps.add({
      severity: "warning",
      kind: "spec-without-source",
      subject: { type: "component", id: spec.id ?? spec.file },
      message: `${spec.file} describes ${spec.id ?? "a component"}${spec.sourceFile ? ` at ${spec.sourceFile}` : ""}, but no matching component was found in the scanned source.`,
      location: { file: spec.file },
      suggestion: "Remove the stale spec, or add the component's files to the react-tsx include globs.",
    });
  }
}

function checkDrift(component: ComponentContract, spec: LoadedSpec, gaps: GapCollector): void {
  const drift = (detail: string, message: string) =>
    gaps.add({
      severity: "warning",
      kind: "spec-drift",
      subject: { type: "component", id: component.id },
      detail,
      message: `${spec.file} disagrees with ${component.files[0]}: ${message} Source wins; the contract follows source.`,
      location: spec.guidance.source,
      suggestion: "Regenerate or correct the spec.",
    });
  const list = (items: string[]) => (items.length ? items.map((i) => `\`${i}\``).join(", ") : "none");

  if (spec.exports) {
    // Specs need not list types, but must list every value export and may not list exports that don't exist.
    const values = [...component.parts.map((p) => p.name), ...component.otherExports];
    const all = new Set([...values, ...component.typeExports]);
    const specExports = new Set(spec.exports);
    const missing = values.filter((e) => !specExports.has(e)).sort();
    const extra = [...specExports].filter((e) => !all.has(e)).sort();
    if (missing.length || extra.length) {
      drift("exports", `exports missing from spec: ${list(missing)}; exports in spec but not in source: ${list(extra)}.`);
    }
  }

  const specPropNames = new Set(spec.specProps.map((p) => p.name));
  const requiredMissing = component.parts
    .flatMap((part) => part.props.filter((p) => p.required && p.origin === "declared").map((p) => `${part.name}.${p.name}`))
    .filter((qualified) => !specPropNames.has(qualified.split(".")[1]!));
  if (requiredMissing.length) {
    drift("required-props", `required props in source are not in the spec: ${list(requiredMissing)}.`);
  }

  for (const specProp of spec.specProps) {
    const specValues = literalValues(specProp.type);
    if (!specValues) continue;
    // Compound components can have the same prop on several parts; drift only if no part matches.
    const candidates = component.parts.flatMap((p) => p.props).filter((p) => p.name === specProp.name && p.values);
    if (candidates.length > 0 && !candidates.some((p) => sameSet(p.values!, specValues))) {
      drift(`prop:${specProp.name}`, `\`${specProp.name}\` values are ${list(specValues)} in the spec but ${candidates.map((p) => list(p.values!)).join(" / ")} in source.`);
    }
  }

  for (const [axis, specValues] of [["variant", spec.variants], ["size", spec.sizes]] as const) {
    if (!specValues) continue;
    const sourceAxes = component.parts.flatMap((p) => p.variants).filter((v) => v.name === axis);
    const matches = sourceAxes.length === 0 ? specValues.length === 0 : sourceAxes.some((v) => sameSet(v.values, specValues));
    if (!matches) {
      const sourceValues = sourceAxes.length ? sourceAxes.map((v) => list(v.values)).join(" / ") : "none";
      drift(`axis:${axis}`, `\`${axis}\` values are ${list(specValues)} in the spec but ${sourceValues} in source.`);
    }
  }
}

function literalValues(type: string): string[] | null {
  const members = type.split("|").map((m) => m.trim());
  if (members.length < 2 || !members.every((m) => /^"[^"]*"$/.test(m) || /^'[^']*'$/.test(m))) return null;
  return members.map((m) => m.slice(1, -1));
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v));
}
