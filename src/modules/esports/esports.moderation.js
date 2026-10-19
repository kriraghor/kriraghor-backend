'use strict';

/**
 * M21 on M05 (FR-02, FR-07) and the other modules' events it reacts to (spec §2.2).
 *  - adapters: game_profile (UID screenshot check) and esports_tournament (pre-publish review), both for
 *    staff with approve_listings (masters see all); UID taken / banned are locked checks (no override);
 *  - consumers: M05 decisions, M06 payment failures, M01 sanctions;
 *  - M06 hook: esports_entry captures confirm the entry in the capture transaction.
 * Registered once per process (registry.registerAll).
 */
const adapters = require('../moderation/moderation.adapters');
const { onEvent } = require('../events/events.consumers');
const purposes = require('../payments').purposes;

adapters.register({
  kind: 'game_profile',
  permission: 'approve_listings',
  ownerWithdraw: false,
  lockedChecks: ['uid_not_banned', 'uid_unique'],
  checks: (submission, { transaction }) => require('./profiles.service').checksFor(submission.payload.profileId, { transaction }),
});

adapters.register({
  kind: 'esports_tournament',
  permission: 'approve_listings',
  ownerWithdraw: false,
  checks: (submission, { transaction }) => require('./tournaments.service').checksFor(submission.payload.tournamentId, { transaction }),
});

purposes.register('esports_entry', { onCaptured: (args) => require('./registrations.service').onCaptured(args) });

const APPLY = { 'submission.approved': 'approved', 'submission.changes_requested': 'changes_requested', 'submission.rejected': 'rejected', 'submission.withdrawn': 'withdrawn' };
const SERVICE = { game_profile: './profiles.service', esports_tournament: './tournaments.service' };

function registerEsportsConsumers() {
  for (const [name, status] of Object.entries(APPLY)) {
    onEvent(name, `esports.apply-${status}`, async (e, { transaction }) => {
      const svc = SERVICE[e.payload.kind];
      if (!svc || (status === 'withdrawn' && e.payload.superseded)) return null;
      return require(svc).applyDecision(e.payload.submissionId, status, { transaction });
    });
  }
  for (const name of ['payment.failed', 'payment.expired']) {
    onEvent(name, `esports.release-${name.split('.')[1]}`, (e, { transaction }) => (e.payload.purpose === 'esports_entry' ? require('./registrations.service').onPaymentClosed(e.payload.paymentId, { transaction }) : null));
  }
  for (const name of ['user.suspended', 'user.banned']) {
    onEvent(name, `esports.sanction-${name.split('.')[1]}`, (e, { transaction }) => require('./registrations.service').withdrawForSanction(e.payload.userId, { transaction }));
  }
}

module.exports = { registerEsportsConsumers };
