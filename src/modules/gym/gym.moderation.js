'use strict';

/**
 * M20 on M05 and the events it reacts to (§2):
 *  - adapter: kind `gym` for staff with approve_listings (masters see all); the owner's approved role
 *    is a locked check (no override);
 *  - consumers: M05 decisions on gym submissions; payment.failed / payment.expired (purposes
 *    gym_package and trainer_subscription) close what was not paid; a suspended or withdrawn gym_owner
 *    role, or a suspended or banned account, pauses the owner's live gyms. Loading this file also
 *    loads the services that register the M06 purpose hooks.
 * Registered once per process (subscriptions.registerAll).
 */
const adapters = require('../moderation/moderation.adapters');
const { onEvent } = require('../events/events.consumers');

adapters.register({
  kind: 'gym',
  permission: 'approve_listings',
  ownerWithdraw: false,
  lockedChecks: ['owner_kyc_approved'],
  checks: (submission, { transaction }) => require('./gyms.service').checksFor(submission.payload.gymId, { transaction }),
});

const APPLY = { 'submission.approved': 'approved', 'submission.changes_requested': 'changes_requested', 'submission.rejected': 'rejected', 'submission.withdrawn': 'withdrawn' };

function registerGymConsumers() {
  require('./passes.service'); // M06 purpose hook gym_package
  require('./subscriptions.service'); // M06 purpose hook trainer_subscription
  for (const [name, status] of Object.entries(APPLY)) {
    onEvent(name, `gym.apply-${status}`, (e, { transaction }) => {
      if (e.payload.kind !== 'gym' || (status === 'withdrawn' && e.payload.superseded)) return null;
      return require('./gyms.service').applyDecision(e.payload.submissionId, status, { transaction });
    });
  }
  for (const name of ['payment.failed', 'payment.expired']) {
    onEvent(name, `gym.unpaid-${name.split('.')[1]}`, (e, { transaction }) => {
      if (e.payload.purpose === 'gym_package') return require('./passes.service').onPaymentClosed(e.payload.paymentId, { transaction });
      if (e.payload.purpose === 'trainer_subscription') return require('./subscriptions.service').onPaymentClosed(e.payload.paymentId, { transaction });
      return null;
    });
  }
  for (const name of ['user_role.suspended', 'user_role.withdrawn']) {
    onEvent(name, `gym.owner-${name.split('.')[1]}`, (e, { transaction }) => (e.payload.role === 'gym_owner' ? require('./gyms.service').pauseAllOf(e.payload.userId, 'owner_role', { transaction }) : null));
  }
  for (const name of ['user.suspended', 'user.banned']) {
    onEvent(name, `gym.sanction-${name.split('.')[1]}`, (e, { transaction }) => require('./gyms.service').pauseAllOf(e.payload.userId, 'owner_sanction', { transaction }));
  }
}

module.exports = { registerGymConsumers };
