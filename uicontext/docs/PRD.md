# UIContext Agent — PRD
**An agent that drafts UIContext.md from a finished prototype, validating every design-system claim against Docent before it's written.**

Status: Draft v0.1
Owner: Timothy McGuire, GO Design
Depends on: Docent (must be queryable via MCP before this agent can validate anything)

---

## 1. Problem

`UIContext.md` is the implementation contract engineering agents read before writing code — component inventory, tokens, state coverage, Agent JSON. Getting it right matters more than any other handoff artifact, because everything downstream trusts it.

Written by hand (or by a human running a one-shot prompt), it has three recurring failure modes:

1. **Invented facts.** A component name, prop, or token that doesn't actually exist in the design system gets written down anyway, because nothing checks it against ground truth at write time.
2. **Inconsistent completeness.** Whether blocking questions get surfaced, whether the state coverage matrix is honest about what's *not* designed, depends on how careful the person running the prompt was that day.
3. **No structural gate.** `status: blocked` in the frontmatter is currently advisory — a human has to notice it and stop. Nothing enforces it.

## 2. Goal

An agent that:

1. Takes a finished prototype, its Jira story, and its companion `intent-ux.md` as input.
2. Drafts `UIContext.md` following the established template structure (see `/handoff/templates/uicontext-template.md` — sourced from the reports_option-e_fd-r10_uicontext.md example).
3. Validates every component name, token, and governance claim against Docent's specialists (`get_contract`, `search_patterns`, `get_governance`) before writing it down. Anything Docent can't confirm is written as `UNKNOWN`, not guessed.
4. Runs the template's own completeness check as a gate, and sets `handoff.status: ready` or `handoff.status: blocked` in the frontmatter based on the result — not as a suggestion, as an enforced field a downstream system can check.
5. Is reusable across clients the same way Docent is — client-specific detail lives in what Docent returns, not in agent code.

## 3. Non-goals (v1)

- Does not write `intent-ux.md` — separate concern, separate (lighter-weight) prompt.
- Does not resolve blocking questions itself — it surfaces them; a human resolves them.
- Does not decide product scope (what's in/out of a release) — that's PM/UX judgment recorded in `intent-ux.md`.
- Does not replace human review — output is a draft for UX/tech-lead to approve, not an auto-publish.
- Does not modify the prototype code itself.

## 4. Inputs

| Input | Source | Required? |
|---|---|---|
| Prototype source tree | Repo path (component code, Figma Code Connect map if present) | Required |
| Jira story | Story ID + fields (scope, acceptance criteria references) | Required |
| Companion `intent-ux.md` | Same repo, already published | Required — read before drafting |
| Docent MCP endpoint | Client's live Docent instance | Required — agent cannot draft without it |
| Prior `UIContext.md` (if regenerating) | Same repo | Optional — see §6 regeneration behavior |

## 5. Functional requirements

### 5.1 Drafting
- Populate every section of the template: metadata, agent briefing index, scope (in/out), state coverage matrix (visual, data stress, permissions, system), UX annotations, component inventory, tokens, interaction states, responsive behavior, a11y notes, API/data assumptions, acceptance criteria, known prototype limitations, missing context, open questions, related governance docs, downloads/links, anti-patterns.
- Follow the exact file naming convention: `{product}_{feature}_{id}_uicontext.md`.

### 5.2 Docent validation (the core mechanism)
- Every component name cited → confirmed via Docent's `get_contract`. Not found → `UNKNOWN`, logged as a flagged item, not silently written.
- Every token cited → confirmed via Docent's `search_patterns`. Same fallback behavior.
- Every composition/pattern claim → checked via Docent's `get_governance` for violations (e.g., disallowed imports, hardcoded values) before being marked as designed.
- The agent must never write a component/token/pattern name into the output that it has not confirmed exists. This is the one rule that cannot be soft — it's the entire reason this agent exists instead of a plain prompt.

### 5.3 Completeness gate
- After drafting, run the template's own "Completeness check" list against the draft.
- Classify open questions as Blocking vs Advisory (per the existing template convention).
- Set `handoff.status` in the YAML frontmatter: `ready` only if there are zero unresolved Blocking questions and zero unconfirmed design-system claims; `blocked` otherwise.
- The gate step must be a separate pass from the drafting step — the agent that wrote the draft should not be the one grading whether it's complete.

### 5.4 Regeneration behavior
- Re-running against an updated prototype must not silently overwrite human-provided answers to open questions or manual review notes.
- Default behavior: regenerate the factual sections (inventory, tokens, state coverage), diff against the prior version, and flag changes for review rather than overwrite blind.

## 6. Non-functional requirements

- **Traceability**: every claim in the output should be attributable to either the prototype code, the Jira story, or a specific Docent response — not the model's general knowledge.
- **Reusability**: no client-specific logic in the agent itself. Client differences come entirely from what Docent returns for that client's repo.
- **Fails loud, not quiet**: if Docent is unreachable or returns nothing for a claim, the agent must surface that as a blocker, never proceed as if the claim were confirmed.

## 7. Success metrics

- Zero invented component/token names found in human review of agent-drafted files.
- % of drafts that reach `ready` status without a human having to manually correct a factual claim.
- Time from "prototype complete" to a reviewable `UIContext.md` draft.

## 8. Risks

- **Naming mismatch risk**: prototype code may name things differently than Docent's contracts (e.g., a component imported as `CardSavedE` in code vs. documented under a different canonical name) — the agent needs a resolution strategy for near-matches, not just exact-match-or-UNKNOWN.
- **Regeneration conflicts**: overwriting a human's manual edits on re-run would erode trust fast — the diff-and-flag behavior in §5.4 is not optional polish, it's load-bearing.
- **Docent completeness**: if Docent itself has gaps for a given client (immature ingestion), this agent will over-flag as blocked. That's the correct failure mode (loud, not silent) but worth setting expectations on for early client pilots.
