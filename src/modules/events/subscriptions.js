'use strict';

/**
 * Every event consumer in the system, registered once per process at boot (api for replay checks,
 * worker for delivery). Each module adds its consumers here when it is built; M08 will add the
 * notification consumers for audit.critical_recorded, setting.* and the M01 events.
 */
const logger = require('../../common/logger');
const { onEvent } = require('./events.consumers');

let registered = false;

function registerAll() {
  if (registered) return;
  registered = true;

  // M04 ops: critical audit actions and dead letters always reach the logs (alerting reads them
  // until M08 sends in-app and email alerts to masters).
  onEvent('audit.critical_recorded', 'ops.log-critical', async (event) => {
    logger.warn({ eventId: event.id, action: event.payload.action, auditLogId: event.payload.auditLogId, actorId: event.payload.actorId }, 'critical audit action');
  });
  onEvent('outbox.event_dead_lettered', 'ops.log-dead-letter', async (event) => {
    logger.error({ eventId: event.payload.eventId, eventType: event.payload.eventType, consumer: event.payload.consumer }, 'event dead-lettered');
  });
  onEvent('audit.chain_mismatch_detected', 'ops.log-chain-mismatch', async (event) => {
    logger.error({ seq: event.payload.seq, auditLogId: event.payload.auditLogId }, 'audit hash chain mismatch');
  });
}

module.exports = { registerAll };
