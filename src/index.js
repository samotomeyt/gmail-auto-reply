const { loadConfig } = require('./config');
const { authorize } = require('./auth');
const { createGmailClient, findOrCreateLabel } = require('./gmailClient');
const { runPollCycle } = require('./pollOnce');
const { buildSearchQuery: buildPollSearchQuery } = require('./pollQuery');
const logger = require('./logger');
const monitor = require('./monitor');

let isProcessing = false;
let startupMs = Date.now();

function buildSearchQuery(baseQuery, processedLabel) {
  return buildPollSearchQuery({
    baseQuery,
    processedLabel,
    afterDate: new Date(startupMs),
  });
}

async function runPoll(config, gmail, labelId) {
  if (isProcessing) {
    logger.warn('Previous poll still running, skipping');
    return;
  }

  isProcessing = true;
  try {
    await runPollCycle(config, gmail, labelId, {
      afterDate: new Date(startupMs),
    });
    monitor.recordPollSuccess();
  } catch (err) {
    await monitor.alertError(err, `Poll failed: ${err.message}`);
    logger.error('Poll error:', err.message);
  } finally {
    isProcessing = false;
  }
}

async function main() {
  monitor.installProcessHandlers();
  startupMs = Date.now();
  const config = loadConfig();
  logger.info('Starting Gmail Auto Reply', {
    dryRun: config.dryRun,
    pollIntervalMs: config.pollIntervalMs,
    replyFrom: config.replyFromEmail,
    inbox: 'samiksha.t@otomeyt.ai (OAuth account)',
    query: buildSearchQuery(config.gmailQuery, config.processedLabel),
  });

  let auth;
  try {
    auth = await authorize(config.credentialsPath, config.tokenPath);
  } catch (err) {
    await monitor.alertError(monitor.ALERT.OAUTH, `OAuth authorization failed: ${err.message}`, err);
    throw err;
  }

  const gmail = createGmailClient(auth);
  const labelId = await findOrCreateLabel(gmail, config.processedLabel);

  monitor.startWatchdog(config.pollIntervalMs);
  monitor.recordPollSuccess();

  await runPoll(config, gmail, labelId);

  setInterval(() => {
    runPoll(config, gmail, labelId);
  }, config.pollIntervalMs);

  logger.info(`Polling every ${config.pollIntervalMs}ms`, {
    monitorWebhook: Boolean(process.env.MONITOR_WEBHOOK_URL),
    alertLog: process.env.MONITOR_ALERT_LOG_PATH || 'alerts.log',
  });
}

main().catch(async (err) => {
  await monitor.alertError(monitor.ALERT.FATAL, `Fatal startup/runtime error: ${err.message}`, err);
  logger.error('Fatal error:', err.message);
  process.exit(1);
});
