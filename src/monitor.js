const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const logger = require('./logger');

const ALERT = {
  PROCESS_STALE: 'process_stale',
  PROCESS_DOWN: 'process_down',
  OAUTH: 'oauth',
  OPENAI: 'openai',
  SEND_FAILED: 'send_failed',
  POLL_FAILED: 'poll_failed',
  FINALIZE_FAILED: 'finalize_failed',
  FATAL: 'fatal',
};

const lastAlertAt = new Map();
let lastPollOkAt = null;
let watchdogTimer = null;

function monitorConfig() {
  const root = path.join(__dirname, '..');
  return {
    webhookUrl: (process.env.MONITOR_WEBHOOK_URL || '').trim(),
    heartbeatPath:
      process.env.MONITOR_HEARTBEAT_PATH ||
      path.join(root, '.monitor', 'heartbeat.json'),
    alertLogPath:
      process.env.MONITOR_ALERT_LOG_PATH || path.join(root, 'alerts.log'),
    cooldownMs: Math.max(
      60_000,
      parseInt(process.env.MONITOR_ALERT_COOLDOWN_MS || '900000', 10) || 900_000,
    ),
    stalePollMultiplier: Math.max(
      1.5,
      parseFloat(process.env.MONITOR_STALE_POLL_MULTIPLIER || '2.5') || 2.5,
    ),
    healthStaleMultiplier: Math.max(
      2,
      parseFloat(process.env.MONITOR_HEALTH_STALE_MULTIPLIER || '3') || 3,
    ),
  };
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeHeartbeat() {
  const { heartbeatPath } = monitorConfig();
  ensureParentDir(heartbeatPath);
  const payload = {
    at: new Date().toISOString(),
    pid: process.pid,
  };
  fs.writeFileSync(heartbeatPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readHeartbeat() {
  const { heartbeatPath } = monitorConfig();
  if (!fs.existsSync(heartbeatPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
  } catch {
    return null;
  }
}

function heartbeatAgeMs() {
  const hb = readHeartbeat();
  if (!hb?.at) return null;
  const t = new Date(hb.at).getTime();
  if (Number.isNaN(t)) return null;
  return Date.now() - t;
}

function appendAlertLog(message, details) {
  const { alertLogPath } = monitorConfig();
  ensureParentDir(alertLogPath);
  const line = `${new Date().toISOString()}\t${message}\t${JSON.stringify(details)}\n`;
  fs.appendFileSync(alertLogPath, line);
}

function postWebhook(url, text) {
  const body = JSON.stringify({ text });
  const target = new URL(url);
  const lib = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Webhook HTTP ${res.statusCode}`));
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error('Webhook timeout'));
    });
    req.write(body);
    req.end();
  });
}

function shouldThrottle(type) {
  const { cooldownMs } = monitorConfig();
  const last = lastAlertAt.get(type) || 0;
  if (Date.now() - last < cooldownMs) return true;
  lastAlertAt.set(type, Date.now());
  return false;
}

async function alert(type, message, details = {}) {
  if (shouldThrottle(type)) {
    logger.warn('Monitor alert suppressed (cooldown)', { type, message });
    return;
  }

  const text = `[ALERT][${type}] ${message}`;
  logger.error(text, details);
  try {
    appendAlertLog(text, details);
  } catch (err) {
    logger.error('Failed to write alerts.log:', err.message);
  }

  const { webhookUrl } = monitorConfig();
  if (!webhookUrl) return;

  try {
    await postWebhook(
      webhookUrl,
      `${text}\n\`\`\`${JSON.stringify(details, null, 2)}\`\`\``,
    );
    logger.info('Monitor alert sent to webhook', { type });
  } catch (err) {
    logger.error('Monitor webhook delivery failed:', err.message, { type });
  }
}

function classifyError(err) {
  const msg = `${err?.message || err || ''}`.toLowerCase();
  const status = err?.response?.status ?? err?.status ?? err?.code;

  if (
    status === 401 ||
    status === 403 ||
    msg.includes('invalid_grant') ||
    msg.includes('invalid credentials') ||
    msg.includes('token has been expired') ||
    msg.includes('token has been revoked') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid authentication credentials')
  ) {
    return ALERT.OAUTH;
  }

  if (
    msg.includes('openai') ||
    msg.includes('incorrect api key') ||
    status === 429 ||
    msg.includes('rate limit')
  ) {
    return ALERT.OPENAI;
  }

  return ALERT.POLL_FAILED;
}

async function alertError(typeOrErr, message, err) {
  let type = typeOrErr;
  let error = err;
  if (err === undefined && typeOrErr instanceof Error) {
    error = typeOrErr;
    type = classifyError(error);
    message = error.message;
  } else if (err === undefined && typeof typeOrErr === 'string' && !message) {
    message = typeOrErr;
    type = ALERT.POLL_FAILED;
  }
  await alert(type, message, {
    error: error?.message || undefined,
    stack: error?.stack?.split('\n').slice(0, 3).join('\n') || undefined,
  });
}

function recordPollSuccess() {
  lastPollOkAt = Date.now();
  writeHeartbeat();
}

function startWatchdog(pollIntervalMs) {
  const { stalePollMultiplier } = monitorConfig();
  const staleMs = Math.max(
    pollIntervalMs * stalePollMultiplier,
    pollIntervalMs + 60_000,
  );

  if (watchdogTimer) clearInterval(watchdogTimer);

  const tickMs = Math.min(Math.max(pollIntervalMs / 2, 15_000), 60_000);
  watchdogTimer = setInterval(() => {
    if (!lastPollOkAt) return;
    const age = Date.now() - lastPollOkAt;
    if (age > staleMs) {
      alert(
        ALERT.PROCESS_STALE,
        `No successful Gmail poll in ${Math.round(age / 1000)}s (threshold ${Math.round(staleMs / 1000)}s)`,
        { lastPollOkAt: new Date(lastPollOkAt).toISOString(), staleMs },
      );
    }
  }, tickMs);

  if (watchdogTimer.unref) watchdogTimer.unref();
}

function installProcessHandlers() {
  process.on('uncaughtException', (err) => {
    alert(ALERT.FATAL, `Uncaught exception: ${err.message}`, {
      stack: err.stack,
    }).finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    alert(ALERT.FATAL, `Unhandled rejection: ${err.message}`, {
      stack: err.stack,
    }).finally(() => process.exit(1));
  });
}

/**
 * For cron/systemd: exit 1 if heartbeat is missing or too old (process likely down).
 */
async function checkHeartbeatHealth(pollIntervalMs) {
  const { healthStaleMultiplier } = monitorConfig();
  const thresholdMs = Math.max(
    pollIntervalMs * healthStaleMultiplier,
    pollIntervalMs + 120_000,
  );
  const age = heartbeatAgeMs();

  if (age === null) {
    const msg = 'Monitor: no heartbeat file — gmail-auto-reply may not be running';
    await alert(ALERT.PROCESS_DOWN, msg, { thresholdMs });
    return { ok: false, message: msg };
  }

  if (age > thresholdMs) {
    const msg = `Monitor: heartbeat stale (${Math.round(age / 1000)}s old, threshold ${Math.round(thresholdMs / 1000)}s)`;
    await alert(ALERT.PROCESS_DOWN, msg, {
      heartbeat: readHeartbeat(),
      ageMs: age,
      thresholdMs,
    });
    return { ok: false, message: msg };
  }

  return { ok: true, message: `OK (heartbeat ${Math.round(age / 1000)}s old)` };
}

module.exports = {
  ALERT,
  alert,
  alertError,
  classifyError,
  recordPollSuccess,
  startWatchdog,
  installProcessHandlers,
  checkHeartbeatHealth,
  writeHeartbeat,
  heartbeatAgeMs,
};
