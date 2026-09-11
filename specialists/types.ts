import type { AskInput, DocentResponse, Domain } from "../schema/response.js";
import type { ContractIndex, Mentions } from "./context.js";

export type SectionStatus = "answered" | "clarification-needed" | "not-found";

/** The part of a response one specialist contributes; the concierge merges sections. */
export type Section = { status: SectionStatus; message: string } & Partial<
  Pick<
    DocentResponse,
    | "components"
    | "unresolved"
    | "clarification"
    | "alternatives"
    | "inventory"
    | "tokens"
    | "utilityClasses"
    | "tokenDecisions"
    | "tokenForbidden"
    | "patterns"
    | "usage"
    | "notes"
    | "governance"
  >
>;

export interface RoutedRequest {
  input: AskInput;
  mentions: Mentions;
  index: ContractIndex;
}

export interface Specialist {
  readonly domain: Domain;
  handle(request: RoutedRequest): Section;
}
