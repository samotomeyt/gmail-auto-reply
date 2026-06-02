#!/usr/bin/env node
/**
 * Local smoke test for Product Support Request parsing and keyword gate.
 * No Gmail or OpenAI required.
 */

const {
  parseSupportRequest,
  classificationText,
} = require('../src/supportRequest');
const { hasKeywordHint } = require('../src/issueGate');

const SAMPLE_BODY = `Product Support Request

Candidate Full Name: Purnima Singh
Candidate Email ID: singhpurnima123568@gmail.com
Candidate Phone: 6307011129
Candidate Assessment Key: HTqVmSp2eDeez1T6EN68
Subject: Problems faced during test
Issue: I am experiencing problem while giving the test. The test doesn't start. I've tried all the ways but it doesn't start.

Thank you for your attention.`;

const ANEESH_BODY = `Product Support Request
Candidate Full Name: aneesh kumar

Candidate Email ID: aneeshror93@gmail.com

Candidate Phone: 9690612354

Candidate Assessment Key: 1EJWfNXPPbp5ByG3lSuc

Subject: assesment

Issue:

not able to start the test

Thank you for your attention.`;

const CAMERA_BODY = `Product Support Request

Candidate Full Name: Test User
Candidate Email ID: test@example.com
Candidate Phone: 1111111111
Candidate Assessment Key: KEY99
Subject: assesment
Issue:

camera not allowed

Thank you for your attention.`;

const BUTTON_BODY = `Product Support Request

Candidate Full Name: Test User
Candidate Email ID: test2@example.com
Candidate Phone: 2222222222
Candidate Assessment Key: KEY88
Subject: test issue
Issue:

start button not working

Thank you for your attention.`;

const MARKDOWN_BODY = `Product Support Request

*Candidate Full Name:* sam

*Candidate Email ID:* tudayekar05@gmail.com

*Candidate Phone:*

*Candidate Assessment Key:* ld8fUmrNShVLRdYUukYv

*Subject:* not start

*Issue:*

Facing issue, can't start the test`;

const EMPTY_EMAIL_BODY = `Product Support Request

*Candidate Full Name:* Harshada manoj gavande

*Candidate Email ID:*

*Candidate Phone:* 7385389497

*Candidate Assessment Key:* F3SZ4h6guOrj0Dw41Esp

*Subject:* Biotechnology

*Issue:*

test not starting`;

const INDENTED_HTML_TEXT_BODY = `body {
            font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
        }

            Product Support Request

            Candidate Full Name: Samiksha Sunil Tudayekar

            Candidate Email ID: samiksha.t@otomeyt.ai

            Candidate Phone: 01234567890

            Candidate Assessment Key: tTNyvPwtRDdfk8x7SA5t

            Subject: assessment not start

            Issue:

            not able to start assessment

            Thank you for your attention.`;

const MID_ASSESSMENT_BODY = `Product Support Request

Candidate Full Name: Test User
Candidate Email ID: test@example.com
Candidate Phone: 1234567890
Candidate Assessment Key: ABC123
Subject: Section 3 failed
Issue: I was in the middle of taking the assessment when section 3 stopped working.

Thank you for your attention.`;

function assertKeywordHint(body, emailSubject, shouldMatch, label) {
  const parsed = parseSupportRequest(body);
  if (!parsed) {
    console.error(`FAIL: ${label} — could not parse`);
    process.exit(1);
  }
  const text = classificationText(parsed, emailSubject);
  const hint = hasKeywordHint(parsed.issueSubject || '', text);
  if (hint !== shouldMatch) {
    console.error(`FAIL: ${label} — hint=${hint} expected=${shouldMatch}`);
    console.error('  Issue:', parsed.issue);
    process.exit(1);
  }
  console.log(`PASS: ${label}`);
}

function run() {
  const parsed = parseSupportRequest(SAMPLE_BODY);
  if (!parsed || parsed.candidateEmail !== 'singhpurnima123568@gmail.com') {
    console.error('FAIL: Purnima sample parse');
    process.exit(1);
  }
  console.log('PASS: Purnima sample parse');

  const aneesh = parseSupportRequest(ANEESH_BODY);
  if (!aneesh || aneesh.candidateEmail !== 'aneeshror93@gmail.com') {
    console.error('FAIL: Aneesh parse', aneesh);
    process.exit(1);
  }
  if (!aneesh.issue.toLowerCase().includes('not able to start')) {
    console.error('FAIL: Aneesh issue text', aneesh.issue);
    process.exit(1);
  }
  console.log('PASS: Aneesh format parse (blank lines after Issue:)');

  assertKeywordHint(
    ANEESH_BODY,
    '1EJWfNXPPbp5ByG3lSuc-assesment',
    true,
    'Aneesh — not able to start',
  );
  const md = parseSupportRequest(MARKDOWN_BODY);
  if (!md || !md.issue.includes('start')) {
    console.error('FAIL: markdown/bold PSR parse', md);
    process.exit(1);
  }
  console.log('PASS: markdown/bold field labels (*Candidate Email ID:*)');

  const emptyEmail = parseSupportRequest(EMPTY_EMAIL_BODY);
  if (!emptyEmail || emptyEmail.candidateEmail !== '') {
    console.error('FAIL: blank Candidate Email ID must not capture next field', emptyEmail);
    process.exit(1);
  }
  if (emptyEmail.candidatePhone !== '7385389497' || !emptyEmail.issue.includes('not starting')) {
    console.error('FAIL: empty-email PSR parse', emptyEmail);
    process.exit(1);
  }
  console.log('PASS: blank Candidate Email ID (no bleed from Candidate Phone)');

  const indented = parseSupportRequest(INDENTED_HTML_TEXT_BODY);
  if (!indented || indented.candidateEmail !== 'samiksha.t@otomeyt.ai') {
    console.error('FAIL: indented/converted-html PSR parse', indented);
    process.exit(1);
  }
  if (!indented.issue.toLowerCase().includes('not able to start assessment')) {
    console.error('FAIL: indented issue parse', indented.issue);
    process.exit(1);
  }
  console.log('PASS: indented PSR body from HTML conversion');

  assertKeywordHint(MARKDOWN_BODY, 'KEY-not start', true, "can't start the test");

  assertKeywordHint(CAMERA_BODY, 'KEY-assesment', true, 'camera not allowed');
  assertKeywordHint(BUTTON_BODY, 'KEY-button', true, 'start button not working');

  const midHint = hasKeywordHint(
    'Section 3 failed',
    classificationText(parseSupportRequest(MID_ASSESSMENT_BODY), ''),
  );
  if (midHint) {
    console.error('FAIL: mid-assessment should not match');
    process.exit(1);
  }
  console.log('PASS: mid-assessment rejected');

  console.log('\nAll local checks passed.');
}

run();
