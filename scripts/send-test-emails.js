/**
 * Sends Product Support Request–shaped test emails.
 *
 * Sends to samiksha.t@otomeyt.ai inbox (OAuth account must match).
 * Use npm run test:parse for local parsing/gate checks without Gmail.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { google } = require('googleapis');
const { authorize } = require('../src/auth');
const path = require('path');

const INBOX_TO = process.env.REPLY_FROM_EMAIL || 'samiksha.t@otomeyt.ai';

function supportRequestBody({
  name,
  email,
  phone,
  assessmentKey,
  subject,
  issue,
}) {
  return `Product Support Request

Candidate Full Name: ${name}
Candidate Email ID: ${email}
Candidate Phone: ${phone}
Candidate Assessment Key: ${assessmentKey}
Subject: ${subject}
Issue: ${issue}

Thank you for your attention.`;
}

const testEmailData = [
  {
    name: 'Start issue (should match keywords)',
    subject: 'HTqVmSp2eDeez1T6EN68-Problems faced during test',
    body: supportRequestBody({
      name: 'Purnima Singh',
      email: 'candidate.start.test@example.com',
      phone: '6307011129',
      assessmentKey: 'HTqVmSp2eDeez1T6EN68',
      subject: 'Problems faced during test',
      issue:
        "I am experiencing problem while giving the test. The test doesn't start. I've tried all the ways but it doesn't start.",
    }),
    shouldReply: true,
  },
  {
    name: 'Camera permission / start button',
    subject: 'KEY001-Test not starting',
    body: supportRequestBody({
      name: 'Test Candidate',
      email: 'candidate.camera@example.com',
      phone: '9999999999',
      assessmentKey: 'KEY001',
      subject: 'Test not starting',
      issue:
        'Unable to start the test. Camera permission issue — start button is still disabled after allowing access.',
    }),
    shouldReply: true,
  },
  {
    name: 'Mid-assessment (should NOT reply)',
    subject: 'KEY002-Section failed during test',
    body: supportRequestBody({
      name: 'Test Candidate Two',
      email: 'candidate.mid@example.com',
      phone: '8888888888',
      assessmentKey: 'KEY002',
      subject: 'Section failed during test',
      issue:
        'I was in the middle of taking the assessment when section 3 stopped working and I could not complete it.',
    }),
    shouldReply: false,
  },
  {
    name: 'Unrelated support subject',
    subject: 'KEY003-General inquiry',
    body: supportRequestBody({
      name: 'Test Candidate Three',
      email: 'candidate.general@example.com',
      phone: '7777777777',
      assessmentKey: 'KEY003',
      subject: 'General inquiry',
      issue: 'Please send me information about your pricing plans.',
    }),
    shouldReply: false,
  },
];

async function sendTestEmail(gmail, emailData, index) {
  const message = createMessage(INBOX_TO, emailData.subject, emailData.body);

  try {
    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: message },
    });

    console.log(`✓ [${index}] SENT: ${emailData.name}`);
    console.log(`   Expected auto-reply: ${emailData.shouldReply ? 'YES' : 'NO'}`);
    console.log(`   Message ID: ${result.data.id}\n`);
    return true;
  } catch (error) {
    console.error(`✗ [${index}] FAILED: ${emailData.name}`);
    console.error(`   Error: ${error.message}\n`);
    return false;
  }
}

function createMessage(to, subject, body) {
  const email = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`;
  return Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

async function main() {
  console.log('Gmail Auto-Reply — Product Support Request test sender\n');
  console.log('====================================\n');
  console.log(`To: ${INBOX_TO}`);
  console.log('OAuth must be signed in as the same inbox.\n');

  const credentialsPath = path.join(__dirname, '..', 'credentials.json');
  const tokenPath = path.join(__dirname, '..', 'token.json');

  const auth = await authorize(credentialsPath, tokenPath);
  const gmail = google.gmail({ version: 'v1', auth });

  let sent = 0;
  for (let i = 0; i < testEmailData.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await sendTestEmail(gmail, testEmailData[i], i + 1)) sent++;
  }

  console.log('====================================');
  console.log(`\nSummary: ${sent}/${testEmailData.length} emails sent`);
  console.log('Run: npm run test:parse  (local parse + keyword checks)');
  console.log('Run: npm run run-once   (single poll against inbox)');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
