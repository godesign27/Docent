/**
 * Components & contracts specialist: structure, props, variants, import
 * paths, and the usage rules the client attached to each component. It only
 * answers from the contract, and only about components.
 */
import type { Contract } from "../../schema/contract.js";
import type { Section, Specialist } from "../types.js";
import { buildAnswer, hasInventory, toRef } from "./answer.js";
import { resolveRequest } from "./resolve.js";

export function createComponentsSpecialist(contract: Contract): Specialist {
  const clientName = contract.client.name;
  const quote = (items: string[]) => items.map((i) => `"${i}"`).join(", ");
  const notInSystem = (unresolved: string[]) =>
    unresolved.length
      ? ` ${quote(unresolved)} ${unresolved.length === 1 ? "is" : "are"} not in the ${clientName} design system: do not build, import or approximate ${unresolved.length === 1 ? "it" : "them"}.`
      : "";

  return {
    domain: "components",
    handle({ input, index, mentions }): Section {
      const resolution = resolveRequest(index.components, input.question, input.component);
      // Unknown names found by the shared mention pass (e.g. "Drawer" in "Drawer and Sheet") are reported too.
      if (resolution.kind !== "inventory") {
        for (const name of mentions.components.unresolved) if (!resolution.unresolved.includes(name)) resolution.unresolved.push(name);
      }

      switch (resolution.kind) {
        case "inventory":
          return {
            status: "answered",
            message: `${contract.components.length} components exist in the ${clientName} design system.${hasInventory(contract) ? " Only those with allowed: true are in the closed-world inventory." : ""} Ask about one by name for its full contract.`,
            inventory: contract.components.map((c) => ({
              ...toRef(c),
              category: c.guidance?.category ?? c.manifest?.category ?? null,
              allowed: hasInventory(contract) ? c.manifest !== null : null,
            })),
          };

        case "matched": {
          const components = resolution.components.map((c) => buildAnswer(c, index.components));
          const blocked = components.filter((c) => c.allowed === false).map((c) => c.name);
          return {
            status: "answered",
            components,
            unresolved: resolution.unresolved,
            message:
              `Contract for ${components.map((c) => c.name).join(", ")}. Use only the props, variants and import paths listed; follow usage.forbiddenUsage and usage.agentRules.` +
              (blocked.length ? ` ${quote(blocked)} exist in source but are not in the component inventory, so they must not be used.` : "") +
              notInSystem(resolution.unresolved),
          };
        }

        case "ambiguous":
          return {
            status: "clarification-needed",
            unresolved: resolution.unresolved,
            message: `The question does not name a specific component. Ask again with component set to one of the options.${notInSystem(resolution.unresolved)}`,
            clarification: {
              question: "Which of these components do you mean?",
              options: resolution.candidates.map((c) => ({ kind: "component", id: c.id, name: c.name, description: toRef(c).intent })),
            },
          };

        case "not-found":
          return {
            status: "not-found",
            unresolved: resolution.unresolved,
            alternatives: resolution.candidates.map(toRef),
            message:
              (resolution.unresolved.length ? notInSystem(resolution.unresolved).trim() : `No component in the ${clientName} design system matches the question.`) +
              (resolution.candidates.length ? " Closest indexed alternatives are listed; compose from them rather than inventing a component." : ""),
          };
      }
    },
  };
}
