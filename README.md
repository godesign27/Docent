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
- **Phase 1 — one specialist, end to end: built.** An MCP server with one `ask` tool, a concierge that routes to the Components & contracts specialist, validation of every answer against the contract, and a per-client request audit log.
- Phase 2 (remaining specialists, real routing, escalation) is next — see [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Getting started

Requires Node 20.11+ and git.

```bash
npm install
npm run ingest -- --client agentic-ui-shadcn
```

That clones the client repo (shallow, read-only) into `.docent/sources/`, and writes:

- `contracts/<client>/contract.json` — the normalized contract (schema: [`schema/contract.ts`](schema/contract.ts), JSON Schema: [`schema/contract.schema.json`](schema/contract.schema.json))
- `contracts/<client>/gaps.md` — a readable report of everything Docent could not establish, grouped by severity, plus what changed since the last run
- `logs/<client>/ingestion.jsonl` — one audit entry per run

### Onboard a new client

1. Copy [`config/clients/_template.yaml`](config/clients/_template.yaml) to `config/clients/<client-id>.yaml`
2. Point `source` at the repo, and pick extractors that match how the client stores components and tokens
3. `npm run docent -- check-config --client <client-id>`
4. `npm run ingest -- --client <client-id>`
5. Read `gaps.md`; adjust globs or modes for config problems, and hand the rest to the design-system team

### Connect a calling agent

After ingesting, register Docent as an MCP server. It serves one client over stdio.

**Claude Code**

```bash
claude mcp add docent -- node /absolute/path/to/Docent/bin/docent.js serve --client agentic-ui-shadcn
```

**Cursor** — `.cursor/mcp.json` in the project that builds UI:

```json
{
  "mcpServers": {
    "docent": {
      "command": "node",
      "args": ["/absolute/path/to/Docent/bin/docent.js", "serve", "--client", "agentic-ui-shadcn"]
    }
  }
}
```

The agent gets one read-only tool, `ask`:

```json
{ "question": "What props does AIButton take?", "component": "ai:ai-button", "caller": "checkout-agent" }
```

Only `question` is required. The response carries a `status` (`answered`, `clarification-needed`, `not-found`, `error`), the validated component contracts, anything the question named that doesn't exist (`unresolved`), the validation checks that ran, and provenance (contract hash, source commit). Every exchange is appended to `logs/<client>/requests.jsonl`. Details: [`concierge/README.md`](concierge/README.md).

Try it without an agent:

```bash
npm run docent -- ask --client agentic-ui-shadcn "Should I use Dialog or Sheet?"
```

### CLI

```
docent ingest (--client <id> | --config <path>) [--ref <git-ref>] [--fail-on error|warning] [--quiet]
docent serve  (--client <id> | --config <path>)
docent ask    (--client <id> | --config <path>) [--component <id>] "<question>"
docent check-config (--client <id> | --config <path>)
docent list-clients
```

`--ref` ingests a branch before it merges. `--fail-on` exits non-zero when gaps are found, for CI.

## What ingestion reads

| Extractor | Reads | Produces |
|---|---|---|
| `react-tsx` | React components (`.tsx`/`.jsx`) | Exported parts, props (types, required, defaults, JSDoc), cva/tailwind-variants variants, rendered element, dependencies, token references |
| `css-variables` | CSS custom properties | Tokens per theme mode, mapped from selectors in config (`:root`, `.dark`, `@media …`, Tailwind v4 `@theme`) |
| `tailwind-theme` | `tailwind.config.*` theme | Utility bindings (`bg-primary` → `--primary`), types from theme sections, derived values |
| `dtcg-json` | W3C design tokens / Style Dictionary JSON | Tokens with declared types, descriptions and aliases |

It also cross-references the client's own component inventory (`manifest`), per-component agent specs such as `*.agent.json` (`specs` — intent, forbidden usage, agent rules, accessibility, AI experience metadata), usage docs in markdown (`docs.components`), token docs (`docs.tokens`), and tsconfig path aliases for import paths.

**Source wins.** Props, variants and exports always come from source. Where a spec disagrees, the contract follows source and records a `spec-drift` gap — for example a required prop the spec forgot to list.

**Nothing from the client repo is executed.** Components and Tailwind configs are parsed statically; values that would need execution (spreads, imported presets, computed themes) are reported as gaps.

### Gaps

Every value in a contract is either read from the repo with a source location, or `null` with a gap that says why. Examples:

- `missing-usage-docs` — a component with no documented usage
- `placeholder-documentation` — inventory fields like "TBD" or "See component source", dropped from the contract
- `non-token-value` — styles using values that aren't tokens (`bg-black/80`, `text-[#ff00aa]`)
- `unresolved-token-reference` — a token or Tailwind binding pointing at a variable that doesn't exist
- `not-in-manifest` / `manifest-entry-without-source` — the inventory and the source disagree
- `unknown-token-type`, `missing-default-mode`, `conflicting-token-definition`, `undocumented-token`, `props-not-resolved`, …

The full list lives in `GapKind` in [`schema/contract.ts`](schema/contract.ts).

## Repo structure

```
/schema         — contract, request and response schemas (zod + exported JSON Schema); runtime-agnostic
/config         — per-client configuration and its schema
/ingestion      — parses a client repo into normalized contracts
/concierge      — the routing agent, validation gate, audit log and MCP server
/specialists    — components (Phase 1); tokens, patterns, governance (Phase 2)
/cli            — the docent command
/contracts      — generated per-client contracts (git-ignored)
/logs           — per-client audit trail (git-ignored)
/docs           — PRD.md, IMPLEMENTATION_PLAN.md
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
