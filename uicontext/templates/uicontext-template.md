# UI context — {FEATURE_NAME}

```yaml
handoff:
  version: 1.0
  status: draft
  approved_design_version: "{DESIGN_VERSION_ID}"
  approved_by:
    product: UNKNOWN
    ux: UNKNOWN
    engineering: pending
```

<!-- Instance: {product}_{feature}_{id}_uicontext.md
     Read {product}_{feature}_{id}_intent-ux.md first.
     Designed UI is the prototype; gaps stay UNKNOWN / not designed. -->

## File naming

```
{product}_{feature}_{id}_uicontext.md
```

Shared prefix with `{product}_{feature}_{id}_intent-ux.md`. Placed wherever this project's download URL convention expects it.

---

## Metadata

| Field | Value |
|---|---|
| Canonical filename | `{product}_{feature}_{id}_uicontext.md` |
| Companion intent-ux | `{product}_{feature}_{id}_intent-ux.md` |
| Product slug | {product} |
| Feature slug | {feature} |
| Feature / story id | {id} |
| Story ID | {ISSUE_TRACKER_KEY} |
| Epic / Feature | {EPIC_OR_FEATURE_NAME} |
| Feature size | {XS / S / M / L / XL} |
| Work type | `{new / enhance / fix}` |
| Screen(s) in scope | {LIST_SCREEN_IDS} |
| This repo | {REPO_URL} |
| Prototype source | {PROTOTYPE_SOURCE_PATH} |
| Feature-handoff source | {HANDOFF_PAGE_SOURCE_PATH} |
| Prototype route | {PROTOTYPE_ROUTE} |
| Feature-handoff route | {HANDOFF_ROUTE} |
| Design system | Queried via Docent — see Agent access, below |
| Companion intent-ux path | {INTENT_UX_PATH} |
| Companion implementation-plan | Engineering fills `{product}_{feature}_{id}_implementation-plan.md` |
| Author | UX (agent-assisted) |
| Reviewer / owner | UNKNOWN |
| Last updated | {DATE} |
| Status | `{draft / blocked / ready}` |

---

## Agent briefing index

One file. Slices: `UX-BEHAVIOR` · `UI-SURFACE` · `CONTRACTS` · `VERIFY` · `PROTOTYPE`.

| Agent | Read | Skip |
|---|---|---|
| **tech-lead** | Metadata, Scope, this index, Open questions, `handoff:` | Token tables, Code Connect detail |
| **frontend-engineer** | UX annotations → tokens + component inventory + implementation intent | File locations as production paths |
| **backend-engineer** | Data / API, Auth | Visual annotations, tokens |
| **test-writer** | Acceptance criteria, a11y, state coverage, open questions, error/loading/empty | Component detail, prototype paths |

`status` gates readiness — see Completeness check at the end of this file.

---

## Agent access

Do not hardcode component names, tokens, or governance rules into this document from memory. Every claim below about what exists in the design system must be confirmed via Docent before being written down.

| Need | Docent tool |
|---|---|
| Does this component exist? What are its props/variants? | `get_contract` |
| Is this the correct token for this use? | `search_patterns` |
| Does this composition violate a governance rule? | `get_governance` |
| What's the broader pattern/strategy for this kind of screen? | `get_strategy` |

**If Docent cannot confirm something, write `UNKNOWN` and log it as an open question. Do not invent a name, value, or rule to fill the gap.**

---

## Scope

**In scope:** {WHAT_IS_DESIGNED_IN_THIS_RELEASE}

**Out of scope / not designed:** {WHAT_STAKEHOLDERS_ASKED_FOR_THAT_ISNT_BUILT_YET}

**Do not invent:** component names, install paths, token values, or API fields not confirmed via Docent. Use UNKNOWN.

---

## State coverage matrix

Formal coverage for engineering. **✓** = designed in the prototype / specified here. **○** = not designed — do not invent UI.

### Visual

| Coverage | State | Notes |
|---|---|---|
| | Default | |
| | Hover | |
| | Focus | |
| | Loading | |
| | Empty | |
| | Error | |

_Add rows for every state relevant to this feature. Mark ○ explicitly for anything not designed — do not omit the row._

### Data stress

| Coverage | State | Notes |
|---|---|---|
| | Long text / overflow | |
| | Large dataset / pagination | |

### Permissions

