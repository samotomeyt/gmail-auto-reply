#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-ap-south-1}"
MAIN_FUNCTION_NAME="${LAMBDA_FUNCTION_NAME:-gmail-auto-reply}"
RULE_NAME="${EVENT_RULE_NAME:-${MAIN_FUNCTION_NAME}-schedule}"
SECRET_NAME="${APP_SECRET_NAME:-gmail-auto-reply/app}"
AUTOSTOP_FUNCTION_NAME="${AUTOSTOP_FUNCTION_NAME:-gmail-auto-reply-autostop}"
AUTOSTOP_ROLE_NAME="${AUTOSTOP_ROLE_NAME:-gmail-auto-reply-autostop-role}"
SNS_TOPIC_NAME="${AUTOSTOP_SNS_TOPIC_NAME:-gmail-auto-reply-incident-topic}"
ERROR_ALARM_NAME="${AUTOSTOP_ERROR_ALARM_NAME:-gmail-auto-reply-errors-autostop}"
SEND_FAIL_ALARM_NAME="${AUTOSTOP_SEND_FAIL_ALARM_NAME:-gmail-auto-reply-send-fail-autostop}"
FINALIZE_FAIL_ALARM_NAME="${AUTOSTOP_FINALIZE_FAIL_ALARM_NAME:-gmail-auto-reply-finalize-fail-autostop}"
FORCE_DRY_RUN_TRUE="${FORCE_DRY_RUN_TRUE:-true}"

cd "$ROOT"

if ! command -v aws >/dev/null; then
  echo "AWS CLI required"
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

SECRET_ARN="${APP_SECRET_ARN:-}"
if [[ -z "$SECRET_ARN" ]]; then
  SECRET_ARN="$(aws secretsmanager describe-secret \
    --secret-id "$SECRET_NAME" \
    --region "$REGION" \
    --query ARN --output text 2>/dev/null || true)"
fi

if [[ -z "$SECRET_ARN" ]]; then
  echo "WARN: Could not resolve APP_SECRET_ARN. Auto-stop will disable rule only."
fi

echo "=== Package auto-stop Lambda ==="
ZIP_FILE="$ROOT/autostop-function.zip"
rm -f "$ZIP_FILE"
(
  cd "$ROOT"
  zip -q "$ZIP_FILE" "lambda/autostop-handler.js"
)

echo "=== IAM role for auto-stop ==="
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name "$AUTOSTOP_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role \
    --role-name "$AUTOSTOP_ROLE_NAME" \
    --assume-role-policy-document "$TRUST" \
    --description "Auto-stop gmail-auto-reply on alarm"
  sleep 5
fi

aws iam attach-role-policy \
  --role-name "$AUTOSTOP_ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole \
  >/dev/null 2>&1 || true

RULE_ARN="arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${RULE_NAME}"
ROLE_POLICY="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["events:DisableRule", "events:DescribeRule"],
      "Resource": "${RULE_ARN}"
    }
  ]
}
EOF
)"

if [[ -n "$SECRET_ARN" ]]; then
  ROLE_POLICY="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["events:DisableRule", "events:DescribeRule"],
      "Resource": "${RULE_ARN}"
    },
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
      "Resource": "${SECRET_ARN}"
    }
  ]
}
EOF
)"
fi

aws iam put-role-policy \
  --role-name "$AUTOSTOP_ROLE_NAME" \
  --policy-name "${AUTOSTOP_ROLE_NAME}-inline" \
  --policy-document "$ROLE_POLICY"

echo "Waiting for IAM propagation ..."
sleep 10

AUTOSTOP_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${AUTOSTOP_ROLE_NAME}"
ENV_VARS="Variables={TARGET_RULE_NAME=${RULE_NAME},TARGET_RULE_REGION=${REGION},FORCE_DRY_RUN_TRUE=${FORCE_DRY_RUN_TRUE}"
if [[ -n "$SECRET_ARN" ]]; then
  ENV_VARS="${ENV_VARS},APP_SECRET_ARN=${SECRET_ARN}"
fi
ENV_VARS="${ENV_VARS}}"

echo "=== Deploy auto-stop Lambda ==="
if aws lambda get-function --function-name "$AUTOSTOP_FUNCTION_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code \
    --region "$REGION" \
    --function-name "$AUTOSTOP_FUNCTION_NAME" \
    --zip-file "fileb://$ZIP_FILE"
  aws lambda wait function-updated \
    --region "$REGION" \
    --function-name "$AUTOSTOP_FUNCTION_NAME"
  aws lambda update-function-configuration \
    --region "$REGION" \
    --function-name "$AUTOSTOP_FUNCTION_NAME" \
    --handler "lambda/autostop-handler.handler" \
    --runtime nodejs20.x \
    --role "$AUTOSTOP_ROLE_ARN" \
    --timeout 30 \
    --memory-size 128 \
    --environment "$ENV_VARS"
