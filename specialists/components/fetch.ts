/**
 * Hands out component source from the ingested snapshot, with everything it
 * needs to compile: support files, component dependencies (in install order)
 * and npm packages. Only files recorded in the contract are ever delivered.
 */
import type { Contract, PackageRequirement } from "../../schema/contract.js";
import type { DeliveredFile, FetchResponse, GetComponentInput } from "../../schema/response.js";
import { hasInventory, toRef } from "./answer.js";
import { ComponentIndex, search } from "./resolve.js";

export type FetchDraft = Omit<FetchResponse, "requestId" | "tool" | "validation" | "provenance">;

export interface Distributor {
  getComponent(input: GetComponentInput): FetchDraft;
  getFoundation(): FetchDraft;
}

/** Components to deliver for a request, dependencies first. Shared with validation. */
export function installClosure(contract: Contract, rootIds: string[], skip: Set<string>): { id: string; reason: string }[] {
  const byId = new Map(contract.components.map((c) => [c.id, c]));
  const ordered: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  const visit = (id: string, reason: string) => {
    if (seen.has(id) || skip.has(id)) return;
    seen.add(id);
    const component = byId.get(id);
    if (!component) return;
    for (const dep of component.install.componentDependencies) visit(dep, `dependency of ${component.name}`);
    ordered.push({ id, reason });
  };
  for (const id of rootIds) visit(id, "requested");
  return ordered;
}

