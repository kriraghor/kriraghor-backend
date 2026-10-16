'use strict';

/**
 * M02 on M05 (M02-FR-08, FR-09; M05 §6.6). Identity documents are the `document` kind:
 *  - the adapter: reviewers need approve_documents; checks are recomputed from the document on every
 *    claim (a duplicate NID may appear while an item waits);
 *  - consumers: M05 decisions are applied to the document, then the document.* events (M01 moves the
 *    member role) and, on approval, verification.passed and the submission.applied acknowledgement.
 * Owners do not withdraw through /me/submissions: a resubmission on /account/verification supersedes.
 */
const crypto = require('crypto');
const { onEvent } = require('../events/events.consumers');
const adapters = require('../moderation/moderation.adapters');
const { LOCKED_CHECKS } = require('./kyc.rules');

/** One stable subject per user, document type and subject key, so versions line up in M05. */
function subjectIdFor(userId, docType, subjectKey = '') {
  const h = crypto.createHash('sha1').update(`kyc:${userId}:${docType}:${subjectKey}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

// M02 check results → M05 rows: blocking checks are hard, warnings soft.
const toModeration = (checks) => checks.map((c) => ({ key: c.key, severity: c.blocks ? 'hard' : 'soft', result: c.ok ? 'pass' : c.blocks ? 'fail' : 'warn', detail: c.detail ?? null }));

adapters.register({
  kind: 'document',
  permission: 'approve_documents',
  ownerWithdraw: false,
  lockedChecks: LOCKED_CHECKS,
  async checks(submission, { transaction }) {
    return toModeration(await require('./kyc.service').checksFor(submission.payload.documentId, { transaction }));
  },
});

function registerKycModeration() {
  const kyc = () => require('./kyc.service');
  const forDocuments = (fn) => async (e, ctx) => (e.payload.kind === 'document' ? fn(e, ctx) : null);
  onEvent('submission.approved', 'kyc.apply-approved', forDocuments((e, { transaction }) => kyc().applyDecision(e.payload.submissionId, 'approved', { transaction })));
  onEvent('submission.changes_requested', 'kyc.apply-changes', forDocuments((e, { transaction }) => kyc().applyDecision(e.payload.submissionId, 'changes_requested', { transaction })));
  onEvent('submission.rejected', 'kyc.apply-rejected', forDocuments((e, { transaction }) => kyc().applyDecision(e.payload.submissionId, 'rejected', { transaction })));
  onEvent('submission.withdrawn', 'kyc.apply-withdrawn', forDocuments((e, { transaction }) => (e.payload.superseded ? null : kyc().applyDecision(e.payload.submissionId, 'withdrawn', { transaction }))));
}

module.exports = { registerKycModeration, subjectIdFor, toModeration };
