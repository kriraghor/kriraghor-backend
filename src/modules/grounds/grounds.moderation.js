'use strict';

/**
 * M09 on M05 (FR-02, FR-03) and the M01 events it reacts to (§2.2).
 *  - adapter: kind `ground` for staff with approve_listings (masters see all); the owner's documents
 *    are a locked check (no override);
 *  - consumers: M05 decisions on ground submissions; an owner whose ground_owner role is suspended or
 *    withdrawn, or whose account is suspended or banned, has every live ground paused (§2.2).
 * Registered once per process (registry.registerAll).
 */
const adapters = require('../moderation/moderation.adapters');
const { onEvent } = require('../events/events.consumers');

adapters.register({
  kind: 'ground',
  permission: 'approve_listings',
  ownerWithdraw: false,
  lockedChecks: ['owner_kyc_approved'],
  checks: (submission, { transaction }) => require('./grounds.service').checksFor(submission.payload.groundId, { transaction }),
});

const APPLY = { 'submission.approved': 'approved', 'submission.changes_requested': 'changes_requested', 'submission.rejected': 'rejected', 'submission.withdrawn': 'withdrawn' };

function registerGroundsConsumers() {
  for (const [name, status] of Object.entries(APPLY)) {
    onEvent(name, `grounds.apply-${status}`, (e, { transaction }) => {
      if (e.payload.kind !== 'ground' || (status === 'withdrawn' && e.payload.superseded)) return null;
      return require('./grounds.service').applyDecision(e.payload.submissionId, status, { transaction });
    });
  }
  for (const name of ['user_role.suspended', 'user_role.withdrawn']) {
    onEvent(name, `grounds.owner-${name.split('.')[1]}`, (e, { transaction }) =>
      e.payload.role === 'ground_owner' ? require('./grounds.service').pauseAllOf(e.payload.userId, 'owner_role', { transaction }) : null
    );
  }
  for (const name of ['user.suspended', 'user.banned']) {
    onEvent(name, `grounds.sanction-${name.split('.')[1]}`, (e, { transaction }) => require('./grounds.service').pauseAllOf(e.payload.userId, 'owner_sanction', { transaction }));
  }
  // M17: the rating on the ground follows the published reviews (read at consume time, so a late or
  // replayed event never writes an old figure).
  onEvent('review.aggregate_updated', 'grounds.rating', async (e, { transaction }) => {
    if (e.payload.subjectType !== 'ground') return null;
    const r = await require('../trust/reviews.service').ratingOf('ground', e.payload.subjectId, { transaction });
    return require('./grounds.service').setRating(e.payload.subjectId, r, { transaction });
  });
}

module.exports = { registerGroundsConsumers };
