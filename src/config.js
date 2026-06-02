require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env'),
  override: true,
});

const { googlePaths } = require('./awsBootstrap');

const REQUIRED = ['GMAIL_QUERY', 'PROCESSED_LABEL'];

function loadConfig() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }

  const dryRun = process.env.DRY_RUN !== 'false';
  const pollIntervalMs = parseInt(
    process.env.POLL_INTERVAL_MS || (process.env.AWS_LAMBDA_FUNCTION_NAME ? '300000' : ''),
    10,
  );
  if (Number.isNaN(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error('POLL_INTERVAL_MS must be a number >= 1000');
  }

  const replyFromEmail = process.env.REPLY_FROM_EMAIL || 'samiksha.t@otomeyt.ai';
  const replyFromName = process.env.REPLY_FROM_NAME || '';
  const replyCc = process.env.REPLY_CC || '';
  const paths = googlePaths();

  return {
    gmailQuery: process.env.GMAIL_QUERY,
    processedLabel: process.env.PROCESSED_LABEL,
    dryRun,
    pollIntervalMs,
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    auditEnabled: process.env.AUDIT_ENABLED !== 'false',
    auditTableName: process.env.AUDIT_TABLE_NAME || '',
    replyFromEmail,
    replyFromName,
    replyCc,
    credentialsPath: paths.credentialsPath,
    tokenPath: paths.tokenPath,
  };
}

module.exports = { loadConfig };
