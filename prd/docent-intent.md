# Docent: intent and decisions

The goal of Docent, the principles every change must respect, and how the built product relates to the [PRD](docent-prd.md). Updated 2026-09-14.

## The goal

**Let any engineering agent build UI against a company's design system correctly the first time, without a human checking every answer, and without the agent ever being told something the design system doesn't say.**

Agents (Cursor, Claude, Lovable, custom agents) write UI code all day. Against an enterprise design system they either:
- **guess**, and invent components, props and tokens that don't exist, or
- **read the repo raw**, with no sense of which rules matter, what needs a person's sign-off, or what's forbidden.

Docent is the front door between the two. It turns the design system into a checked contract, answers agents only from that contract, checks proposed code against the design system's rules, sends real conflicts to a person, and records everything.

For GO Design it is also a repeatable engagement: point it at a client's design system, configure it in under a day, and don't rebuild anything per client.

## Who it serves

| User | What they need from Docent |
|---|---|
| **The calling agent** | One endpoint that says exactly which component, prop, token or pattern to use, delivers the design system's own code, and says clearly when something doesn't exist or isn't allowed. |
| **The client's design-system and engineering leads** | Confidence that agent-built UI stays on-system, a person decides real conflicts, and every exchange is on record. |
| **GO Design** | A clone-and-configure starting point per client, with a runbook that gets a new client live in a day. |
| **The UIContext agent and other handoff tools** | A source of truth to confirm every design-system claim before it is written into a handoff document. |

## Principles

Every change to Docent, and every deployment of it, keeps these. A change that needs to break one is a product decision for a person, not an implementation detail.

1. **Never invent.** What isn't in the design system is reported as not existing, or as unknown with a gap that says why. No near-matches presented as matches, no filling holes with general knowledge.
2. **Source wins.** Components' real props, variants and exports come from their source code. Where documentation or specs disagree, Docent follows the source and reports the disagreement.
3. **Every answer is checked before it's returned.** Each answer is re-validated against the contract; delivered files are re-hashed. If anything doesn't match, the answer is withheld and the failure logged.
4. **Deterministic and explainable.** Routing and answers come from matching against the contract, not from a language model, so the same request gets the same answer and every routing decision shows its evidence.
5. **Fail loud, never fall back.** Unreachable services, refused access, unapproved installations and checks with nothing to check stop with a clear message. Docent doesn't guess, retry around a refusal, or quietly use a weaker path.
6. **A person decides real conflicts.** Rules carry severities; critical breaks are rejected, high ones escalated to a named reviewer, and asking for an exception always goes to a person. No automated approval of anything a person is meant to decide.
7. **Read-only and non-executing.** Docent reads a snapshot of the design system and never runs its code, writes to its repository, or holds more access than read.
8. **Isolation by default.** One client per configuration, contract, log, deployment bundle and running instance. Nothing of one client may reach another.
9. **Configuration, not code, per client.** Onboarding a client means writing config and agreed rules, never forking Docent.
10. **No secrets in artifacts.** Tokens and keys live in the environment or a secret manager: never in URLs, config, contracts, logs, images, commits or chat.

## Where the build differs from the PRD, and why

| PRD said | Built | Why |
|---|---|---|
| The concierge "reads the incoming request, determines intent", and v1 "uses prompting + retrieval" | **Deterministic routing and answers, with no language model** in the answering path | Answers must be verifiable against the contract and repeatable (principles 3 and 4). The trade-off: a badly phrased question may get "which of these do you mean?" instead of an answer. |
| Ingest "any" enterprise design-system repo | **React (TSX) components; CSS variables; Tailwind v3 config and v4 `@theme`; DTCG / Style Dictionary tokens; JSON or markdown specs, patterns and rules** | Covers the stacks of the design systems onboarded so far. Other component frameworks (Vue, Web Components, native) aren't supported yet. |
| Deploy on "Cloudflare Workers / Fly.io" | **Fly.io**, plus a kit for **a company's own AWS (EC2)** | Docent needs a filesystem for contracts and append-only logs and runs as a Node server; Workers would need a rewrite. Enterprise clients will often require their own infrastructure. |
| Governance "what's allowed to ship" | **Checks proven on code** (restricted packages, unindexed components, invalid props, broken nesting, raw colors, re-created components, base edits, new dependencies), plus **rules agreed during onboarding** when a repo has none written | Only what can be proven is enforced automatically; rules that need design judgment are shown to agents and listed as not evaluated. |

