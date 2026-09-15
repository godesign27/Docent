# Docent — Phased Implementation Plan

Companion to [the PRD](../prd/docent-prd.md). Each phase has a single exit criterion — don't start the next phase until it's met.

---

## Phase 0 — Scaffold & single-client ingestion
**Goal:** Prove ingestion works on one real repo.

- Set up repo structure: `/ingestion`, `/concierge`, `/specialists`, `/config`, `/logs`.
- Build ingestion for one client repo (use your own design system repo as the first test subject — lowest-friction real data).
- Normalize components + tokens into the contract schema. Patterns/governance can wait.
- No agent, no MCP server yet — just prove the repo → structured contract step works and gaps get flagged, not guessed.

**Exit criterion:** Running ingestion against a real repo produces a structured, inspectable contract file with flagged gaps.

---

## Phase 1 — One specialist, end-to-end
**Goal:** Prove the full request/response loop works for a single domain.

- Stand up the MCP server with a single tool (start with **Components & contracts** — highest-value, most concrete).
- Build the concierge agent, but scoped to only route to this one specialist (no real routing logic needed yet).
- Add validation: response must be checked against the contract before returning.
- Add basic logging: every request/response pair recorded.
- Test with a real calling agent (e.g., Cursor or Lovable) making an actual request.

**Exit criterion:** An external agent can ask a real component question and get back a validated, logged, contract-accurate answer — no human in the loop.

---

## Phase 2 — Full specialist set + real routing
**Goal:** Prove the concierge can route, not just pass through.

- Add the remaining three specialists (Tokens & foundations, Patterns & usage, Governance & compliance).
- Build real intent-routing in the concierge agent — including asking a clarifying question when intent is ambiguous.
- Add escalation logic: governance conflicts pause for human review instead of auto-responding.
- Expand ingestion to cover patterns and governance docs, not just components/tokens.

**Exit criterion:** The concierge correctly routes a mixed batch of real-world request types to the right specialist, and correctly escalates governance conflicts instead of guessing.

---

## Phase 3 — Multi-client config
**Goal:** Prove it's reusable, not just built well once.

- Extract all client-specific logic into the config file (repo location, active specialists, escalation policy).
- Point the same codebase at a second client repo (different structure, different maturity) with config only — no code changes.
- Add client isolation checks: confirm no data/log crossover between instances.

**Exit criterion:** Two clients running on the same unmodified codebase, config-only difference, with verified isolation.

---

## Phase 4 — Productize the clone-and-go workflow
**Goal:** Get onboarding time under a day.

- Write the onboarding runbook: clone → configure → ingest → deploy, step by step.
- Add a lightweight setup script/CLI that walks through the config file.
- Write the "what Docent can and can't do" client-facing doc (trust/scoping document from the PRD's risk section).
- Dry-run a full onboarding against a client repo you haven't used before, timing it.

**Exit criterion:** A new client can go from repo access to a working Docent instance in under a day, following the runbook alone.

---

## What to hand to Claude Code

Once the repo exists, the most useful first prompt is Phase 0 only — don't ask it to build the whole system at once. Point it at `prd/docent-prd.md` and this file, and ask it to scaffold the repo structure and build ingestion against one real repo. Confirm Phase 0's exit criterion before moving it on to Phase 1.
