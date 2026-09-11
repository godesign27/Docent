/**
 * What calling agents send to Docent and what they get back. Runtime-agnostic
 * like the contract schema, so a Worker can share it.
 */
import { z } from "zod";

export const AskInput = z.object({
  question: z
    .string()
    .min(1)
    .max(4000)
    .describe("The question, in plain language. Name components as they appear in code (e.g. Button, AlertDialog) when you know them."),
  component: z
    .string()
    .max(200)
    .optional()
    .describe("Component id or export name when you already know which one you mean, e.g. ui:button or Button."),
  caller: z.string().max(200).optional().describe("Who is asking, for the audit trail, e.g. cursor or checkout-agent."),
});
export type AskInput = z.infer<typeof AskInput>;

export const ComponentRef = z.object({
  id: z.string(),
  inventoryId: z.string().nullable(),
  name: z.string(),
  intent: z.string().nullable(),
});
export type ComponentRef = z.infer<typeof ComponentRef>;

export const PropAnswer = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  values: z.array(z.string()).optional(),
  default: z.string().optional(),
  description: z.string().optional(),
  hint: z.string().optional(),
});
export type PropAnswer = z.infer<typeof PropAnswer>;

export const PartAnswer = z.object({
  name: z.string(),
  primary: z.boolean(),
  element: z.string().nullable(),
  props: z.array(PropAnswer),
  variants: z.array(z.object({ name: z.string(), values: z.array(z.string()), default: z.string().optional() })),
  inheritsFrom: z.array(z.string()).describe("Props are also accepted from these types; they are not listed individually"),
});
export type PartAnswer = z.infer<typeof PartAnswer>;

export const ComponentAnswer = z.object({
  id: z.string(),
  inventoryId: z.string().nullable(),
  name: z.string(),
  allowed: z.boolean().nullable().describe("In the client's closed-world inventory. false = must not be used. null = the client keeps no inventory"),
  lifecycle: z.string().nullable(),
  category: z.string().nullable(),
  intent: z.string().nullable(),
  description: z.string().nullable(),
  import: z.object({ path: z.string(), statement: z.string() }).nullable(),
  parts: z.array(PartAnswer),
  helpers: z.array(z.string()).describe("Non-component exports such as cva variant functions"),
  typeExports: z.array(z.string()),
  structure: z.unknown().nullable().describe("Required nesting of parts, as authored by the client"),
  usage: z.object({
    forbiddenUsage: z.array(z.string()),
    agentRules: z.array(z.string()),
    docs: z.array(z.object({ file: z.string(), heading: z.string() })),
  }),
  accessibility: z.record(z.string(), z.unknown()).nullable(),
  experience: z.record(z.string(), z.unknown()).nullable().describe("AI autonomy and the accountability it owes, for AI components"),
  related: z.array(z.object({ id: z.string(), name: z.string(), note: z.string().nullable() })),
  tokens: z.array(z.string()),
  knownGaps: z.array(z.string()).describe("Limitations the design-system team declared"),
  docentGaps: z.array(z.object({ kind: z.string(), severity: z.string(), message: z.string() })).describe("What Docent could not establish or found inconsistent"),
  sources: z.object({ component: z.array(z.string()), spec: z.string().nullable() }),
});
export type ComponentAnswer = z.infer<typeof ComponentAnswer>;

export const ValidationResult = z.object({
  passed: z.boolean(),
  checks: z.array(z.object({ id: z.string(), passed: z.boolean(), failures: z.array(z.string()) })),
});
export type ValidationResult = z.infer<typeof ValidationResult>;

export const ResponseStatus = z.enum(["answered", "clarification-needed", "not-found", "error"]);
export type ResponseStatus = z.infer<typeof ResponseStatus>;

// ---------------------------------------------------------------------------
// Fetching source: get_component / get_foundation
// ---------------------------------------------------------------------------

export const GetComponentInput = z.object({
  components: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(20)
    .describe("Component ids or export names to fetch, e.g. [\"ui:card\", \"AIAction\"]. Their dependencies are included automatically."),
  installed: z
    .array(z.string().max(300))
    .max(300)
    .optional()
    .describe("Components (ids or names) or file paths this project already has from an earlier fetch; they are not sent again."),
  caller: z.string().max(200).optional().describe("Who is asking, for the audit trail."),
});
export type GetComponentInput = z.infer<typeof GetComponentInput>;

export const GetFoundationInput = z.object({
  caller: z.string().max(200).optional().describe("Who is asking, for the audit trail."),
});
export type GetFoundationInput = z.infer<typeof GetFoundationInput>;

export const DeliveredFile = z.object({
  path: z.string().describe("Where to write the file, relative to the project root"),
  content: z.string(),
  sha256: z.string(),
  role: z.enum(["component", "support", "foundation"]),
  component: z.string().nullable().describe("Component id the file belongs to; null for shared support and foundation files"),
});
export type DeliveredFile = z.infer<typeof DeliveredFile>;

const Package = z.object({ name: z.string(), version: z.string().nullable(), dev: z.boolean() });

export const FetchResponse = z.object({
  requestId: z.string(),
  tool: z.enum(["get_component", "get_foundation"]),
  status: z.enum(["delivered", "not-found", "rejected", "error"]),
  message: z.string(),
  components: z
    .array(z.object({ id: z.string(), inventoryId: z.string().nullable(), name: z.string(), importPath: z.string().nullable(), reason: z.string() }))
    .describe("Delivered components in install order: dependencies before the components that use them"),
  files: z.array(DeliveredFile),
  packages: z.array(Package),
  pathAliases: z.array(z.object({ alias: z.string(), target: z.string() })),
  instructions: z.array(z.string()),
  unresolved: z.array(z.string()).describe("Requested names that do not exist in this design system"),
  rejected: z.array(z.object({ id: z.string(), name: z.string(), reason: z.string() })).describe("Components that exist in source but may not be used"),
  alternatives: z.array(ComponentRef),
  validation: ValidationResult,
  provenance: z.object({
    client: z.object({ id: z.string(), name: z.string() }),
    contractHash: z.string(),
    contractGeneratedAt: z.string(),
    sourceCommit: z.string().nullable(),
    docentVersion: z.string(),
  }),
});
export type FetchResponse = z.infer<typeof FetchResponse>;

export const DocentResponse = z.object({
  requestId: z.string(),
  status: ResponseStatus,
  specialist: z.enum(["components"]).nullable(),
  message: z.string(),
  components: z.array(ComponentAnswer),
  unresolved: z.array(z.string()).describe("Things the question named that do not exist in this design system"),
  clarification: z.object({ question: z.string(), options: z.array(ComponentRef) }).nullable(),
  alternatives: z.array(ComponentRef),
  inventory: z.array(ComponentRef.extend({ category: z.string().nullable(), allowed: z.boolean().nullable() })).nullable(),
  validation: ValidationResult,
  provenance: z.object({
    client: z.object({ id: z.string(), name: z.string() }),
    contractHash: z.string(),
    contractGeneratedAt: z.string(),
    sourceCommit: z.string().nullable(),
    docentVersion: z.string(),
  }),
});
export type DocentResponse = z.infer<typeof DocentResponse>;
