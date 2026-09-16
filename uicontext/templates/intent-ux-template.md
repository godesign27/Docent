# Intent / UX — {FEATURE_NAME}

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

<!-- Instance file. Do not rename to intent-ux.md.
     Prefix: {product}_{feature}_{id}
     Sources: {LIST_SOURCE_DOCS — JTBD, personas, tracker ticket, prototype} -->

## File naming

```
{product}_{feature}_{id}_{artifact}.md
```

| Segment | Value |
|---|---|
| `{product}` | {product} |
| `{feature}` | {feature} |
| `{id}` | {id} |

**This set**

| Artifact | Filename | Owner |
|---|---|---|
| Intent / UX (this artifact) | `{product}_{feature}_{id}_intent-ux.md` | UX |
| UI context | `{product}_{feature}_{id}_uicontext.md` | UX |
| Implementation plan | `{product}_{feature}_{id}_implementation-plan.md` | Product + Engineering — not authored here |

---

## How to use this file

Agents read this file first (Metadata through Sign-off, then Agent instructions), then the paired uicontext. Do not duplicate token tables or prop APIs here — that belongs in uicontext.

## Agent briefing index

| Agent | Read | Skip |
|---|---|---|
| **tech-lead** | Problem, in/out, use cases, FR-*, assumptions, open questions | Design system detail |
| **frontend-engineer** | Must-priority use cases/FRs that map to UI; Content and voice | Research essays, rollout |
| **backend-engineer** | Must-priority use cases/FRs as capabilities; API assumptions | Personas, content |
| **test-writer** | Eval criteria, Must use case success/failure paths, traceability | Design system map |

---

## Metadata

| Field | Value |
|---|---|
| Canonical filename | `{product}_{feature}_{id}_intent-ux.md` |
| Companion uicontext | `{product}_{feature}_{id}_uicontext.md` |
| Product slug | {product} |
| Feature slug | {feature} |
| Feature / story id | {id} |
| Story ID | {ISSUE_TRACKER_KEY} |
| Epic / Feature | {EPIC_OR_FEATURE_NAME} |
| Feature size | {XS / S / M / L / XL} |
| Work type | `{new / enhance / fix}` |
| Product / surface | {PRODUCT_SURFACE} |
| Primary channel | {web / mobile / etc.} |
| This repo | {REPO_URL} |
| Research | {LIST_JTBD_PERSONA_OR_INTERVIEW_SOURCES} |
| Author | UX (agent-assisted draft) |
| Product owner | UNKNOWN |
| Last updated | {DATE} |
| Status | `{draft / blocked / ready}` |

---

## Problem statement

**Who** is struggling · **what** they cannot do today · **evidence** · **cost of doing nothing**.

{PROBLEM_STATEMENT}

**Current workaround:** {WHAT_USERS_DO_TODAY_INSTEAD}

**If we do nothing:** {CONSEQUENCE_OF_NOT_BUILDING_THIS}

---

## Goals and objectives

### Outcome goal

{ONE_SENTENCE_OUTCOME}

### Objectives

| # | Objective | Type | How we will know |
|---|---|---|---|

Type: **user** · **business** · **technical**.

### Non-goals

- {EXPLICITLY_OUT_OF_SCOPE_ITEM}

---

## Success metrics

Define task success, not only output polish.

| Metric | Baseline | Target | How measured | Time window |
|---|---|---|---|---|

**Guardrail metrics (must not get worse):** {LIST}

---

## In / out of scope

| In scope | Out of scope |
|---|---|

---

## Users and personas

### Primary persona (must be satisfied)

| Field | Value |
|---|---|
| Name / archetype | {PERSONA_NAME} |
| Status | `{researched / assumed}` |
| Role / job | {ROLE} |
| Quote | "{REPRESENTATIVE_QUOTE}" |
| Goals | functional: {} · emotional: {} · social: {} |
| Frustrations | {} |
| Design implications | {} |

### Secondary persona(s)

| Name | Role | Why they matter | What we will not optimize for them |
|---|---|---|---|

**Anti-persona:** {WHO_THIS_IS_EXPLICITLY_NOT_FOR}

---

