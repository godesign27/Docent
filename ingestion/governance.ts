/**
 * Ingests the client's patterns, governance rules and semantic token roles.
 * Everything is read through config field mappings, so a client whose rules
 * live in differently shaped files only needs different config.
 */
import type { GovernanceConfig, PatternsConfig, TokenSemanticsConfig } from "../config/schema.js";
import {
  GovernanceCheck,
  RuleSeverity,
  type ComponentContract,
  type Governance,
  type GovernanceRule,
  type PatternContract,
  type TokenContract,
  type TokenGuidance,
} from "../schema/contract.js";
import { findFiles, lineOf, readText } from "./files.js";
import type { GapCollector } from "./gaps.js";
import { getPath } from "./manifest.js";

interface Context {
  root: string;
  scanned: Set<string>;
  gaps: GapCollector;
}

function readJson(ctx: Context, file: string): { data: unknown; text: string } | null {
  ctx.scanned.add(file);
  const text = readText(ctx.root, file);
  try {
    return { data: JSON.parse(text), text };
  } catch (err) {
    ctx.gaps.add({
      severity: "error",
      kind: "parse-error",
      subject: { type: "source", id: file },
      message: `Could not parse ${file}: ${(err as Error).message}`,
      location: { file },
    });
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "") : []);

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export async function loadPatterns(ctx: Context, config: PatternsConfig, components: ComponentContract[]): Promise<PatternContract[]> {
  const byKey = new Map<string, ComponentContract>();
  for (const c of components) for (const key of [c.id, c.name, c.manifest?.id, c.guidance?.id]) if (key) byKey.set(key.toLowerCase(), c);

  const patterns: PatternContract[] = [];
  for (const file of await findFiles(ctx.root, config.include, config.exclude)) {
    const json = readJson(ctx, file);
    if (!json) continue;
    const items = config.itemsPath ? getPath(json.data, config.itemsPath) : [json.data];
    for (const item of Array.isArray(items) ? items : []) {
      const f = config.fields;
      const field = (path: string | undefined) => (path ? getPath(item, path) : undefined);
      const id = str(field(f.id));
      if (!id) continue;
      const unresolved: string[] = [];
      const resolve = (refs: string[]) =>
        refs.flatMap((ref) => {
          const hit = byKey.get(ref.toLowerCase());
          if (!hit && !unresolved.includes(ref)) unresolved.push(ref);
          return hit ? [hit.id] : [];
        });
      const pattern: PatternContract = {
        id,
        name: str(field(f.name)) ?? id,
        intent: str(field(f.intent)),
        requiredComponents: resolve(strings(field(f.requiredComponents))),
        recommendedComponents: resolve(strings(field(f.recommendedComponents))),
        optionalComponents: resolve(strings(field(f.optionalComponents))),
        unresolvedComponents: unresolved,
        sequence: strings(field(f.sequence)),
        rules: strings(field(f.rules)),
        forbidden: strings(field(f.forbidden)),
        example: str(field(f.example)),
        metadata: Object.fromEntries(config.keep.map((k) => [k, field(k)]).filter(([, v]) => v !== undefined)),
        source: { file, line: lineOf(json.text, Math.max(0, json.text.indexOf(JSON.stringify(id)))) },
      };
      for (const ref of unresolved) {
        ctx.gaps.add({
          severity: "warning",
          kind: "pattern-component-missing",
          subject: { type: "pattern", id },
          detail: ref,
          message: `Pattern ${id} refers to "${ref}", which is not a component in the contract.`,
          location: pattern.source,
          suggestion: "Correct the reference, or index the component.",
        });
      }
      patterns.push(pattern);
    }
  }
  return patterns.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export async function loadGovernance(
  ctx: Context,
  config: GovernanceConfig | undefined,
  authored: { patterns: PatternContract[]; components: ComponentContract[] },
): Promise<Governance> {
  const rules: GovernanceRule[] = [];
  for (const source of config?.rules ?? []) {
    for (const file of await findFiles(ctx.root, source.include)) {
      const json = readJson(ctx, file);
      if (!json) continue;
      const items = source.itemsPath ? getPath(json.data, source.itemsPath) : json.data;
      if (!Array.isArray(items)) {
        ctx.gaps.add({
          severity: "warning",
          kind: "unresolvable-config-value",
          subject: { type: "source", id: file },
          detail: source.itemsPath,
          message: `"${source.itemsPath}" in ${file} is not an array of rules.`,
          location: { file },
        });
        continue;
      }
      items.forEach((item, index) => {
        const f = source.fields;
        const field = (path: string | undefined) => (typeof item === "object" && item && path ? getPath(item, path) : undefined);
        const text = typeof item === "string" ? item.trim() : str(field(f.rule));
        if (!text) return;
        const id = str(field(f.id)) ?? `${source.category}-${index + 1}`;
        const declared = str(field(f.severity))?.toLowerCase();
        const severity = RuleSeverity.safeParse(declared).success ? (declared as GovernanceRule["severity"]) : source.severity;
        const anchor = json.text.indexOf(typeof item === "string" ? JSON.stringify(item) : JSON.stringify(id));
        rules.push({
          id,
          rule: text,
          severity,
          category: source.category,
          response: str(field(f.response)),
          reference: str(field(f.reference)),
          source: anchor >= 0 ? { file, line: lineOf(json.text, anchor) } : { file },
        });
      });
    }
  }

  // The "don'ts" authored in patterns and component specs are rules too; they carry no severity of their own.
  if (config?.includeAuthoredGuidance ?? true) {
    for (const p of authored.patterns) {
      p.forbidden.forEach((text, i) =>
        rules.push({ id: `pattern:${p.id}:forbidden-${i + 1}`, rule: text, severity: "unspecified", category: "pattern", response: null, reference: p.source.file, source: p.source }),
      );
    }
    for (const c of authored.components) {
      c.guidance?.forbiddenUsage.forEach((text, i) =>
        rules.push({
          id: `component:${c.manifest?.id ?? c.guidance?.id ?? c.id}:forbidden-${i + 1}`,
          rule: `${c.name}: ${text}`,
          severity: "unspecified",
          category: "component-usage",
          response: null,
          reference: c.guidance!.source.file,
          source: c.guidance!.source,
        }),
      );
    }
  }

  const ids = new Set(rules.map((r) => r.id));
  const checks: Record<string, string> = {};
  for (const [check, ruleId] of Object.entries(config?.checks ?? {})) {
    const knownCheck = GovernanceCheck.safeParse(check).success;
    if (!knownCheck || !ids.has(ruleId)) {
      ctx.gaps.add({
        severity: "error",
        kind: "governance-check-unmapped",
        subject: { type: "ingestion", id: "governance.checks" },
        detail: check,
        message: knownCheck
          ? `governance.checks maps ${check} to rule ${ruleId}, which is not in the ingested rules.`
          : `governance.checks names "${check}", which is not a Docent check (${GovernanceCheck.options.join(", ")}).`,
      });
      continue;
    }
    checks[check] = ruleId;
  }

  return {
    rules,
    checks,
    approvedImportPrefixes: config?.approvedImports ?? [],
    restrictedPackages: config?.restrictedPackages ?? [],
  };
}

// ---------------------------------------------------------------------------
// Semantic token roles
// ---------------------------------------------------------------------------

export function applyTokenSemantics(ctx: Context, config: TokenSemanticsConfig, tokens: TokenContract[]): TokenGuidance | null {
  const json = readJson(ctx, config.path);
  if (!json) return null;
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const byCssVar = new Map(tokens.filter((t) => t.cssVariable).map((t) => [t.cssVariable!, t]));

  const groups = config.rolesPath ? getPath(json.data, config.rolesPath) : undefined;
  if (groups && typeof groups === "object") {
    for (const [role, entries] of Object.entries(groups as Record<string, unknown>)) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        const name = str(getPath(entry, config.roleFields.token));
        if (!name) continue;
        const token = byId.get(name.replace(/^--/, "")) ?? byCssVar.get(name.startsWith("--") ? name : `--${name}`);
        if (!token) {
          ctx.gaps.add({
            severity: "warning",
            kind: "semantic-token-missing",
            subject: { type: "token", id: name },
            message: `${config.path} describes the "${name}" role, but no such token is defined.`,
            location: { file: config.path, line: lineOf(json.text, Math.max(0, json.text.indexOf(JSON.stringify(name)))) },
          });
          continue;
        }
        token.role = role;
        const meaning = config.roleFields.meaning ? str(getPath(entry, config.roleFields.meaning)) : null;
        if (meaning) token.description = meaning;
      }
    }
  }

  const decisions = config.decisionsPath ? getPath(json.data, config.decisionsPath) : undefined;
  return {
    decisions: (Array.isArray(decisions) ? decisions : []).flatMap((d) => {
      const need = str(getPath(d, config.decisionFields.need));
      const use = str(getPath(d, config.decisionFields.use));
      return need && use ? [{ need, use }] : [];
    }),
    forbidden: strings(config.forbiddenPath ? getPath(json.data, config.forbiddenPath) : undefined),
    source: { file: config.path },
  };
}
