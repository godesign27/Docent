#!/bin/bash
# Sourced by the pipeline scripts: signs the AWS CLI in with the step's Bitbucket OIDC token.
# No AWS access keys are stored anywhere. Needs `oidc: true` on the step.
set -euo pipefail

: "${AWS_REGION:?Set AWS_REGION as a repository variable}"
: "${DOCENT_DEPLOY_ROLE_ARN:?Set DOCENT_DEPLOY_ROLE_ARN as a repository variable}"
: "${BITBUCKET_STEP_OIDC_TOKEN:?This step needs oidc: true}"

if ! command -v aws >/dev/null 2>&1; then
  # If your pipelines can't reach the internet, use a build image with the AWS CLI v2 preinstalled instead.
  command -v unzip >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq unzip >/dev/null)
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  (cd /tmp && unzip -q -o awscliv2.zip && ./aws/install --update >/dev/null)
fi

export AWS_DEFAULT_REGION="$AWS_REGION"
export AWS_ROLE_ARN="$DOCENT_DEPLOY_ROLE_ARN"
export AWS_ROLE_SESSION_NAME="docent-pipeline-${BITBUCKET_BUILD_NUMBER:-local}"
export AWS_WEB_IDENTITY_TOKEN_FILE="$(mktemp)"
printf '%s' "$BITBUCKET_STEP_OIDC_TOKEN" > "$AWS_WEB_IDENTITY_TOKEN_FILE"
