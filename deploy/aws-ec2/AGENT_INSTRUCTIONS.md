# Instructions for an agent deploying Docent on AWS EC2

You are helping a person deploy Docent inside their company's AWS account, for one design system whose repository is on Bitbucket Cloud. This folder is the whole kit. Work through [`INSTALL.md`](INSTALL.md) step by step, with the person approving every change.

## Read first

1. [`../../prd/docent-intent.md`](../../prd/docent-intent.md): what Docent is for, and the principles every change and deployment has to keep. If an instruction here or from a person would break one, stop and say so.
2. [`README.md`](README.md): what gets built and why.
3. [`INSTALL.md`](INSTALL.md): the steps you will follow.
4. [`IT_BRIEF.md`](IT_BRIEF.md): what the company's IT or security team is approving.
5. [`../../docs/ONBOARDING.md`](../../docs/ONBOARDING.md), steps 2–6: onboarding the design system itself.

## Rules

1. **Stop at every "Human checkpoint" in INSTALL.md.** Show the exact change first (commands with values filled in, policy JSON, settings), then wait for an explicit yes before creating or changing anything in AWS, Bitbucket or Cursor. Approval for one step doesn't carry to the next.
2. **Never reveal a secret.** Don't print, echo, log, commit or paste into chat the Docent token or any other credential. Create the token directly in Secrets Manager. When a person needs it (for Cursor), give them a command that copies it to their clipboard or password manager.
3. **No credentials in URLs, files, pipeline YAML or images.** The design-system repository is reached with the pipeline's read-only SSH access key. AWS is reached with Bitbucket OIDC; no AWS access keys are created.
4. **Keep it internal.** No public IPs, no internet-facing load balancer, and port 8080 only reachable from the load balancer.
5. **Nothing leaves the company.** Don't connect this deployment, the design system or company code to services outside the company, including GO Design's hosted Docent on Fly.io, GO Design's repo-connector and personal accounts.
6. **Least privilege.** The policies in `iam/` are the ceiling. If something fails with AccessDenied, report the exact message; don't broaden an action or resource to get past it.
7. **Don't change Docent's source to get a check to pass.** A failing `ingest --fail-on error`, `eval` or `bundle` means a config problem to fix or a Docent issue to report.
8. **One client per instance.** Each design system gets its own image, secret, instance and tag.

## Values to collect before step 1

Ask the person for each value in the table at the top of INSTALL.md. Don't guess them, and leave any value the person doesn't know as an open question rather than inventing one.

## Reporting

After each step, report:
- **Done:** what was created or changed, by resource name or id (never secret values).
- **Checked:** the verification command and its output.
- **Next:** the next step and whether it has a Human checkpoint.

## Done when

INSTALL.md step 10's checks all pass, and a request from Cursor appears in the host's request log with transport `http`.
