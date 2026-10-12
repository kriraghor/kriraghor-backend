'use strict';

const { User, UserRole, StaffMember, StaffPermission, sequelize } = require('../../models');
const { E, AppError } = require('../../common/errors');
const { ROLES, PERMISSION_LIST, MASTER_ONLY_PERMISSIONS } = require('../../common/enums');
const audit = require('../audit/audit.service');
const sessions = require('../auth/session.service');
const authz = require('../auth/authz.service');
const { maskPhone, maskEmail } = require('../../common/identifiers');

const GRANTABLE = PERMISSION_LIST.filter((p) => !MASTER_ONLY_PERMISSIONS.includes(p));

async function list() {
  const staff = await StaffMember.findAll({
    include: [{ model: User, as: 'user', include: [{ association: 'staffPermissions', where: { revokedAt: null }, required: false }] }],
    order: [['isMaster', 'DESC'], ['createdAt', 'ASC']],
  });
  return {
    grantable: GRANTABLE,
    locked: MASTER_ONLY_PERMISSIONS,
    data: staff.map((s) => ({
      userId: s.userId,
      displayName: s.user.displayName,
      phone: maskPhone(s.user.phone),
      email: maskEmail(s.user.email),
      employeeId: s.employeeId,
      team: s.team,
      isMaster: s.isMaster,
      status: s.status,
      twoFactorEnabled: Boolean(s.totpEnabledAt),
      permissions: s.isMaster ? PERMISSION_LIST : s.user.staffPermissions.map((p) => p.permission).sort(),
    })),
  };
}

function assertGrantable(perms) {
  const bad = perms.filter((p) => !GRANTABLE.includes(p));
  if (bad.length) throw new AppError(422, 'PERMISSION_NOT_GRANTABLE', 'These permissions cannot be granted to staff', { meta: { permissions: bad } });
}

/** Grant or re-grant a permission row (one row per user+permission; MySQL has no partial unique index). */
async function grant(userId, permission, by, transaction) {
  const row = await StaffPermission.findOne({ where: { userId, permission }, transaction, lock: transaction.LOCK.UPDATE });
  if (!row) return StaffPermission.create({ userId, permission, grantedBy: by }, { transaction }).then(() => true);
  if (row.revokedAt) return row.update({ revokedAt: null, revokedBy: null, grantedBy: by, grantedAt: new Date() }, { transaction }).then(() => true);
  return false;
}

async function revoke(userId, permission, by, transaction) {
  const [n] = await StaffPermission.update({ revokedAt: new Date(), revokedBy: by }, { where: { userId, permission, revokedAt: null }, transaction });
  return n > 0;
}

/** Make an existing (signed-up) user a staff member. They must set up TOTP at next sign-in. */
async function invite(principal, { userId, employeeId, team, permissions = [] }, req) {
  assertGrantable(permissions);
  return sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user) throw E.notFound('User');
    if (user.status !== 'active') throw E.conflict('USER_NOT_ACTIVE', 'Only active accounts can become staff');
    const existing = await StaffMember.findOne({ where: { userId }, transaction });
    if (existing && existing.status !== 'offboarded') throw E.conflict('ALREADY_STAFF', 'This user is already staff');

    if (existing) await existing.update({ status: 'invited', employeeId, team, offboardedAt: null, totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, invitedBy: principal.id, invitedAt: new Date() }, { transaction });
    else await StaffMember.create({ userId, employeeId, team, invitedBy: principal.id }, { transaction });

    const role = await UserRole.findOne({ where: { userId, role: ROLES.STAFF }, transaction });
    if (role) await role.update({ status: 'active', activatedAt: new Date(), decidedBy: principal.id }, { transaction });
    else await UserRole.create({ userId, role: ROLES.STAFF, status: 'active', activatedAt: new Date(), decidedBy: principal.id }, { transaction });

    for (const p of permissions) await grant(userId, p, principal.id, transaction);
    await authz.bumpVersion(userId, { transaction });
    await sessions.revokeAllForUser(userId, 'permission_change', { transaction });
    await audit.record({ action: 'staff.invited', actor: principal, entityType: 'user', entityId: userId, after: { employeeId, team, permissions }, req }, { transaction });
    return { userId, status: 'invited', permissions };
  });
}

/**
 * Atomic permission matrix save (M01-FR-17): every change for every staff member in one
 * transaction, one audit row per changed flag, affected users' sessions revoked.
 */
