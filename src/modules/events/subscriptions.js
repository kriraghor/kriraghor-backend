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

  // M07: refund payouts and account-suspension holds.
  require('../payouts/payouts.consumers').registerPayoutConsumers();

  // M05: applied acknowledgements and sanctions; M02 applies document decisions from M05.
  require('../moderation/moderation.consumers').registerModerationConsumers();
  require('../kyc/kyc.moderation').registerKycModeration();

  // M21: M05 decisions for game profiles and tournaments, payment failures, sanctions.
  require('../esports/esports.moderation').registerEsportsConsumers();

  // M01 ← M02: the member role follows the NID review.
  require('../users/kyc.consumers').registerKycConsumers();

  // M04 ops: a broken audit chain always reaches the logs (no notification code for it yet).
  onEvent('audit.chain_mismatch_detected', 'ops.log-chain-mismatch', async (event) => {
    logger.error({ seq: event.payload.seq, auditLogId: event.payload.auditLogId }, 'audit hash chain mismatch');
  });
}

module.exports = { registerAll };
