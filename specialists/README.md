# specialists/

Narrowly scoped handlers the concierge routes to. Each answers only from the contract, only in its domain.

| Specialist | Status | Answers |
|---|---|---|
| **Components & contracts** (`components/`) | Phase 1 — built | Import path, exported parts, props (types, required, defaults, hints), variants, required nesting, forbidden usage, agent rules, accessibility, AI experience metadata, known gaps, closed-world inventory status |
| **Tokens & foundations** | Phase 2 | Color, type, spacing, elevation |
| **Patterns & usage** | Phase 2 | When and how to use a component or pattern, and what not to use it for ("which component should I use for…") |
| **Governance & compliance** | Phase 2 | What may ship as-is, what needs review, what is disallowed; escalation |

## Components specialist

- `resolve.ts` finds the components a request names: the `component` argument, ids (`ui:button`), export and part names (`AlertDialog`, `DialogContent`), and multi-word names (`alert dialog`). Code-like mentions win over plain words. Unknown code-like names (`DatePicker`) are reported as `unresolved`, never mapped to a real component.
- When nothing is named, it ranks candidates from authored intent, descriptions and other specs' notes about the component, and asks for clarification rather than picking one.
- `answer.ts` projects the contract into the response. Mechanical facts come from source; guidance comes from the client's specs; spec drift is surfaced in `docentGaps`.