export function createDistributor(contract: Contract, sources: Record<string, string>): Distributor {
  const index = new ComponentIndex(contract);
  const hashes = new Map(contract.sourceFiles.map((f) => [f.path, f]));
  const byId = new Map(contract.components.map((c) => [c.id, c]));
  const system = contract.client.name;
  const commit = contract.source.commit?.slice(0, 12) ?? "unknown";
  const aliases = contract.foundation?.pathAliases ?? [];

  const deliver = (path: string, component: string | null): DeliveredFile => {
    const entry = hashes.get(path);
    const content = sources[path];
    if (!entry || content === undefined) throw new Error(`${path} is not in the source snapshot`);
    return { path, content, sha256: entry.sha256, role: entry.role, component };
  };

  const installCommands = (packages: PackageRequirement[]) => {
    const spec = (p: PackageRequirement) => `"${p.version ? `${p.name}@${p.version}` : p.name}"`;
    const runtime = packages.filter((p) => !p.dev).map(spec);
    const dev = packages.filter((p) => p.dev).map(spec);
    return [
      ...(runtime.length ? [`Install runtime packages: npm install ${runtime.join(" ")}`] : []),
      ...(dev.length ? [`Install dev packages: npm install -D ${dev.join(" ")}`] : []),
    ];
  };
  const dependencyRule = contract.governance.checks["new-dependencies"]
    ? contract.governance.rules.find((r) => r.id === contract.governance.checks["new-dependencies"])
    : undefined;
  const dependencyInstruction = (packages: PackageRequirement[]) =>
    dependencyRule && packages.length
      ? [`This design system's rule ${dependencyRule.id} (${dependencyRule.severity}) says: "${dependencyRule.rule}". Get the user's approval before installing these packages.`]
      : [];
  const aliasInstruction = aliases.length
    ? [`The source imports through ${aliases.map((a) => `${a.alias} → ${a.target || "project root"}`).join(", ")}. Configure the same alias in tsconfig.json "paths" and in the bundler (e.g. Vite resolve.alias) if the project does not have it.`]
    : [];
  const empty = { components: [], files: [], packages: [], pathAliases: aliases, instructions: [], unresolved: [], ambiguous: [], rejected: [], alternatives: [] };

  function getComponent(input: GetComponentInput): FetchDraft {
    const skipIds = new Set<string>();
    const skipPaths = new Set<string>();
    for (const item of input.installed ?? []) {
      const hit = index.get(item);
      if (hit && !hashes.has(item)) skipIds.add(hit.id);
      else skipPaths.add(item.replace(/^\.\//, ""));
    }

    const inventory = hasInventory(contract);
    const unresolved: string[] = [];
    const ambiguous: FetchResponse["ambiguous"] = [];
    const rejected: FetchResponse["rejected"] = [];
    const roots: string[] = [];
    for (const name of input.components) {
      const hits = index.lookup(name);
      const hit = hits[0];
      if (hits.length > 1) ambiguous.push({ name, candidates: hits.map((c) => ({ ...toRef(c), importPath: c.importPath })) });
      else if (!hit) unresolved.push(name);
      else if (inventory && hit.manifest === null) rejected.push({ id: hit.id, name: hit.name, reason: "Not in the component inventory, so it may not be used." });
      else if (!roots.includes(hit.id)) roots.push(hit.id);
    }

    const closure = installClosure(contract, roots, skipIds);
    const files: DeliveredFile[] = [];
    const packages = new Map<string, PackageRequirement>();
    const addFile = (path: string, component: string | null) => {
      if (skipPaths.has(path) || files.some((f) => f.path === path)) return;
      files.push(deliver(path, component));
    };
    for (const { id } of closure) {
      const c = byId.get(id)!;
      for (const support of c.install.supportFiles) addFile(support, null);
      for (const file of c.files) addFile(file, id);
      for (const p of c.install.packages) if (!packages.has(p.name)) packages.set(p.name, p);
    }

    const alternatives = unresolved
      .flatMap((name) => search(contract, name, 3))
      .filter((c, i, all) => all.indexOf(c) === i && !roots.includes(c.id))
      .map(toRef);
    const notices = [
      ...(unresolved.length
        ? [`${unresolved.map((n) => `"${n}"`).join(", ")} ${unresolved.length === 1 ? "does" : "do"} not exist in the ${system} design system; do not build or approximate ${unresolved.length === 1 ? "it" : "them"}.`]
        : []),
      ...(rejected.length
        ? [`${rejected.map((r) => r.name).join(", ")} ${rejected.length === 1 ? "is" : "are"} not in the component inventory and ${rejected.length === 1 ? "was" : "were"} not delivered.`]
        : []),
      ...ambiguous.map(
        (a) => `"${a.name}" is exported by ${a.candidates.length} components (${a.candidates.map((c) => c.importPath ?? c.id).join(", ")}) and was not delivered; request it again by import path.`,
      ),
    ];

    if (closure.length === 0) {
      const alreadyInstalled = roots.length > 0;
      return {
        ...empty,
        status: alreadyInstalled ? "delivered" : ambiguous.length ? "clarification-needed" : unresolved.length ? "not-found" : "rejected",
        message: alreadyInstalled ? "Everything requested is already installed in this project." : notices.join(" "),
        unresolved,
        ambiguous,
        rejected,
        alternatives,
      };
    }

    const sortedPackages = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
    return {
      ...empty,
      status: "delivered",
      message: [`Source for ${closure.map((c) => byId.get(c.id)!.name).join(", ")} from the ${system} design system at commit ${commit}.`, ...notices].join(" "),
      components: closure.map(({ id, reason }) => {
        const c = byId.get(id)!;
        return { id, inventoryId: c.manifest?.id ?? c.guidance?.id ?? null, name: c.name, importPath: c.importPath, reason };
      }),
      files,
      packages: sortedPackages,
      unresolved,
      ambiguous,
      rejected,
      alternatives,
      instructions: [
        ...(contract.foundation ? ["If this project has not been set up for this design system yet, call get_foundation first and apply it."] : []),
        ...dependencyInstruction(sortedPackages),
        ...installCommands(sortedPackages),
        "Write every file at its path, relative to the project root, with its content exactly as delivered. Do not edit these files. If a file already exists with different content, stop and ask the user before overwriting it.",
        ...aliasInstruction,
        "Import components from their importPath. Before using one, call ask for its props, variants and usage rules.",
      ],
    };
  }

  function getFoundation(): FetchDraft {
    const foundation = contract.foundation;
    if (!foundation) {
      return { ...empty, status: "not-found", message: `The ${system} design system has no foundation configured in Docent. Ask the Docent operator to configure ingestion.foundation.` };
    }
    return {
      ...empty,
      status: "delivered",
      message: `Theme tokens and build setup for the ${system} design system at commit ${commit}. Apply these once per project, before any component.`,
      files: foundation.files.map((path) => deliver(path, null)),
      packages: foundation.packages,
      instructions: [
        ...dependencyInstruction(foundation.packages),
        ...installCommands(foundation.packages),
        "Write each file at its path. Where the project already has that file (for example its own tailwind.config or global CSS), merge rather than replace: keep every design-system CSS variable, theme extension and plugin, and keep the project's own content globs and entry styles.",
        "Import every CSS file in files from the app entry (e.g. src/main.tsx), in the order listed, and make sure Tailwind's content globs cover the project's source files.",
        ...aliasInstruction,
        "Then fetch components with get_component.",
      ],
    };
  }

  // Deep copies: nothing a caller does with a delivery may reach back into the loaded contract.
  return {
    getComponent: (input) => structuredClone(getComponent(input)),
    getFoundation: () => structuredClone(getFoundation()),
  };
}
