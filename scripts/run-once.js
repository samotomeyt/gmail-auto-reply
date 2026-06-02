#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const { loadConfig } = require('../src/config');
const { authorize } = require('../src/auth');
const {
  createGmailClient,
  searchMessages,
  getMessageMetadata,
  getMessage,
  findOrCreateLabel,
} = require('../src/gmailClient');
const { buildSearchQuery } = require('../src/pollQuery');
const { finalizeThreadAfterReply } = require('../src/finalizeThread');
const { matchesSupportSubject } = require('../src/subjectFilter');
const { shouldAutoReply } = require('../src/issueGate');
const { parseSupportRequest, classificationText } = require('../src/supportRequest');
const { sendReply } = require('../src/responder');
const { generateReply } = require('../src/openaiReply');
const logger = require('../src/logger');

async function main() {
  const config = loadConfig();
  const auth = await authorize(config.credentialsPath, config.tokenPath);
  const gmail = createGmailClient(auth);
  const labelId = await findOrCreateLabel(gmail, config.processedLabel);

  const query = buildSearchQuery({
    baseQuery: config.gmailQuery,
    processedLabel: config.processedLabel,
    afterDate: new Date(),
  });

  const messages = await searchMessages(gmail, query);
  logger.info(`One-shot poll: ${messages.length} message(s)`, { query, dryRun: config.dryRun });

  for (const { id } of messages) {
    const meta = await getMessageMetadata(gmail, id);
    if (!matchesSupportSubject(meta.subject)) {
      logger.info('Skipped (subject)', { subject: meta.subject });
      continue;
    }

    const message = await getMessage(gmail, id);
    const supportRequest = parseSupportRequest(message.body);
    if (!supportRequest) continue;

    const issueText = classificationText(supportRequest, message.subject);
    const gate = await shouldAutoReply(
      supportRequest.issueSubject || message.subject,
      issueText,
      message.from,
      config,
    );
    if (!gate.reply) {
      logger.info('Skipped', { subject: message.subject, reason: gate.reason });
      continue;
    }
    if (!supportRequest.candidateEmail) continue;

    const candidateName = supportRequest.candidateFullName || 'Candidate';
    const replyBody = await generateReply(config, {
      candidateName,
      subject: supportRequest.issueSubject || message.subject,
      body: supportRequest.issue,
    });
    logger.info('Matched', {
      messageId: message.messageId,
      subject: message.subject,
      candidateEmail: supportRequest.candidateEmail,
    });
    const result = await sendReply(gmail, message, replyBody, config.dryRun, {
      replyTo: supportRequest.candidateEmail,
      fromEmail: config.replyFromEmail,
      fromName: config.replyFromName,
    });
    if (!config.dryRun && result.sent) {
      const finalized = await finalizeThreadAfterReply(gmail, message.threadId, labelId);
      logger.info('Thread finalized after reply', {
        threadId: message.threadId,
        labeled: finalized.labeled,
        markedRead: finalized.markedRead,
      });
    } else if (config.dryRun) {
      logger.info('[DRY_RUN] Would send reply', { to: supportRequest.candidateEmail });
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
