'use strict';

const { Op } = require('sequelize');
const { User, UserRole, UserSanction, StaffMember, sequelize } = require('../../models');
const { E } = require('../../common/errors');
const { ROLES, ADMIN_ROLES, ROLE_TRANSITIONS } = require('../../common/enums');
const { hmac } = require('../../common/crypto');
const audit = require('../audit').audit;
const events = require('../events').events;
const sessions = require('../auth').session;
const authz = require('../auth').authz;
const { serializeUserForAdmin } = require('../users').serializer;

const MAX_SUSPENSION_DAYS = 365;

const encodeCursor = (u) => Buffer.from(`${u.createdAt.toISOString()}|${u.id}`).toString('base64url');
function decodeCursor(c) {
  try {
    const [at, id] = Buffer.from(c, 'base64url').toString().split('|');
    const d = new Date(at);
    if (Number.isNaN(d.getTime()) || !id) throw new Error('bad');
    return { at: d, id };
  } catch {
    throw E.badRequest('CURSOR_INVALID', 'Invalid cursor');
  }
}

/** Search users (M01-FR-19). Results are masked; searches with a query are audited. */
async function search(principal, { q, status, role, roleStatus, limit = 20, cursor }, req) {
  const where = {};
  if (status) where.status = status;
  if (q) {
    const digits = q.replace(/\D/g, '');
    where[Op.or] = [
      { displayName: { [Op.iLike]: `%${q}%` } }, // case-insensitive name search
      { email: { [Op.like]: `%${q.toLowerCase()}%` } },
      ...(digits.length >= 4 ? [{ phone: { [Op.like]: `%${digits.slice(-10)}%` } }] : []),
    ];
  }
  if (cursor) {
    const c = decodeCursor(cursor);
    where[Op.and] = [{ [Op.or]: [{ createdAt: { [Op.lt]: c.at } }, { createdAt: c.at, id: { [Op.lt]: c.id } }] }];
  }
  const include = [];
  if (role) include.push({ model: UserRole, as: 'roles', where: { role, ...(roleStatus ? { status: roleStatus } : {}) }, required: true });

  const rows = await User.findAll({ where, include, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const ids = page.map((u) => u.id);
  const roles = ids.length ? await UserRole.findAll({ where: { userId: ids } }) : [];

  if (q) {
    // An NID-looking query is stored hashed, never in clear text.
    const looksLikeNid = /^\d{10}$|^\d{13}$|^\d{17}$/.test(q.replace(/\s/g, ''));
    await audit.record({ action: 'user.searched', actor: principal, meta: { q: looksLikeNid ? `nid:${hmac(q).slice(0, 16)}` : q, filters: { status, role, roleStatus } }, req });
  }

  return {
    data: page.map((u) => serializeUserForAdmin(u, { roles: roles.filter((r) => r.userId === u.id) })),
    nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
  };
}

async function loadTarget(userId, { transaction, lock } = {}) {
  const user = await User.findByPk(userId, { transaction, lock });
  if (!user) throw E.notFound('User');
  return user;
}

async function getOne(userId) {
  const user = await loadTarget(userId);
  const [roles, sanctions, staff] = await Promise.all([
    UserRole.findAll({ where: { userId } }),
    UserSanction.findAll({ where: { userId }, order: [['createdAt', 'DESC']], limit: 20 }),
    StaffMember.findOne({ where: { userId } }),
  ]);
  return serializeUserForAdmin(user, { roles, sanctions, staff });
}

/** M16 (Q27): staff correct a member's gender (with a reason; audited; the value is never public). */
async function correctGender(principal, userId, { gender, reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const target = await loadTarget(userId, { transaction, lock: transaction.LOCK.UPDATE });
    await guardTarget(principal, target, { transaction });
    const before = { gender: target.gender ?? null };
    await target.update({ gender, genderSource: 'staff_corrected' }, { transaction });
    await audit.record({ action: 'user.gender_corrected', actor: principal, entityType: 'user', entityId: target.id, before, after: { gender }, reason, req }, { transaction });
    await events.publish(transaction, { name: 'user.identity_changed', aggregateType: 'user', aggregateId: target.id, payload: { userId: target.id, fields: ['gender'] }, actor: principal, req });
    return getOneInTx(target, transaction);
  });
}

async function getOneInTx(user, transaction) {
  const [roles, sanctions, staff] = await Promise.all([
    UserRole.findAll({ where: { userId: user.id }, transaction }),
    UserSanction.findAll({ where: { userId: user.id }, order: [['createdAt', 'DESC']], limit: 20, transaction }),
    StaffMember.findOne({ where: { userId: user.id }, transaction }),
  ]);
  return serializeUserForAdmin(user, { roles, sanctions, staff });
}

/** Staff may not act on themselves, and only a master may act on staff accounts. */
async function guardTarget(principal, target, { transaction } = {}) {
  if (target.id === principal.id) throw E.forbidden('SELF_ACTION_FORBIDDEN', 'You cannot do this to your own account');
  const staff = await StaffMember.findOne({ where: { userId: target.id }, transaction });
  if (staff && staff.status !== 'offboarded' && !principal.isMaster) {
    throw E.forbidden('MASTER_REQUIRED', 'Only a master admin can act on staff accounts');
  }
}

async function suspend(principal, userId, { reasonCode, note, until }, req) {
  if (until) {
    const ms = new Date(until).getTime() - Date.now();
    if (ms <= 0) throw E.badRequest('UNTIL_IN_PAST', 'The end date must be in the future');
    if (ms > MAX_SUSPENSION_DAYS * 24 * 3600 * 1000) throw E.badRequest('SUSPENSION_TOO_LONG', 'Suspensions longer than a year must be bans');
  }
  return sequelize.transaction((transaction) => suspendInTx(principal, userId, { reasonCode, note, until }, { transaction, req }));
}

/**
 * The suspension inside the caller's transaction (also M17 report actions, reasonCode reported, and
 * M18 risk actions with source risk).
 */
async function suspendInTx(principal, userId, { reasonCode, note, until = null, source = 'admin' }, { transaction, req = null }) {
  const target = await loadTarget(userId, { transaction, lock: transaction.LOCK.UPDATE });
  await guardTarget(principal, target, { transaction });
  if (target.status !== 'active') throw E.conflict('USER_NOT_ACTIVE', `The account is already ${target.status}`);

  const sanction = await UserSanction.create(
    { userId, kind: 'suspension', reasonCode, note, endsAt: until ? new Date(until) : null, createdBy: principal.id, source },
    { transaction }
  );
  await target.update({ status: 'suspended' }, { transaction });
  await authz.bumpVersion(userId, { transaction });
  const revoked = await sessions.revokeAllForUser(userId, 'sanction', { transaction });
  await audit.record({ action: 'user.suspended', actor: principal, entityType: 'user', entityId: userId, before: { status: 'active' }, after: { status: 'suspended', until: until ?? null }, meta: { reasonCode, sanctionId: sanction.id }, req }, { transaction });
  await events.publish(transaction, { name: 'user.suspended', aggregateType: 'user', aggregateId: userId, payload: { userId, sanctionId: sanction.id, until: until ?? null }, actor: principal, req });
  return { sanctionId: sanction.id, status: 'suspended', sessionsRevoked: revoked };
}

async function ban(principal, userId, { reasonCode, note }, req) {
  return sequelize.transaction((transaction) => banInTx(principal, userId, { reasonCode, note }, { transaction, req }));
}

/** The ban inside the caller's transaction (M18 risk actions pass source risk). */
async function banInTx(principal, userId, { reasonCode, note, source = 'admin' }, { transaction, req = null }) {
  const target = await loadTarget(userId, { transaction, lock: transaction.LOCK.UPDATE });
  await guardTarget(principal, target, { transaction });
  if (target.status === 'banned') throw E.conflict('USER_ALREADY_BANNED', 'The account is already banned');

  // Close any open suspension; the ban replaces it.
  await UserSanction.update({ liftedAt: new Date(), liftedBy: principal.id, liftNote: 'Superseded by ban' }, { where: { userId, liftedAt: null, kind: 'suspension' }, transaction });
  const sanction = await UserSanction.create({ userId, kind: 'ban', reasonCode, note, createdBy: principal.id, source }, { transaction });
  const before = target.status;
  await target.update({ status: 'banned' }, { transaction });
  await authz.bumpVersion(userId, { transaction });
  const revoked = await sessions.revokeAllForUser(userId, 'sanction', { transaction });
  await audit.record({ action: 'user.banned', actor: principal, entityType: 'user', entityId: userId, before: { status: before }, after: { status: 'banned' }, meta: { reasonCode, sanctionId: sanction.id }, req }, { transaction });
  await events.publish(transaction, { name: 'user.banned', aggregateType: 'user', aggregateId: userId, payload: { userId, sanctionId: sanction.id }, actor: principal, req });
  return { sanctionId: sanction.id, status: 'banned', sessionsRevoked: revoked };
}

/** Lift the active suspension or ban. Restoring a ban requires a master (route-level). */
async function restore(principal, userId, { note }, req, { allowBan = false } = {}) {
  return sequelize.transaction((transaction) => restoreInTx(principal, userId, { note }, { transaction, req, allowBan }));
}

/** The restore inside the caller's transaction (M18 undoes its own suspensions and bans). */
async function restoreInTx(principal, userId, { note }, { transaction, req = null, allowBan = false }) {
  const target = await loadTarget(userId, { transaction, lock: transaction.LOCK.UPDATE });
  await guardTarget(principal, target, { transaction });
  if (target.status === 'active') throw E.conflict('USER_ALREADY_ACTIVE', 'The account is already active');
  if (target.status === 'banned' && !allowBan) throw E.forbidden('MASTER_REQUIRED', 'Only a master admin can lift a ban');
  if (target.status === 'closed') throw E.conflict('USER_CLOSED', 'Closed accounts cannot be restored');

  const before = target.status;
  await UserSanction.update({ liftedAt: new Date(), liftedBy: principal.id, liftNote: note ?? null }, { where: { userId, liftedAt: null, kind: ['suspension', 'ban'] }, transaction });
  await target.update({ status: 'active' }, { transaction });
  await authz.bumpVersion(userId, { transaction });
  await audit.record({ action: 'user.restored', actor: principal, entityType: 'user', entityId: userId, before: { status: before }, after: { status: 'active' }, meta: { note }, req }, { transaction });
  await events.publish(transaction, { name: 'user.restored', aggregateType: 'user', aggregateId: userId, payload: { userId }, actor: principal, req });
  return { status: 'active' };
}

async function signOutEverywhere(principal, userId, req) {
  return sequelize.transaction(async (transaction) => {
    const target = await loadTarget(userId, { transaction });
    await guardTarget(principal, target, { transaction });
    const n = await sessions.revokeAllForUser(userId, 'admin', { transaction });
    await audit.record({ action: 'user.signed_out_by_admin', actor: principal, entityType: 'user', entityId: userId, meta: { sessionsRevoked: n }, req }, { transaction });
    return { sessionsRevoked: n };
  });
}

/**
 * Change a role's status (admin path). Normal activation comes from M02 verification
 * events; this endpoint covers manual decisions, role suspensions and reinstatements.
 */
async function setRoleStatus(principal, userId, role, { status, reasonCode, note }, req) {
  if (ADMIN_ROLES.includes(role)) throw E.forbidden('ROLE_NOT_MANAGEABLE', 'Staff roles are managed in Staff and permissions');
  return sequelize.transaction(async (transaction) => {
    const target = await loadTarget(userId, { transaction });
    await guardTarget(principal, target, { transaction });
    const row = await UserRole.findOne({ where: { userId, role }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw E.notFound('Role');
    const allowed = ROLE_TRANSITIONS[row.status] || [];
    const extra = row.status === 'documents_pending' ? ['in_review', 'rejected'] : [];
    if (![...allowed, ...extra].includes(status)) {
      throw E.conflict('ROLE_TRANSITION_INVALID', `Cannot move ${role} from ${row.status} to ${status}`);
    }
    if (status === 'active' && role !== ROLES.MEMBER) {
      const member = await UserRole.findOne({ where: { userId, role: ROLES.MEMBER }, transaction });
      if (member?.status !== 'active') throw E.conflict('MEMBER_NOT_ACTIVE', 'The member (NID) verification must be approved first');
    }
    if (['suspended', 'rejected', 'changes_requested'].includes(status) && !reasonCode) {
      throw E.validation([{ field: 'reasonCode', message: 'A reason is required' }]);
    }

    const before = row.status;
    await row.update(
      {
        status,
        decidedBy: principal.id,
        statusReasonCode: reasonCode ?? null,
        statusNote: note ?? null,
        activatedAt: status === 'active' ? new Date() : row.activatedAt,
      },
      { transaction }
    );
    if (role === ROLES.MEMBER) {
      const kyc = { active: 'verified', in_review: 'pending', rejected: 'rejected', changes_requested: 'unverified' }[status];
      if (kyc) await target.update({ kycStatus: kyc }, { transaction });
    }
    if (status === 'suspended') {
      await UserSanction.create({ userId, kind: 'role_suspension', role, reasonCode, note, createdBy: principal.id, source: 'admin' }, { transaction });
    }
    if (before === 'suspended' && status === 'active') {
      await UserSanction.update({ liftedAt: new Date(), liftedBy: principal.id }, { where: { userId, role, kind: 'role_suspension', liftedAt: null }, transaction });
    }
    await authz.bumpVersion(userId, { transaction });
    await audit.record({ action: `user_role.${status}`, actor: principal, entityType: 'user_role', entityId: row.id, before: { status: before }, after: { status }, meta: { role, reasonCode }, req }, { transaction });
    // M04 §6.3 user_role.* events (in_review and changes_requested belong to M02, no event).
    const roleEvent = { active: before === 'suspended' ? 'user_role.reinstated' : 'user_role.activated', rejected: 'user_role.rejected', suspended: 'user_role.suspended' }[status];
    if (roleEvent) {
      const payload = ['user_role.rejected', 'user_role.suspended'].includes(roleEvent) ? { userId, role, reasonCode: reasonCode ?? null } : { userId, role };
      await events.publish(transaction, { name: roleEvent, aggregateType: 'user_role', aggregateId: row.id, payload, actor: principal, req });
    }
    return row.toPublic();
  });
}

/** Lift timed suspensions whose end has passed (M01-FR-23). Idempotent. */
async function liftExpiredSuspensions() {
  const due = await UserSanction.findAll({ where: { kind: 'suspension', liftedAt: null, endsAt: { [Op.lte]: new Date() } } });
  let lifted = 0;
  for (const s of due) {
    await sequelize.transaction(async (transaction) => {
      const [n] = await UserSanction.update({ liftedAt: new Date(), liftNote: 'Suspension period ended' }, { where: { id: s.id, liftedAt: null }, transaction });
      if (!n) return;
      const user = await User.findByPk(s.userId, { transaction, lock: transaction.LOCK.UPDATE });
      if (user?.status === 'suspended') {
        await user.update({ status: 'active' }, { transaction });
        await authz.bumpVersion(user.id, { transaction });
        await audit.record({ action: 'user.restored', actor: { id: null, role: 'system' }, entityType: 'user', entityId: user.id, after: { status: 'active' }, meta: { sanctionId: s.id, reason: 'expired' } }, { transaction });
        await events.publish(transaction, { name: 'user.restored', aggregateType: 'user', aggregateId: user.id, payload: { userId: user.id } });
        lifted += 1;
      }
    });
  }
  return lifted;
}

module.exports = { search, getOne, correctGender, suspend, suspendInTx, ban, banInTx, restore, restoreInTx, signOutEverywhere, setRoleStatus, liftExpiredSuspensions };
