'use strict';

/**
 * M11 tick (one BullMQ job, hire.tick, every minute; §10). Every step locks the row and re-checks its
 * status, so a repeat or an overlap is harmless:
 *   pending requests past reply_by        expired (FR-23)
 *   accepted requests past pay_by         lapsed: the reserved jobs are void, the time is free (FR-26)
 *   scheduled jobs whose check-in opens   one reminder to the pro
 *   jobs marked complete past release_at  released to the pro when no dispute is open (v3)
 */
const requests = require('./requests.service');
const jobs = require('./jobs.service');

async function tick(now = new Date()) {
  return { ...(await requests.sweep(now)), ...(await jobs.sweep(now)) };
}

module.exports = { tick };
