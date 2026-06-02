const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

let docClient = null;

function getDocClient() {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({}),
      {
        marshallOptions: { removeUndefinedValues: true },
      },
    );
  }
  return docClient;
}

function isoNow() {
  return new Date().toISOString();
}

function buildKeys({ messageId, stage, timestamp }) {
  return {
    PK: `MSG#${messageId || 'unknown'}`,
    SK: `EVT#${timestamp}#${stage}`,
  };
}

function buildRunKeys(runId, timestamp, messageId) {
  return {
    GSI1PK: `RUN#${runId || 'unknown'}`,
    GSI1SK: `${timestamp}#${messageId || 'unknown'}`,
  };
}

async function writeAuditEvent(config, event) {
  if (!config?.auditEnabled || !config?.auditTableName) return false;

  const timestamp = event.timestamp || isoNow();
  const messageId = event.messageId || 'unknown';
  const runId = event.runId || 'unknown';
  const stage = event.stage || 'unknown';
  const keys = buildKeys({ messageId, stage, timestamp });
  const runKeys = buildRunKeys(runId, timestamp, messageId);

  const item = {
    ...keys,
    ...runKeys,
    eventType: 'email_audit',
    stage,
    status: event.status || 'info',
    timestamp,
    runId,
    functionName: event.functionName,
    requestId: event.requestId,
    messageId,
    threadId: event.threadId,
    candidateEmail: event.candidateEmail,
    subject: event.subject,
    issuePreview: event.issuePreview,
    assessmentKey: event.assessmentKey,
    replyTo: event.replyTo,
    fromEmail: event.fromEmail,
    replySubject: event.replySubject,
    dryRun: event.dryRun,
    replyHtml: event.replyHtml,
    errorMessage: event.errorMessage,
    errorStackSnippet: event.errorStackSnippet,
    failureStage: event.failureStage,
    details: event.details,
    // Optional TTL in epoch seconds if configured.
    ttl: Number.isInteger(event.ttl) ? event.ttl : undefined,
  };

  await getDocClient().send(
    new PutCommand({
      TableName: config.auditTableName,
      Item: item,
    }),
  );

  return true;
}

module.exports = { writeAuditEvent };