| Coverage | State | Notes |
|---|---|---|
| | {ROLE_1} | |
| | {ROLE_2} | |

### System

| Coverage | State | Notes |
|---|---|---|
| | API timeout | |
| | Offline | |
| | Stale data | |

---

# Part 1 — UX (designed experience)

<!-- slice: UX-BEHAVIOR -->

Job-level use cases live in intent-ux (`UC-*`). This part is designed behavior.

## UX annotations

| ID | Page | Target (control / region) | Type | Behavior (what happens) | States that apply | Notes |
|---|---|---|---|---|---|---|
| A-1 | | | | | | |

_One row per interactive element or region. Reference the use case ID (`UC-*`) from intent-ux.md where relevant._

---

# Part 2 — UI surface (component inventory)

<!-- slice: UI-SURFACE -->

## Component inventory

| Component | Confirmed via Docent? | Variant used | Notes |
|---|---|---|---|
| | | | |

## Design tokens

| Token | Confirmed via Docent? | Usage | Value reference |
|---|---|---|---|
| | | | `var(--*)` only — no hardcoded hex |

## Props API (primary components)

| Component | Prop | Type | Required? | Notes |
|---|---|---|---|---|

---

# Part 3 — Contracts

<!-- slice: CONTRACTS -->

## Interaction rules

{HOW_COMPONENTS_RESPOND_TO_INPUT}

## Responsive behavior

{BREAKPOINT_OR_CONTAINER_QUERY_RULES}

## Accessibility

{A11Y_REQUIREMENTS_AND_KNOWN_GAPS}

## Data / API

{ENDPOINTS_OR_DATA_SHAPES_ASSUMED_BY_THE_PROTOTYPE}

## Auth / permissions

{WHO_CAN_SEE_OR_DO_WHAT}

---

# Part 4 — Verify

<!-- slice: VERIFY -->

## Acceptance criteria

- [ ] {CRITERION_1}
- [ ] {CRITERION_2}
- [ ] No hardcoded hex in new styles
- [ ] Every component/token cited resolves via Docent — none marked UNKNOWN without a corresponding open question

**Definition of done**

- [ ] Required sections filled for this feature's size (see Addendum)
- [ ] Blocking questions listed (not silently guessed)
- [ ] Handoff page updated with both named downloads
- [ ] Intent-ux metrics still valid

---

## Known prototype limitations

- {LIMITATION_1}

---

## Missing context

| Item | In prototype? | Production need | Owner |
|---|---|---|---|

---

## Open questions

| # | Priority | Question | Detail | Resolution path |
|---|---|---|---|---|

_Priority is `Blocking` or `Advisory`. A `Blocking` question in this table must keep `handoff.status` from being set to `ready`._

---

## Downloads / export artifacts

| Artifact | Path | Description |
|---|---|---|
| This file | `{product}_{feature}_{id}_uicontext.md` | Canonical uicontext |
| Intent-ux | `{product}_{feature}_{id}_intent-ux.md` | Why / who / jobs |

---

## Links

- Companion intent-ux: `{product}_{feature}_{id}_intent-ux.md`
- Companion implementation-plan: `{product}_{feature}_{id}_implementation-plan.md`
- This repo: {REPO_URL}
- Prototype source: {PROTOTYPE_SOURCE_PATH}

---

## Anti-patterns — never do these

- Hardcoded hex in product or story styles
- Citing a component/token/pattern name not confirmed via Docent
- Inventing names when Docent returns no match — write UNKNOWN instead
- Treating the prototype as production-complete
- Setting `handoff.status: ready` with an open Blocking question

---

# Addendum

## Feature size rubric

| Size | UIContext depth |
|---|---|
| **XS** | Metadata, scope, affected states only |
| **S** | + component inventory for changed components |
| **M** | + full state coverage matrix |
| **L** | + full contracts (interaction, responsive, a11y, data) |
| **XL** | + full addendum, all sections required |

This instance is **{SIZE}**.

## Completeness check

1. Filename matches `{product}_{feature}_{id}_uicontext.md` + paired intent-ux exists.
2. Every component/token cited has been confirmed via Docent or is marked UNKNOWN with a logged open question.
3. State coverage matrix includes explicit ○ rows for anything not designed — no silent omissions.
4. No Blocking open questions remain if `handoff.status: ready`.
5. This file is not a substitute for `implementation-plan.md`.
