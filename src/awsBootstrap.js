const fs = require('fs');
const path = require('path');
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');
const logger = require('./logger');

const TMP_CREDENTIALS = '/tmp/credentials.json';
const TMP_TOKEN = '/tmp/token.json';

function parseSecretPayload(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Some secrets were saved with an accidental prefix banner line.
    const start = raw.indexOf('{"credentials"');
    if (start >= 0) return JSON.parse(raw.slice(start));
    const firstBrace = raw.indexOf('{');
    if (firstBrace >= 0) return JSON.parse(raw.slice(firstBrace));
    throw new Error('SecretString is not valid JSON');
  }
}

/**
 * On Lambda: load credentials, token, and env from Secrets Manager into /tmp + process.env.
 */
async function bootstrapFromSecrets() {
  const secretId = process.env.APP_SECRET_ARN || process.env.APP_SECRET_NAME;
  if (!secretId) {
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
      throw new Error('APP_SECRET_ARN or APP_SECRET_NAME is required on Lambda');
    }
    return { bootstrapped: false };
  }

  const client = new SecretsManagerClient({});
  const res = await client.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const payload = parseSecretPayload(res.SecretString || '{}');

  if (payload.credentials) {
    fs.writeFileSync(TMP_CREDENTIALS, JSON.stringify(payload.credentials, null, 2));
    process.env.GOOGLE_CREDENTIALS_PATH = TMP_CREDENTIALS;
  }
  if (payload.token) {
    fs.writeFileSync(TMP_TOKEN, JSON.stringify(payload.token, null, 2));
    process.env.GOOGLE_TOKEN_PATH = TMP_TOKEN;
  }
  if (payload.env && typeof payload.env === 'object') {
    for (const [key, value] of Object.entries(payload.env)) {
      if (value !== undefined && value !== null) {
        process.env[key] = String(value);
      }
    }
  }

  logger.info('Loaded app configuration from Secrets Manager', {
    secretId,
    hasCredentials: Boolean(payload.credentials),
    hasToken: Boolean(payload.token),
    dryRun: process.env.DRY_RUN,
  });

  return { bootstrapped: true };
}

function googlePaths() {
  const root = path.join(__dirname, '..');
  return {
    credentialsPath:
      process.env.GOOGLE_CREDENTIALS_PATH ||
      path.join(root, 'credentials.json'),
    tokenPath: process.env.GOOGLE_TOKEN_PATH || path.join(root, 'token.json'),
  };
}

module.exports = { bootstrapFromSecrets, googlePaths, TMP_CREDENTIALS, TMP_TOKEN };
