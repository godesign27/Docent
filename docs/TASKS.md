# Task list

Open work across Docent, the UIContext agent and the repo connector. Updated 2026-09-14.

## Waiting on a decision

- **Wire the real GitHub App** for the repo connector, then set `CONNECTOR_MODE=github` on its Fly app.
- **Duplicate AI components in agentic-ui-shadcn.** Pick one of each pair: `AIAvatar`, `AIButton`, `AIDialog`, `AIFeedbackBar`, `AIMessageBody`, `AIMessageFooter`, `AIMessageHeader`. One eval fails until then.
- **Test site cleanup:** remove the invented nav items (Product 1, Product 2, Recents) and one of the two sidebar toggles.

## Repo connector integration

**Goal:** Docent clones private design-system repos with short-lived, read-only tokens that a person approved, instead of the machine's own git credentials. The connector is a separate service (`godesign27/repo-connector`); Docent talks to it only through its public HTTP interface.

**Decided:**
- **Opt-in per client.** Public repos (like agentic-ui-shadcn) keep cloning in the open. A client uses the connector only when its repo is private or otherwise needs the GitHub App.
- **One connector `clientId` per GitHub org or account, not per design system,** e.g. `docent:acme`. Several Docent clients in the same org share it, and one approved install covers all their repos.
- **Approvals are the connector's own gate:** whoever holds its admin secret approves in `/admin`. This is separate from Docent's escalation reviewers.

1. **Config.** On a git source: `githubAccess: "public" | "repo-connector"`, and `repoConnectorClientId: "docent:<org>"` only when using the connector. Validation rejects a connector id without the flag, and the flag without an id.
2. **Client.** A small HTTP client for the four public calls (request installation, status, token, repos), configured from `REPO_CONNECTOR_URL` and `REPO_CONNECTOR_API_KEY`, sending `X-Actor: docent-ingestion` on writes. No SDK dependency until the connector is packaged.
3. **Gate before every clone or fetch.** Only when the flag is on, Docent checks the status:
   - `not_found`: request an installation, print the install link, and skip ingestion.
   - `pending`, `rejected` or `revoked`: skip ingestion, saying who needs to act.
   - `approved`: continue, provided the configured repo is among the accessible repos; otherwise skip.

   Skipping never falls back to public access. It leaves the last good contract in place, so a running Docent keeps serving it, and the command exits non-zero.
4. **Token hygiene.** Mint a token per ingestion and give it to git for that command only. Never write it to the source URL, the git remote, `.git/config`, logs, the contract or `sources.json`. Mint again after `expiresAt`.
5. **Onboarding.** `docent init` and `onboard` for a connector client report the install link and the approval state instead of failing on a clone.
6. **Isolation.** Clients sharing one connector id is expected, not a leak; `docent isolation` shouldn't flag it.
7. **Tests against a fake connector:**
   - each status: `not_found`, `pending`, `rejected`, `revoked`, `approved`
   - a repo outside the grant, and an expired token
   - a public client that never calls the connector
   - the last contract left untouched after a skip
   - the token appearing in no file Docent writes
8. **Later:** re-ingestion on the deployed Docent, with the key as a Fly secret, and possibly one set of approvers for the connector and Docent.

**Status (2026-09-14):** steps 1–5 and 7 are built and tested against a fake connector. Step 6 needed no code change, because the isolation checks don't compare connector ids. A real private-repo clone waits for the GitHub App, since mock mode returns fake repos and tokens.

## Docent

- **First real run of the AWS EC2 kit** (`deploy/aws-ec2/`). It hasn't run in AWS yet: the Dockerfile, bootstrap, IAM policies and pipeline need an end-to-end install, and IT approval comes first.
- **Usage stats report** (`docent stats`): answered, escalated, rejected and clarification rates, and components requested that don't exist.
- **Reviewer notifications** for escalations.
- **Re-ingest, eval and redeploy in CI** after design-system merges.
- **Pilot with a real team.**
- **Agent prompt guidance** in the runbook: submit full file contents to the ship check, re-run it after the last edit, and don't build placeholder destinations.
- **Lower runtime memory** by precompiling TypeScript instead of running through `tsx`, so a smaller Fly machine works.

## UIContext agent

- Phase 3: regeneration.
- Phase 4: productize.

## Done recently

- **UIContext agent Phase 2 is done**: nine deterministic checks plus a grader pass with fresh context that sees only the inputs and the rendered file. Code sets `handoff.status`; `ready` needs every blocking check passed and no blocking finding. On the first real gated run the grader caught three renderer bugs of its own — props marked "used" per component instead of per part, evidence ids cited in prose but never defined in the file, and a variant chosen in code reported as `default`. All three are fixed.
- The model call streams at 64k output: at 16k a long draft came back as truncated JSON, because adaptive thinking shares that budget.
- **UIContext agent Phase 1 is done**, both exit checks met: the seeded test (an invented component, token and import path never reach the file) and a real draft of the Docent-TestSite dashboard — 473 lines, every section filled, 24 components confirmed, 0 invented names, 7 Blocking and 8 Advisory questions, `blocked`. It found contradictions the intent-ux had not: the projects table never filters by the date range, and a typed future date is applied while the calendar blocks it.
- An org-level Anthropic key needs `ANTHROPIC_WORKSPACE_ID`; the model layer now sends `anthropic-workspace-id` when it is set.
- UIContext agent Phase 1: the draft pass (Claude behind a small `Model` interface, so tests run scripted and free), rendering every design-system table from evidence, and the claim lint that replaces an unconfirmed name with `UNKNOWN`, records it in `flags.json` and raises a Blocking question pointing at the prototype.
- The UIContext templates now point agents at Docent's real `ask` call instead of the four tool names Docent doesn't have.
- AWS EC2 deployment kit written (`deploy/aws-ec2/`): non-root Dockerfile, bootstrap, IAM policies, Bitbucket Pipelines with OIDC and SSM deploys, install guide, agent instructions and IT brief.
- repo-connector integration built against a fake connector: opt-in config, approval check before every clone or fetch, token never written to disk, `init --repo-connector`, exit code 3 for skips.
- repo-connector API key rotated; the new key is in `~/.docent/tokens/repo-connector-api-key` and the connector's Fly secret.
- Docent deployed on Fly.io for agentic-ui-shadcn, with Cursor connected over HTTPS.
- Ship checks with placeholder code are refused; component aliases inside callbacks are no longer flagged.
- Deploys are built from one-client bundles.
