# Install Docent on AWS EC2

Deploys Docent for one design system in your company's AWS account, with the design system on Bitbucket Cloud. Follow the steps in order. **Human checkpoint** marks a step that creates or changes something in AWS, Bitbucket or Cursor: show the exact change and get approval first.

Commands assume a shell with the AWS CLI v2 signed in to the right account. Placeholders look like `<AWS_REGION>`.

## Values to collect first

| Placeholder | What it is | Example |
|---|---|---|
| `<AWS_ACCOUNT_ID>` | The 12-digit AWS account id | from `aws sts get-caller-identity` |
| `<AWS_REGION>` | Region for everything below | `us-east-1` |
| `<CLIENT_ID>` | Docent's id for this design system: lowercase letters, digits, dashes | `acme-design-system` |
| `<BITBUCKET_WORKSPACE>` | Bitbucket Cloud workspace slug | `acme` |
| `<BITBUCKET_WORKSPACE_UUID>` | Workspace UUID, without braces | Repository settings → OpenID Connect |
| `<DOCENT_REPO>` / `<DOCENT_REPOSITORY_UUID>` | The internal Docent repository, and its UUID without braces | `docent` |
| `<DESIGN_SYSTEM_REPO>` | The design-system repository slug on Bitbucket Cloud | `design-system` |
| `<VPC_ID>`, `<PRIVATE_SUBNET_IDS>` | VPC and at least two private subnets | from the network team |
| `<INTERNAL_HOSTNAME>` | Internal DNS name for Docent | `docent.internal.example.com` |
| `<CERTIFICATE_ARN>` | ACM certificate for that hostname | from the network team |
| `<CORPORATE_CIDRS>` | Address ranges allowed to reach Docent (office, VPN) | from the network team |
| `<NPM_CONFIG_REGISTRY>` | Optional internal npm registry | |

Keep filled-in copies of the policy files and bootstrap script outside the repository.

## 0. Approval

**Human checkpoint.** IT or security has reviewed [`IT_BRIEF.md`](IT_BRIEF.md) and answered its four decisions. Don't start before this.

**Done when** there is a written approval, and the answers are recorded (token model, log retention, Cursor administration, scanning).

## 1. Put Docent in Bitbucket Cloud

**Human checkpoint:** creating the repository.

Create an empty repository `<DOCENT_REPO>` in the workspace, then:

```bash
git clone https://github.com/godesign27/Docent.git docent
cd docent
git checkout -b main <DOCENT_TAG_OR_COMMIT>   # pin a known version
git remote rename origin upstream
git remote add origin git@bitbucket.org:<BITBUCKET_WORKSPACE>/<DOCENT_REPO>.git
cp deploy/aws-ec2/bitbucket-pipelines.yml bitbucket-pipelines.yml
```

Let the repository track this client's config, which Docent ignores by default. Add these lines to the end of `.gitignore`:

```
!config/clients/<CLIENT_ID>.yaml
!config/clients/<CLIENT_ID>.eval.yaml
```

Keep the `LICENSE` file (MIT). Commit and push:

```bash
git add bitbucket-pipelines.yml .gitignore
git commit -m "Docent for <CLIENT_ID>: pipeline and config tracking"
git push -u origin main
```

**Done when** the repository is in Bitbucket and its default pipeline (the test step) passes.

## 2. Onboard the design system

On a machine that can read the design-system repository, follow [`docs/ONBOARDING.md`](../../docs/ONBOARDING.md) steps 2–6. Use the **Bitbucket Cloud** repository's SSH URL, not the GitHub mirror:

```bash
npm install
npm run docent -- init --repo git@bitbucket.org:<BITBUCKET_WORKSPACE>/<DESIGN_SYSTEM_REPO>.git --id <CLIENT_ID> --name "<Design system name>"
npm run docent -- onboard --client <CLIENT_ID>
npm run docent -- eval --client <CLIENT_ID>
```

- **The eval batch must pass completely.** The pipeline stops a deploy on any failing case. Fix the config, or correct an expectation that is wrong, with the design-system owner. Don't just delete a failing case.
- **Never put a username, password or token in the repository URL:** Docent writes the URL into the contract and logs.

Commit only the config and eval batch (contracts and logs stay out of git):

```bash
git add config/clients/<CLIENT_ID>.yaml config/clients/<CLIENT_ID>.eval.yaml
git commit -m "Docent config for <CLIENT_ID>"
git push
```

**Done when** `onboard` ends with "is onboarded", `eval` passes every case, and the config is pushed.

## 3. ECR repository

**Human checkpoint.**

```bash
aws ecr create-repository --region <AWS_REGION> --repository-name docent-<CLIENT_ID> \
  --image-scanning-configuration scanOnPush=true --image-tag-mutability IMMUTABLE
```

**Done when** `aws ecr describe-repositories --repository-names docent-<CLIENT_ID>` shows it. Note its `repositoryUri`.

## 4. Access token

**Human checkpoint.** This generates the token straight into Secrets Manager, so the value is never printed:

