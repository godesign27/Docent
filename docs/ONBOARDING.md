# Onboarding a client to Docent

The runbook for taking a client from repo access to a working Docent instance in under a day. Follow it top to bottom; every step says what done looks like.

| Step | What | Time |
|---|---|---|
| 0 | Prerequisites | 10 min |
| 1 | Clone Docent for the client | 10 min |
| 2 | Generate and review the config | 30 min |
| 3 | First onboarding run | 5 min |
| 4 | Triage gaps | 1–2 h |
| 5 | Set governance and escalation | 1 h |
| 6 | Replace the starter eval with real requests | 1–2 h |
| 7 | Connect an agent and verify | 15 min |
| 8 | Deploy for the team (optional) | 1 h |
| 9 | Hand off | 30 min |

Most of the day is judgment in steps 4–6. The commands themselves run in seconds.

---

## 0. Prerequisites

- Node.js 20.11 or later, and git.
- Read access to the client's design-system repo. For a private repo, the machine running Docent needs git credentials that can clone it (SSH key or credential helper). Docent never asks for them.
- Someone at the client who can answer: which rules must block, and who reviews escalations.
- A few real questions the client's engineers or agents ask about their design system (for step 6).

**Done when** you can `git clone` the client's repo on this machine.

## 1. Clone Docent for the client

One clone per client engagement. Client configs, contracts, logs and reviews live in that clone and are git-ignored.

```bash
git clone https://github.com/godesign27/Docent.git docent-<client>
cd docent-<client>
npm install
npm test
```

**Done when** `npm test` passes.

## 2. Generate and review the config

```bash
npm run docent -- init --repo <git-url-or-path> --id <client-id> --name "<Client Design System>"
```

Add `--ref <branch>` for a branch other than the default and `--subdir <dir>` for a design system inside a monorepo. `init` clones the repo read-only, detects its structure and writes `config/clients/<client-id>.yaml`. The top of that file lists what was detected and the TODOs it could not decide.

Resolve each TODO:

| TODO | How to decide |
|---|---|
| Narrow `ingestion.components` | Keep only design-system components: primitives, layout and anything the client's docs call part of the system. Leave out product features (pages, dashboards, domain widgets). List individual files if needed. |
| CSS variables under other selectors | A selector such as `.theme-blue` or `[data-brand="x"]` that holds token values is a mode: add it to `modes`. Leave out selectors that aren't themes. |
| Token JSON not linked to CSS | If the client generates CSS from JSON, keep the CSS (it binds utilities). If they have no CSS tokens, switch to `dtcg-json`. |
| No global CSS entry for foundation | Set `ingestion.foundation.files` to the stylesheet that defines tokens and the Tailwind/PostCSS config, or leave it out if consumers already have the design system's styles. |
| Rules read with severity "medium" | Handled in step 5. |
| Confirm governance.checks | Each check should point at the rule that forbids what it detects. Remove a mapping that points at the wrong rule; a check without a mapping only warns. |
| No component docs | Point `docs.components` at the markdown that explains usage. |

Validate:

```bash
npm run docent -- check-config --client <client-id>
```

