'use strict';

/**
 * M20 tick (one BullMQ job, gym.tick, every minute; §10). Every step locks the row and re-checks its
 * status, so a repeat or an overlap is harmless:
 *   unpaid passes past pay_by                       void (capacity frees)
 *   active passes past closing on their last day    expired; money not yet released goes to the gym (Q110)
 *   unpaid first months                             the subscription never starts
 *   paid months near their end                      next month's row appears; the member is told
 *   subscriptions past the grace days unpaid        lapsed; renewal switched off and ended → ended
 *   paid months past their release time             released to the trainer minus fees.gym_pct
 */
const passes = require('./passes.service');
const subscriptions = require('./subscriptions.service');

async function tick(now = new Date()) {
  return { ...(await passes.sweep(now)), ...(await subscriptions.sweep(now)) };
}

module.exports = { tick };
