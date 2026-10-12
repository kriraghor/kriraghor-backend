'use strict';

const { UserRole, sequelize } = require('../../models');
const { E } = require('../../common/errors');
const { SELF_SERVICE_ROLES } = require('../../common/enums');
const audit = require('../audit/audit.service');
const passwords = require('../auth/password');
const sessions = require('../auth/session.service');
const authz = require('../auth/authz.service');
const gate = require('../auth/gate.service');

async function updateProfile(principal, { displayName, locale, lastPanelRole }, req) {
  const { user } = principal;
  if (lastPanelRole && !principal.roles[lastPanelRole]) throw E.badRequest('ROLE_NOT_HELD', 'You do not have that role');
  const before = { displayName: user.displayName, locale: user.locale, lastPanelRole: user.lastPanelRole };
  const changes = {};
  if (displayName !== undefined) changes.displayName = displayName;
  if (locale !== undefined) changes.locale = locale;
  if (lastPanelRole !== undefined) changes.lastPanelRole = lastPanelRole;
  await sequelize.transaction(async (transaction) => {
    await user.update(changes, { transaction });
    await audit.record({ action: 'user.profile_updated', actor: principal, entityType: 'user', entityId: user.id, before, after: changes, req }, { transaction });
  });
}

function gatePreview(principal, action) {
  const result = gate.evaluateAction(principal, action);
  if (!result) throw E.badRequest('GATE_ACTION_UNKNOWN', 'Unknown action');
  return { action, ...result };
}

/** Apply for (or re-open) a self-service role (M01-FR-13). */
async function applyForRole(principal, { role, meta }, req) {
  if (!SELF_SERVICE_ROLES.includes(role)) throw E.badRequest('ROLE_NOT_SELF_SERVICE', 'That role cannot be requested');
  return sequelize.transaction(async (transaction) => {
    const existing = await UserRole.findOne({ where: { userId: principal.id, role }, transaction, lock: transaction.LOCK.UPDATE });
    let row;
    if (!existing) {
      row = await UserRole.create({ userId: principal.id, role, status: 'applied', meta: meta ?? null }, { transaction });
    } else if (['rejected', 'withdrawn'].includes(existing.status)) {
      row = await existing.update(
        { status: 'applied', attempt: existing.attempt + 1, meta: meta ?? existing.meta, appliedAt: new Date(), statusReasonCode: null, statusNote: null },
        { transaction }
      );
    } else {
      throw E.conflict('ROLE_ALREADY_APPLIED', 'You already have this role or an open application for it');
    }
    await authz.bumpVersion(principal.id, { transaction });
    await audit.record({ action: 'user_role.applied', actor: principal, entityType: 'user_role', entityId: row.id, after: { role, attempt: row.attempt }, req }, { transaction });
    return row.toPublic();
  });
}

async function withdrawRole(principal, role, req) {
  return sequelize.transaction(async (transaction) => {
    const row = await UserRole.findOne({ where: { userId: principal.id, role }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row || !SELF_SERVICE_ROLES.includes(role)) throw E.notFound('Role application');
    if (!['applied', 'documents_pending', 'in_review', 'changes_requested'].includes(row.status)) {
      throw E.conflict('ROLE_NOT_WITHDRAWABLE', 'Only open applications can be withdrawn');
    }
    const before = row.status;
    await row.update({ status: 'withdrawn' }, { transaction });
    await authz.bumpVersion(principal.id, { transaction });
    await audit.record({ action: 'user_role.withdrawn', actor: principal, entityType: 'user_role', entityId: row.id, before: { status: before }, after: { status: 'withdrawn' }, req }, { transaction });
    return row.toPublic();
  });
}

/** Set or change the password; other sessions are signed out. */
async function changePassword(principal, { currentPassword, newPassword }, req) {
  const { user } = principal;
  if (user.passwordHash) {
    if (!currentPassword || !(await passwords.verify(user.passwordHash, currentPassword))) {
      throw E.badRequest('PASSWORD_INCORRECT', 'Your current password is not right');
    }
  }
  await passwords.assertAcceptable(newPassword, { identifiers: [user.phone, user.email, user.displayName] });
  const passwordHash = await passwords.hash(newPassword);
  await sequelize.transaction(async (transaction) => {
    await user.update({ passwordHash }, { transaction });
    await sessions.revokeAllForUser(user.id, 'password_change', { exceptFamilyId: req.auth.familyId, transaction });
    await audit.record({ action: 'user.password_changed', actor: principal, entityType: 'user', entityId: user.id, req }, { transaction });
  });
}

async function listSessions(principal, currentFamilyId) {
  const rows = await sessions.listActive(principal.id);
  return rows.map((s) => ({
    id: s.id,
    device: s.deviceLabel,
    ip: s.ip,
    lastSeenAt: s.lastSeenAt,
    createdAt: s.createdAt,
    current: s.familyId === currentFamilyId,
  }));
}

async function revokeSession(principal, sessionId, req) {
  const rows = await sessions.listActive(principal.id);
  const target = rows.find((s) => s.id === sessionId);
  if (!target) throw E.notFound('Session');
  await sequelize.transaction(async (transaction) => {
    await sessions.revokeFamilyOf(target.id, 'logout', { transaction });
    await audit.record({ action: 'session.revoked', actor: principal, entityType: 'session', entityId: target.id, req }, { transaction });
  });
}

module.exports = { updateProfile, gatePreview, applyForRole, withdrawRole, changePassword, listSessions, revokeSession };
