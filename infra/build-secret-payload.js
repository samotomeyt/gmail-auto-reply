#!/usr/bin/env node
/**
 * Build Secrets Manager JSON from local credentials.json, token.json, and .env
 * Usage: node infra/build-secret-payload.js > /tmp/secret-payload.json
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
require('dotenv').config({
  path: path.join(root, '.env'),
  override: true,
  quiet: true,
});

const credentialsPath = path.join(root, 'credentials.json');
const tokenPath = path.join(root, 'token.json');

if (!fs.existsSync(credentialsPath)) {
  console.error('Missing credentials.json');
  process.exit(1);
}
if (!fs.existsSync(tokenPath)) {
  console.error('Missing token.json — run OAuth locally first (npm start)');
  process.exit(1);
}

const payload = {
  credentials: JSON.parse(fs.readFileSync(credentialsPath, 'utf8')),
  token: JSON.parse(fs.readFileSync(tokenPath, 'utf8')),
  env: {
    GMAIL_QUERY: process.env.GMAIL_QUERY || 'in:inbox',
    REPLY_FROM_EMAIL: process.env.REPLY_FROM_EMAIL || 'samiksha.t@otomeyt.ai',
    REPLY_FROM_NAME: process.env.REPLY_FROM_NAME || 'Samiksha',
    REPLY_CC: process.env.REPLY_CC || '',
    PROCESSED_LABEL: process.env.PROCESSED_LABEL || 'Auto-Replied',
    DRY_RUN: process.env.DRY_RUN !== 'false' ? 'true' : 'false',
    POLL_INTERVAL_MS: process.env.POLL_INTERVAL_MS || '300000',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    MONITOR_WEBHOOK_URL: process.env.MONITOR_WEBHOOK_URL || '',
    AUDIT_ENABLED: process.env.AUDIT_ENABLED !== 'false' ? 'true' : 'false',
    AUDIT_TABLE_NAME: process.env.AUDIT_TABLE_NAME || 'gmail-auto-reply-audit',
  },
};

process.stdout.write(JSON.stringify(payload));