Built beyond the PRD, because agents needed it:
- **Code delivery:** `get_component` and `get_foundation` hand over the design system's own files and setup, so projects don't copy the repo.
- **Onboarding and deploys:** `docent init` and `onboard`, HTTP serving behind a bearer token, and one-client deploy bundles.
- **Private repositories:** fetched with approved, short-lived read-only tokens through GO Design's repo-connector.
- **Audit mode:** handoff tools can check prototypes without opening reviews.

## Status against the PRD

### Requirements

| Requirement | Status |
|---|---|
| 5.1 Ingestion: parse, normalize, re-run, flag gaps | Built. Every value has a source location or a gap; an unchanged design system gives an identical contract hash. |
| 5.2 One MCP entry point, routing, clarifying questions | Built: `ask` (plus `get_component`, `get_foundation`, `check_review`), evidence-based routing, and clarification when it can't tell. |
| 5.3 Four narrow specialists | Built: components, tokens, patterns, governance; each can be turned off per client. |
| 5.4 Validation, audit log, configurable escalation | Built: every answer validated, every request logged with routing evidence, and severity-based reject / escalate / warn with a human review queue. |
| 5.5 Per-client config, no client code | Built: one YAML file per client, with `init` to generate it. |
| 6 Latency | Sub-second once running. The first request after an idle deployment wakes the server in about 15 seconds. |
| 6 Isolation | Built: isolation checks, one-client bundles, one instance per client. |
| 6 Observability | Built: routing signals, scores and validation results on every response and in the logs. |
| 6 Deployability | Fly.io in use; AWS EC2 kit written, not yet run in AWS. |

### Success metrics

| Metric | Status |
|---|---|
| Onboard a new client in under a day | **Met in a timed dry run** on an unseen repo following the runbook alone: every step ran in minutes, against a runbook budget of 5 h 40 min to 7 h 40 min for a person. Not yet timed with a person doing it. |
| % of requests answered without human escalation | **Not measured yet.** Needs a usage report from the logs. |
| Zero governance violations shipped in pilot use | **No pilot yet.** In testing, an agent passed a ship check by submitting placeholder text instead of its file; that loophole is closed. |
| Reused unmodified across at least two client engagements | **Not yet.** Three design systems onboarded (GO Design's own, one private client, one dry-run repo), but each surfaced fixes to Docent's core. |

## Scope boundaries

In scope:
- Reading, normalizing and serving one design system per instance.
- Checking agents' questions and code against it.
- Delivering its components and setup.
- Escalating conflicts to people, and recording everything.

Out of scope, per the PRD:
- **Authoring.** No new components, tokens or rules, and no edits to the design system.
- **Replacing the client's documentation** for human designers.
- **Training or fine-tuning models.**
- **Serving several design systems from one instance.**

Also out of scope today:
- **Per-user identity or single sign-on.** An instance uses one shared bearer token.
- **Enforcing rules that need design judgment.** They are shown, not checked.
- **Making an agent use Docent.** Pair Docent with normal code review and CI.

## Open questions

1. **Per-user identity.** When do clients require single sign-on, and how do agent tools pass it?
2. **More frameworks.** Which component frameworks are needed next?
3. **Vague requests.** Should a language model ever help route them, and how would its output stay verifiable?
4. **Approvals.** Should the people who approve repo access and the people who review escalations be the same?
5. **Pilot metrics.** What does a pilot need to measure the escalation rate and shipped violations credibly?
