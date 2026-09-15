#!/bin/bash
# Bitbucket Pipelines: builds the client's Docent image from the bundle and pushes it to ECR.
# Tags the image with the build number, so the deploy step and the ECR history line up.
set -euo pipefail

: "${DOCENT_CLIENT:?Set DOCENT_CLIENT as a repository variable}"
: "${DOCENT_ECR_REPOSITORY_URI:?Set DOCENT_ECR_REPOSITORY_URI as a repository variable}"
: "${BITBUCKET_BUILD_NUMBER:?Run this inside Bitbucket Pipelines}"
source "$(dirname "$0")/aws-oidc.sh"

BUNDLE=".deploy/$DOCENT_CLIENT"
if [ ! -f "$BUNDLE/contracts/$DOCENT_CLIENT/contract.json" ]; then
  echo "No bundle for $DOCENT_CLIENT at $BUNDLE. The ingest step must run first and pass its artifacts." >&2
  exit 1
fi

IMAGE="$DOCENT_ECR_REPOSITORY_URI:build-$BITBUCKET_BUILD_NUMBER"
REGISTRY="${DOCENT_ECR_REPOSITORY_URI%%/*}"

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker build \
  -f "$BUNDLE/deploy/aws-ec2/Dockerfile" \
  ${NPM_CONFIG_REGISTRY:+--build-arg NPM_CONFIG_REGISTRY="$NPM_CONFIG_REGISTRY"} \
  -t "$IMAGE" \
  "$BUNDLE"
docker push "$IMAGE"
echo "Pushed $IMAGE"
