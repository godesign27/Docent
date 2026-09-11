/**
 * Independent check of a drafted response against the contract. It does not
 * trust the specialist: every component, prop, variant, import path and rule in
 * the response must be traceable to the contract, or the response is withheld.
 */
import type { ComponentContract, Contract, PackageRequirement } from "../schema/contract.js";
import { DocentResponse, FetchResponse, type ComponentAnswer, type GetComponentInput, type ValidationResult } from "../schema/response.js";
import { installClosure } from "../specialists/components/fetch.js";
import { ComponentIndex } from "../specialists/components/resolve.js";

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
    for (const name of response.unresolved) if (index.get(name)) fail(`${name} is reported as not in the design system, but it is`);
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
