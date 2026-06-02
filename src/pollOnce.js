const {
  searchMessages,
  getMessageMetadata,
  getMessage,
} = require('./gmailClient');
const { matchesSupportSubject } = require('./subjectFilter');
const { shouldAutoReply } = require('./issueGate');
const {
  parseSupportRequest,
  classificationText,
  isValidCandidateEmail,
} = require('./supportRequest');
const { sendReply } = require('./responder');
const { generateReply } = require('./openaiReply');
const { finalizeThreadAfterReply } = require('./finalizeThread');
const {
  buildSearchQuery,
  shouldSkipThreadInPoll,
  shouldSkipLabeledMessage,
} = require('./pollQuery');
const logger = require('./logger');
const monitor = require('./monitor');
const { writeAuditEvent } = require('./auditStore');

function stackSnippet(err) {
  return err?.stack ? err.stack.split('\n').slice(0, 3).join('\n') : undefined;
}

async function auditSafe(config, payload) {
  try {
    await writeAuditEvent(config, payload);
  } catch (err) {
    logger.warn('Audit write failed (continuing)', {
      stage: payload.stage,
      messageId: payload.messageId,
      error: err.message,
    });
  }
}

function buildReplyCc(config, candidateEmail) {
  const raw = `${config.replyCc || ''}`;
  if (!raw.trim()) return '';

  const candidate = (candidateEmail || '').trim().toLowerCase();
  const list = raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  const dedup = [];
  const seen = new Set();
  for (const email of list) {
    const normalized = email.toLowerCase();
    if (normalized === candidate) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    dedup.push(email);
  }
  return dedup.join(', ');
}

/**
 * Single inbox poll — used by long-running server and AWS Lambda.
 * @param {object} config
 * @param {import('googleapis').gmail_v1.Gmail} gmail
 * @param {string} labelId
 * @param {{ afterDate?: Date, runContext?: object }} options
 */
