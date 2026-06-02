#!/usr/bin/env node
/**
 * External liveness check — run from cron every few minutes.
 * Exits 0 if heartbeat is fresh; 1 and alerts if the main process is down or stuck.
 *
 * Example cron (every 5 min):
 *   */5 * * * * cd /path/to/gmail-auto-reply && node scripts/monitor-health-check.js
 */

require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env'),
  override: true,
});

const { checkHeartbeatHealth } = require('../src/monitor');

async function main() {
  const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
  if (Number.isNaN(pollIntervalMs) || pollIntervalMs < 1000) {
    console.error('Invalid POLL_INTERVAL_MS');
    process.exit(1);
  }

  const result = await checkHeartbeatHealth(pollIntervalMs);
  if (result.ok) {
    console.log(result.message);
    process.exit(0);
  }

  console.error(result.message);
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
