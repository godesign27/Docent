# specialists/

Narrowly scoped handlers the concierge routes to. Each answers only from the contract, only in its domain.

| Specialist | Status | Answers |
|---|---|---|
| **Components & contracts** (`components/`) | Phase 1 — built | Import path, exported parts, props (types, required, defaults, hints), variants, required nesting, forbidden usage, agent rules, accessibility, AI experience metadata, known gaps, closed-world inventory status |
| **Tokens & foundations** (`tokens/`) | Phase 2 — built | Token values per mode, utilities, meaning and role; the authored need → use decisions; forbidden token usage; tokens that don't exist are reported, and categories the repo doesn't define say so |
| **Patterns & usage** (`patterns/`) | Phase 2 — built | Patterns (sequence, required components, do/don't) and usage guidance when choosing between components |
| **Governance & compliance** (`governance/`) | Phase 2 — built | Whether a request or code is allowed: findings from deterministic checks, rule wording or exception requests, turned into reject / escalate / warn by the client's policy |

`context.ts` extracts what a request mentions once, for the router and every specialist. `types.ts` is the shared specialist interface.

## Components specialist

- `resolve.ts` finds the components a request names: the `component` argument, ids (`ui:button`), export and part names (`AlertDialog`, `DialogContent`), and multi-word names (`alert dialog`). Code-like mentions win over plain words. Unknown code-like names (`DatePicker`) are reported as `unresolved`, never mapped to a real component.
- When nothing is named, it ranks candidates from authored intent, descriptions and other specs' notes about the component, and asks for clarification rather than picking one.
- `answer.ts` projects the contract into the response. Mechanical facts come from source; guidance comes from the client's specs; spec drift is surfaced in `docentGaps`.

## Governance specialist

- `code.ts` proves violations from submitted code: restricted packages, unapproved import paths, components or exports not in the inventory, prop values outside a component's declared values, compound parts outside their required parent, local components that duplicate indexed ones, palette utilities and hard-coded colors. What it cannot check is listed in `notEvaluated`.
- `policy.ts` is the single place findings become actions and an outcome, shared with validation so the two cannot disagree.
- Plain-language requests count a named entity as a violation only when the request proposes using it ("can I use MUI" — not "why is MUI forbidden").
