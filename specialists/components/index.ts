/**
 * Components & contracts specialist: structure, props, variants, import
 * paths, and the usage rules the client attached to each component. It only
 * answers from the contract, and only about components.
 */
import type { Contract } from "../../schema/contract.js";
import type { AskInput, DocentResponse } from "../../schema/response.js";
import { buildAnswer, hasInventory, toRef } from "./answer.js";
import { ComponentIndex, resolveRequest } from "./resolve.js";

/** A specialist drafts the answer body; the concierge adds identity, validation and provenance. */
export type SpecialistDraft = Pick<DocentResponse, "status" | "message" | "components" | "unresolved" | "clarification" | "alternatives" | "inventory">;

export interface Specialist {
  readonly name: "components";
  handle(input: AskInput): SpecialistDraft;
}

export function createComponentsSpecialist(contract: Contract): Specialist {
  const index = new ComponentIndex(contract);
  const clientName = contract.client.name;
  const quote = (items: string[]) => items.map((i) => `"${i}"`).join(", ");
  const notInSystem = (unresolved: string[]) =>
    unresolved.length
      ? ` ${quote(unresolved)} ${unresolved.length === 1 ? "is" : "are"} not in the ${clientName} design system: do not build, import or approximate ${unresolved.length === 1 ? "it" : "them"}.`
      : "";

  return {
    name: "components",
    handle(input) {
      const empty = { components: [], unresolved: [], clarification: null, alternatives: [], inventory: null };
      const resolution = resolveRequest(index, input.question, input.component);

      switch (resolution.kind) {
        case "inventory":
          return {
            ...empty,
            status: "answered",
            message: `${contract.components.length} components exist in the ${clientName} design system.${hasInventory(contract) ? " Only those with allowed: true are in the closed-world inventory." : ""} Ask about one by name for its full contract.`,
            inventory: contract.components.map((c) => ({
              ...toRef(c),
              category: c.guidance?.category ?? c.manifest?.category ?? null,
              allowed: hasInventory(contract) ? c.manifest !== null : null,
            })),
          };

        case "matched": {
          const components = resolution.components.map((c) => buildAnswer(c, index));
          const blocked = components.filter((c) => c.allowed === false).map((c) => c.name);
          return {
            ...empty,
            status: "answered",
            components,
            unresolved: resolution.unresolved,
            message:
              `Contract for ${components.map((c) => c.name).join(", ")} from the ${clientName} design system. Use only the props, variants and import paths listed; follow usage.forbiddenUsage and usage.agentRules.` +
              (blocked.length ? ` ${quote(blocked)} exist in source but are not in the component inventory, so they must not be used.` : "") +
              notInSystem(resolution.unresolved),
          };
        }

        case "ambiguous":
          return {
            ...empty,
            status: "clarification-needed",
            unresolved: resolution.unresolved,
            message: `The question does not name a specific component in the ${clientName} design system. Ask again with component set to one of the options.${notInSystem(resolution.unresolved)}`,
            clarification: {
              question: "Which of these components do you mean?",
              options: resolution.candidates.map(toRef),
            },
          };

        case "not-found":
          return {
            ...empty,
            status: "not-found",
            unresolved: resolution.unresolved,
            alternatives: resolution.candidates.map(toRef),
            message:
              (resolution.unresolved.length
                ? notInSystem(resolution.unresolved).trim()
                : `No component in the ${clientName} design system matches the question.`) +
              (resolution.candidates.length ? " Closest indexed alternatives are listed; compose from them rather than inventing a component." : ""),
          };
      }
    },
  };
}
