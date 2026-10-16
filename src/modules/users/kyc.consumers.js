'use strict';

/**
 * M01 reacts to M02 KYC events (M02 §2, §6.2; M01-FR-14). M01 owns user_roles and users, so the
 * member role and users.kyc_status move here, inside the M04 inbox transaction:
 *   document.submitted          → member in_review, kyc pending
 *   verification.passed         → member active, kyc verified; legal name, DOB, NID hash and last 4
 *                                 copied from the approved NID (M02 getVerifiedIdentity)
 *   document.changes_requested  → member changes_requested, kyc unverified (with the reason)
 *   document.rejected           → member rejected, kyc rejected (with the reason)
 * An active or suspended member is never moved by these events (kyc.rules memberMove).
 */
const { onEvent } = require('../events/events.consumers');
const { UserRole, User } = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const authz = require('../auth/authz.service');
const rules = require('../kyc/kyc.rules');

async function applyKyc(userId, kind, { reasonCode = null, documentId = null } = {}, { transaction }) {
  const row = await UserRole.findOne({ where: { userId, role: 'member' }, transaction, lock: transaction.LOCK.UPDATE });
  if (!row) return null;
  const move = rules.memberMove(kind, row.status);
  if (!move) return null;
  const before = row.status;
  await row.update(
    { status: move.role, statusReasonCode: reasonCode, statusNote: null, activatedAt: move.role === 'active' ? new Date() : row.activatedAt },
    { transaction }
  );
  const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
  const identity = kind === 'approved' ? await require('../kyc/kyc.service').getVerifiedIdentity(userId, { transaction }) : null;
  await user.update(
    { kycStatus: move.kyc, ...(identity ? { legalName: identity.legalName, dob: identity.dob, nidHash: identity.nidHash, nidLast4: identity.nidLast4 } : {}) },
    { transaction }
  );
  await authz.bumpVersion(userId, { transaction });
  await audit.record(
    { action: `user_role.${move.role}`, actor: null, entityType: 'user_role', entityId: row.id, before: { status: before }, after: { status: move.role }, meta: { role: 'member', reasonCode, source: 'kyc', documentId } },
    { transaction }
  );
  if (move.role === 'active') {
    await events.publish(transaction, { name: 'user_role.activated', aggregateType: 'user_role', aggregateId: row.id, payload: { userId, role: 'member' } });
  }
  if (move.role === 'rejected') {
    await events.publish(transaction, { name: 'user_role.rejected', aggregateType: 'user_role', aggregateId: row.id, payload: { userId, role: 'member', reasonCode } });
  }
  return move;
}

function registerKycConsumers() {
  onEvent('document.submitted', 'identity.kyc-submitted', (e, { transaction }) => applyKyc(e.payload.userId, 'submitted', { documentId: e.payload.documentId }, { transaction }));
  onEvent('verification.passed', 'identity.kyc-passed', (e, { transaction }) => (e.payload.role === 'member' ? applyKyc(e.payload.userId, 'approved', {}, { transaction }) : null));
  onEvent('document.changes_requested', 'identity.kyc-changes', (e, { transaction }) =>
    applyKyc(e.payload.userId, 'changes_requested', { reasonCode: e.payload.reasonCode, documentId: e.payload.documentId }, { transaction })
  );
  onEvent('document.rejected', 'identity.kyc-rejected', (e, { transaction }) =>
    applyKyc(e.payload.userId, 'rejected', { reasonCode: e.payload.reasonCode, documentId: e.payload.documentId }, { transaction })
  );
}

module.exports = { registerKycConsumers, applyKyc };
