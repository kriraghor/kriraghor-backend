'use strict';

const { Queue } = require('bullmq');
const config = require('../config');
const { createRedis } = require('../common/redis');

/** Every BullMQ queue in the system. Modules add their queue here when they add jobs. */
const QUEUES = Object.freeze({
  IDENTITY: 'identity',
  SETTINGS: 'settings',
  OUTBOX: 'outbox', // outbox.relay
  EVENTS: 'events', // events.consume (one job per event and consumer)
  AUDIT: 'audit', // chain seal and verify, exports
  NOTIFY: 'notify', // M08 deliveries and their schedules
  PAYMENTS: 'payments', // M06 polls, refunds, expiry, escrow releases, invariants, reconciliation
  PAYOUTS: 'payouts', // M07 schedule runs and hold expiry
  KYC: 'kyc', // M02 retention purge
  MODERATION: 'moderation', // M05 claim expiry, SLA breaches, apply watchdog
  ESPORTS: 'esports', // M21 lifecycle tick, rankings
  BOOKINGS: 'bookings', // M10 tick: hold expiry, completion, reminders, unrecorded balances
  ANALYTICS: 'analytics', // M19 view refresh, nightly reconcile and occupancy rebuild
  TRUST: 'trust', // M17 respondent reminders and timeouts, SLA breaches, claim expiry
  MARKET: 'market', // M12 supplement expiry, inventory reconcile, visibility sweep
  HIRE: 'hire', // M11 tick: request expiry and lapse, check-in reminders, auto-release
  GYM: 'gym', // M20 tick: unpaid and expired passes, trainer renewals, lapses and monthly releases
  SAAS: 'saas', // M22 tick: flat-fee invoices, overdue invoices, contract expiry
  ESPORTS_EVENTS: 'esports_events', // M23 tick: event start and final reminders, final live, polls closing, missed places
  ORDERS: 'orders', // M13 tick: unpaid orders, accept expiry and reminders, overdue shipping, auto-complete
  RISK: 'risk', // M18 evaluations (debounced per user), re-evaluation after a threshold change, nightly runs
});

const prefix = `${config.redis.prefix}:bull`;
const queues = new Map();

/** Producer-side queue (lazily created, one connection per queue). */
function getQueue(name) {
  if (!Object.values(QUEUES).includes(name)) throw new Error(`Unknown queue: ${name}`);
  if (!queues.has(name)) {
    queues.set(name, new Queue(name, { connection: createRedis(`queue:${name}`, { bullmq: true }), prefix }));
  }
  return queues.get(name);
}

async function closeQueues() {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
}

module.exports = { QUEUES, getQueue, closeQueues, prefix };
