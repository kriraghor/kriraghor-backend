'use strict';

/**
 * M22 tick (one BullMQ job, saas.tick, every minute; §10). Every step locks its row and re-checks
 * its status, so a repeat or an overlap is harmless:
 *   active flat contracts                  the invoice for today's month or quarter (key per period)
 *   issued invoices past their due date     overdue (and, past the grace days, submits are blocked)
 *   paid invoices                           collected to fee revenue (normally done at capture)
 *   contracts past ends_on                  ended; the expiry reminder goes notice days before
 * Prize funds settle inside M21's finalise and cancel (no job: same transaction as the payout).
 */
const invoices = require('./invoices.service');
const contracts = require('./contracts.service');

async function tick(now = new Date()) {
  const c = await contracts.sweep(now);
  const i = await invoices.sweep(now);
  return { ...i, contractsEnded: c.ended, expiryNotices: c.notified };
}

module.exports = { tick };
