/**
 * Independent check of a drafted response against the contract. It does not
 * trust the specialist: every component, prop, variant, import path and rule in
 * the response must be traceable to the contract, or the response is withheld.
 */
import type { ComponentContract, Contract } from "../schema/contract.js";
import { DocentResponse, type ComponentAnswer, type ValidationResult } from "../schema/response.js";

type Check = ValidationResult["checks"][number];

export function validateResponse(response: DocentResponse, contract: Contract): ValidationResult {
  const byId = new Map(contract.components.map((c) => [c.id, c]));
  const inventoryConfigured = contract.components.some((c) => c.manifest !== null);
  const checks: Check[] = [];
  const check = (id: string, run: (fail: (msg: string) => void) => void) => {
    const failures: string[] = [];
    run((msg) => failures.push(msg));
    checks.push({ id, passed: failures.length === 0, failures });
  };

  check("response-schema", (fail) => {
    const parsed = DocentResponse.safeParse(response);
    if (!parsed.success) parsed.error.issues.slice(0, 10).forEach((i) => fail(`${i.path.join(".")}: ${i.message}`));
  });

  check("provenance", (fail) => {
    if (response.provenance.contractHash !== contract.contentHash) fail("contractHash does not match the loaded contract");
    if (response.provenance.client.id !== contract.client.id) fail(`client ${response.provenance.client.id} is not ${contract.client.id}`);
  });

  check("components-exist", (fail) => {
    const refs = [
      ...response.components.map((c) => ({ id: c.id, name: c.name, where: "components" })),
      ...response.components.flatMap((c) => c.related.map((r) => ({ id: r.id, name: r.name, where: `${c.id}.related` }))),
      ...(response.clarification?.options ?? []).map((o) => ({ id: o.id, name: o.name, where: "clarification" })),
      ...response.alternatives.map((a) => ({ id: a.id, name: a.name, where: "alternatives" })),
      ...(response.inventory ?? []).map((a) => ({ id: a.id, name: a.name, where: "inventory" })),
    ];
    for (const ref of refs) {
      const c = byId.get(ref.id);
      if (!c) fail(`${ref.where}: ${ref.id} is not in the contract`);
      else if (c.name !== ref.name) fail(`${ref.where}: ${ref.id} is named ${c.name}, not ${ref.name}`);
    }
  });

  check("unresolved-names", (fail) => {
    const known = new Set(contract.components.flatMap((c) => [c.id, c.name, ...c.parts.map((p) => p.name)].map((k) => k.toLowerCase())));
    for (const name of response.unresolved) {
      if (known.has(name.toLowerCase())) fail(`${name} is reported as not in the design system, but it is`);
    }
  });

  for (const answer of response.components) {
    const c = byId.get(answer.id);
    if (!c) continue;
    check(`contract:${answer.id}`, (fail) => compareAnswer(answer, c, inventoryConfigured, fail));
  }

  return { passed: checks.every((c) => c.passed), checks };
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
