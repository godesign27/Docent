# UIContext Agent — Implementation plan

How the [PRD](PRD.md) gets built, phase by phase. Each phase ends with an exit criterion that is checked before the next phase starts.

## Where the agent runs in the handoff flow

```
Jira story ──▶ design (prototype) ──▶ intent-ux.md ──▶ UIContext agent ──▶ uicontext.md ──▶ implementation plan
(before design)                       (after design,     (this agent)        (reviewed by UX
                                       separate prompt)                       and tech lead)
```

The story exists before design. `intent-ux.md` and `uicontext.md` are both outputs once the design is done. `intent-ux.md` comes first, from its own lighter prompt (not this agent, per the PRD's non-goals), and records the why, who and scope the design settled. The agent then reads the story, the finished prototype and that `intent-ux.md`.

The Docent-TestSite pilot's story is `Docent-TestSite/handoff/jira/DTS-101.md`. Stories are markdown with YAML frontmatter mirroring Jira fields, so a Jira API fetch (Phase 4) can produce the same shape.

## The one design decision everything follows from

The PRD's hard rule is that no component, token or pattern name reaches the file unless Docent has confirmed it. A prompt can't guarantee that: a model told "don't invent names" still sometimes does. So the agent is not a model writing markdown. It is a pipeline in which **code** holds every design-system fact and **the model** only writes what code cannot:

```
prototype ─┐
story ─────┼─▶ 1 Evidence ───▶ 2 Draft ───▶ 3 Render + claim lint ───▶ 4 Gate ───▶ uicontext.md
intent-ux ─┘   (code + Docent)  (model)      (code)                     (code + a      + flags.json
prior file ──────────────────────────────────────────────────────────▶ 5 Merge   separate model)
```

1. **Evidence (no model).** Parse the prototype statically. Every design-system import, JSX usage, utility class and CSS variable is resolved through Docent, and each result keeps the Docent `requestId`. Every prototype file is also checked against governance by Docent. Output: `evidence.json`.
2. **Draft (model).** The model writes the judgment sections: annotations, state coverage, scope, interaction rules, acceptance criteria, limitations, open questions. It works from the prototype, story, intent-ux and evidence, and outputs structured JSON, not markdown. Wherever it refers to a design-system item, it must cite an evidence id.
3. **Render and claim lint (code).**
   - The component inventory, tokens and props tables are rendered from evidence, never from model text.
   - Every free-text field is scanned for anything shaped like a design-system name: PascalCase identifiers, `--variables`, utility classes, `@/…` import paths. Anything not in the confirmed set is replaced with `UNKNOWN`, recorded in `flags.json` with where it came from, and raised as a Blocking open question. The question points at the prototype location, not the unconfirmed name.
4. **Gate (separate pass).**
   - Deterministic checks cover the template's completeness list and the sections the feature's size requires.
   - A second model call grades what code can't, such as whether ○ rows are honest. It gets a fresh context and a grader prompt, and sees only the inputs and the rendered file, never the drafter's reasoning.
   - Code, not either model, sets `handoff.status`: `ready` only with zero unconfirmed claims, zero Blocking questions and no failed checks; otherwise `blocked`.
5. **Merge (regeneration).** With a prior file:
   - Human-owned content is carried forward: answers to open questions, review notes, sign-offs.
   - Factual sections are regenerated and diffed against the prior file, and changes are flagged for review in `flags.json` and a `## Changes since last draft` section. Nothing a person wrote is overwritten without being flagged.

**Fails loud:**
- If Docent is unreachable, or returns an error for a check, the run stops before drafting and writes no file.
- If Docent answers but can't confirm an item, the item is `UNKNOWN`, flagged and Blocking.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Docent's real tools, not the PRD's names.** The PRD and templates name `get_contract`, `search_patterns`, `get_governance` and `get_strategy`, which Docent doesn't have. The agent uses the mapping below; the templates' *Agent access* tables should be updated to match. | One Docent API for every agent; `search_patterns` for tokens would mislead. |
| D2 | **Lives in the Docent repo under `uicontext/`**, but talks to Docent only over MCP. It imports no Docent source; tests may import Docent to stand up a fixture server. A test enforces this. | Reusable with any client's Docent (stdio or HTTP), and shares tooling. Easy to split into its own repo later. |
| D3 | **Claude via the Anthropic API** for the draft and gate passes, behind a small `Model` interface, so tests run against a scripted model. Needs `ANTHROPIC_API_KEY` in the environment. | Structured output and a separate grader call are straightforward; tests stay deterministic. |
| D4 | **Story as a file first** (Jira JSON export or markdown), fetched from Jira's REST API later (Phase 4), with credentials from the environment. | No Jira access is needed to build and test the core. |
| D5 | **Unconfirmed names never appear in the file**, not even in parentheses. They go to `flags.json`, and the open question cites the prototype file and line. | The PRD's hard rule, read strictly. |
| D6 | **Framework utilities are not design-system claims.** Utilities Docent reports as framework defaults (`gap-3`, `text-sm`) are listed as such, not as tokens or `UNKNOWN`. | Otherwise every Tailwind project is blocked for spacing classes the design system doesn't own. |
| D7 | **Prototype-local components are not design-system claims.** A relative import (`./components/ReportTable`) is listed as prototype-local. Docent's governance check still reports it if it re-creates a design-system component. | The inventory says what the design system provides; it doesn't have to pretend local code doesn't exist. |

### Tool mapping (D1)

| PRD / template | Docent call | Confirmed when |
|---|---|---|
| `get_contract` — does this component exist, props, variants | `ask` with `component` set to the import path (then the name), components specialist | `status: answered` and the component is in `components`, with `allowed` not `false` |
| `search_patterns` — is this the right token | `ask` naming the variable or utility, tokens specialist | The exact CSS variable or utility appears in the answer's `tokens` |
| `get_governance` — does this violate a rule | `ask` with `code` set to the file | Outcome `no-conflict` or `warn`; `disallowed` and `needs-review` block, and every finding is listed |
| `get_strategy` — broader pattern for this screen | `ask` a patterns question | The pattern id appears in `patterns` |

### Near-match strategy (PRD risk: naming mismatch)

In order, stopping at the first that settles it:
1. **Import path** (`@/components/ui/card-saved-e`) is Docent's exact lookup.
2. **Exported name** (`CardSavedE`).
3. **Local alias** (`import { Card as CardSavedE }`) resolves the original export name.
4. **Clarification** (a name several components share) is not settled by picking one. Every candidate goes into `flags.json`, and the item is Blocking with the choice as the open question.
5. **Not found** gives `UNKNOWN` with Docent's closest alternatives in `flags.json`.

Every step records its Docent `requestId`, so a reviewer can see exactly how a name was confirmed.

---

## Phase 0 — Evidence layer

**Goal:** Prove that every design-system fact in a prototype can be confirmed or flagged through Docent, with no model involved.

- A Docent MCP client for stdio and HTTP with a bearer token. It checks the tool list up front and fails loud.
- A prototype scanner using the TypeScript compiler API:
  - imports and aliases
  - JSX elements and literal prop values
  - class strings and utility classes
  - CSS variables and raw colors
  - per-file source locations
- A resolver: components through the near-match strategy, tokens and utilities, and a governance check per file. Every result carries a `requestId` and the contract hash.
- `evidence.json` output and the CLI command `npm run uicontext -- evidence`.

**Exit criterion:** On Docent-TestSite against agentic-ui-shadcn, every design-system import, token and utility is confirmed with a `requestId`, or flagged with a reason. Every file has a governance result. With Docent unreachable, the command exits non-zero and writes nothing.

## Phase 1 — Draft and render

**Goal:** A complete `{product}_{feature}_{id}_uicontext.md` in which no unconfirmed name can appear.

- Input loaders for the story file, intent-ux (parsed by section), and prototype routes and files.
- Structured draft schema (zod) for the sections the model owns, with evidence-id citations.
- Model pass that fills the schema from inputs and evidence.
- Renderer that follows the template section by section, with the frontmatter and naming convention.
- Claim lint over every free-text field, feeding `flags.json` and Blocking questions.

**Exit criterion:**
- A draft for the Docent-TestSite dashboard, with a hand-written story and intent-ux, fills every section.
- A seeded test, in which the scripted model writes an invented component, token and import path, produces a file with none of them, three flags and three Blocking questions.

## Phase 2 — Completeness gate

**Goal:** `handoff.status` is decided by checks, not by the drafter.

- Deterministic checks:
  - template completeness items 1–5
  - sections required by feature size
  - no empty coverage rows, with ○ explicit
  - every `UNKNOWN` paired with an open question
  - questions classified as Blocking or Advisory
- Grader pass: separate model call, fresh context, sees inputs and rendered file only, and returns structured findings. Judgment checks include honest ○ rows and questions that should be Blocking.
- Status set by code; the gate report goes into `flags.json` and a short summary at the top of the file.

**Exit criterion:** A suite of seeded defective drafts is gated as `blocked`, each for the expected reason: a missing ○ row, an unpaired `UNKNOWN`, a Blocking question, an unconfirmed claim and a governance rejection. A clean draft is `ready`.

## Phase 3 — Regeneration

**Goal:** Re-running never silently overwrites a person's work.

- Parse the prior file.
- Carry forward open-question answers and resolutions, review notes, sign-offs, and any section marked `<!-- human -->`.
- Regenerate the factual sections and diff them against the prior file. Changes are listed in `## Changes since last draft` and `flags.json`, and a question a person resolved that the new prototype re-opens is flagged.

**Exit criterion:** A round trip keeps human answers byte-for-byte: draft, then human edits, then prototype change, then regenerate. The factual diff is flagged and an unchanged prototype produces no changes.

## Phase 4 — Productize

**Goal:** A UX lead can run it on a real story in minutes.

- `npm run uicontext -- draft --prototype … --story … --intent-ux … --docent …` writes the `.md` plus `flags.json`.
- Jira fetch with credentials from the environment.
- A CI mode that fails when `handoff.status` isn't `ready`, so the gate can block a pipeline.
- A runbook, and a dry run on a second client's prototype with no agent code changes.

**Exit criterion:** A real story from a client project goes from "prototype complete" to a reviewable draft, timed, and a human reviewer finds zero invented names.
