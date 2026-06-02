#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-ap-south-1}"
SECRET_NAME="${APP_SECRET_NAME:-gmail-auto-reply/app}"

cd "$ROOT"

if ! command -v aws >/dev/null; then
  echo "Install AWS CLI and configure credentials (aws configure)"
  exit 1
fi

echo "Building secret payload from credentials.json, token.json, and .env ..."
PAYLOAD="$(node infra/build-secret-payload.js)"

if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "Updating secret: $SECRET_NAME"
  aws secretsmanager put-secret-value \
    --region "$REGION" \
    --secret-id "$SECRET_NAME" \
    --secret-string "$PAYLOAD"
else
  echo "Creating secret: $SECRET_NAME"
  aws secretsmanager create-secret \
    --region "$REGION" \
    --name "$SECRET_NAME" \
    --description "Gmail auto-reply OAuth + env" \
    --secret-string "$PAYLOAD"
fi

ARN="$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" --query ARN --output text)"
echo ""
echo "Secret ready."
echo "  Name: $SECRET_NAME"
echo "  ARN:  $ARN"
echo ""
echo "Export for deploy:"
echo "  export APP_SECRET_ARN=$ARN"
