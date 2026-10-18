'use strict';

/**
 * M14 clock (job tournaments.tick, every minute on the `tournaments` queue): registration closes at its
 * time, unlocked rules lock again, unpaid holds and lapsed reserve offers end and free places go to
 * the next reserve team. Each step locks its row and re-checks the status, so a retry is harmless.
 */
const tournaments = require('./tournaments.service');
const registrations = require('./registrations.service');

async function tick(now = new Date()) {
  await registrations.expireHolds(now);
  await tournaments.sweep(now);
}

module.exports = { tick };
