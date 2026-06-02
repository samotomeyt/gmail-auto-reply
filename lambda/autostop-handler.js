'use strict';

const AWS = require('aws-sdk');

function parseSecretPayload(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{"credentials"');
    if (start >= 0) return JSON.parse(raw.slice(start));
    const firstBrace = raw.indexOf('{');
    if (firstBrace >= 0) return JSON.parse(raw.slice(firstBrace));
    throw new Error('SecretString is not valid JSON');
  }
}

function shouldForceDryRun() {
  const value = `${process.env.FORCE_DRY_RUN_TRUE || ''}`.toLowerCase().trim();
  return value === '1' || value === 'true' || value === 'yes';
}

async function setDryRunTrue(secrets, secretId) {
  const current = await secrets.getSecretValue({ SecretId: secretId }).promise();
  const payload = parseSecretPayload(current.SecretString || '{}');
  payload.env = payload.env || {};
  payload.env.DRY_RUN = 'true';

  await secrets
    .putSecretValue({
      SecretId: secretId,
      SecretString: JSON.stringify(payload),
    })
    .promise();
}

function parseAlarmEvent(event) {
  const snsRecord = event?.Records?.[0];
  if (!snsRecord || snsRecord.EventSource !== 'aws:sns') {
    return { source: 'unknown', raw: event };
  }
  const msg = snsRecord.Sns?.Message || '';
  try {
    return {
      source: 'sns',
      parsedMessage: JSON.parse(msg),
      rawMessage: msg,
      topicArn: snsRecord.Sns?.TopicArn,
    };
  } catch {
    return {
      source: 'sns',
      parsedMessage: null,
      rawMessage: msg,
      topicArn: snsRecord.Sns?.TopicArn,
    };
  }
}

exports.handler = async (event) => {
  const region = process.env.TARGET_RULE_REGION || process.env.AWS_REGION;
  const ruleName = process.env.TARGET_RULE_NAME;
  const secretArn = process.env.APP_SECRET_ARN || '';

  if (!ruleName) {
    throw new Error('TARGET_RULE_NAME is required');
  }

  const events = new AWS.EventBridge({ region });
  const secrets = new AWS.SecretsManager({ region });

  const alarm = parseAlarmEvent(event);
  const summary = {
    at: new Date().toISOString(),
    region,
    ruleName,
    dryRunForced: false,
    ruleDisabled: false,
    alarmSource: alarm.source,
    alarmName: alarm.parsedMessage?.AlarmName,
    alarmReason: alarm.parsedMessage?.NewStateReason,
  };

  await events.disableRule({ Name: ruleName }).promise();
  summary.ruleDisabled = true;

  if (shouldForceDryRun() && secretArn) {
    await setDryRunTrue(secrets, secretArn);
    summary.dryRunForced = true;
  }

  console.log('[AUTOSTOP] Incident guardrail executed', summary);
  return summary;
};
