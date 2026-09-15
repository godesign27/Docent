#!/bin/bash
# Bitbucket Pipelines: tells the EC2 host tagged docent-client=<client> to run the image built in this
# pipeline, through SSM Run Command (no SSH, no open inbound ports), and waits for it to be healthy.
set -euo pipefail

: "${DOCENT_CLIENT:?Set DOCENT_CLIENT as a repository variable}"
: "${DOCENT_ECR_REPOSITORY_URI:?Set DOCENT_ECR_REPOSITORY_URI as a repository variable}"
: "${BITBUCKET_BUILD_NUMBER:?Run this inside Bitbucket Pipelines}"
source "$(dirname "$0")/aws-oidc.sh"

IMAGE="$DOCENT_ECR_REPOSITORY_URI:build-$BITBUCKET_BUILD_NUMBER"

COMMAND_ID=$(aws ssm send-command \
  --document-name AWS-RunShellScript \
  --targets "Key=tag:docent-client,Values=$DOCENT_CLIENT" \
  --parameters "commands=[\"/opt/docent/deploy.sh $IMAGE\"]" \
  --comment "Docent $DOCENT_CLIENT build $BITBUCKET_BUILD_NUMBER" \
  --query Command.CommandId --output text)
echo "SSM command $COMMAND_ID: deploying $IMAGE"

output() {
  aws ssm list-command-invocations --command-id "$COMMAND_ID" --details \
    --query 'CommandInvocations[].CommandPlugins[].Output' --output text || true
}

for _ in $(seq 1 60); do
  STATUS=$(aws ssm list-command-invocations --command-id "$COMMAND_ID" --query 'CommandInvocations[0].Status' --output text)
  case "$STATUS" in
    Success)
      output
      echo "Deployed $IMAGE to the host tagged docent-client=$DOCENT_CLIENT"
      exit 0
      ;;
    Failed | Cancelled | TimedOut)
      output
      echo "Deploy $STATUS" >&2
      exit 1
      ;;
  esac
  sleep 5
done

echo "Timed out after 5 minutes. If the status stayed None, no running instance is tagged docent-client=$DOCENT_CLIENT or its SSM agent isn't registered." >&2
exit 1
