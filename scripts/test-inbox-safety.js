#!/usr/bin/env node
/**
 * Pre-OAuth safety test: simulates a busy inbox (many email types).
 * No Gmail API, no OpenAI API — uses a mock for the final YES/NO gate.
 */

const assert = require('assert');
const { loadConfig } = require('../src/config');
const { evaluateInboundMessage } = require('../src/messageEvaluation');
const { buildSearchQuery } = require('../src/pollQuery');
const { hasKeywordHint } = require('../src/issueGate');
const { parseSupportRequest } = require('../src/supportRequest');
const { matchesSupportSubject } = require('../src/subjectFilter');

const LABEL_ID = 'Label_auto_replied';
const processedThreadIds = new Set();

function supportBody({ issue, subject = 'Test subject', email = 'candidate@example.com', name = 'Test User' }) {
  return `Product Support Request

Candidate Full Name: ${name}
Candidate Email ID: ${email}
Candidate Phone: 9999999999
Candidate Assessment Key: KEY123
Subject: ${subject}
Issue: ${issue}

Thank you for your attention.`;
}

function msg(overrides) {
  return {
    messageId: overrides.messageId || 'msg-1',
    threadId: overrides.threadId || 'thread-1',
    subject: overrides.subject || '1EJWfNXPPbp5ByG3lSuc-assesment',
    from: overrides.from || 'notifications@company.com',
    to: 'samiksha.t@otomeyt.ai',
    cc: '',
    body: overrides.body || '',
    labelIds: overrides.labelIds || ['INBOX', 'UNREAD'],
    messageIdHeader: '<test@id>',
    references: '',
    ...overrides,
  };
}

/** Mock OpenAI gate: YES only when issue text clearly has start blocker */
async function mockShouldAutoReply(subject, body, from, config) {
  const { hasKeywordHint: hint } = require('../src/issueGate');
  if (!hint(subject, body)) {
    return { reply: false, reason: 'mock: no keyword hint' };
  }
  return { reply: true, reason: 'mock: keyword hint + confirmed' };
}

async function expectSkip(name, message, reasonIncludes) {
  const config = loadConfig();
  const result = await evaluateInboundMessage(message, config, LABEL_ID, processedThreadIds, {
    shouldAutoReply: mockShouldAutoReply,
  });
  assert.strictEqual(result.action, 'skip', `${name}: expected skip got ${result.action}`);
  if (reasonIncludes) {
    assert.ok(
      result.reason.toLowerCase().includes(reasonIncludes.toLowerCase()),
      `${name}: reason "${result.reason}" should include "${reasonIncludes}"`,
    );
  }
  console.log(`PASS: SKIP — ${name} (${result.reason})`);
}

async function expectSkipSubject(name, subject) {
  const config = loadConfig();
  const result = await evaluateInboundMessage(
    msg({ subject, body: 'not psr' }),
    config,
    LABEL_ID,
    new Set(),
    { shouldAutoReply: mockShouldAutoReply },
  );
  assert.strictEqual(result.action, 'skip');
  assert.ok(result.reason.includes('assessment key pattern'));
  console.log(`PASS: SKIP — ${name} (subject filter)`);
}

async function expectReply(name, message) {
  const config = loadConfig();
  const result = await evaluateInboundMessage(message, config, LABEL_ID, processedThreadIds, {
    shouldAutoReply: mockShouldAutoReply,
  });
  assert.strictEqual(result.action, 'reply', `${name}: expected reply got ${result.action}`);
  assert.ok(result.supportRequest?.candidateEmail, `${name}: missing candidate email`);
  console.log(`PASS: REPLY — ${name} → ${result.supportRequest.candidateEmail}`);
}

