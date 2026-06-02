const {
  parseSupportRequest,
  classificationText,
  isValidCandidateEmail,
} = require('./supportRequest');
const { shouldAutoReply } = require('./issueGate');
const { matchesSupportSubject } = require('./subjectFilter');
const {
  shouldSkipThreadInPoll,
  shouldSkipLabeledMessage,
} = require('./pollQuery');

/**
 * Same decision order as index.js — does not send mail or call Gmail.
 * @returns {Promise<{ action: 'skip'|'reply', reason: string, supportRequest?: object }>}
 */
async function evaluateInboundMessage(
  message,
  config,
  labelId,
  processedThreadIds,
  deps = {},
) {
  const gateFn = deps.shouldAutoReply || shouldAutoReply;

  if (shouldSkipThreadInPoll(processedThreadIds, message.threadId)) {
    return { action: 'skip', reason: 'thread already processed in poll' };
  }

  if (shouldSkipLabeledMessage(message.labelIds, labelId)) {
    return { action: 'skip', reason: 'already labeled' };
  }

  if (!matchesSupportSubject(message.subject)) {
    return {
      action: 'skip',
      reason: 'subject does not match assessment key pattern (KEY-description)',
    };
  }

  const supportRequest = parseSupportRequest(message.body);
  if (!supportRequest) {
    return { action: 'skip', reason: 'not a Product Support Request email' };
  }

  const issueText = classificationText(supportRequest, message.subject);
  const gate = await gateFn(
    supportRequest.issueSubject || message.subject,
    issueText,
    message.from,
    config,
  );

  if (!gate.reply) {
    return { action: 'skip', reason: gate.reason, supportRequest };
  }

  if (!supportRequest.candidateEmail || !isValidCandidateEmail(supportRequest.candidateEmail)) {
    return { action: 'skip', reason: 'missing or invalid Candidate Email ID', supportRequest };
  }

  return { action: 'reply', reason: gate.reason, supportRequest };
}

module.exports = { evaluateInboundMessage };
