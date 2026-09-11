# Docent

A reusable concierge layer that lets engineering agents safely query any enterprise design system.

Docent sits in front of a client's design system repo and gives unfamiliar engineering agents (Cursor, Lovable, Copilot, custom coding agents) a single, trustworthy entry point to ask "what's the correct token / component / pattern for X" — and get back a validated, contract-accurate answer instead of a guess.

## Why

Design systems are documented for humans. An agent that needs to build UI against a client's system today either gets no structured access (and hallucinates), or raw repo access with no judgment layer (and can silently violate governance). Docent is the missing front door: it ingests a design system into structured contracts, and mediates every request through routing, validation, and an audit trail.

## How it works

```
Client's repo  →  Ingestion & indexing  →  Structured contracts
                                                    │
Incoming agent request  ──────────────────────────►│
                                                    ▼
                                          Concierge agent (routes)
                                                    │
                        ┌───────────────┬───────────┴───────────┬───────────────┐
                        ▼               ▼                       ▼               ▼
                  Tokens &        Components &            Patterns &      Governance &
                  foundations      contracts                usage         compliance
                        └───────────────┴───────────┬───────────┴───────────────┘
                                                      ▼
                                    Validated, logged, merged response
                                                      │
                                                      ▼
                                              Returned to caller
```

Full architecture and rationale: see [`docs/PRD.md`](docs/PRD.md).

## Status

- **Phase 0 — single-client ingestion: built.** Docent reads a design-system repo into a structured, inspectable contract and flags gaps instead of guessing.
- **Phase 1 — one specialist, end to end: built.** An MCP server whose concierge routes to the Components & contracts specialist: `ask` for contracts, `get_component` / `get_foundation` to fetch source into a project without cloning the design system. Every result is validated against the contract and logged per client.
- **Phase 2 — full specialist set and real routing: built.** Tokens & foundations, Patterns & usage and Governance & compliance specialists; evidence-based intent routing that can send one request to several specialists or ask a clarifying question; governance conflicts rejected or escalated to a human review queue by policy; ingestion of patterns, rules and semantic token roles. Measured with a labelled batch of real-world requests (`docent eval`).
- **Phase 3 — multi-client config: built.** The same code serves a second, differently built design system (Tailwind v4 `@theme` tokens, no component inventory, rules in markdown, no patterns) through config alone, with per-client specialists and escalation policy, and `docent isolation` verifies that contracts, snapshots, logs and reviews never cross between clients.
- **Phase 4 — clone-and-go onboarding: built.** `docent init` inspects a repo and writes a commented config with the decisions only a person can make; `docent onboard` ingests, seeds and runs an eval, checks isolation and prints how to connect; `serve --http` deploys one client for a team behind a bearer token. The step-by-step runbook is [`docs/ONBOARDING.md`](docs/ONBOARDING.md), and [`docs/WHAT_DOCENT_DOES.md`](docs/WHAT_DOCENT_DOES.md) is the scoping document for clients.

## Getting started

Requires Node 20.11+ and git.

```bash
npm install
npm run ingest -- --client agentic-ui-shadcn
```

That clones the client repo (shallow, read-only) into `.docent/sources/`, and writes:

- `contracts/<client>/contract.json` — the normalized contract (schema: [`schema/contract.ts`](schema/contract.ts), JSON Schema: [`schema/contract.schema.json`](schema/contract.schema.json))
- `contracts/<client>/gaps.md` — a readable report of everything Docent could not establish, grouped by severity, plus what changed since the last run
- `contracts/<client>/sources.json` — hashed snapshot of every file Docent may deliver to agents (components, their support files, the foundation)
- `logs/<client>/ingestion.jsonl` — one audit entry per run

### Onboard a new client

Follow [`docs/ONBOARDING.md`](docs/ONBOARDING.md). The short version:

```bash
npm run docent -- init --repo https://github.com/acme/design-system.git --id acme
# review config/clients/acme.yaml and its TODOs
npm run docent -- onboard --client acme
```

`init` detects components, tokens (CSS variables, Tailwind v3/v4, token JSON), inventories, specs, patterns, rules and docs, and records its evidence and open decisions at the top of the config. `onboard` validates the config, ingests, writes a starter eval batch from the contract and runs it, checks isolation, and prints the agent connection snippets. Then triage `gaps.md`, set rule severities and reviewers, and replace the starter eval with real requests.

