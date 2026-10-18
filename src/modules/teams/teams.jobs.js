'use strict';

/** M16 tick (job teams.tick, every 5 minutes, queue teams): pending invites past expires_at expire. */
const invites = require('./invites.service');

async function tick(now = new Date()) {
  return { expired: await invites.sweep(now) };
}

module.exports = { tick };