```bash
aws secretsmanager create-secret --region <AWS_REGION> --name docent/<CLIENT_ID>/token \
  --description "Bearer token for Docent (<CLIENT_ID>)" \
  --secret-string "$(openssl rand -hex 32)"
```

**Done when** `aws secretsmanager describe-secret --secret-id docent/<CLIENT_ID>/token` shows the secret.

## 5. IAM roles

**Human checkpoint:** show the filled-in policy JSON before creating anything.

Fill the placeholders in `iam/*.json` in your working copies, then create the **instance role**:

```bash
aws iam create-role --role-name docent-<CLIENT_ID>-instance \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam put-role-policy --role-name docent-<CLIENT_ID>-instance --policy-name docent --policy-document file://instance-role-policy.json
aws iam attach-role-policy --role-name docent-<CLIENT_ID>-instance --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam create-instance-profile --instance-profile-name docent-<CLIENT_ID>
aws iam add-role-to-instance-profile --instance-profile-name docent-<CLIENT_ID> --role-name docent-<CLIENT_ID>-instance
```

Then the **Bitbucket OIDC identity provider**, once per AWS account and workspace:
1. In Bitbucket, open the internal Docent repository's **Repository settings → OpenID Connect**. It shows the identity provider URL, the audience, and the repository UUID.
2. In IAM, add an OpenID Connect provider with exactly that URL and audience.
3. Check that `iam/pipeline-trust-policy.json` uses the same provider path, audience and repository UUID. The `sub` condition limits the role to this repository's pipelines.

Then the **pipeline role**:

```bash
aws iam create-role --role-name docent-<CLIENT_ID>-deploy --assume-role-policy-document file://pipeline-trust-policy.json
aws iam put-role-policy --role-name docent-<CLIENT_ID>-deploy --policy-name docent-deploy --policy-document file://pipeline-role-policy.json
```

**Done when** both roles exist with only these policies. Note the deploy role's ARN.

## 6. EC2 instance

**Human checkpoint.**

- **Network.** The instance runs in a private subnet with no public IP, so it needs a route to AWS services: a NAT gateway, or VPC endpoints for `ssm`, `ssmmessages`, `ec2messages`, `ecr.api`, `ecr.dkr`, `secretsmanager` and `s3` (a gateway endpoint, for image layers).
- **Security group** `docent-<CLIENT_ID>-host`: inbound TCP 8080 only from the load balancer's security group (step 7), and no inbound SSH.
- **User data.** Copy `ec2/bootstrap.sh`, and fill in `AWS_REGION`, `DOCENT_CLIENT` and `DOCENT_SECRET_ID` (`docent/<CLIENT_ID>/token`).

```bash
aws ec2 run-instances --region <AWS_REGION> \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --instance-type t3.small \
  --subnet-id <ONE_PRIVATE_SUBNET_ID> \
  --no-associate-public-ip-address \
  --security-group-ids <HOST_SECURITY_GROUP_ID> \
  --iam-instance-profile Name=docent-<CLIENT_ID> \
  --metadata-options HttpTokens=required,HttpEndpoint=enabled \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,Encrypted=true}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=docent-<CLIENT_ID>},{Key=docent-client,Value=<CLIENT_ID>}]' \
  --user-data file://bootstrap.filled.sh
```

`t3.small` has 2 GB of memory; Docent uses about 400 MB, and the container is capped at 1 GB. Optionally add daily EBS snapshots with Data Lifecycle Manager, since they back up the review queue.

**Done when:**
- `aws ssm describe-instance-information --filters Key=tag:docent-client,Values=<CLIENT_ID>` shows the instance **Online**.
- In a Session Manager shell, `sudo tail -n 5 /var/log/cloud-init-output.log` ends with "Docent host ready".

## 7. Internal load balancer

**Human checkpoint.**

