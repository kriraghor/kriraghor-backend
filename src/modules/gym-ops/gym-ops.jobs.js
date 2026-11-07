'use strict';

/**
 * M27 jobs (BullMQ, src/jobs/definitions.js):
 *  - gym-ops.daily (09:00 Dhaka): locker rentals ending soon are reminded once and ended ones free their
 *    lockers (M27-FR-25); products near or past their expiry date alert the gym once per date (M27-FR-15).
 * Idempotent: every step checks its row's state in its own transaction.
 */
const lockers = require('./lockers.service');
const shop = require('./shop.service');

async function daily(now = new Date()) {
  const rentals = await lockers.daily(now);
  const expiring = await shop.expiryAlerts(now);
  return { ...rentals, expiring };
}

module.exports = { daily };
