#!/usr/bin/env node
const assert = require('assert');
const {
  normalizeSubject,
  matchesSupportSubject,
  parseAssessmentKeyFromSubject,
} = require('../src/subjectFilter');

const MATCH = [
  'srnVnEHFqfD3W7V3K4o3-B pharm',
  '1EJWfNXPPbp5ByG3lSuc-assesment',
  'HTqVmSp2eDeez1T6EN68-Problems faced during test',
  'Re: 1EJWfNXPPbp5ByG3lSuc-assesment',
  'Fwd: srnVnEHFqfD3W7V3K4o3-test not start',
];

const NO_MATCH = [
  'test not starting',
  'Meeting tomorrow',
  'Weekly report - Q2',
  '',
  'abc-short',
  'Re: team sync',
];

function run() {
  for (const s of MATCH) {
    assert.ok(matchesSupportSubject(s), `should match: ${s}`);
    const key = parseAssessmentKeyFromSubject(s);
    assert.ok(key && key.length >= 8, `key from: ${s}`);
  }
  console.log(`PASS: ${MATCH.length} matching subjects`);

  for (const s of NO_MATCH) {
    assert.ok(!matchesSupportSubject(s), `should not match: ${s}`);
  }
  console.log(`PASS: ${NO_MATCH.length} non-matching subjects`);

  assert.strictEqual(
    normalizeSubject('Re: Fwd: 1EJWfNXPPbp5ByG3lSuc-assesment'),
    '1EJWfNXPPbp5ByG3lSuc-assesment',
  );
  console.log('PASS: strips Re:/Fwd: prefixes');

  console.log('\nAll subject filter tests passed.');
}

run();
