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

**Phase 0 — single-client ingestion: built.** Docent reads a design-system repo into a structured, inspectable contract and flags gaps instead of guessing. The concierge, specialists and MCP server start in Phase 1 — see [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

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

### CLI

```
docent ingest (--client <id> | --config <path>) [--ref <git-ref>] [--fail-on error|warning] [--quiet]
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

It also cross-references the client's own component inventory (`manifest`), usage docs in markdown (`docs.components`), token docs (`docs.tokens`), and tsconfig path aliases for import paths.

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
/schema         — contract schema (zod + exported JSON Schema); runtime-agnostic, shared by every layer
/config         — per-client configuration and its schema
/ingestion      — parses a client repo into normalized contracts
/concierge      — the routing agent and MCP server entry point (Phase 1)
/specialists    — tokens, components, patterns, governance handlers (Phases 1–2)
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
