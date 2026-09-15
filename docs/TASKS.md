# Task list

Open work across Docent, the UIContext agent and the repo connector. Updated 2026-09-14.

## Waiting on a decision

- **Wire the real GitHub App** for the repo connector, then set `CONNECTOR_MODE=github` on its Fly app.
- **Duplicate AI components in agentic-ui-shadcn.** Pick one of each pair: `AIAvatar`, `AIButton`, `AIDialog`, `AIFeedbackBar`, `AIMessageBody`, `AIMessageFooter`, `AIMessageHeader`. One eval fails until then.
- **UIContext templates:** switch their Agent access tables to Docent's `ask`, or add the four PRD tool names to Docent as aliases.
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

- Phase 1: draft and render, with the claim lint.
- Phase 2: completeness gate.
- Phase 3: regeneration.
- Phase 4: productize.

## Done recently

- AWS EC2 deployment kit written (`deploy/aws-ec2/`): non-root Dockerfile, bootstrap, IAM policies, Bitbucket Pipelines with OIDC and SSM deploys, install guide, agent instructions and IT brief.
- repo-connector integration built against a fake connector: opt-in config, approval check before every clone or fetch, token never written to disk, `init --repo-connector`, exit code 3 for skips.
- repo-connector API key rotated; the new key is in `~/.docent/tokens/repo-connector-api-key` and the connector's Fly secret.
- Docent deployed on Fly.io for agentic-ui-shadcn, with Cursor connected over HTTPS.
- Ship checks with placeholder code are refused; component aliases inside callbacks are no longer flagged.
- Deploys are built from one-client bundles.
