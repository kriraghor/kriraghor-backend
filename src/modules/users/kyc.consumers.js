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
 *
 * Business roles (ground_owner, with M09) follow their own documents (the event carries the role):
 *   document.submitted → in_review; .changes_requested / .rejected → the same; verification.passed
 *   {role} → active, but only once the member (NID) role is active (M01-FR-14).
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

async function applyBusinessRole(userId, role, kind, { reasonCode = null, documentId = null } = {}, { transaction }) {
  const row = await UserRole.findOne({ where: { userId, role }, transaction, lock: transaction.LOCK.UPDATE });
  if (!row) return null;
  let to;
  if (kind === 'approved') {
    const member = await UserRole.findOne({ where: { userId, role: 'member' }, transaction });
    if (member?.status !== 'active' || !rules.businessMove('submitted', row.status)) return null;
    to = 'active';
  } else {
    to = rules.businessMove(kind, row.status);
    if (!to || to === row.status) return null;
  }
  const before = row.status;
  await row.update({ status: to, statusReasonCode: reasonCode, statusNote: null, activatedAt: to === 'active' ? new Date() : row.activatedAt }, { transaction });
  await authz.bumpVersion(userId, { transaction });
  await audit.record(
    { action: `user_role.${to}`, actor: null, entityType: 'user_role', entityId: row.id, before: { status: before }, after: { status: to }, meta: { role, reasonCode, source: 'kyc', documentId } },
    { transaction }
  );
  if (to === 'active') await events.publish(transaction, { name: 'user_role.activated', aggregateType: 'user_role', aggregateId: row.id, payload: { userId, role } });
  if (to === 'rejected') await events.publish(transaction, { name: 'user_role.rejected', aggregateType: 'user_role', aggregateId: row.id, payload: { userId, role, reasonCode } });
  return to;
}

/** Route a document event to the member role or to the business role it belongs to. */
const route = (e, kind, extra, ctx) =>
  !e.payload.role || e.payload.role === 'member' ? applyKyc(e.payload.userId, kind, extra, ctx) : applyBusinessRole(e.payload.userId, e.payload.role, kind, extra, ctx);

function registerKycConsumers() {
  onEvent('document.submitted', 'identity.kyc-submitted', (e, { transaction }) => route(e, 'submitted', { documentId: e.payload.documentId }, { transaction }));
  onEvent('verification.passed', 'identity.kyc-passed', (e, { transaction }) => (e.payload.role === 'member' ? applyKyc(e.payload.userId, 'approved', {}, { transaction }) : applyBusinessRole(e.payload.userId, e.payload.role, 'approved', {}, { transaction })));
  onEvent('document.changes_requested', 'identity.kyc-changes', (e, { transaction }) =>
    route(e, 'changes_requested', { reasonCode: e.payload.reasonCode, documentId: e.payload.documentId }, { transaction })
  );
  onEvent('document.rejected', 'identity.kyc-rejected', (e, { transaction }) =>
    route(e, 'rejected', { reasonCode: e.payload.reasonCode, documentId: e.payload.documentId }, { transaction })
  );
}

module.exports = { registerKycConsumers, applyKyc, applyBusinessRole };