## Use cases and flows

### Flow: {USE_CASE_NAME} · UC-1

| Field | Value |
|---|---|
| Entry point | |
| Exit — success | |
| Exit — abandon | |
| Exit — failure | |

#### Happy path

| # | Actor | Action | Data / context in | Data / context out |
|---|---|---|---|---|

#### Alternate paths

| ID | Trigger | Steps (summary) | Lands on |
|---|---|---|---|

#### Failure paths

| ID | Trigger | What the user sees | Recovery | Context preserved? |
|---|---|---|---|---|

#### Handoffs

| Kind | From | To | Trigger | Payload | What the user sees | Acknowledgment |
|---|---|---|---|---|---|---|

_Repeat this block per use case. Every Must-priority use case needs a success state, at least one failure path, and a complete flow (use `none` for N/A rows, not a blank)._

---

## Functional requirements

| ID | Requirement | Use case | Priority | Notes |
|---|---|---|---|---|

Priority: **Must** · **Should** · **Could**. Write capabilities, not widgets.

---

## Non-functional (product view)

| Concern | Expectation |
|---|---|
| Time-to-complete primary task | |
| Trust / transparency | |
| Accessibility (product bar) | WCAG AA (or project standard) |
| Scale | |

---

## Experience principles

1. {PRINCIPLE_1}

---

## Content and voice

| Surface | Direction |
|---|---|
| Page title / nav label | |
| Primary CTA | |
| Empty state | |
| Error | |
| Success | |

**Words to use:** {}
**Words to avoid:** {}

---

## Constraints

| Kind | Constraint | Owner |
|---|---|---|

---

## Dependencies and risks

| Dependency | Need from them | If late / missing |
|---|---|---|

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|

---

## Research and evidence

| Source | What it told us | Confidence |
|---|---|---|

**Gaps:** {WHAT_RESEARCH_DOESNT_COVER}

---

## Open product questions

| # | Priority | Question | Detail | Resolution path |
|---|---|---|---|---|

_Priority is `Blocking` or `Advisory`. A `Blocking` question must keep `handoff.status` from being set to `ready`._

---

## AI evaluation criteria

Pass/fail outcomes an agent (or reviewer) can check without prescribing implementation.

| Use case | Pass condition | Fail condition |
|---|---|---|

---

## Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Product | | | |
| UX | | | |
| Engineering | | | |

---

## Agent instructions

Do not hardcode design-system knowledge into this document. Query Docent for anything you'd otherwise guess:

| Need | Docent call |
|---|---|
| Does a component for this exist? | `ask` with `component` set to the import path or name |
| What's the right token? | `ask` naming the CSS variable or utility class |
| What's the broader pattern for this kind of screen? | `ask` a patterns question |
| Does this violate a governance rule? | `ask` with `code` set to the file |

If Docent cannot confirm something, write `UNKNOWN` and raise it as an open question — do not invent a name, value, or rule.

---

# Addendum

## Feature size rubric

Size is **blast radius**, not importance.

| Size | Intent depth | Typical product shape |
|---|---|---|
| **XS** | Problem, one outcome, who notices the change | Copy, token, or tiny behavior fix |
| **S** | Primary persona + 1–2 use cases | One component or section on an existing screen |
| **M** | Personas, full use-case set for one screen | One new or substantially changed screen |
| **L** | Full brief: flows, metrics, constraints | Multi-screen flow or major enhancement |
| **XL** | Full brief + research, rollout, risks, dependencies | New product area or redesign |

This instance is **{SIZE}**.

## Completeness check — is this enough to design or build?

1. Filename matches `{product}_{feature}_{id}_intent-ux.md` and the paired uicontext exists.
2. Problem and outcome are stated without naming a widget.
3. In / out of scope is explicit.
4. Primary persona exists (labeled researched or assumed).
5. Every Must-priority use case has a success state, at least one failure path, and a complete flow.
6. Functional requirements trace to use cases.
7. Blocking unknowns are listed as questions, not silently guessed.
8. AI evaluation criteria define pass/fail without prescribing implementation.

If a developer still has to guess **who this is for** or **what done looks like**, this file is not enough.