async function run() {
  console.log('=== Pre-OAuth inbox safety test ===\n');
  const config = loadConfig();

  // Config / query safety
  const query = buildSearchQuery({
    baseQuery: config.gmailQuery,
    processedLabel: config.processedLabel,
  });
  assert.ok(query.includes('is:unread'), 'query limits to unread');
  assert.ok(query.includes('-label:Auto-Replied'), 'query excludes processed');
  assert.ok(!query.includes('hello@otomeyt'), 'no hello filter in query');
  assert.ok(!query.includes('candidatesupport'), 'no candidatesupport in query');
  console.log('PASS: Gmail query is unread + unlabeled only');
  console.log(`       Query: ${query}\n`);

  // Without OpenAI key, real shouldAutoReply never approves (extra safety)
  const noKeyConfig = { ...config, openaiApiKey: '' };
  const startBody = supportBody({
    issue: "The test doesn't start. Start button is disabled.",
    subject: 'Cannot start test',
  });
  const realGate = await evaluateInboundMessage(
    msg({ body: startBody, subject: '1EJWfNXPPbp5ByG3lSuc-Cannot start test' }),
    noKeyConfig,
    LABEL_ID,
    new Set(),
  );
  assert.strictEqual(realGate.action, 'skip');
  assert.ok(realGate.reason.includes('openai'), 'no API key blocks send');
  console.log('PASS: Without OPENAI_API_KEY, even valid PSR will not reply\n');

  console.log('--- Subject filter (should SKIP before body) ---\n');

  await expectSkipSubject('Plain subject', 'test not starting');
  await expectSkipSubject('Meeting', 'Team meeting tomorrow');

  console.log('\n--- Typical non-support mail (should SKIP) ---\n');

  await expectSkip(
    'Team meeting invite',
    msg({
      subject: '1EJWfNXPPbp5ByG3lSuc-assesment',
      body: 'Hi Samiksha,\nCan we meet tomorrow at 3pm to discuss the roadmap?',
    }),
    'Product Support Request',
  );

  await expectSkip(
    'Newsletter / marketing',
    msg({
      subject: 'Weekly digest',
      body: 'Top stories this week...\nUnsubscribe here.',
    }),
    'assessment key pattern',
  );

  await expectSkip(
    'HR / payroll (not PSR format)',
    msg({
      from: 'hr@company.com',
      subject: 'Payslip for May',
      body: 'Please find your payslip attached.',
    }),
    'assessment key pattern',
  );

  await expectSkip(
    'Client reply in normal thread',
    msg({
      from: 'client@external.com',
      subject: 'Re: Project update',
      body: 'Thanks for the update. Looks good to proceed.',
    }),
    'assessment key pattern',
  );

  await expectSkip(
    'Calendar invite text',
    msg({
      subject: 'Invitation: Standup',
      body: 'You have been invited to a Google Meet event.',
    }),
    'assessment key pattern',
  );

  console.log('\n--- Product Support Request but NOT start issue (should SKIP) ---\n');

  await expectSkip(
    'Mid-assessment section failure',
    msg({
      body: supportBody({
        subject: 'Section failed',
        issue: 'I was in the middle of taking the assessment when section 3 stopped working.',
      }),
    }),
    'mock',
  );

  await expectSkip(
    'Reattempt request',
    msg({
      body: supportBody({
        subject: 'Need reattempt',
        issue: 'I already submitted the assessment but need a reattempt for section 2.',
      }),
    }),
    'mock',
  );

  await expectSkip(
    'General pricing question (PSR format)',
    msg({
      body: supportBody({
        subject: 'Pricing',
        issue: 'Please send information about your enterprise pricing plans.',
      }),
    }),
    'mock',
  );

  await expectSkip(
    'Vague technical issue (no start symptom)',
    msg({
      body: supportBody({
        subject: 'Technical issue',
        issue: 'The platform UI looks broken on my laptop. Please advise.',
      }),
    }),
    'mock',
  );

  console.log('\n--- Already handled / duplicate (should SKIP) ---\n');

  await expectSkip(
    'Already has Auto-Replied label',
    msg({
      body: startBody,
      labelIds: ['INBOX', LABEL_ID],
    }),
    'already labeled',
  );

  processedThreadIds.add('thread-dup');
  await expectSkip(
    'Same thread twice in one poll',
    msg({ threadId: 'thread-dup', body: startBody }),
    'thread already processed',
  );
  processedThreadIds.delete('thread-dup');

  await expectSkip(
    'PSR missing candidate email',
    msg({
      body: `Product Support Request
Candidate Full Name: X
Subject: Test
Issue: The test doesn't start.

Thank you for your attention.`,
    }),
    'missing Candidate Email ID',
  );

  console.log('\n--- Should REPLY (assessment start issue) ---\n');

  await expectReply(
    'Test does not start (screenshot sample)',
    msg({
      subject: 'HTqVmSp2eDeez1T6EN68-Problems faced during test',
      body: supportBody({
        name: 'Purnima Singh',
        email: 'singhpurnima123568@gmail.com',
        subject: 'Problems faced during test',
        issue:
          "I am experiencing problem while giving the test. The test doesn't start. I've tried all the ways but it doesn't start.",
      }),
    }),
  );

  await expectReply(
    'Camera permission / start button',
    msg({
      body: supportBody({
        subject: 'Test not starting',
        issue:
          'Unable to start the test. Camera permission issue — start button is still disabled.',
      }),
    }),
  );

  await expectReply(
    'Cannot click start',
    msg({
      body: supportBody({
        subject: 'Start button',
        issue: 'I cannot start the assessment. The start button is not working.',
      }),
    }),
  );

  assert.strictEqual(hasKeywordHint('Pricing', 'Please send enterprise pricing plans.'), false);
  const parsed = parseSupportRequest(
    supportBody({ issue: "The test doesn't start. Start button disabled." }),
  );
  const classified = `${parsed.issueSubject}\n${parsed.issue}`;
  assert.strictEqual(hasKeywordHint(parsed.issueSubject, classified), true);
  console.log('\nPASS: Keyword gate matches start-issue PSR, rejects unrelated text\n');

  console.log('=== All inbox safety checks passed ===');
  console.log('\nNotes before OAuth:');
  console.log('• Poll only touches UNREAD mail in inbox (read mail is ignored).');
  console.log('• Non–Product Support Request emails are skipped immediately.');
  console.log('• Start-issue emails still need OPENAI_API_KEY for final YES (you have this in .env).');
  console.log('• Set DRY_RUN=true for first live run to log without sending.');
  console.log('• Delete token.json and sign in as samiksha.t@otomeyt.ai only.\n');
}

run().catch((err) => {
  console.error('\nFAIL:', err.message);
  process.exit(1);
});