else
  aws lambda create-function \
    --region "$REGION" \
    --function-name "$AUTOSTOP_FUNCTION_NAME" \
    --runtime nodejs20.x \
    --role "$AUTOSTOP_ROLE_ARN" \
    --handler "lambda/autostop-handler.handler" \
    --timeout 30 \
    --memory-size 128 \
    --zip-file "fileb://$ZIP_FILE" \
    --environment "$ENV_VARS" \
    --description "Auto-stop gmail-auto-reply when alarms fire"
fi

aws lambda wait function-active \
  --region "$REGION" \
  --function-name "$AUTOSTOP_FUNCTION_NAME"

echo "=== SNS topic + subscription ==="
TOPIC_ARN="$(aws sns create-topic --name "$SNS_TOPIC_NAME" --region "$REGION" --query TopicArn --output text)"
AUTOSTOP_ARN="$(aws lambda get-function --region "$REGION" --function-name "$AUTOSTOP_FUNCTION_NAME" --query 'Configuration.FunctionArn' --output text)"

aws sns subscribe \
  --region "$REGION" \
  --topic-arn "$TOPIC_ARN" \
  --protocol lambda \
  --notification-endpoint "$AUTOSTOP_ARN" >/dev/null 2>&1 || true

aws lambda add-permission \
  --region "$REGION" \
  --function-name "$AUTOSTOP_FUNCTION_NAME" \
  --statement-id "${SNS_TOPIC_NAME}-invoke" \
  --action lambda:InvokeFunction \
  --principal sns.amazonaws.com \
  --source-arn "$TOPIC_ARN" >/dev/null 2>&1 || true

echo "=== Log metric filters (send/finalize failures) ==="
LOG_GROUP="/aws/lambda/${MAIN_FUNCTION_NAME}"
aws logs put-metric-filter \
  --region "$REGION" \
  --log-group-name "$LOG_GROUP" \
  --filter-name "gmail-auto-reply-send-failed" \
  --filter-pattern "\"Gmail send failed\"" \
  --metric-transformations metricName=SendFailedCount,metricNamespace=GmailAutoReply,metricValue=1 >/dev/null

aws logs put-metric-filter \
  --region "$REGION" \
  --log-group-name "$LOG_GROUP" \
  --filter-name "gmail-auto-reply-finalize-failed" \
  --filter-pattern "\"Reply sent but label/mark-read failed\"" \
  --metric-transformations metricName=FinalizeFailedCount,metricNamespace=GmailAutoReply,metricValue=1 >/dev/null

echo "=== CloudWatch alarms => SNS => auto-stop ==="
aws cloudwatch put-metric-alarm \
  --region "$REGION" \
  --alarm-name "$ERROR_ALARM_NAME" \
  --alarm-description "Auto-stop on Lambda errors for ${MAIN_FUNCTION_NAME}" \
  --metric-name Errors \
  --namespace AWS/Lambda \
  --statistic Sum \
  --period 60 \
  --evaluation-periods 2 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --dimensions Name=FunctionName,Value="$MAIN_FUNCTION_NAME" \
  --alarm-actions "$TOPIC_ARN"

aws cloudwatch put-metric-alarm \
  --region "$REGION" \
  --alarm-name "$SEND_FAIL_ALARM_NAME" \
  --alarm-description "Auto-stop on send failures for ${MAIN_FUNCTION_NAME}" \
  --metric-name SendFailedCount \
  --namespace GmailAutoReply \
  --statistic Sum \
  --period 60 \
  --evaluation-periods 1 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC_ARN"

aws cloudwatch put-metric-alarm \
  --region "$REGION" \
  --alarm-name "$FINALIZE_FAIL_ALARM_NAME" \
  --alarm-description "Auto-stop on finalize failures for ${MAIN_FUNCTION_NAME}" \
  --metric-name FinalizeFailedCount \
  --namespace GmailAutoReply \
  --statistic Sum \
  --period 60 \
  --evaluation-periods 1 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC_ARN"

echo ""
echo "Auto-stop deployed."
echo "  Main function:      $MAIN_FUNCTION_NAME"
echo "  Rule to disable:    $RULE_NAME"
echo "  Auto-stop function: $AUTOSTOP_FUNCTION_NAME"
echo "  SNS topic:          $TOPIC_ARN"
echo "  Alarms:"
echo "    - $ERROR_ALARM_NAME"
echo "    - $SEND_FAIL_ALARM_NAME"
echo "    - $FINALIZE_FAIL_ALARM_NAME"
echo "  Force DRY_RUN=true on incident: $FORCE_DRY_RUN_TRUE"
