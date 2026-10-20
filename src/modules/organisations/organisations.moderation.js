'use strict';

/**
 * M14 lite on M05: kind `organisation` for staff with approve_listings (masters see all). The owner's
 * organiser role (documents approved) is a locked check: no override. Consumers apply the decisions.
 * Registered once per process (registry.registerAll).
 */
const adapters = require('../moderation').adapters;
const { onEvent } = require('../events').consumers;

adapters.register({
  kind: 'organisation',
  permission: 'approve_listings',
  ownerWithdraw: false,
  lockedChecks: ['owner_documents_approved'],
  checks: (submission, { transaction }) => require('./organisations.service').checksFor(submission.payload.organisationId, { transaction }),
});

const APPLY = { 'submission.approved': 'approved', 'submission.changes_requested': 'changes_requested', 'submission.rejected': 'rejected', 'submission.withdrawn': 'withdrawn' };

function registerOrganisationConsumers() {
  for (const [name, status] of Object.entries(APPLY)) {
    onEvent(name, `organisation.apply-${status}`, (e, { transaction }) => {
      if (e.payload.kind !== 'organisation' || (status === 'withdrawn' && e.payload.superseded)) return null;
      return require('./organisations.service').applyDecision(e.payload.submissionId, status, { transaction });
    });
  }
}

module.exports = { registerOrganisationConsumers };
