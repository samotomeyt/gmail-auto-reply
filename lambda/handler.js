const { bootstrapFromSecrets } = require('../src/awsBootstrap');
const { loadConfig } = require('../src/config');
const { authorize } = require('../src/auth');
const { createGmailClient, findOrCreateLabel } = require('../src/gmailClient');
const { runPollCycle } = require('../src/pollOnce');
const monitor = require('../src/monitor');
const logger = require('../src/logger');

/**
 * AWS Lambda entry — one inbox poll per invocation (EventBridge schedule).
 */
async function handler(event, context) {
  await bootstrapFromSecrets();
  const config = loadConfig();

  logger.info('Lambda poll starting', {
    dryRun: config.dryRun,
    region: process.env.AWS_REGION,
    function: process.env.AWS_LAMBDA_FUNCTION_NAME,
  });

  let auth;
  try {
    auth = await authorize(config.credentialsPath, config.tokenPath);
  } catch (err) {
    await monitor.alertError(monitor.ALERT.OAUTH, `OAuth failed: ${err.message}`, err);
    throw err;
  }

  const gmail = createGmailClient(auth);
  const labelId = await findOrCreateLabel(gmail, config.processedLabel);

  const summary = await runPollCycle(config, gmail, labelId, {
    afterDate: new Date(),
    runContext: {
      runId: context?.awsRequestId || `${Date.now()}`,
      requestId: context?.awsRequestId,
      functionName: context?.functionName || process.env.AWS_LAMBDA_FUNCTION_NAME,
      eventSource: event?.source,
    },
  });

  try {
    monitor.recordPollSuccess();
  } catch {
    // heartbeat file is optional on Lambda
  }

  logger.info('Lambda poll finished', summary);
  return summary;
}

exports.handler = handler;