1. **Security group** `docent-<CLIENT_ID>-alb`: inbound TCP 443 from `<CORPORATE_CIDRS>`, and outbound TCP 8080 to the host security group.
2. **Target group** `docent-<CLIENT_ID>`: protocol HTTP, port 8080, target type instance, health check path `/healthz` expecting 200. Register the instance.
3. **Application Load Balancer**: scheme **internal**, in `<PRIVATE_SUBNET_IDS>` (at least two availability zones), with that security group. Add an HTTPS :443 listener using `<CERTIFICATE_ARN>` that forwards to the target group.
4. **DNS**: point `<INTERNAL_HOSTNAME>` at the load balancer (a Route 53 private hosted zone, or the company's DNS).

The target shows unhealthy until the first deploy; that's expected.

**Done when** the load balancer is active, and `<INTERNAL_HOSTNAME>` resolves to it from the company network.

## 8. Pipeline settings

**Human checkpoint.**

In the internal Docent repository:
1. **Repository settings → Repository variables:**
   - `DOCENT_CLIENT` = `<CLIENT_ID>`
   - `AWS_REGION` = `<AWS_REGION>`
   - `DOCENT_ECR_REPOSITORY_URI` = the ECR URI from step 3
   - `DOCENT_DEPLOY_ROLE_ARN` = the deploy role's ARN from step 5
   - optionally `NPM_CONFIG_REGISTRY`

   None of these are secrets.
2. **Repository settings → Pipelines → SSH keys:** generate a key pair and copy the public key.
3. In the **design-system** repository, **Repository settings → Access keys → Add key**: paste that public key. Access keys are read-only.

**Done when** the variables are set, and the design-system repository lists the access key.

## 9. First deploy

In the internal Docent repository, open **Pipelines → Run pipeline**, choose branch `main` and the custom pipeline `ingest-and-deploy`.

It runs four steps:
1. Test Docent.
2. Ingest, evaluate and bundle.
3. Build and push the image.
4. Deploy to EC2.

**Done when** all four steps pass, and the last one prints "Docent is healthy".

## 10. Verify

From a machine on the company network:

```bash
curl -sS https://<INTERNAL_HOSTNAME>/healthz
```
This should return `status: ok`, the client id, the contract hash and the design system's commit.

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<INTERNAL_HOSTNAME>/mcp
```
This must print `401`: requests without the token are refused.

After step 11, check the host's request log in a Session Manager shell. It shows the question, so only admins should read it:
```bash
sudo tail -n 1 /var/lib/docent/logs/<CLIENT_ID>/requests.jsonl
```

**Done when:**
- `/healthz` is OK.
- An unauthenticated POST gets 401.
- The target group shows healthy.
- After step 11, the newest request log line has `"transport":"http"`.

## 11. Connect Cursor

**Human checkpoint:** the company's Cursor administrator does this, or approves per-user settings.

1. **Copy the token without printing it.**
   macOS:
   ```bash
   aws secretsmanager get-secret-value --secret-id docent/<CLIENT_ID>/token --query SecretString --output text | pbcopy
   ```
   Windows PowerShell:
   ```powershell
   aws secretsmanager get-secret-value --secret-id docent/<CLIENT_ID>/token --query SecretString --output text | Set-Clipboard
   ```
2. **Add the server.**
   - **For the whole team:** Cursor team settings → MCP → Add → Remote HTTPS. URL `https://<INTERNAL_HOSTNAME>/mcp`, header `Authorization` with value `Bearer <token>`, and optionally `X-Docent-Caller` with value `cursor-team`. Leave the OAuth fields empty.
   - **For one person:** use [`cursor/mcp.json.example`](cursor/mcp.json.example).
3. **Test it.** In a new agent chat, ask: *Using only the docent tools, what variants does `<a real component>` support?*

**Done when** the agent answers from Docent, and step 10's log check passes.

## Operating

- **After a design-system release:** run `ingest-and-deploy` again. To automate it, add a schedule under **Pipelines → Schedules**, or trigger the custom pipeline from the design-system repository's own pipeline through the Bitbucket API.
- **Rotating the token:**
  1. `aws secretsmanager put-secret-value --secret-id docent/<CLIENT_ID>/token --secret-string "$(openssl rand -hex 32)"`
  2. Run `ingest-and-deploy` again.
  3. Update Cursor.
- **Reviewing escalations,** in a Session Manager shell:
  - `sudo docker exec docent node bin/docent.js reviews --client <CLIENT_ID>`
  - `sudo docker exec docent node bin/docent.js review --client <CLIENT_ID> <review-id> --approve --note "…" --by "<name>"`
- **Updating Docent:** `git fetch upstream`, merge a newer tag, check that `npm test` passes, push, then run `ingest-and-deploy`.
- **Patching:** patch the instance with Systems Manager Patch Manager, and rebuild the image regularly to pick up Node.js base image updates.
- **Log retention:** `/etc/logrotate.d/docent` keeps 12 weeks of request logs; change it to the retention IT decided. The review queue is never rotated.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Ingest step: `Permission denied (publickey)` | The pipeline's SSH key isn't an access key on the design-system repository, or the config URL isn't the Bitbucket SSH URL. |
| Eval step fails | A case fails. Run `npm run docent -- eval --client <CLIENT_ID> --verbose` locally and fix the config or the expectation with the design-system owner. |
| Build or deploy step: `AccessDenied` assuming the role | The OIDC provider URL, audience or repository UUID in the trust policy don't match the Bitbucket OpenID Connect page. |
| Deploy step times out with status `None` | No running instance is tagged `docent-client=<CLIENT_ID>`, or its SSM agent can't reach SSM (instance profile, NAT or VPC endpoints). |
| Deploy step: "did not become healthy" | Read the journal lines it prints. `Out of memory` means a bigger instance; a missing-secret error means the secret name in `/etc/docent/config` is wrong. |
| Load balancer returns 502 or 503 | The target is unhealthy: the host security group must allow 8080 from the load balancer's, and `systemctl status docent` must show it running. |
| Cursor can't connect | Check the VPN, that the hostname resolves, that the machine trusts the certificate, and that the header value is `Bearer ` followed by the token. |
