# UIContext Agent

Drafts `{product}_{feature}_{id}_uicontext.md` from a finished prototype, and confirms every design-system claim against [Docent](../README.md) before writing it down. See the [PRD](../prd/uicontext-agent-prd.md) and the [implementation plan](docs/IMPLEMENTATION_PLAN.md).

**Status: Phases 0 and 1 built** — evidence, drafting and rendering with the claim lint. The completeness gate (Phase 2) and regeneration (Phase 3) are still to come, so a run writes `draft` or `blocked`, never `ready`.

The agent is not a model writing markdown. Code holds every design-system fact; the model only writes what code cannot:

```
prototype ─┐
story ─────┼─▶ evidence (code + Docent) ─▶ draft (model) ─▶ render + claim lint (code) ─▶ uicontext.md + flags.json
intent-ux ─┘
```

## Run it

```bash
npm run uicontext -- evidence --prototype ../my-prototype --entry src/pages/Reports.tsx --docent-client acme --out evidence.json
```

```bash
npm run uicontext -- draft --prototype ../my-prototype --entry src/pages/Reports.tsx \
  --story ../my-prototype/handoff/jira/ACME-7.md \
  --intent-ux ../my-prototype/handoff/acme_reports_acme-7_intent-ux.md \
  --docent-client acme
```

- `--entry` can repeat; the agent follows the prototype's own imports from there and stops at design-system components.
- `--docent-client <id>` starts this repo's Docent for that client over stdio. Use `--docent-url https://…/mcp` for a deployed Docent (token from `DOCENT_TOKEN`).
- `draft` writes the `.md` next to the intent-ux file (or under `--out-dir`) plus `flags.json`. It needs `ANTHROPIC_API_KEY` (plus `ANTHROPIC_WORKSPACE_ID` if the key is org-level rather than scoped to a workspace); `--evidence <file>` reuses an earlier evidence run instead of asking Docent again.
- Exit codes: `2` Docent was unavailable, `3` the model was unavailable. Nothing is written on either.

## What it reports

| Section | Contents |
|---|---|
| `components` | Each design-system import: `confirmed`, `near-match` (confirmed by name, imported from another path), `ambiguous` (several components share the name), `not-in-inventory`, or `unconfirmed`, with its usage and literal props |
| `localModules` | The prototype's own files it walked through |
| `tokens` | CSS variables used, `confirmed` or `unconfirmed` |
| `utilities` | Each utility class: a `token` it applies, `palette` / `arbitrary-color`, `unknown-variable`, or `unbound` (not the design system's, e.g. `gap-3`) |
| `governance` | Docent's decision for each prototype file, as an audit that opens no review |
| `flags` | Everything a draft can't state as fact: `blocking` or `advisory`, with locations and request ids |

## How a name is kept out of the file

The component, token, utility and props tables are rendered from evidence, never from model text. Every free-text field the model wrote is then scanned for anything shaped like a design-system name — PascalCase identifiers, `--variables`, utility classes in backticks, `@/…` import paths. Anything Docent didn't confirm is:

1. replaced with `UNKNOWN` in the file,
2. recorded in `flags.json` with the draft field it came from, and
3. raised as a **Blocking** open question that points at the prototype location, not at the name.

Framework utilities Docent reports as defaults (`gap-3`) and the prototype's own components are listed as such, not as design-system claims. A name from a library the evidence doesn't cover is treated as unconfirmed — over-flagging, which is the failure mode the PRD asks for.

The model is reached through a small `Model` interface, so tests run against a scripted model and cost nothing.

The agent talks to Docent only over MCP and imports none of its code, so it works with any client's Docent.
