#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const code = process.argv[2] || process.env.GOOGLE_AUTH_CODE;
if (!code) {
  console.error('Usage: node scripts/exchange-token.js <authorization_code>');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const credentials = JSON.parse(fs.readFileSync(path.join(root, 'credentials.json'), 'utf8'));
const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

oAuth2Client.getToken(code.trim()).then(({ tokens }) => {
  fs.writeFileSync(path.join(root, 'token.json'), JSON.stringify(tokens, null, 2));
  console.log('token.json saved');
}).catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
