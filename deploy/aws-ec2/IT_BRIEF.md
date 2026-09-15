# Docent on internal AWS: brief for IT and security review

## What it is

Docent answers coding agents' questions about the company's design system (components, tokens, usage rules) and checks proposed UI code against the design system's rules. Agents such as Cursor call it over MCP, a standard protocol for agent tools. It answers only from a snapshot of the design-system repository, never runs that repository's code, and doesn't call any AI model or outside service while it runs. Open source, MIT licence: [github.com/godesign27/Docent](https://github.com/godesign27/Docent).

## Architecture

- **Host:** one EC2 instance (Amazon Linux 2023, t3.small) in a private subnet, with no public IP and no SSH. Administration is through AWS Systems Manager.
- **Access:** an internal Application Load Balancer terminates HTTPS and forwards to the container on port 8080. Users reach it over the company network or VPN.
- **Container:** one Docent container per design system, running as a non-root user with all Linux capabilities dropped and a 1 GB memory limit.
- **Image:** stored in a private ECR repository.
- **Token:** the access token is in AWS Secrets Manager.
- **Storage:** the request log and review queue are on the instance's encrypted EBS volume.
- **Deploys:** Bitbucket Pipelines builds and deploys. It signs in to AWS with OIDC (no stored AWS keys), and can only push to the Docent ECR repository and run the deploy command on the one tagged instance.

## Data flow

1. **Build time:** the pipeline reads the design-system repository with a read-only SSH access key. It parses it into a contract, which is checked and baked into the image.
2. **Run time:** agents send questions, and optionally code to check, to Docent over internal HTTPS. Docent answers from the contract.
3. **Outbound:** at run time, none. At build time, the pipeline needs Bitbucket, the npm registry (or an internal mirror), ECR, and the AWS CLI (or a build image that includes it).

## What is stored

| Data | Where | Retention |
|---|---|---|
| Design-system snapshot: contract and source files | Container image in ECR | Replaced on each deploy; ECR lifecycle rules apply |
| Request log: every question, answer, and code submitted for checking | `requests.jsonl` on the EBS volume | Rotated weekly, 12 weeks kept by default; set to company policy |
| Review queue: escalated requests and reviewers' decisions | `reviews.jsonl` on the EBS volume | Kept; no decision is deleted |

## Access control

- **One shared bearer token** (64 hex characters) per instance, sent by each agent tool. Rotating it means updating the secret, redeploying, and updating the agent tools' settings.
- **No per-user identity or single sign-on** in Docent itself. Callers name themselves for the audit log, but that isn't authenticated.
- **Network restriction:** the load balancer is internal, and the instance only accepts traffic from it.

## Security properties

- **Read-only access** to the design-system repository.
- **Nothing executed:** the repository's code is parsed, never run.
- **Validated answers:** every answer is checked against the snapshot before it's returned, and failures are withheld and logged.
- **Deliberate deploys only:** they happen through the pipeline, and every step's output is kept in Bitbucket.

## Decisions for IT

1. Is connecting the company's Cursor (or other agent tools) to an internal MCP server allowed, and who administers it?
2. Is a shared bearer token acceptable on the internal network, or is per-user sign-on required? Adding sign-on in front of Docent would need work in Docent and in the agent tools.
3. How long should the request log be kept, given it contains code submitted for checking?
4. Image scanning (for example ECR enhanced scanning), and the patching schedule for the instance and base image.
