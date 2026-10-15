'use strict';

/**
 * Every event consumer in the system, registered once per process at boot (api for replay checks,
 * worker for delivery). Each module adds its consumers here when it is built.
 */
const logger = require('../../common/logger');
const { onEvent } = require('./events.consumers');
const { registerNotifications } = require('../notifications/notify.subscriptions');

let registered = false;

function registerAll() {
  if (registered) return;
  registered = true;

  // M08: notifications for every catalogue entry (critical audit alerts and dead letters included).
  registerNotifications();

  // M04 ops: a broken audit chain always reaches the logs (no notification code for it yet).
  onEvent('audit.chain_mismatch_detected', 'ops.log-chain-mismatch', async (event) => {
    logger.error({ seq: event.payload.seq, auditLogId: event.payload.auditLogId }, 'audit hash chain mismatch');
  });
}

module.exports = { registerAll };
