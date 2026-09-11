/** Projects a component contract into the answer shape a calling agent reads. */
import type { ComponentContract, Contract } from "../../schema/contract.js";
import type { ComponentAnswer, ComponentRef } from "../../schema/response.js";
import type { ComponentIndex } from "./resolve.js";

export function hasInventory(contract: Contract): boolean {
  return contract.components.some((c) => c.manifest !== null);
}

export function toRef(c: ComponentContract): ComponentRef {
  return {
    id: c.id,
    inventoryId: c.manifest?.id ?? c.guidance?.id ?? null,
    name: c.name,
    intent: c.guidance?.intent ?? c.manifest?.notes.intent ?? null,
  };
}

export function buildAnswer(c: ComponentContract, index: ComponentIndex): ComponentAnswer {
  const { contract } = index;
  const guidance = c.guidance;
  const valueExports = [...c.parts.map((p) => p.name), ...c.otherExports];

  // Deep copy: nothing a caller does with the response may reach back into the loaded contract.
  return structuredClone({
    id: c.id,
    inventoryId: c.manifest?.id ?? guidance?.id ?? null,
    name: c.name,
    allowed: hasInventory(contract) ? c.manifest !== null : null,
    lifecycle: guidance?.lifecycle ?? null,
    category: guidance?.category ?? c.manifest?.category ?? null,
    intent: guidance?.intent ?? c.manifest?.notes.intent ?? null,
    description: guidance?.description ?? c.description,
    import: c.importPath ? { path: c.importPath, statement: `import { ${valueExports.join(", ")} } from "${c.importPath}"` } : null,
    parts: c.parts.map((part) => ({
      name: part.name,
      primary: part.primary,
      element: part.element ?? null,
      props: part.props.map((p) => {
        const hint = guidance?.propHints[p.name];
        return {
          name: p.name,
          type: p.type,
          required: p.required,
          ...(p.values ? { values: p.values } : {}),
          ...(p.default !== undefined ? { default: p.default } : {}),
          ...(p.description ? { description: p.description } : {}),
          ...(hint ? { hint } : {}),
        };
      }),
      variants: part.variants.map((v) => ({ name: v.name, values: v.values, ...(v.default !== undefined ? { default: v.default } : {}) })),
      inheritsFrom: part.extends,
    })),
    helpers: c.otherExports,
    typeExports: c.typeExports,
    structure: guidance?.structure ?? null,
    usage: {
      forbiddenUsage: guidance?.forbiddenUsage ?? [],
      agentRules: guidance?.agentRules ?? [],
      docs: c.docs.map((d) => ({ file: d.file, heading: d.heading })),
    },
    accessibility: guidance?.accessibility ?? null,
    experience: guidance?.experience ?? null,
    // Related ids that are not in the contract are dropped rather than passed on.
    related: (guidance?.related ?? []).flatMap((r) => {
      const target = index.get(r.id);
      return target ? [{ id: target.id, name: target.name, note: r.note }] : [];
    }),
    tokens: c.tokenRefs,
    knownGaps: guidance?.knownGaps ?? [],
    docentGaps: contract.gaps
      .filter((g) => g.subject.type === "component" && g.subject.id === c.id)
      .map((g) => ({ kind: g.kind, severity: g.severity, message: g.message })),
    sources: { component: c.files, spec: guidance?.source.file ?? null },
  } satisfies ComponentAnswer);
}
