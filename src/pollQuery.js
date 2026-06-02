/**
 * Gmail search and skip rules so replied threads stay read and are not processed again.
 */

function buildSearchQuery({ baseQuery, processedLabel, afterDate = new Date() }) {
  const after = `after:${afterDate.getFullYear()}/${afterDate.getMonth() + 1}/${afterDate.getDate()}`;
  return [baseQuery, after, `-label:${processedLabel}`, 'is:unread']
    .filter(Boolean)
    .join(' ')
    .trim();
}

function shouldSkipThreadInPoll(processedThreadIds, threadId) {
  return processedThreadIds.has(threadId);
}

function shouldSkipLabeledMessage(labelIds, labelId) {
  return Boolean(labelId && labelIds && labelIds.includes(labelId));
}

function postReplyThreadLabelUpdate(labelId) {
  return {
    addLabelIds: [labelId],
    removeLabelIds: ['UNREAD'],
  };
}

function markReadOnlyThreadLabelUpdate() {
  return {
    removeLabelIds: ['UNREAD'],
  };
}

module.exports = {
  buildSearchQuery,
  shouldSkipThreadInPoll,
  shouldSkipLabeledMessage,
  postReplyThreadLabelUpdate,
  markReadOnlyThreadLabelUpdate,
};
