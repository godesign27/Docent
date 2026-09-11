/**
 * What calling agents send to Docent and what they get back. Runtime-agnostic
 * like the contract schema, so a Worker can share it.
 */
import { z } from "zod";

export const Domain = z.enum(["components", "tokens", "patterns", "governance"]);
export type Domain = z.infer<typeof Domain>;

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
  domain: Domain.optional().describe("Force a specialist when you know which kind of question this is; otherwise Docent routes it."),
  code: z
    .string()
    .max(100_000)
    .optional()
    .describe("Proposed code (JSX/TSX) to check against the design system's governance rules before shipping it."),
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

export const ResponseStatus = z.enum(["answered", "clarification-needed", "not-found", "escalated", "rejected", "error"]);
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

export const TokenAnswer = z.object({
  id: z.string(),
  name: z.string(),
  cssVariable: z.string().nullable(),
  type: z.string(),
  category: z.string(),
  role: z.string().nullable(),
  meaning: z.string().nullable(),
  values: z.record(z.string(), z.string()).describe("Raw value per theme mode"),
  utilities: z.array(z.string()).describe("Tailwind utilities that apply this token"),
  references: z.array(z.string()),
});
export type TokenAnswer = z.infer<typeof TokenAnswer>;

export const PatternAnswer = z.object({
  id: z.string(),
  name: z.string(),
  intent: z.string().nullable(),
  requiredComponents: z.array(ComponentRef),
  recommendedComponents: z.array(ComponentRef),
  optionalComponents: z.array(ComponentRef),
  sequence: z.array(z.string()),
  rules: z.array(z.string()),
  forbidden: z.array(z.string()),
  example: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type PatternAnswer = z.infer<typeof PatternAnswer>;

export const UsageAnswer = z.object({
  component: ComponentRef,
  whenNotToUse: z.array(z.string()),
  agentRules: z.array(z.string()),
  related: z.array(z.object({ id: z.string(), name: z.string(), note: z.string().nullable() })),
  patterns: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(["required", "recommended", "optional"]) })),
});
export type UsageAnswer = z.infer<typeof UsageAnswer>;

export const GovernanceFinding = z.object({
  ruleId: z.string().nullable(),
  rule: z.string().nullable(),
  severity: z.enum(["critical", "high", "medium", "low", "unspecified"]),
  category: z.string().nullable(),
  basis: z.enum(["check", "rule-wording", "exception-request"]).describe("check = proven by a deterministic check; rule-wording = the request resembles the rule; exception-request = the request asks to bypass a rule"),
  check: z.string().nullable(),
  action: z.enum(["reject", "escalate", "warn"]),
  evidence: z.string(),
  line: z.number().optional(),
  response: z.string().nullable().describe("What the design system says to tell the agent"),
});
export type GovernanceFinding = z.infer<typeof GovernanceFinding>;

export const GovernanceDecision = z.object({
  outcome: z.enum(["no-conflict", "warn", "needs-review", "disallowed"]),
  exceptionRequested: z.boolean(),
  findings: z.array(GovernanceFinding),
  applicableRules: z.array(z.object({ id: z.string(), rule: z.string(), severity: z.string(), category: z.string() })),
  checksRun: z.array(z.string()),
  notEvaluated: z.array(z.string()).describe("What Docent could not check, so its absence from findings means nothing"),
});
export type GovernanceDecision = z.infer<typeof GovernanceDecision>;

export const ClarificationOption = z.object({
  kind: z.enum(["component", "pattern", "token", "domain"]),
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});
export type ClarificationOption = z.infer<typeof ClarificationOption>;

export const Routing = z.object({
  domains: z.array(Domain),
  scores: z.record(z.string(), z.number()),
  signals: z.array(z.object({ domain: Domain, signal: z.string(), detail: z.string() })),
  reason: z.string(),
});
export type Routing = z.infer<typeof Routing>;

export const DocentResponse = z.object({
  requestId: z.string(),
  status: ResponseStatus,
  specialists: z.array(Domain).describe("Specialists whose answers are merged into this response"),
  routing: Routing,
  message: z.string(),
  components: z.array(ComponentAnswer),
  unresolved: z.array(z.string()).describe("Things the question named that do not exist in this design system"),
  clarification: z.object({ question: z.string(), options: z.array(ClarificationOption) }).nullable(),
  alternatives: z.array(ComponentRef),
  inventory: z.array(ComponentRef.extend({ category: z.string().nullable(), allowed: z.boolean().nullable() })).nullable(),
  tokens: z.array(TokenAnswer),
  tokenDecisions: z.array(z.object({ need: z.string(), use: z.string() })),
  tokenForbidden: z.array(z.string()),
  patterns: z.array(PatternAnswer),
  usage: z.array(UsageAnswer),
  notes: z.array(z.string()),
  governance: GovernanceDecision.nullable(),
  review: z
    .object({ id: z.string(), status: z.enum(["pending", "approved", "denied"]), reviewers: z.array(z.string()), instructions: z.string() })
    .nullable(),
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

// ---------------------------------------------------------------------------
// Human review of escalated requests
// ---------------------------------------------------------------------------

export const CheckReviewInput = z.object({
  reviewId: z.string().min(1).max(100).describe("The review.id from an escalated response"),
  caller: z.string().max(200).optional(),
});
export type CheckReviewInput = z.infer<typeof CheckReviewInput>;

export const ReviewRecord = z.object({
  id: z.string(),
  client: z.string(),
  requestId: z.string(),
  createdAt: z.string(),
  status: z.enum(["pending", "approved", "denied"]),
  caller: z.string(),
  request: z.object({ question: z.string(), component: z.string().optional(), domain: Domain.optional(), code: z.string().optional() }),
  outcome: GovernanceDecision.shape.outcome,
  findings: z.array(GovernanceFinding),
  decision: z.object({ by: z.string(), at: z.string(), note: z.string() }).nullable(),
});
export type ReviewRecord = z.infer<typeof ReviewRecord>;

export const ReviewResponse = z.object({
  requestId: z.string(),
  tool: z.literal("check_review"),
  status: z.enum(["pending", "approved", "denied", "not-found", "error"]),
  message: z.string(),
  review: ReviewRecord.nullable(),
  validation: ValidationResult,
  provenance: DocentResponse.shape.provenance,
});
export type ReviewResponse = z.infer<typeof ReviewResponse>;