Client configs are git-ignored except the template and the reference client (`agentic-ui-shadcn`, GO Design's own design system): a client's config, contracts, logs and reviews stay in the clone that serves that client.

### Running several clients

Each client is its own config and its own MCP server process. Register one server per client in the calling agent:

```json
{
  "mcpServers": {
    "docent-agentic-ui": { "command": "/opt/homebrew/bin/node", "args": ["/absolute/path/to/Docent/bin/docent.js", "serve", "--client", "agentic-ui-shadcn"] },
    "docent-acme": { "command": "/opt/homebrew/bin/node", "args": ["/absolute/path/to/Docent/bin/docent.js", "serve", "--client", "acme"] }
  }
}
```

A server loads exactly one client's contract, snapshot and policy, and its request log and review queue refuse entries for any other client.

### Deploy for a team

`serve --http` serves MCP Streamable HTTP at `/mcp` with a health check at `/healthz`. A bearer token (`DOCENT_TOKEN`, 24+ characters) is required whenever the server listens beyond localhost. The [`Dockerfile`](Dockerfile) builds a per-client image and [`fly.toml.example`](fly.toml.example) deploys it to Fly.io; see [step 8 of the runbook](docs/ONBOARDING.md#8-deploy-for-the-team-optional).

### Connect a calling agent

After ingesting, register Docent as an MCP server in the project where the agent builds UI. That project does **not** need a copy of the design-system repo: the agent fetches the setup and the components it uses through Docent.

**Cursor** — `.cursor/mcp.json` in that project (use the absolute path to `node`; apps launched from the Dock don't get your shell's PATH):

```json
{
  "mcpServers": {
    "docent": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/Docent/bin/docent.js", "serve", "--client", "agentic-ui-shadcn"]
    }
  }
}
```

**Claude Code**

```bash
claude mcp add docent -- node /absolute/path/to/Docent/bin/docent.js serve --client agentic-ui-shadcn
```

The agent gets four read-only tools:

| Tool | Use |
|---|---|
| `ask` | The single entry point. Docent routes the question to the right specialist(s) — components, tokens, patterns, governance — and merges their answers. Pass `code` to check proposed code against the rules before shipping it. |
| `check_review` | Look up the human decision on a request Docent escalated. |
| `get_foundation` | Once per project: theme token CSS, Tailwind and PostCSS config, required packages and the `@/` import alias. |
| `get_component` | Fetch source for components, e.g. `{ "components": ["Sidebar", "AIAction"] }`. Returns every file to write — including dependencies (Sidebar brings Button, Sheet, Tooltip, `use-mobile`, `lib/utils`) in install order — the npm packages with versions, and instructions. Pass `installed` to skip what the project already has. |

Delivered files are byte-identical to the design system at the ingested commit: ingestion snapshots every deliverable file into `contracts/<client>/sources.json`, the server refuses to start if the snapshot doesn't match the contract's hashes, and every delivery is re-hashed and scope-checked before it is returned. Components that don't exist, or aren't in the client's inventory, are refused. Every call is appended to `logs/<client>/requests.jsonl`. Details: [`concierge/README.md`](concierge/README.md).

### How a request is handled

1. **Routing.** Docent looks for evidence of what the request is about: components named in code style (`Button`, `ui:button`), tokens (`--primary`, `bg-muted`, "token"), patterns ("destructive action", "which component should I use"), and governance (code, "can I", exception requests, restricted packages, raw colors, base-component edits, new dependencies, rule ids). Every specialist with enough evidence gets the request. With no clear evidence Docent searches the design system, and if that doesn't settle it, asks a clarifying question. Every signal and score is recorded in the response and the audit log.
2. **Specialists answer from the contract only**, and the answers are merged.
3. **Governance decides.** Findings come from deterministic checks (proven), rule wording (a resemblance), or an exception request. The client's escalation policy turns each into an action — by default: critical violation → **rejected**, high → **escalated**, medium/low → warning; a resemblance never rejects; asking for an exception always goes to a human. Rejected and escalated responses carry no answer content.
4. **Validation** re-checks everything against the contract — including that each finding quotes its rule exactly and has the action the policy gives — and withholds anything that fails.
5. **Escalations** open a review in `logs/<client>/reviews.jsonl`. A reviewer runs `docent reviews` and `docent review <id> --approve|--deny --note "…"`; the agent polls `check_review`.

Try it without an agent:

```bash
npm run docent -- ask --client agentic-ui-shadcn "Should I use Dialog or Sheet?"
npm run docent -- fetch --client agentic-ui-shadcn Sidebar AIAction
npm run docent -- fetch --client agentic-ui-shadcn --foundation
npm run docent -- ask --client agentic-ui-shadcn --code src/App.tsx "Is this OK to ship?"
```

### Measure routing

```bash
npm run docent -- eval --client agentic-ui-shadcn
```

Runs `config/clients/<client>.eval.yaml` — labelled real-world requests with the specialists they should reach and the status, governance outcome, rules, components, tokens and patterns they should produce — without touching the client's logs or review queue.

### CLI

```
docent init   --repo <git-url | path> [--id <id>] [--name <name>] [--ref <ref>] [--subdir <dir>] [--yes] [--force]
docent onboard --client <id>
docent ingest (--client <id> | --config <path>) [--ref <git-ref>] [--fail-on error|warning] [--quiet]
docent serve  (--client <id> | --config <path>) [--http [--host 127.0.0.1] [--port 3333]]
docent ask    (--client <id> | --config <path>) [--component <id>] "<question>"
docent fetch  (--client <id> | --config <path>) [--json] (<component>... | --foundation)
docent reviews (--client <id> | --config <path>) [--all]
docent review  (--client <id> | --config <path>) <review-id> (--approve | --deny) --note "<why>" [--by <name>]
docent eval   (--client <id> | --config <path>) [--file <batch.yaml>] [--verbose]
docent check-config (--client <id> | --config <path>)
docent isolation
docent list-clients
```

`--ref` ingests a branch before it merges. `--fail-on` exits non-zero when gaps are found, for CI.

## What ingestion reads

| Extractor | Reads | Produces |
|---|---|---|
| `react-tsx` | React components (`.tsx`/`.jsx`) | Exported parts, props (types, required, defaults, JSDoc), cva/tailwind-variants variants, rendered element, dependencies, token references |
| `css-variables` | CSS custom properties | Tokens per theme mode, mapped from selectors in config (`:root`, `.dark`, `@media …`, `@theme`). Tailwind v4 `@theme` variables also become utility bindings (`--color-brand` → `bg-brand`); `@theme inline` aliases wire a utility to a runtime variable. How the CSS uses a variable (`hsl(var(--neutral-500))`, `background-color: var(--x)`) types it as a color when nothing stronger does |
| `tailwind-theme` | `tailwind.config.*` theme | Utility bindings (`bg-primary` → `--primary`), types from theme sections, derived values |
| `dtcg-json` | W3C design tokens / Style Dictionary JSON | Tokens with declared types, descriptions and aliases |

It also cross-references the client's own component inventory (`manifest`), per-component agent specs such as `*.agent.json` (`specs` — intent, forbidden usage, agent rules, accessibility, AI experience metadata), usage docs in markdown (`docs.components`), token docs (`docs.tokens`), and tsconfig path aliases for import paths.

Governance knowledge is read the same way, through field mappings in config:

| Config | Reads | Produces |
|---|---|---|
| `patterns` | Pattern files (JSON) | Required/recommended/optional components (resolved to contract ids), sequence, rules, forbidden list, example |
| `governance.rules` | JSON rule files (objects or plain strings), or a bullet list under a markdown heading | Rules with id, severity, category and the response the client wants agents told; patterns' forbidden lists and components' forbidden usage become rules too |
| `governance.agreedRules` | — (written in the config) | Rules the design-system owner agreed during onboarding that aren't written in the repo, each with a severity and who agreed it. They are enforced like written rules and marked `origin: agreed` in the contract |
| `governance.checks` | — | Maps Docent's deterministic checks (restricted package, unindexed component, raw color, invalid prop value, compound structure, …) to the client's rule ids, so every finding cites the client's own rule |
| `tokenSemantics` | Semantic token roles | Token meanings and role groups, the "need → use" decision table, forbidden token usage |
| `escalation` | — | What each kind of finding leads to: reject, escalate or warn, and who reviews |
| `specialists` | — | Which specialists this client gets; leave one out when the design system has no data for it |

**Source wins.** Props, variants and exports always come from source. Where a spec disagrees, the contract follows source and records a `spec-drift` gap — for example a required prop the spec forgot to list.

**Nothing from the client repo is executed.** Components and Tailwind configs are parsed statically; values that would need execution (spreads, imported presets, computed themes) are reported as gaps.

### Gaps

Every value in a contract is either read from the repo with a source location, or `null` with a gap that says why. Examples:

- `missing-usage-docs` — a component with no documented usage
- `placeholder-documentation` — inventory fields like "TBD" or "See component source", dropped from the contract
- `non-token-value` — styles using values that aren't tokens (`bg-black/80`, `text-[#ff00aa]`)
- `unresolved-token-reference` — a token or Tailwind binding pointing at a variable that doesn't exist
- `not-in-manifest` / `manifest-entry-without-source` — the inventory and the source disagree
- `duplicate-component-name` — two components export the same name (e.g. two `Toaster`s); agents asking by name are asked to choose by id
- `unknown-token-type`, `missing-default-mode`, `conflicting-token-definition`, `undocumented-token`, `props-not-resolved`, …

The full list lives in `GapKind` in [`schema/contract.ts`](schema/contract.ts).

## Repo structure

```
/schema         — contract, request and response schemas (zod + exported JSON Schema); runtime-agnostic
/config         — per-client configuration and its schema
/ingestion      — parses a client repo into normalized contracts
/concierge      — router, concierge, validation gate, audit log, review queue, eval runner, MCP server
/specialists    — components, tokens, patterns and governance specialists
/onboarding     — repo detection for `docent init`, config and starter-eval rendering
/cli            — the docent command
/contracts      — generated per-client contracts (git-ignored)
/logs           — per-client audit trail (git-ignored)
/docs           — PRD, implementation plan, onboarding runbook, client scoping doc
```

## Design principles

- **Reusable, not rebuilt.** Client differences live in config, not code.
- **Flag gaps, don't guess.** If a design system is under-documented, Docent surfaces the gap rather than hallucinating an answer.
- **Every response is validated and logged.** No silent answers, no black box.
- **Escalate, don't override.** Governance conflicts pause for a human rather than being auto-resolved.

## Development

```bash
npm test            # fixture design system covering every extractor and gap type
npm run typecheck
npm run schema:export
```

## License

MIT — see [`LICENSE`](LICENSE).

---
Built by [GO Design](https://godesign.one).
