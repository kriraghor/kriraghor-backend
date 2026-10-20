'use strict';

/**
 * The composition root (ADR-007 §3, rule 3): every module's event consumers, registered once per
 * process at boot (api for replay checks, worker for delivery). This file sits outside every module,
 * so the events module itself imports none of them. The order is the boot order and matters (the
 * notification catalogue first; purpose hooks load with their module's consumers); keep it when adding
 * a module.
 */
const logger = require('../common/logger');
const { onEvent } = require('./events/events.consumers');
const { registerNotifications } = require('./notifications/notify.subscriptions');

let registered = false;

function registerAll() {
  if (registered) return;
  registered = true;

  // M08: notifications for every catalogue entry (critical audit alerts and dead letters included).
  registerNotifications();

  // M07: refund payouts and account-suspension holds.
  require('./payouts/payouts.consumers').registerPayoutConsumers();

  // M05: applied acknowledgements and sanctions; M02 applies document decisions from M05.
  require('./moderation/moderation.consumers').registerModerationConsumers();
  require('./kyc/kyc.moderation').registerKycModeration();

  // M21: M05 decisions for game profiles and tournaments, payment failures, sanctions.
  require('./esports/esports.moderation').registerEsportsConsumers();
  require('./grounds/grounds.moderation').registerGroundsConsumers();
  // M12: M05 decisions for shops and products, owner sanctions pause the shop, saved-item alerts.
  require('./market/market.moderation').registerMarketConsumers();
  // M13: payment failures cancel unpaid orders (and the purpose hook loads with them).
  require('./orders/orders.consumers').registerOrdersConsumers();
  // M11: M05 decisions on hire profiles, payment failures lapse requests, sanctions pause profiles.
  require('./hire/hire.moderation').registerHireConsumers();
  // M20: M05 decisions on gyms, unpaid passes and months close, sanctions pause gyms.
  require('./gym/gym.moderation').registerGymConsumers();
  // M14 lite and M22: M05 decisions on organisations; the M21 organiser hooks and M06 purpose hooks.
  require('./organisations/organisations.moderation').registerOrganisationConsumers();
  require('./organiser-saas/saas.hooks');
  require('./organiser-saas/invoices.service');
  require('./organiser-saas/prize-funds.service');
  // M16: banned accounts leave their teams; newly verified phones pick up their team invites.
  require('./teams/teams.consumers').registerTeamsConsumers();
  require('./tournaments/tournaments.moderation').registerTournamentConsumers();
  // M23: big events react to M21 (qualifiers finalised, entries closed, cancels, streams live); the
  // M21 entry-policy hooks for invite-only finals load with them.
  require('./esports-events/events.consumers').registerEsportsEventConsumers();
  // M10: payment failures end holds; suspended or removed grounds cancel their bookings.
  require('./bookings/bookings.consumers').registerBookingsConsumers();
  // M19: read models from bookings, closures, series, payments, the ledger and esports.
  require('./analytics/facts.consumers').registerAnalyticsConsumers();

  // M18: events schedule risk evaluations and reliability; overdue document requests raise their flag.
  require('./risk/risk.consumers').registerRiskConsumers();

  // M01 ← M02: the member role follows the NID review.
  require('./users/kyc.consumers').registerKycConsumers();

  // M04 ops: a broken audit chain always reaches the logs (no notification code for it yet).
  onEvent('audit.chain_mismatch_detected', 'ops.log-chain-mismatch', async (event) => {
    logger.error({ seq: event.payload.seq, auditLogId: event.payload.auditLogId }, 'audit hash chain mismatch');
  });
}

module.exports = { registerAll };
