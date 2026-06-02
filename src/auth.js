const fs = require('fs');
const http = require('http');
const { google } = require('googleapis');
const logger = require('./logger');

function waitForAuthCode(port = 80) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`Authorization failed: ${error}`);
        server.close();
        reject(new Error(error));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization successful</h1><p>You can close this tab and return to the terminal.</p>');
        server.close();
        resolve(code);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    });

    server.on('error', reject);
    server.listen(port, () => {
      logger.info(`Waiting for OAuth callback on http://localhost:${port}`);
    });
  });
}

async function promptForAuthCode() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Enter the authorization code: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
];

async function authorize(credentialsPath, tokenPath) {
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(tokenPath)) {
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  let code = process.env.GOOGLE_AUTH_CODE?.trim();
  if (!code) {
    logger.info('Open this URL in your browser to authorize:');
    console.log(authUrl);

    try {
      code = await waitForAuthCode(80);
      logger.info('Authorization code received from browser redirect');
    } catch {
      logger.info('Could not start callback server on port 80. Paste the code from the redirect URL.');
      code = await promptForAuthCode();
    }
  }

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  logger.info('Token saved to', tokenPath);

  return oAuth2Client;
}

module.exports = { authorize, SCOPES };
