/**
 * Independent check of a drafted response against the contract. It does not
 * trust the specialist: every component, prop, variant, import path and rule in
 * the response must be traceable to the contract, or the response is withheld.
 */
import type { EscalationPolicy } from "../config/schema.js";
import type { ComponentContract, Contract, PackageRequirement } from "../schema/contract.js";
import { DocentResponse, FetchResponse, type ComponentAnswer, type GetComponentInput, type ValidationResult } from "../schema/response.js";
import { installClosure } from "../specialists/components/fetch.js";
import { ComponentIndex } from "../specialists/components/resolve.js";
import { actionFor, outcomeFor } from "../specialists/governance/policy.js";

type Check = ValidationResult["checks"][number];

export function validateResponse(response: DocentResponse, contract: Contract, policy: EscalationPolicy): ValidationResult {
  const byId = new Map(contract.components.map((c) => [c.id, c]));
  const tokensById = new Map(contract.tokens.map((t) => [t.id, t]));
  const patternsById = new Map(contract.patterns.map((p) => [p.id, p]));
  const rulesById = new Map(contract.governance.rules.map((r) => [r.id, r]));
  const inventoryConfigured = contract.components.some((c) => c.manifest !== null);
  const checks: Check[] = [];
  const check = (id: string, run: (fail: (msg: string) => void) => void) => {
    const failures: string[] = [];
    run((msg) => failures.push(msg));
    checks.push({ id, passed: failures.length === 0, failures });
  };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  check("response-schema", (fail) => {
    const parsed = DocentResponse.safeParse(response);
    if (!parsed.success) parsed.error.issues.slice(0, 10).forEach((i) => fail(`${i.path.join(".")}: ${i.message}`));
  });

  check("provenance", (fail) => {
    if (response.provenance.contractHash !== contract.contentHash) fail("contractHash does not match the loaded contract");
    if (response.provenance.client.id !== contract.client.id) fail(`client ${response.provenance.client.id} is not ${contract.client.id}`);
  });

  check("routing", (fail) => {
    for (const s of response.specialists) if (!response.routing.domains.includes(s)) fail(`${s} answered but was not routed to`);
    if (response.status === "clarification-needed" && !response.clarification) fail("clarification-needed without a clarification");
  });

  check("references-exist", (fail) => {
    const componentRefs = [
      ...response.components.map((c) => ({ id: c.id, name: c.name, where: "components" })),
      ...response.components.flatMap((c) => c.related.map((r) => ({ id: r.id, name: r.name, where: `${c.id}.related` }))),
      ...response.alternatives.map((a) => ({ id: a.id, name: a.name, where: "alternatives" })),
      ...(response.inventory ?? []).map((a) => ({ id: a.id, name: a.name, where: "inventory" })),
      ...response.patterns.flatMap((p) =>
        [...p.requiredComponents, ...p.recommendedComponents, ...p.optionalComponents].map((c) => ({ id: c.id, name: c.name, where: `pattern ${p.id}` })),
      ),
      ...response.usage.flatMap((u) => [
        { id: u.component.id, name: u.component.name, where: "usage" },
        ...u.related.map((r) => ({ id: r.id, name: r.name, where: `usage ${u.component.id}.related` })),
      ]),
    ];
    for (const ref of componentRefs) {
      const c = byId.get(ref.id);
      if (!c) fail(`${ref.where}: ${ref.id} is not in the contract`);
      else if (c.name !== ref.name) fail(`${ref.where}: ${ref.id} is named ${c.name}, not ${ref.name}`);
    }
    for (const option of response.clarification?.options ?? []) {
      const exists =
        option.kind === "component" ? byId.has(option.id) : option.kind === "pattern" ? patternsById.has(option.id) : option.kind === "token"
          ? tokensById.has(option.id) || (contract.tokenGuidance?.decisions ?? []).some((d) => d.use === option.id)
          : ["components", "tokens", "patterns", "governance"].includes(option.id);
      if (!exists) fail(`clarification option ${option.kind} ${option.id} is not in the contract`);
    }
  });

  check("unresolved-names", (fail) => {
    const known = new Set(
      [
        ...contract.components.flatMap((c) => [c.id, c.name, ...c.parts.map((p) => p.name)]),
        ...contract.tokens.flatMap((t) => [t.id, t.cssVariable ?? ""]),
      ].map((k) => k.toLowerCase()),
    );
    for (const name of response.unresolved) if (known.has(name.toLowerCase())) fail(`${name} is reported as not in the design system, but it is`);
  });

  for (const answer of response.components) {
    const c = byId.get(answer.id);
    if (c) check(`contract:${answer.id}`, (fail) => compareAnswer(answer, c, inventoryConfigured, fail));
  }

  check("tokens", (fail) => {
    for (const t of response.tokens) {
      const source = tokensById.get(t.id);
      if (!source) {
        fail(`token ${t.id} is not in the contract`);
        continue;
      }
      const values = Object.fromEntries(Object.entries(source.values).map(([m, v]) => [m, v.raw]));
      if (!same(values, t.values)) fail(`token ${t.id} values differ from the contract`);
      if (t.meaning !== source.description || t.role !== source.role || t.cssVariable !== source.cssVariable) fail(`token ${t.id} meaning, role or variable differs`);
      const utilities = new Set(source.tailwind.flatMap((b) => b.exampleClasses));
      for (const u of t.utilities) if (!utilities.has(u)) fail(`token ${t.id} lists utility ${u}, which is not bound to it`);
    }
    const decisions = contract.tokenGuidance?.decisions ?? [];
    for (const d of response.tokenDecisions) if (!decisions.some((x) => x.need === d.need && x.use === d.use)) fail(`token decision "${d.need}" was not authored`);
    if (response.tokenForbidden.length && !same(response.tokenForbidden, contract.tokenGuidance?.forbidden ?? [])) fail("tokenForbidden differs from the authored list");
  });

  check("patterns-and-usage", (fail) => {
    for (const p of response.patterns) {
      const source = patternsById.get(p.id);
      if (!source) {
        fail(`pattern ${p.id} is not in the contract`);
        continue;
      }
      const ids = (refs: { id: string }[]) => refs.map((r) => r.id);
      if (
        !same([p.intent, p.sequence, p.rules, p.forbidden, p.example, p.metadata], [source.intent, source.sequence, source.rules, source.forbidden, source.example, source.metadata]) ||
        !same([ids(p.requiredComponents), ids(p.recommendedComponents), ids(p.optionalComponents)], [source.requiredComponents, source.recommendedComponents, source.optionalComponents])
      ) {
        fail(`pattern ${p.id} differs from the contract`);
      }
    }
    for (const u of response.usage) {
      const c = byId.get(u.component.id);
      if (!c) continue;
      if (!same(u.whenNotToUse, c.guidance?.forbiddenUsage ?? []) || !same(u.agentRules, c.guidance?.agentRules ?? [])) fail(`usage for ${c.id} differs from its authored guidance`);
      for (const ref of u.patterns) {
        const p = patternsById.get(ref.id);
        const role = p?.requiredComponents.includes(c.id) ? "required" : p?.recommendedComponents.includes(c.id) ? "recommended" : p?.optionalComponents.includes(c.id) ? "optional" : null;
        if (role !== ref.role) fail(`usage for ${c.id} says it is ${ref.role} in ${ref.id}`);
      }
    }
  });

  check("governance", (fail) => {
    const g = response.governance;
    if (!g) {
      if (response.status === "escalated" || response.status === "rejected") fail(`${response.status} without a governance decision`);
      return;
    }
    for (const f of g.findings) {
      if (f.ruleId) {
        const rule = rulesById.get(f.ruleId);
        if (!rule) fail(`finding cites ${f.ruleId}, which is not a rule in the contract`);
        else if (rule.rule !== f.rule || rule.severity !== f.severity || rule.category !== f.category || rule.response !== f.response) fail(`finding ${f.ruleId} misquotes the rule`);
        if (f.check && contract.governance.checks[f.check] !== f.ruleId) fail(`check ${f.check} is not mapped to ${f.ruleId}`);
      } else if (f.basis !== "exception-request" && !(f.check && !contract.governance.checks[f.check])) {
        fail("finding cites no rule");
      }
      if (f.action !== actionFor(policy, f)) fail(`finding ${f.ruleId ?? f.check} has action ${f.action}; the policy gives ${actionFor(policy, f)}`);
    }
    for (const r of g.applicableRules) if (!rulesById.has(r.id)) fail(`applicable rule ${r.id} is not in the contract`);
    const outcome = outcomeFor(g.findings);
    if (g.outcome !== outcome) fail(`outcome ${g.outcome} does not follow from the findings (${outcome})`);
    const expectedStatus = outcome === "disallowed" ? "rejected" : outcome === "needs-review" ? "escalated" : null;
    if (expectedStatus && response.status !== expectedStatus) fail(`outcome ${outcome} requires status ${expectedStatus}, not ${response.status}`);
    if (!expectedStatus && (response.status === "rejected" || response.status === "escalated")) fail(`status ${response.status} without a matching governance outcome`);
  });

  check("withheld-when-blocked", (fail) => {
    const blocked = response.status === "escalated" || response.status === "rejected";
    if (blocked && (response.components.length || response.tokens.length || response.patterns.length || response.usage.length || response.inventory)) {
      fail(`a ${response.status} response must not carry answers`);
    }
    if (response.status === "escalated") {
      if (!response.review || response.review.status !== "pending") fail("an escalated response must carry a pending review");
      else if (!same(response.review.reviewers, policy.reviewers)) fail("review reviewers differ from the policy");
    } else if (response.review) {
      fail("only escalated responses carry a review");
    }
  });

  return { passed: checks.every((c) => c.passed), checks };
}

