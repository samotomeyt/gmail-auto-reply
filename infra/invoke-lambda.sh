#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
FUNCTION_NAME="${LAMBDA_FUNCTION_NAME:-gmail-auto-reply}"
OUT="/tmp/gmail-auto-reply-lambda-out.json"

echo "Invoking $FUNCTION_NAME in $REGION ..."
aws lambda invoke \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --log-type Tail \
  --output json \
  "$OUT" > /tmp/gmail-auto-reply-invoke-meta.json

echo "Response:"
cat "$OUT"
echo ""
echo "Recent logs:"
aws logs tail "/aws/lambda/${FUNCTION_NAME}" --region "$REGION" --since 5m 2>/dev/null | tail -40 || echo "(log group may appear after first run)"
