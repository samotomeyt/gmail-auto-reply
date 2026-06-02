#!/usr/bin/env node
/**
 * Validates that replied threads are excluded from future polls (read + label guards).
 */

const assert = require('assert');
const {
  buildSearchQuery,
  shouldSkipThreadInPoll,
  shouldSkipLabeledMessage,
  postReplyThreadLabelUpdate,
  markReadOnlyThreadLabelUpdate,
} = require('../src/pollQuery');

const PROCESSED_LABEL = 'Auto-Replied';
const BASE_QUERY = 'in:inbox';
const LABEL_ID = 'Label_123';

function testSearchQueryExcludesProcessedAndRead() {
  const query = buildSearchQuery({
    baseQuery: BASE_QUERY,
    processedLabel: PROCESSED_LABEL,
    afterDate: new Date('2026-05-30T12:00:00Z'),
  });

  assert.ok(query.includes(BASE_QUERY), 'includes base query');
  assert.ok(query.includes('-label:Auto-Replied'), 'excludes processed label');
  assert.ok(query.includes('is:unread'), 'only unread');
  assert.ok(query.includes('after:2026/5/30'), 'after startup date');
  console.log('PASS: search query excludes labeled + read mail');
}

function testSkipLabeledMessage() {
  assert.strictEqual(shouldSkipLabeledMessage(['INBOX', LABEL_ID], LABEL_ID), true);
  assert.strictEqual(shouldSkipLabeledMessage(['INBOX', 'UNREAD'], LABEL_ID), false);
  assert.strictEqual(shouldSkipLabeledMessage(undefined, LABEL_ID), false);
  console.log('PASS: skip message that already has Auto-Replied label');
}

function testSkipThreadInSamePoll() {
  const seen = new Set(['thread-abc']);
  assert.strictEqual(shouldSkipThreadInPoll(seen, 'thread-abc'), true);
  assert.strictEqual(shouldSkipThreadInPoll(seen, 'thread-other'), false);
  console.log('PASS: skip duplicate thread in same poll');
}

function testPostReplyMarksReadAndLabels() {
  const update = postReplyThreadLabelUpdate(LABEL_ID);
  assert.deepStrictEqual(update.addLabelIds, [LABEL_ID]);
  assert.deepStrictEqual(update.removeLabelIds, ['UNREAD']);
  console.log('PASS: post-reply applies label and removes UNREAD');
}

function testMarkReadFallback() {
  const update = markReadOnlyThreadLabelUpdate();
  assert.deepStrictEqual(update.removeLabelIds, ['UNREAD']);
  assert.strictEqual(update.addLabelIds, undefined);
  console.log('PASS: fallback can mark read without label');
}

async function testFinalizeThreadFallback() {
  const calls = [];
  const { finalizeThreadAfterReply } = require('../src/finalizeThread');
  const modify = async (g, threadId, body) => {
    calls.push({ threadId, body });
    if (calls.length === 1) throw new Error('label API failed');
  };

  const result = await finalizeThreadAfterReply({}, 'thread-1', LABEL_ID, {
    modifyThreadLabels: modify,
  });
  assert.strictEqual(calls.length, 2, 'retries with mark-read only');
  assert.strictEqual(result.markedRead, true);
  assert.strictEqual(result.labeled, false);
  assert.deepStrictEqual(calls[1].body.removeLabelIds, ['UNREAD']);
  console.log('PASS: finalize falls back to mark-read if label fails');
}

async function testFinalizeThreadSuccess() {
  const calls = [];
  const { finalizeThreadAfterReply } = require('../src/finalizeThread');
  const modify = async (g, threadId, body) => {
    calls.push({ threadId, body });
  };

  const result = await finalizeThreadAfterReply({}, 'thread-2', LABEL_ID, {
    modifyThreadLabels: modify,
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(result.labeled, true);
  assert.strictEqual(result.markedRead, true);
  assert.deepStrictEqual(calls[0].body, postReplyThreadLabelUpdate(LABEL_ID));
  console.log('PASS: finalize labels and marks read on success');
}

function testSimulatedPollCycle() {
  // After successful finalize, thread should not appear in next search (conceptually)
  const labelIds = ['INBOX', LABEL_ID];
  const unread = ['INBOX', 'UNREAD'];

  assert.strictEqual(shouldSkipLabeledMessage(labelIds, LABEL_ID), true);

  const queryAfter = buildSearchQuery({
    baseQuery: BASE_QUERY,
    processedLabel: PROCESSED_LABEL,
  });
  // Labeled thread: excluded by -label; read thread: excluded by is:unread
  assert.ok(queryAfter.includes('-label:Auto-Replied'));
  assert.ok(queryAfter.includes('is:unread'));
  assert.strictEqual(shouldSkipLabeledMessage(unread, LABEL_ID), false);
  console.log('PASS: simulated cycle — labeled thread skipped by in-message check');
}

async function main() {
  testSearchQueryExcludesProcessedAndRead();
  testSkipLabeledMessage();
  testSkipThreadInSamePoll();
  testPostReplyMarksReadAndLabels();
  testMarkReadFallback();
  testSimulatedPollCycle();
  await testFinalizeThreadSuccess();
  await testFinalizeThreadFallback();
  console.log('\nAll dedup / mark-read guard tests passed.');
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
