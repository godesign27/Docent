# Phase 4 dry run: agentic-bootstrap-core

*A timed onboarding of a design system Docent had never seen, following [`ONBOARDING.md`](../ONBOARDING.md) alone. It is the evidence for Phase 4's exit criterion: repo access to a working instance in under a day.*

| | |
|---|---|
| Date | 2026-09-11 |
| Client repo | [godesign27/agentic-bootstrap-core](https://github.com/godesign27/agentic-bootstrap-core) at `b193822` (never ingested before) |
| What it is | A Lovable-generated React 18 + Vite app: 48 shadcn/ui components, 3 layout components, Tailwind v3, a brand palette stylesheet, report-wizard pages. No component docs, no written rules. |
| Docent | `phase-4-onboarding` at `9eaf7a4` (first pass), `580b09b` with the fixes below (second pass) |
| Operator | Claude Code, following the runbook step by step in a fresh clone. It stood in for the design-system owner on decisions (reviewers, which rules block) and used MCP SDK clients in place of Cursor and Claude Code. |

## Result

**Met.** Both passes reached a working instance by following the runbook: a validated contract, agents connected over stdio and HTTP, requests logged, and an eval batch written for this repo.

The first pass exposed one product gap. A repo without written rules could never block anything: all 6 governance cases in the eval failed. That gap and five smaller issues were fixed. The second pass, on the fixed build, passed 27/27.

## Timings

Wall-clock time per step. The operator was automated, so the judgment steps took minutes, not hours; the runbook's budget is what a person should plan for.

| Step | Runbook budget | First pass | Second pass |
|---|---|---|---|
| 0 Prerequisites | 10 min | 1 s | — |
| 1 Clone, install, test | 10 min | 4 s | 4 s |
| 2 `init` and review the config | 30 min | 2 min 38 s | 16 s |
| 3 `onboard` | 5 min | 2 s (command 1.7 s) | 2 s |
| 4 Triage gaps | 1–2 h | 1 min | reused |
| 5 Governance and escalation | 1 h | 54 s | in step 2 |
| 6 Real eval batch | 1–2 h | 1 min 6 s | 1 s (same batch) |
| 7 Connect an agent | 15 min | 31 s | 1 s |
| 8 Deploy (local HTTP rehearsal) | 1 h | 1 s | — |
| 9 Hand off | 30 min | < 1 s | — |
| **Total** | **5 h 40 min – 7 h 40 min** | **6 min 52 s** | **24 s** |

Every command ran in under 2 seconds, and the clone of the client repo took about 1 second. For a person, the time goes into conversations with the owner (steps 2 and 5), reading gaps (step 4) and collecting real questions (step 6). The budget leaves room for that within a working day.

## What the runbook produced

- **Contract:** 51 components (249 parts), 159 tokens from 59 files; 0 errors, 57 warnings, 45 info gaps (second pass).
- **Starter eval:** 9/9 on the first pass; 11/11 on the second, once checks were mapped to rules.
- **Real eval:** 27 requests written for this repo, covering components, tokens, governance, code checks and one vague request. First pass 21/27, with every routing case passing and all 6 governance cases failing. Second pass 27/27.
- **Isolation:** 9/9 checks.
- **stdio:** the server entry `onboard` printed served `ask`, `get_component` and `get_foundation`. `get_component DashboardLayout` delivered 15 files and 11 packages, including `NavLink.tsx` and `use-mobile.tsx`, which sit outside the component folders. `get_foundation` followed `index.css`'s `@import` to `brand-tokens.css` and picked up the `tailwindcss-animate` plugin. The log recorded `transport: stdio`.
- **HTTP:** `serve --http --host 0.0.0.0` with a 64-hex token. `/healthz` returned the contract hash and commit, `POST /mcp` without a token returned 401, and an SDK client with `X-Docent-Caller` got a validated answer. The log recorded `transport: http`. Docker isn't installed on the machine, so the container itself wasn't built.

## Issues found, and what changed

| # | Found in step | Issue | Change (`580b09b`) |
|---|---|---|---|
| 1 | 5–6 | **No path to blocking rules for a repo without written rules.** Every check could only warn. The 6 governance eval cases (Material UI, react-bootstrap, hard-coded brand hex, a new Badge variant, an invalid Button variant, a palette class) all came back as warnings. | `governance.agreedRules`: rules the owner states during onboarding, recorded in config with severity and `agreedBy`, enforced like written rules and marked `origin: agreed`. `init`'s TODO and runbook step 5 point to it. |
| 2 | Found while writing the eval | **A name exported by two components resolved silently to one.** `toaster.tsx` and `sonner.tsx` both export `Toaster`; "How do I use the Toaster?" answered with sonner, and even `get_component toaster` delivered sonner. | Exact ids always resolve. A shared name gets `clarification-needed` in `ask`; in `get_component` it is listed under `ambiguous` with its candidates and not delivered. Validation checks the candidates against the contract. New `duplicate-component-name` gap. |
| 3 | 2 | **`init` included a copy-and-paste token kit** (`report-wizard-tokens.css`) that nothing imports and that redefines `--primary`, `--background` and others. A comment in it quoted `@tailwind base`, so it was even taken for a Tailwind entry file. | Entry files are detected from parsed CSS, not text. Token CSS is what the entry stylesheet loads through `@import`; other files are listed in a TODO. |
| 4 | 4 | **False `unresolved-token-reference` gaps** for variables a component sets on itself (`style={{ "--sidebar-width": … }}` in sidebar.tsx and chart.tsx). The runbook called these "real bugs for the client". | Variables a component file sets through style objects or `setProperty` are excluded. |
| 5 | 4 | **96 `unknown-token-type` gaps.** Palette variables such as `--neutral-500: 220 9% 50%` have no Tailwind binding, but the same file uses them as `background-color: hsl(var(--neutral-500))`. | That usage is now type evidence (`typeEvidence: css-usage`); 91 of the 96 closed. Runbook triage table gained `unknown-token-type`, `no-primary-export` and `duplicate-component-name`. |
| 6 | 6 | **An invalid eval file printed a raw validation dump** (`"path": [24, "expect", "outcome"]`), and the runbook didn't list the `outcome` values. | The error names the case and field. The runbook lists outcome values and notes that governance cases fail until step 5. |
| 7 | 3 | `onboard`'s `claude mcp add` line used `node` while the Cursor line used the absolute path. The gap report listed all 91 resolved gaps inline. | Both use the absolute path. Change lists are capped at 20 entries. |

Contract schema moved to 0.5.0 (new gap kind, `origin` on rules, `css-usage` type evidence, `ambiguous` on deliveries). All 113 tests pass, including 10 new regression tests for these issues. Evals for the other clients are unchanged: agentic-ui-shadcn 45/45, and 15/15 for a second, private client.

## Not changed

- **Relative imports into the design system** (`../../components/ui/card`) are reported as not evaluated rather than checked against `approvedImports`.
- **Hand-written utility classes** such as `.bg-brand-1-500 { … }` help type tokens, but aren't offered to agents as utilities.
- **Component ids follow file names**, so the layout components have ids like `DashboardLayout` next to kebab-case ids like `alert-dialog`.
- **Governance findings don't carry a rule's origin**; it is on the rule in the contract.

## Hand-off note for the design-system owner

1. **No usage docs** for any of the 51 components. Agents get props and variants, but no guidance on when to use each component.
2. **Two `Toaster` components** (`toaster.tsx`, `sonner.tsx`). Agents are asked which one they mean; pick one.
3. **Hard-coded colors in 5 components**: `bg-black/80` overlays in AlertDialog, Dialog, Drawer and Sheet; `red-*` palette classes in Toast's destructive variant.
4. **Two class names for the same brand colors**: Tailwind exposes `bg-brand-b1-500`, while `brand-tokens.css` defines `.bg-brand-1-500`. Pages use the `b1`/`b2` form.
5. **Brand neutrals share names with Tailwind's palette**: `brand-tokens.css` defines `.bg-neutral-500` using the brand neutral. Once someone writes `bg-neutral-500` in a component, Tailwind generates its own default-palette rule under the same name, and stylesheet order decides which color wins.
6. **`report-wizard-tokens.css`** redefines core theme variables with the same values as `index.css`. It isn't imported today; if it is, it will silently override the theme.
7. **No written rules.** Docent enforces the four rules recorded as `agreedRules` for this run. Replace them with the owner's own, ideally committed to the repo.
