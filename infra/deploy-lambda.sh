#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-ap-south-1}"
FUNCTION_NAME="${LAMBDA_FUNCTION_NAME:-gmail-auto-reply}"
ROLE_NAME="${LAMBDA_ROLE_NAME:-gmail-auto-reply-lambda-role}"
SECRET_NAME="${APP_SECRET_NAME:-gmail-auto-reply/app}"
AUDIT_TABLE_NAME="${AUDIT_TABLE_NAME:-gmail-auto-reply-audit}"
SCHEDULE="${POLL_SCHEDULE:-rate(5 minutes)}"
MEMORY="${LAMBDA_MEMORY:-512}"
TIMEOUT="${LAMBDA_TIMEOUT:-600}"

cd "$ROOT"

if ! command -v aws >/dev/null; then
  echo "AWS CLI required"
  exit 1
fi

if [[ -z "${APP_SECRET_ARN:-}" ]]; then
  APP_SECRET_ARN="$(aws secretsmanager describe-secret \
    --secret-id "$SECRET_NAME" \
    --region "$REGION" \
    --query ARN --output text 2>/dev/null || true)"
fi
if [[ -z "${APP_SECRET_ARN:-}" ]]; then
  echo "Run first: npm run aws:setup-secrets"
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

echo "=== DynamoDB audit table ==="
if aws dynamodb describe-table --table-name "$AUDIT_TABLE_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "Using existing table: $AUDIT_TABLE_NAME"
else
  aws dynamodb create-table \
    --region "$REGION" \
    --table-name "$AUDIT_TABLE_NAME" \
    --attribute-definitions \
      AttributeName=PK,AttributeType=S \
      AttributeName=SK,AttributeType=S \
      AttributeName=GSI1PK,AttributeType=S \
      AttributeName=GSI1SK,AttributeType=S \
    --key-schema \
      AttributeName=PK,KeyType=HASH \
      AttributeName=SK,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --global-secondary-indexes \
      "IndexName=GSI1,KeySchema=[{AttributeName=GSI1PK,KeyType=HASH},{AttributeName=GSI1SK,KeyType=RANGE}],Projection={ProjectionType=ALL}"
  aws dynamodb wait table-exists \
    --region "$REGION" \
    --table-name "$AUDIT_TABLE_NAME"
  echo "Created table: $AUDIT_TABLE_NAME"
fi

echo "=== Package Lambda ==="
BUILD_DIR="$ROOT/.lambda-build"
ZIP_FILE="$ROOT/function.zip"
rm -rf "$BUILD_DIR" "$ZIP_FILE"
mkdir -p "$BUILD_DIR"
cp -r src lambda templates package.json package-lock.json "$BUILD_DIR/"
(
  cd "$BUILD_DIR"
  npm ci --omit=dev --quiet
  zip -qr "$ZIP_FILE" . -x "*.git*"
)

echo "=== IAM role ==="
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST" \
    --description "Gmail auto-reply Lambda"
  sleep 5
fi

aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole \
  2>/dev/null || true

POLICY_DOC="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "${APP_SECRET_ARN}"
    },
    {
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:Query"],
      "Resource": [
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${AUDIT_TABLE_NAME}",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${AUDIT_TABLE_NAME}/index/*"
      ]
    }
  ]
}
EOF
)"
POLICY_NAME="${ROLE_NAME}-secrets"
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "$POLICY_DOC"

echo "Waiting for IAM role to propagate ..."
sleep 10

ENV_VARS="Variables={APP_SECRET_ARN=${APP_SECRET_ARN},AWS_NODEJS_CONNECTION_REUSE_ENABLED=1}"

echo "=== Lambda function ($REGION) ==="
if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code \
    --region "$REGION" \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$ZIP_FILE"
  aws lambda wait function-updated \
    --region "$REGION" \
    --function-name "$FUNCTION_NAME"
  aws lambda update-function-configuration \
    --region "$REGION" \
    --function-name "$FUNCTION_NAME" \
    --handler "lambda/handler.handler" \
    --runtime nodejs20.x \
    --role "$ROLE_ARN" \
    --timeout "$TIMEOUT" \
    --memory-size "$MEMORY" \
    --environment "$ENV_VARS"
else
  aws lambda create-function \
    --region "$REGION" \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs20.x \
    --role "$ROLE_ARN" \
    --handler "lambda/handler.handler" \
    --timeout "$TIMEOUT" \
    --memory-size "$MEMORY" \
    --zip-file "fileb://$ZIP_FILE" \
    --environment "$ENV_VARS" \
    --description "Gmail auto-reply poll (Otomeyt PSR)"
fi

aws lambda wait function-active \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME"

if ! aws lambda put-function-concurrency \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --reserved-concurrent-executions 1; then
  echo "WARN: could not set reserved concurrency=1 (account limit). Continuing."
fi

RULE_NAME="${FUNCTION_NAME}-schedule"
echo "=== EventBridge schedule: $SCHEDULE ==="
aws events put-rule \
  --region "$REGION" \
  --name "$RULE_NAME" \
  --schedule-expression "$SCHEDULE" \
  --state ENABLED \
  --description "Poll Samiksha Gmail inbox"

LAMBDA_ARN="$(aws lambda get-function \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --query 'Configuration.FunctionArn' --output text)"

aws events put-targets \
  --region "$REGION" \
  --rule "$RULE_NAME" \
  --targets "Id"="1","Arn"="$LAMBDA_ARN"

aws lambda add-permission \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --statement-id "${RULE_NAME}-invoke" \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${RULE_NAME}" \
  2>/dev/null || true

echo ""
echo "Deploy complete."
echo "  Region:   $REGION"
echo "  Function: $FUNCTION_NAME"
echo "  Schedule: $SCHEDULE"
echo "  Secret:   $APP_SECRET_ARN"
echo "  Dry run:  check secret env DRY_RUN (use npm run aws:setup-secrets after .env change)"
echo ""
echo "Test: npm run aws:invoke"
echo "Logs: aws logs tail /aws/lambda/${FUNCTION_NAME} --region ${REGION} --follow"
