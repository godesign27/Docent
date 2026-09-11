# UIContext Agent

Drafts `{product}_{feature}_{id}_uicontext.md` from a finished prototype, and confirms every design-system claim against [Docent](../README.md) before writing it down. See the [PRD](docs/PRD.md) and the [implementation plan](docs/IMPLEMENTATION_PLAN.md).

**Status: Phase 0 (evidence layer) built.** The agent reads a prototype statically and checks, through Docent:

- every design-system component it imports, by import path, file or name
- every CSS variable and utility class
- governance, one audit per file

Every result keeps the Docent request id behind it. Drafting, the completeness gate and regeneration are Phases 1–3.

## Run it

```bash
npm run uicontext -- evidence --prototype ../my-prototype --entry src/pages/Reports.tsx --docent-client acme --out evidence.json
```

- `--entry` can repeat; the agent follows the prototype's own imports from there and stops at design-system components.
- `--docent-client <id>` starts this repo's Docent for that client over stdio. Use `--docent-url https://…/mcp` for a deployed Docent (token from `DOCENT_TOKEN`).
- Exit code `2` means Docent was unavailable, and nothing was written.

## What it reports

| Section | Contents |
|---|---|
| `components` | Each design-system import: `confirmed`, `near-match` (confirmed by name, imported from another path), `ambiguous` (several components share the name), `not-in-inventory`, or `unconfirmed`, with its usage and literal props |
| `localModules` | The prototype's own files it walked through |
| `tokens` | CSS variables used, `confirmed` or `unconfirmed` |
| `utilities` | Each utility class: a `token` it applies, `palette` / `arbitrary-color`, `unknown-variable`, or `unbound` (not the design system's, e.g. `gap-3`) |
| `governance` | Docent's decision for each prototype file, as an audit that opens no review |
| `flags` | Everything a draft can't state as fact: `blocking` or `advisory`, with locations and request ids |

The agent talks to Docent only over MCP and imports none of its code, so it works with any client's Docent.