async function runPollCycle(config, gmail, labelId, options = {}) {
  const afterDate = options.afterDate || new Date();
  const runContext = options.runContext || {};
  const processedThreadIds = new Set();

  const query = buildSearchQuery({
    baseQuery: config.gmailQuery,
    processedLabel: config.processedLabel,
    afterDate,
  });

  const messages = await searchMessages(gmail, query);
  logger.info(`Found ${messages.length} message(s) matching query`, { query });

  let subjectFiltered = 0;
  let matched = 0;
  let sent = 0;

  for (const { id } of messages) {
    try {
      const meta = await getMessageMetadata(gmail, id);

      if (shouldSkipThreadInPoll(processedThreadIds, meta.threadId)) {
        await auditSafe(config, {
          stage: 'classified_skip',
          status: 'skip',
          timestamp: new Date().toISOString(),
          runId: runContext.runId,
          requestId: runContext.requestId,
          functionName: runContext.functionName,
          messageId: meta.messageId,
          threadId: meta.threadId,
          subject: meta.subject,
          failureStage: 'duplicate_thread',
          details: { reason: 'thread already processed in poll' },
          dryRun: config.dryRun,
        });
        logger.info('Skipped (thread already processed)', {
          messageId: meta.messageId,
          threadId: meta.threadId,
          subject: meta.subject,
        });
        continue;
      }

      if (shouldSkipLabeledMessage(meta.labelIds, labelId)) {
        await auditSafe(config, {
          stage: 'classified_skip',
          status: 'skip',
          timestamp: new Date().toISOString(),
          runId: runContext.runId,
          requestId: runContext.requestId,
          functionName: runContext.functionName,
          messageId: meta.messageId,
          threadId: meta.threadId,
          subject: meta.subject,
          failureStage: 'already_labeled',
          details: { reason: 'already labeled' },
          dryRun: config.dryRun,
        });
        logger.info('Skipped (already labeled)', {
          messageId: meta.messageId,
          subject: meta.subject,
        });
        continue;
      }

      if (!matchesSupportSubject(meta.subject)) {
        subjectFiltered += 1;
        await auditSafe(config, {
          stage: 'classified_skip',
          status: 'skip',
          timestamp: new Date().toISOString(),
          runId: runContext.runId,
          requestId: runContext.requestId,
          functionName: runContext.functionName,
          messageId: meta.messageId,
          threadId: meta.threadId,
          subject: meta.subject,
          failureStage: 'subject_filter',
          details: { reason: 'subject does not match assessment key pattern (KEY-description)' },
          dryRun: config.dryRun,
        });
        logger.info('Skipped', {
          messageId: meta.messageId,
          subject: meta.subject,
          reason: 'subject does not match assessment key pattern (KEY-description)',
        });
        continue;
      }

      const message = await getMessage(gmail, id);
      const supportRequest = parseSupportRequest(message.body);
      await auditSafe(config, {
        stage: 'message_loaded',
        status: 'ok',
        timestamp: new Date().toISOString(),
        runId: runContext.runId,
        requestId: runContext.requestId,
        functionName: runContext.functionName,
        messageId: message.messageId,
        threadId: message.threadId,
        subject: message.subject,
        candidateEmail: supportRequest?.candidateEmail,
        assessmentKey: supportRequest?.assessmentKey,
        issuePreview: supportRequest?.issue?.slice(0, 250),
        dryRun: config.dryRun,
      });
      if (!supportRequest) {
        await auditSafe(config, {
          stage: 'classified_skip',
          status: 'skip',
          timestamp: new Date().toISOString(),
          runId: runContext.runId,
          requestId: runContext.requestId,
          functionName: runContext.functionName,
          messageId: message.messageId,
          threadId: message.threadId,
          subject: message.subject,
          failureStage: 'psr_parse',
          details: { reason: 'not a Product Support Request email' },
          dryRun: config.dryRun,
        });
        logger.info('Skipped', {
          messageId: message.messageId,
          subject: message.subject,
          reason: 'not a Product Support Request email',
        });
        continue;
      }

      const issueText = classificationText(supportRequest, message.subject);
      const gate = await shouldAutoReply(
        supportRequest.issueSubject || message.subject,
        issueText,
        message.from,
        config,
      );
      if (!gate.reply) {
        if (gate.reason === 'openai error') {
          await monitor.alert(monitor.ALERT.OPENAI, 'OpenAI classification failed', {
            messageId: message.messageId,
            subject: message.subject,
          });
        }
        await auditSafe(config, {
          stage: 'classified_skip',
          status: 'skip',
          timestamp: new Date().toISOString(),
          runId: runContext.runId,
          requestId: runContext.requestId,
          functionName: runContext.functionName,
          messageId: message.messageId,
          threadId: message.threadId,
          subject: message.subject,
          candidateEmail: supportRequest.candidateEmail,
          assessmentKey: supportRequest.assessmentKey,
          issuePreview: supportRequest.issue.slice(0, 250),
          failureStage: 'issue_gate',
          details: { reason: gate.reason },
          dryRun: config.dryRun,
        });
        logger.info('Skipped', {
          messageId: message.messageId,
          subject: message.subject,
          reason: gate.reason,
          issuePreview: supportRequest.issue.slice(0, 120),
        });
        continue;
      }

      const candidateName = supportRequest.candidateFullName || 'Candidate';
      const replyBody = await generateReply(config, {
        candidateName,
        subject: supportRequest.issueSubject || message.subject,
        body: supportRequest.issue,
      });

      matched += 1;
      await auditSafe(config, {
        stage: 'matched',
        status: 'ok',
        timestamp: new Date().toISOString(),
        runId: runContext.runId,
        requestId: runContext.requestId,
        functionName: runContext.functionName,
        messageId: message.messageId,
        threadId: message.threadId,
        subject: message.subject,
        candidateEmail: supportRequest.candidateEmail,
        assessmentKey: supportRequest.assessmentKey,
        issuePreview: supportRequest.issue.slice(0, 250),
        dryRun: config.dryRun,
      });
      logger.info('Matched issue email', {
        messageId: message.messageId,
        threadId: message.threadId,
        from: message.from,
        subject: message.subject,
        candidateName,
        candidateEmail: supportRequest.candidateEmail,
        assessmentKey: supportRequest.assessmentKey,
      });

      if (!supportRequest.candidateEmail || !isValidCandidateEmail(supportRequest.candidateEmail)) {
        await auditSafe(config, {
          stage: 'classified_skip',
          status: 'skip',
          timestamp: new Date().toISOString(),
          runId: runContext.runId,
          requestId: runContext.requestId,
          functionName: runContext.functionName,
          messageId: message.messageId,
          threadId: message.threadId,
          subject: message.subject,
          candidateEmail: supportRequest.candidateEmail,
          assessmentKey: supportRequest.assessmentKey,
          issuePreview: supportRequest.issue.slice(0, 250),
          failureStage: 'invalid_candidate_email',
          details: { reason: 'missing or invalid Candidate Email ID' },
          dryRun: config.dryRun,
        });
        logger.error('Skipped send: missing or invalid Candidate Email ID in support request', {
          messageId: message.messageId,
          candidateEmail: supportRequest.candidateEmail || '(empty)',
        });
        continue;
      }

      let result;
      const replyCc = buildReplyCc(config, supportRequest.candidateEmail);
      try {
        await auditSafe(config, {
          stage: 'reply_attempt',
          status: config.dryRun ? 'dry_run' : 'attempt',
          timestamp: new Date().toISOString(),
          runId: runContext.runId,
          requestId: runContext.requestId,
          functionName: runContext.functionName,
          messageId: message.messageId,
          threadId: message.threadId,
          subject: message.subject,
          candidateEmail: supportRequest.candidateEmail,
          assessmentKey: supportRequest.assessmentKey,
          issuePreview: supportRequest.issue.slice(0, 250),
          replyTo: supportRequest.candidateEmail,
          fromEmail: config.replyFromEmail,
          replySubject: `Re: ${(message.subject || '').trim()}`.replace(/^Re:\s*Re:/i, 'Re:'),
          dryRun: config.dryRun,
          replyHtml: replyBody,
        });
        result = await sendReply(gmail, message, replyBody, config.dryRun, {
          replyTo: supportRequest.candidateEmail,
          cc: replyCc,
          fromEmail: config.replyFromEmail,
          fromName: config.replyFromName,
        });
      } catch (sendErr) {
        await monitor.alertError(monitor.ALERT.SEND_FAILED, 'Gmail send failed', sendErr);
        await auditSafe(config, {
          stage: 'processing_error',
          status: 'error',
          timestamp: new Date().toISOString(),
          runId: runContext.runId,
          requestId: runContext.requestId,
          functionName: runContext.functionName,
          messageId: message.messageId,
          threadId: message.threadId,
          subject: message.subject,
          candidateEmail: supportRequest.candidateEmail,
          assessmentKey: supportRequest.assessmentKey,
          issuePreview: supportRequest.issue.slice(0, 250),
          failureStage: 'send_reply',
          errorMessage: sendErr.message,
          errorStackSnippet: stackSnippet(sendErr),
          dryRun: config.dryRun,
          replyHtml: replyBody,
        });
        throw sendErr;
      }

      await auditSafe(config, {
        stage: result.sent ? 'reply_sent' : 'dry_run_preview',
        status: result.sent ? 'ok' : 'dry_run',
        timestamp: new Date().toISOString(),
        runId: runContext.runId,
        requestId: runContext.requestId,
        functionName: runContext.functionName,
        messageId: message.messageId,
        threadId: message.threadId,
        subject: message.subject,
        candidateEmail: supportRequest.candidateEmail,
        assessmentKey: supportRequest.assessmentKey,
        issuePreview: supportRequest.issue.slice(0, 250),
        replyTo: result.to,
        fromEmail: result.from || config.replyFromEmail,
        replySubject: result.replySubject,
        dryRun: result.dryRun,
        replyHtml: replyBody,
      });

      if (!config.dryRun && result.sent) {
        sent += 1;
        const finalized = await finalizeThreadAfterReply(gmail, message.threadId, labelId);
        processedThreadIds.add(message.threadId);

        if (finalized.labeled && finalized.markedRead) {
          await auditSafe(config, {
            stage: 'finalize_ok',
            status: 'ok',
            timestamp: new Date().toISOString(),
            runId: runContext.runId,
            requestId: runContext.requestId,
            functionName: runContext.functionName,
            messageId: message.messageId,
            threadId: message.threadId,
            subject: message.subject,
            candidateEmail: supportRequest.candidateEmail,
            assessmentKey: supportRequest.assessmentKey,
            dryRun: config.dryRun,
          });
          logger.info('Successfully replied, labeled, and marked read', {
            messageId: message.messageId,
            threadId: message.threadId,
            label: config.processedLabel,
          });
        } else if (finalized.markedRead) {
          await auditSafe(config, {
            stage: 'finalize_failed',
            status: 'error',
            timestamp: new Date().toISOString(),
            runId: runContext.runId,
            requestId: runContext.requestId,
            functionName: runContext.functionName,
            messageId: message.messageId,
            threadId: message.threadId,
            subject: message.subject,
            candidateEmail: supportRequest.candidateEmail,
            assessmentKey: supportRequest.assessmentKey,
            failureStage: 'finalize_label',
            errorMessage: finalized.labelError,
            dryRun: config.dryRun,
          });
          logger.warn('Replied and marked read; Auto-Replied label failed', {
            messageId: message.messageId,
            threadId: message.threadId,
            labelError: finalized.labelError,
          });
        } else {
          await monitor.alert(monitor.ALERT.FINALIZE_FAILED, 'Reply sent but label/mark-read failed', {
            messageId: message.messageId,
            threadId: message.threadId,
          });
          await auditSafe(config, {
            stage: 'finalize_failed',
            status: 'error',
            timestamp: new Date().toISOString(),
            runId: runContext.runId,
            requestId: runContext.requestId,
            functionName: runContext.functionName,
            messageId: message.messageId,
            threadId: message.threadId,
            subject: message.subject,
            candidateEmail: supportRequest.candidateEmail,
            assessmentKey: supportRequest.assessmentKey,
            failureStage: 'finalize_label_and_mark_read',
            errorMessage: finalized.readError || finalized.labelError || 'unknown finalize failure',
            dryRun: config.dryRun,
          });
          logger.error('Replied but failed to label and mark read — may reply again on next poll', {
            messageId: message.messageId,
            threadId: message.threadId,
          });
        }
      } else if (config.dryRun) {
        logger.info('[DRY_RUN] Would apply label and mark read on thread', {
          label: config.processedLabel,
          threadId: message.threadId,
        });
      }
    } catch (error) {
      const alertType = monitor.classifyError(error);
      if (alertType === monitor.ALERT.OAUTH || alertType === monitor.ALERT.SEND_FAILED) {
        await monitor.alertError(alertType, `Error processing email: ${error.message}`, error);
      }
      await auditSafe(config, {
        stage: 'processing_error',
        status: 'error',
        timestamp: new Date().toISOString(),
        runId: runContext.runId,
        requestId: runContext.requestId,
        functionName: runContext.functionName,
        messageId: id,
        failureStage: 'process_email',
        errorMessage: error.message,
        errorStackSnippet: stackSnippet(error),
        dryRun: config.dryRun,
      });
      logger.error('Error processing email', {
        messageId: id,
        error: error.message,
      });
    }
  }

  if (messages.length > 0) {
    logger.info(`Subject filter: ${subjectFiltered} skipped (non-matching subject)`, {
      candidates: messages.length - subjectFiltered,
    });
  }

  return {
    query,
    messagesFound: messages.length,
    subjectFiltered,
    matched,
    sent,
    dryRun: config.dryRun,
  };
}

module.exports = { runPollCycle };