async function setPermissions(principal, { changes, reason }, req) {
  const all = changes.flatMap((c) => [...(c.grant || []), ...(c.revoke || [])]);
  assertGrantable(all);
  return sequelize.transaction(async (transaction) => {
    let applied = 0;
    let sessionsRevoked = 0;
    for (const change of changes) {
      const staff = await StaffMember.findOne({ where: { userId: change.userId }, transaction });
      if (!staff || staff.status === 'offboarded') throw E.notFound(`Staff member ${change.userId}`);
      if (staff.isMaster) throw E.conflict('MASTER_PERMISSIONS_FIXED', 'Master admins hold every permission');

      let changed = false;
      for (const p of change.grant || []) {
        if (await grant(change.userId, p, principal.id, transaction)) {
          changed = true;
          applied += 1;
          await audit.record({ action: 'staff.permission_granted', actor: principal, entityType: 'user', entityId: change.userId, before: { [p]: false }, after: { [p]: true }, meta: { reason }, req }, { transaction });
        }
      }
      for (const p of change.revoke || []) {
        if (await revoke(change.userId, p, principal.id, transaction)) {
          changed = true;
          applied += 1;
          await audit.record({ action: 'staff.permission_revoked', actor: principal, entityType: 'user', entityId: change.userId, before: { [p]: true }, after: { [p]: false }, meta: { reason }, req }, { transaction });
        }
      }
      if (changed) {
        await authz.bumpVersion(change.userId, { transaction });
        sessionsRevoked += await sessions.revokeAllForUser(change.userId, 'permission_change', { transaction });
      }
    }
    return { applied, sessionsRevoked };
  });
}

async function offboard(principal, userId, { note }, req) {
  if (userId === principal.id) throw E.forbidden('SELF_ACTION_FORBIDDEN', 'You cannot offboard yourself');
  return sequelize.transaction(async (transaction) => {
    const staff = await StaffMember.findOne({ where: { userId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!staff || staff.status === 'offboarded') throw E.notFound('Staff member');
    if (staff.isMaster) {
      const masters = await StaffMember.count({ where: { isMaster: true, status: 'active' }, transaction });
      if (masters <= 1) throw E.conflict('LAST_MASTER', 'You cannot offboard the last master admin');
    }
    await staff.update({ status: 'offboarded', offboardedAt: new Date(), totpSecretEnc: null }, { transaction });
    await UserRole.update({ status: 'suspended', statusReasonCode: 'offboarded', statusNote: note ?? null }, { where: { userId, role: [ROLES.STAFF, ROLES.MASTER_ADMIN] }, transaction });
    await StaffPermission.update({ revokedAt: new Date(), revokedBy: principal.id }, { where: { userId, revokedAt: null }, transaction });
    await authz.bumpVersion(userId, { transaction });
    await sessions.revokeAllForUser(userId, 'admin', { transaction });
    await audit.record({ action: 'staff.offboarded', actor: principal, entityType: 'user', entityId: userId, meta: { note }, req }, { transaction });
    return { status: 'offboarded' };
  });
}

async function resetTwoFactor(principal, userId, req) {
  return sequelize.transaction(async (transaction) => {
    const staff = await StaffMember.findOne({ where: { userId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!staff || staff.status === 'offboarded') throw E.notFound('Staff member');
    await staff.update({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null }, { transaction });
    await authz.bumpVersion(userId, { transaction });
    await sessions.revokeAllForUser(userId, 'admin', { transaction });
    await audit.record({ action: 'staff.totp_reset', actor: principal, entityType: 'user', entityId: userId, req }, { transaction });
    return { twoFactorEnabled: false };
  });
}

/** Promote an active staff member to master (needs an existing master + step-up). */
async function promoteToMaster(principal, userId, req) {
  return sequelize.transaction(async (transaction) => {
    const staff = await StaffMember.findOne({ where: { userId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!staff || staff.status !== 'active') throw E.conflict('STAFF_NOT_ACTIVE', 'Only an active staff member with two-factor can be promoted');
    if (staff.isMaster) throw E.conflict('ALREADY_MASTER', 'Already a master admin');
    await staff.update({ isMaster: true }, { transaction });
    const role = await UserRole.findOne({ where: { userId, role: ROLES.MASTER_ADMIN }, transaction });
    if (role) await role.update({ status: 'active', activatedAt: new Date(), decidedBy: principal.id }, { transaction });
    else await UserRole.create({ userId, role: ROLES.MASTER_ADMIN, status: 'active', activatedAt: new Date(), decidedBy: principal.id }, { transaction });
    await authz.bumpVersion(userId, { transaction });
    await sessions.revokeAllForUser(userId, 'permission_change', { transaction });
    await audit.record({ action: 'staff.promoted_to_master', actor: principal, entityType: 'user', entityId: userId, req }, { transaction });
    return { isMaster: true };
  });
}

module.exports = { list, invite, setPermissions, offboard, resetTwoFactor, promoteToMaster, GRANTABLE };
