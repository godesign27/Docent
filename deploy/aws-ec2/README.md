# Docent on AWS EC2: deployment kit

Everything needed to run Docent for one design system inside a company's own AWS account. The design system's repository is on Bitbucket Cloud and deploys go through Bitbucket Pipelines. Nothing runs outside the company network.

**Status:** written and linted, not yet run end to end in AWS. Expect to adjust names and network details on the first run.

## Where to start

| You are | Read |
|---|---|
| An agent doing the install | [`AGENT_INSTRUCTIONS.md`](AGENT_INSTRUCTIONS.md), then [`INSTALL.md`](INSTALL.md) |
| The person doing or approving the install | [`INSTALL.md`](INSTALL.md) |
| IT or security reviewing it | [`IT_BRIEF.md`](IT_BRIEF.md) |

## What gets built

```
Bitbucket Cloud                                  AWS account (private network)
┌──────────────────────────┐   OIDC, no keys   ┌──────────────────────────────────────────────────┐
│ design-system repo       │                   │ ECR: docent-<client>        Secrets Manager:     │
│   ▲ read-only access key │                   │   ▲ image                     docent/<client>/token│
│ internal Docent repo     │                   │   │                              │               │
│   bitbucket-pipelines:   │ ── push image ──▶ │   │                              ▼               │
│   test → ingest → eval → │ ── SSM deploy ──▶ │ EC2 (private subnet, no SSH): docent.service     │
│   bundle → build → deploy│                   │   container :8080, non-root, 1 GB, logs on EBS   │
└──────────────────────────┘                   │   ▲                                              │
                                               │ internal ALB, HTTPS :443 ◀── Cursor over VPN     │
                                               └──────────────────────────────────────────────────┘
```

## Contents

| File | What it is |
|---|---|
| `Dockerfile` | Docent image for one client: non-root, optional internal npm registry, health check |
| `ec2/bootstrap.sh` | EC2 user data for Amazon Linux 2023: Docker, `docent.service`, deploy script, log rotation |
| `iam/instance-role-policy.json` | Instance role: pull this image, read this token (plus the AWS-managed SSM policy) |
| `iam/pipeline-trust-policy.json` | Lets only the internal Docent repository's pipelines assume the deploy role, via Bitbucket OIDC |
| `iam/pipeline-role-policy.json` | Deploy role: push this image, run the deploy command on the host tagged for this client |
| `bitbucket-pipelines.yml` | Template for the internal Docent repository's root |
| `ci/*.sh` | Pipeline scripts: OIDC sign-in, build and push, deploy through SSM |
| `cursor/mcp.json.example` | Per-user Cursor settings for the internal URL |
| `INSTALL.md`, `AGENT_INSTRUCTIONS.md`, `IT_BRIEF.md` | Install guide, rules for agents, one-page brief for IT |

## Decisions built in

| Decision | Why |
|---|---|
| **EC2 with Docker and systemd**, one instance per design system | Docent keeps its request log and review queue in files that expect one writer; one small instance is enough. |
| **Bitbucket Cloud as the source**, not its GitHub mirror | Bitbucket is the source of truth, and a mirror can lag. GO Design's repo-connector (GitHub) is an outside service and isn't used here. |
| **Bitbucket OIDC to AWS**, no access keys | Nothing long-lived to leak or rotate; the role only trusts this repository's pipelines. |
| **SSM Run Command** for deploys, no SSH | No inbound admin port; every deploy is recorded. |
| **Contract baked into the image** in CI | The server never touches the repository; each deploy is a known snapshot, and the pipeline stops if ingestion or the eval batch fails. |
| **Internal ALB with HTTPS**, shared bearer token | Keeps Docent off the internet. Docent has no single sign-on today; see IT_BRIEF.md. |

## Limits

- **One shared bearer token per instance.** Callers aren't individually authenticated.
- **One instance, no horizontal scaling.** Plan for a short restart on each deploy.
- **The first request after a deploy** takes a few seconds while Docent loads the contract.
