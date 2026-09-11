# Docent — PRD
**A reusable concierge layer that lets engineering agents safely query any enterprise design system.**

Status: Draft v0.1
Owner: Timothy McGuire, GO Design

---

## 1. Problem

Enterprise design systems are documented for humans. Engineering agents (Cursor, Lovable, Copilot, custom coding agents) that need to build UI against a client's design system today either:

- Get no structured access at all, and hallucinate components/tokens, or
- Get raw file/API access to the repo, with no judgment layer — they can technically read anything and violate governance without knowing it.

There's no reusable "front door" that lets an unfamiliar agent ask a design system a question and get back a validated, contract-accurate answer, without a human in the loop for every request.

Every client engagement that wants this today requires bespoke integration work. That doesn't scale across a consulting practice.

## 2. Goal

Ship a clonable, config-driven repo that:

1. Ingests **any** enterprise design system repo (components, tokens, docs, patterns) into a normalized contract format.
2. Exposes that contract set through a **concierge agent** that other engineering agents can query via MCP.
3. Routes queries to one of four specialist domains: tokens/foundations, components/contracts, patterns/usage, governance/compliance.
4. Validates and logs every response before it's returned (guardrails + audit trail).
5. Can be cloned, pointed at a new client's repo, configured, and running in **under a day** — not re-architected per client.

## 3. Non-goals (v1)

- Not a design system *authoring* tool — Docent reads and mediates, it doesn't generate new components or tokens.
- Not a replacement for the client's own design system documentation for human designers.
- Not a training/fine-tuning pipeline — v1 uses prompting + retrieval, not a custom model.
- Not multi-repo federation (one Docent instance = one client's design system) in v1.

## 4. Users

| User | What they need |
|---|---|
| **Calling engineering agent** (Cursor, Lovable, custom coding agent) | A single, reliable endpoint to ask "what's the correct token/component/pattern for X" and get a trustworthy, contract-backed answer |
| **Client engineering team** | Confidence that agent-generated UI can't silently violate their design system; an audit trail of what was asked and answered |
| **GO Design (you)** | A repeatable starting point per client engagement — configure, don't rebuild |

## 5. Functional requirements

### 5.1 Ingestion
- Point at a client repo (or designated design-system subfolder).
- Parse components, design tokens, documented patterns, and governance/policy docs into a normalized contract schema (JSON/YAML).
- Re-run ingestion on demand (repo changes → contracts update).
- Flag ingestion gaps (e.g., a component with no documented usage) rather than silently guessing.

### 5.2 Concierge agent
- Single MCP entry point for calling agents.
- Reads the incoming request, determines intent, and routes to the correct specialist(s).
- Can ask a clarifying question back to the calling agent when intent is ambiguous, rather than guessing.

### 5.3 Specialists
- **Tokens & foundations** — color, type, spacing, elevation.
- **Components & contracts** — structure, required props, valid variants.
- **Patterns & usage** — when/how a component or pattern should be used, and what it shouldn't be used for.
- **Governance & compliance** — what's allowed to ship as-is, what needs review, what's explicitly disallowed.
- Each specialist is scoped narrowly — no cross-domain guessing.

### 5.4 Guardrails & audit
- Every response is validated against the contract before returning (no silently wrong answers).
- Every request/response pair is logged: who asked, what was asked, what was returned, whether it was flagged.
- Configurable escalation: certain request types (e.g., governance conflicts) can require human sign-off before the response returns.

### 5.5 Reusability / config
- Per-client config file: repo location, ingestion rules, which specialists are active, escalation policy.
- No client-specific code required to onboard a new client — config only, for the common case.

## 6. Non-functional requirements

- **Latency**: concierge round-trip should feel synchronous to a calling agent (target: single-digit seconds for a typical query).
- **Isolation**: each client's contracts and logs are fully separated — no cross-client data leakage, ever.
- **Observability**: every routing decision and validation outcome is inspectable, not a black box.
- **Deployability**: must run on infrastructure GO Design already uses (Cloudflare Workers / Fly.io track), so it doesn't introduce a new ops burden.

## 7. Success metrics (v1)

- Time to onboard a new client: < 1 day from repo access to a working Docent instance.
- % of calling-agent requests answered without human escalation.
- Zero governance violations shipped through Docent-mediated responses in pilot usage.
- Reused, unmodified, across at least 2 client engagements without core code changes.

## 8. Risks

- **Ingestion quality varies wildly by client.** A messy or undocumented design system may not normalize well — mitigate by surfacing gaps explicitly rather than hallucinating to fill them.
- **Over-scoping v1.** The temptation is to build all four specialists fully before testing any of them end-to-end — mitigate via phased plan (below).
- **Client trust.** Handing an AI system read access to a design system repo is a trust ask — mitigate with strong audit logging and a clear "what Docent can and can't do" doc per client.
