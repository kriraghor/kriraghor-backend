'use strict';

/**
 * M11 on M05 and the events it reacts to (§2):
 *  - adapter: kind `hire_profile` for staff with approve_listings (masters see all); NID and the
 *    credential are locked checks;
 *  - consumers: M05 decisions on profile submissions; payment.failed / payment.expired (purpose hire)
 *    lapse the request; a suspended player or pro role, or a suspended or banned account, pauses the
 *    live profiles. Loading this file also loads requests.service (the M06 purpose hook).
 * Registered once per process (registry.registerAll).
 */
const adapters = require('../moderation').adapters;
const { onEvent } = require('../events').consumers;

adapters.register({
  kind: 'hire_profile',
  permission: 'approve_listings',
  ownerWithdraw: false,
  lockedChecks: ['nid_verified', 'credential_covers'],
  checks: (submission, { transaction }) => require('./profiles.service').checksFor(submission.payload.profileId, { transaction }),
});

const APPLY = { 'submission.approved': 'approved', 'submission.changes_requested': 'changes_requested', 'submission.rejected': 'rejected', 'submission.withdrawn': 'withdrawn' };

function registerHireConsumers() {
  require('./requests.service'); // the M06 purpose hook
  require('./hire.consumers').registerHireStatsConsumers(); // Round B1: jobs done, acceptance, reply time (FR-52)
  for (const [name, status] of Object.entries(APPLY)) {
    onEvent(name, `hire.apply-${status}`, (e, { transaction }) => {
      if (e.payload.kind !== 'hire_profile' || (status === 'withdrawn' && e.payload.superseded)) return null;
      return require('./profiles.service').applyDecision(e.payload.submissionId, status, { transaction });
    });
  }
  for (const name of ['payment.failed', 'payment.expired']) {
    onEvent(name, `hire.lapse-${name.split('.')[1]}`, (e, { transaction }) => (e.payload.purpose === 'hire' ? require('./requests.service').onPaymentClosed(e.payload.paymentId, { transaction }) : null));
  }
  for (const name of ['user_role.suspended', 'user_role.withdrawn']) {
    onEvent(name, `hire.role-${name.split('.')[1]}`, (e, { transaction }) => (['player', 'pro'].includes(e.payload.role) ? require('./profiles.service').pauseAllOf(e.payload.userId, { transaction }) : null));
  }
  for (const name of ['user.suspended', 'user.banned']) {
    onEvent(name, `hire.sanction-${name.split('.')[1]}`, (e, { transaction }) => require('./profiles.service').pauseAllOf(e.payload.userId, { transaction }));
  }
}

module.exports = { registerHireConsumers };