Reference for every field: [`config/clients/_template.yaml`](../config/clients/_template.yaml) and the tables in the [README](../README.md#what-ingestion-reads).

**Done when** `check-config` passes and no TODO is left unconsidered.

## 3. First onboarding run

```bash
npm run docent -- onboard --client <client-id>
```

This ingests the design system, writes `contracts/<client-id>/gaps.md`, seeds `config/clients/<client-id>.eval.yaml` from the contract and runs it, checks isolation against every client in this clone, and prints how to connect an agent.

**Done when** it ends with `✔ <Client> is onboarded.` If the starter eval fails, the config is usually the cause (a wrong mode, a missed component folder): fix it and rerun.

## 4. Triage gaps

Open `contracts/<client-id>/gaps.md`. Every gap is either a config problem (fix it now) or a design-system problem (hand it to the client).

| Gap | Usually means | Action |
|---|---|---|
| `parse-error`, `no-components-found`, `no-tokens-found` | Wrong globs or file types | Fix config |
| `unresolvable-config-value` | A mode, heading, path or mapping in config doesn't match the repo | Fix config |
| `governance-check-unmapped` | A check maps to a rule id that doesn't exist | Fix config |
| `import-path-unknown` | No tsconfig paths and no inventory import paths | Set `importPath` on the react-tsx extractor |
| `not-in-manifest`, `manifest-entry-without-source` | Components globs too wide/narrow, or the inventory is stale | Fix globs; otherwise hand off |
| `unresolved-token-reference` | A token or utility points at a variable that isn't defined | Real bug for the client, unless a CSS file is missing from the tokens extractor |
| `spec-drift` | The client's spec disagrees with source | Hand off (source wins meanwhile) |
| `non-token-value` | Components use colors that aren't tokens | Hand off |
| `missing-usage-docs`, `undocumented-token`, `placeholder-documentation` | Documentation gaps | Hand off; not blocking |
| `inherited-props-not-expanded`, `framework-defaults-not-captured` | Known limits of static reading | Nothing to do |

Rerun `onboard` after config fixes. Collect the hand-off gaps into a short note for the client.

**Done when** no config-caused gap remains and the hand-off note is written.

## 5. Set governance and escalation

With the client's design-system owner:

1. **Severities.** For each rule that must block, set a severity. In a rules JSON file that is the rule's own severity field; for rules read from markdown, set `severity` on the rule source (all bullets under that heading share it), or split the heading.
2. **Policy.** The defaults: proven critical → rejected, high → escalated to a human, medium/low → warning, a request that only resembles a rule → warning, a request for an exception → escalated. Change `escalation` in config only if the client wants something else.
3. **Reviewers.** Set `escalation.reviewers` to the people who decide escalations.
4. **Check it** with requests the client cares about:

```bash
npm run docent -- ask --client <client-id> "Can I use Material UI for the data table?"
npm run docent -- ask --client <client-id> "Can we make an exception and hardcode #ff0000 just this once?"
npm run docent -- ask --client <client-id> --code path/to/Component.tsx "Is this OK to ship?"
```

**Done when** each answer's status (`answered`, `rejected`, `escalated`) is what the client expects.

## 6. Replace the starter eval with real requests

`config/clients/<client-id>.eval.yaml` was generated from the contract. It proves the pipeline works, not that routing suits this client. Replace it with 20–40 requests the client's engineers or agents really send, across components, tokens, patterns (if enabled), governance and code checks, plus one or two vague requests.

```yaml
- name: short label
  ask: The request, as an agent would send it
  # code: |            # optional, for code checks
  expect:
    domains: [components]          # exact set of specialists; [] for clarification
    status: answered               # answered | clarification-needed | not-found | rejected | escalated
    components: [button]           # ids that must be answered
    # tokens, patterns, unresolved, rules (rule ids in findings), outcome, includesDomains
```

Write the expectation you want, not the one you get. Quote any request containing `#` (YAML treats ` #` as a comment).

```bash
npm run docent -- eval --client <client-id> --verbose
```

When a case fails, `--verbose` prints the routing signals. Fix it through config (a missing component folder, a rule's severity, a check mapping, docs paths) rather than by rewording the request. If a failure needs a code change in Docent, note it; don't block the onboarding on it.

**Done when** the batch passes, or every failure is understood and recorded.

## 7. Connect an agent and verify

In the client's project, register the server `onboard` printed. Cursor: add it to `~/.cursor/mcp.json` (project-level `.cursor/mcp.json` only loads when that folder is the open workspace), then turn it on under **Settings → Tools & MCP**. Claude Code:

```bash
claude mcp add docent-<client-id> -- node /absolute/path/to/docent-<client>/bin/docent.js serve --client <client-id>
```

Open a new agent chat and ask: *Using only the docent MCP tools, what variants does <a real component> support?*

**Done when** the newest line of `logs/<client-id>/requests.jsonl` shows the agent's client name and transport `stdio`.

## 8. Deploy for the team (optional)

One deployed instance serves one client over HTTPS, protected by a bearer token. The image contains the client's config, contract and source snapshot, so keep it in a private registry.

On Fly.io, from the client's Docent clone after step 3:

```bash
cp fly.toml.example fly.toml    # set app name and DOCENT_CLIENT
fly launch --no-deploy --copy-config
fly volumes create docent_logs --size 1
fly secrets set DOCENT_TOKEN=$(openssl rand -hex 32)
fly deploy
curl https://<app>.fly.dev/healthz
```

Share the token with the team through the client's secret manager. Agents connect to `https://<app>.fly.dev/mcp` with the header `Authorization: Bearer <token>`:

```bash
claude mcp add --transport http docent-<client-id> https://<app>.fly.dev/mcp --header "Authorization: Bearer $DOCENT_TOKEN"
```

In Cursor's `mcp.json`: `"docent-<client-id>": { "url": "https://<app>.fly.dev/mcp", "headers": { "Authorization": "Bearer <token>" } }`.

Set `X-Docent-Caller` in the headers to name the agent in the audit log. Reviewers decide escalations on the server:

```bash
fly ssh console -C "node bin/docent.js reviews --client <client-id>"
fly ssh console -C "node bin/docent.js review --client <client-id> <review-id> --approve --note '...' --by <name>"
```

Anywhere else that runs a container works the same way: build the [`Dockerfile`](../Dockerfile), set `DOCENT_CLIENT` and `DOCENT_TOKEN`, expose port 8080, mount `/app/logs`.

**Done when** `/healthz` shows the client's contract hash and a remote agent's request appears in the logs with transport `http`.

## 9. Hand off

- [ ] Share [`WHAT_DOCENT_DOES.md`](WHAT_DOCENT_DOES.md) with the client.
- [ ] Send the gap hand-off note from step 4.
- [ ] Reviewers know how to list and decide reviews (step 5 / step 8).
- [ ] Agree when to re-ingest: after every design-system release, or on a schedule (below).
- [ ] Record where the instance runs, who holds the token, and where logs live.

---

## Operating

**Re-ingest when the design system changes.** Ingestion is deterministic: an unchanged design system produces an identical contract hash.

```bash
npm run ingest -- --client <client-id>
npm run docent -- eval --client <client-id>
```

Then restart the local server, or `fly deploy` again. In CI, `npm run ingest -- --client <client-id> --fail-on error` fails the build on error-level gaps.

**Rotate the token:** `fly secrets set DOCENT_TOKEN=...` and update agents.

**Several clients on one machine:** one config each, one server each; run `npm run docent -- isolation` after adding a client.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Cursor doesn't list the server | Use `~/.cursor/mcp.json`, or open the project folder that holds `.cursor/mcp.json`; toggle the server on in settings; start a new chat. |
| Server red in Cursor, "command not found" | Use the absolute path to `node` (e.g. `/opt/homebrew/bin/node`); apps launched from the Dock don't inherit your shell's PATH. |
| Agent answers without calling Docent | Ask again in a new chat, telling it to use only the docent tools; check `requests.jsonl`. |
| Tokens have no utility bindings | Tailwind v3: add the `tailwind-theme` extractor. Tailwind v4: map `@theme` in `modes`. |
| Every token has a `missing-default-mode` gap | `defaultMode` doesn't match the mode name used for `:root` / `@theme`. |
| Eval case with `#` behaves oddly | Quote the `ask:` value. |
| `No contract for <client>` when serving | Run `ingest` or `onboard` first. |
| `Refusing to serve on 0.0.0.0 without a token` | Set `DOCENT_TOKEN` (24+ characters) or bind to 127.0.0.1. |
