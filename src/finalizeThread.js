const { modifyThreadLabels } = require('./gmailClient');
const {
  postReplyThreadLabelUpdate,
  markReadOnlyThreadLabelUpdate,
} = require('./pollQuery');
const logger = require('./logger');

/**
 * After a successful send: label thread + mark read.
 * If labeling fails, still try mark-read so is:unread search won't pick it up again.
 */
async function finalizeThreadAfterReply(gmail, threadId, labelId, deps = {}) {
  const modify = deps.modifyThreadLabels || modifyThreadLabels;

  try {
    await modify(gmail, threadId, postReplyThreadLabelUpdate(labelId));
    return { labeled: true, markedRead: true };
  } catch (labelError) {
    logger.error('Failed to label thread after reply; retrying mark-read only', {
      threadId,
      error: labelError.message,
    });
    try {
      await modify(gmail, threadId, markReadOnlyThreadLabelUpdate());
      return { labeled: false, markedRead: true, labelError: labelError.message };
    } catch (readError) {
      logger.error('Failed to mark thread read after reply — may duplicate on next poll', {
        threadId,
        error: readError.message,
      });
      return { labeled: false, markedRead: false, labelError: labelError.message, readError: readError.message };
    }
  }
}

module.exports = { finalizeThreadAfterReply };
