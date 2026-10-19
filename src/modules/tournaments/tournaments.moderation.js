'use strict';

/**
 * M14 on M05 and the events it reacts to:
 *  - adapter: kind `tournament` for staff with approve_listings (masters see all); the organisation
 *    being verified is a locked check (no override);
 *  - consumers: M05 decisions on tournament submissions; payment.failed / payment.expired (purpose
 *    tournament_entry) end unpaid registrations. Loading the registrations service registers the M06
 *    purpose hook.
 * Registered once per process (registry.registerAll).
 */
const adapters = require('../moderation/moderation.adapters');
const { onEvent } = require('../events/events.consumers');

adapters.register({
  kind: 'tournament',
  permission: 'approve_listings',
  ownerWithdraw: false,
  lockedChecks: ['org_verified'],
  checks: (submission, { transaction }) => require('./tournaments.service').checksFor(submission.payload.tournamentId, { transaction }),
});

const APPLY = { 'submission.approved': 'approved', 'submission.changes_requested': 'changes_requested', 'submission.rejected': 'rejected', 'submission.withdrawn': 'withdrawn' };

function registerTournamentConsumers() {
  require('./registrations.service'); // M06 purpose hook tournament_entry
  for (const [name, status] of Object.entries(APPLY)) {
    onEvent(name, `tournaments.apply-${status}`, (e, { transaction }) => {
      if (e.payload.kind !== 'tournament' || (status === 'withdrawn' && e.payload.superseded)) return null;
      return require('./tournaments.service').applyDecision(e.payload.submissionId, status, { transaction });
    });
  }
  for (const name of ['payment.failed', 'payment.expired']) {
    onEvent(name, `tournaments.unpaid-${name.split('.')[1]}`, (e, { transaction }) =>
      e.payload.purpose === 'tournament_entry' ? require('./registrations.service').onPaymentClosed(e.payload.paymentId, { transaction }) : null
    );
  }
}

module.exports = { registerTournamentConsumers };