/**
 * Checks delivered source: every file must be in the contract, byte-identical
 * to the ingested snapshot (content re-hashed here), and within what the
 * request is entitled to. Scope is recomputed from the request, not taken from
 * the response.
 */
export async function validateFetch(
  response: FetchResponse,
  contract: Contract,
  request: { tool: "get_component"; input: GetComponentInput } | { tool: "get_foundation" },
): Promise<ValidationResult> {
  const checks: Check[] = [];
  const check = async (id: string, run: (fail: (msg: string) => void) => void | Promise<void>) => {
    const failures: string[] = [];
    await run((msg) => failures.push(msg));
    checks.push({ id, passed: failures.length === 0, failures });
  };
  const index = new ComponentIndex(contract);
  const byId = new Map(contract.components.map((c) => [c.id, c]));
  const recorded = new Map(contract.sourceFiles.map((f) => [f.path, f]));
  const inventory = contract.components.some((c) => c.manifest !== null);

  // What this request may receive, derived from the contract alone.
  let allowedFiles = new Set<string>();
  let allowedPackages: PackageRequirement[] = [];
  let expectedComponents: string[] = [];
  if (request.tool === "get_foundation") {
    allowedFiles = new Set(contract.foundation?.files ?? []);
    allowedPackages = contract.foundation?.packages ?? [];
  } else {
    const roots = request.input.components
      .map((name) => index.get(name))
      .filter((c): c is ComponentContract => Boolean(c) && (!inventory || c!.manifest !== null))
      .map((c) => c.id);
    const skip = new Set((request.input.installed ?? []).map((i) => index.get(i)?.id).filter((id): id is string => Boolean(id)));
    const closure = installClosure(contract, [...new Set(roots)], skip);
    expectedComponents = closure.map((c) => c.id);
    for (const { id } of closure) {
      const c = byId.get(id)!;
      [...c.files, ...c.install.supportFiles].forEach((f) => allowedFiles.add(f));
      allowedPackages.push(...c.install.packages);
    }
  }

  await check("response-schema", (fail) => {
    const parsed = FetchResponse.safeParse(response);
    if (!parsed.success) parsed.error.issues.slice(0, 10).forEach((i) => fail(`${i.path.join(".")}: ${i.message}`));
  });

  await check("provenance", (fail) => {
    if (response.provenance.contractHash !== contract.contentHash) fail("contractHash does not match the loaded contract");
    if (response.provenance.client.id !== contract.client.id) fail(`client ${response.provenance.client.id} is not ${contract.client.id}`);
  });

  await check("files-match-snapshot", async (fail) => {
    for (const file of response.files) {
      const entry = recorded.get(file.path);
      if (!entry) {
        fail(`${file.path} is not a file recorded in the contract`);
        continue;
      }
      if (file.sha256 !== entry.sha256 || file.role !== entry.role) fail(`${file.path} hash or role differs from the contract`);
      if ((await sha256Hex(file.content)) !== entry.sha256) fail(`${file.path} content does not match the ingested source`);
    }
  });

  await check("files-in-scope", (fail) => {
    for (const file of response.files) if (!allowedFiles.has(file.path)) fail(`${file.path} was not part of this request`);
    const delivered = response.components.map((c) => c.id);
    for (const id of delivered) if (!expectedComponents.includes(id)) fail(`${id} was not requested and is not a dependency`);
    if (response.status === "delivered" && request.tool === "get_component") {
      for (const id of expectedComponents) if (!delivered.includes(id)) fail(`${id} is required but missing from the delivery`);
    }
  });

  await check("packages", (fail) => {
    for (const p of response.packages) {
      const match = allowedPackages.find((a) => a.name === p.name);
      if (!match) fail(`package ${p.name} is not required by the delivered source`);
      else if (match.version !== p.version || match.dev !== p.dev) fail(`package ${p.name} version or kind differs from the contract`);
    }
  });

  await check("components-and-names", (fail) => {
    for (const c of response.components) {
      const source = byId.get(c.id);
      if (!source) fail(`${c.id} is not in the contract`);
      else if (source.importPath !== c.importPath || source.name !== c.name) fail(`${c.id} name or import path differs from the contract`);
    }
    for (const name of response.unresolved) if (index.lookup(name).length) fail(`${name} is reported as not in the design system, but it is`);
    for (const a of response.ambiguous) {
      const actual = index.lookup(a.name).map((c) => c.id).sort().join(",");
      if (actual !== a.candidates.map((c) => c.id).sort().join(",")) fail(`${a.name} is reported as shared by ${a.candidates.map((c) => c.id).join(", ")}, but the contract says ${actual || "nothing"}`);
    }
    for (const r of response.rejected) {
      const source = byId.get(r.id);
      if (!source || !inventory || source.manifest !== null) fail(`${r.id} was rejected but is allowed by the inventory`);
    }
  });

  return { passed: checks.every((c) => c.passed), checks };
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function compareAnswer(answer: ComponentAnswer, c: ComponentContract, inventoryConfigured: boolean, fail: (msg: string) => void) {
  const expectedAllowed = inventoryConfigured ? c.manifest !== null : null;
  if (answer.allowed !== expectedAllowed) fail(`allowed is ${answer.allowed}, contract says ${expectedAllowed}`);
  if ((answer.import?.path ?? null) !== c.importPath) fail(`import path ${answer.import?.path ?? null} is not ${c.importPath}`);
  if (answer.import && !answer.import.statement.endsWith(`from "${c.importPath}"`)) fail("import statement does not use the contract import path");

  const exported = new Set([...c.parts.map((p) => p.name), ...c.otherExports]);
  for (const name of answer.import?.statement.match(/\{([^}]*)\}/)?.[1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? []) {
    if (!exported.has(name)) fail(`import statement names ${name}, which ${c.files[0]} does not export`);
  }

  const partNames = (parts: { name: string }[]) => parts.map((p) => p.name).sort().join(",");
  if (partNames(answer.parts) !== partNames(c.parts)) fail(`parts ${partNames(answer.parts)} do not match contract parts ${partNames(c.parts)}`);

  for (const part of answer.parts) {
    const source = c.parts.find((p) => p.name === part.name);
    if (!source) continue;
    if (part.primary !== source.primary) fail(`${part.name}.primary does not match`);
    for (const prop of part.props) {
      const sp = source.props.find((p) => p.name === prop.name);
      if (!sp) {
        fail(`${part.name} has no prop ${prop.name}`);
        continue;
      }
      if (prop.type !== sp.type || prop.required !== sp.required || prop.default !== sp.default) fail(`${part.name}.${prop.name} type/required/default do not match`);
      if (JSON.stringify(prop.values ?? null) !== JSON.stringify(sp.values ?? null)) fail(`${part.name}.${prop.name} values do not match`);
      const hint = c.guidance?.propHints[prop.name];
      if (prop.hint !== undefined && prop.hint !== hint) fail(`${part.name}.${prop.name} hint is not the authored hint`);
    }
    if (part.props.length !== source.props.length) fail(`${part.name} lists ${part.props.length} props, contract has ${source.props.length}`);
    for (const variant of part.variants) {
      const sv = source.variants.find((v) => v.name === variant.name);
      if (!sv || JSON.stringify(sv.values) !== JSON.stringify(variant.values) || sv.default !== variant.default) {
        fail(`${part.name} variant ${variant.name} does not match`);
      }
    }
    if (part.variants.length !== source.variants.length) fail(`${part.name} variant axes do not match`);
  }

  const authored = (field: "forbiddenUsage" | "agentRules") => new Set(c.guidance?.[field] ?? []);
  for (const field of ["forbiddenUsage", "agentRules"] as const) {
    const allowed = authored(field);
    for (const rule of answer.usage[field]) if (!allowed.has(rule)) fail(`usage.${field} contains a rule the client did not author: "${rule}"`);
  }
  for (const gap of answer.knownGaps) if (!(c.guidance?.knownGaps ?? []).includes(gap)) fail(`knownGaps contains "${gap}", which the client did not declare`);
  for (const token of answer.tokens) if (!c.tokenRefs.includes(token)) fail(`token ${token} is not referenced by ${c.id}`);
}
