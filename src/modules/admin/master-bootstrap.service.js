'use strict';

const { Op } = require('sequelize');
const { User, UserRole, StaffMember, sequelize } = require('../../models');
const { parseIdentifier, maskPhone, maskEmail } = require('../../common/identifiers');
const audit = require('../audit').audit;

/**
 * The first master admin (M01-FR-12, M01-FR-40). Two ways in, one rule set:
 *  - the CLI: npm run create:master -- --email you@example.com (or --phone 01…)
 *  - hosts without a shell: BOOTSTRAP_MASTER=<email or phone> at startup (src/server.js)
 *
 * It works only while no master who can sign in exists. A master "can sign in" with a verified
 * phone, a verified email or a password (the admin sign-in takes those, then TOTP). The demo
 * seeder's master has none of them on purpose, so it never blocks the real first master.
 * The account must already exist with that identifier verified (sign up on kriraghor.com first).
 * It grants member, staff and master_admin and an "invited" master staff row in one transaction,
 * audited; the master then signs in with a code and must enrol TOTP before any access.
 * Results carry a masked identifier only.
 */
const ROLES = ['member', 'staff', 'master_admin'];

const masked = (id) => (id.type === 'phone' ? maskPhone(id.value) : maskEmail(id.value));
const canSignIn = (u) => Boolean(u.phoneVerifiedAt || u.emailVerifiedAt || u.passwordHash);

async function bootstrapMaster({ identifier, name, employeeId = 'KG-0001' }) {
  const id = parseIdentifier(String(identifier ?? '').trim());
  if (!id) return { created: false, reason: 'IDENTIFIER_INVALID' };

  return sequelize.transaction(async (transaction) => {
    const masters = await StaffMember.findAll({ where: { isMaster: true, status: { [Op.ne]: 'offboarded' } }, attributes: ['userId'], transaction });
    if (masters.length) {
      const users = await User.findAll({ where: { id: masters.map((m) => m.userId) }, attributes: ['id', 'phoneVerifiedAt', 'emailVerifiedAt', 'passwordHash'], transaction });
      if (users.some(canSignIn)) return { created: false, reason: 'MASTER_EXISTS', target: masked(id) };
    }

    const where = id.type === 'phone' ? { phone: id.value, phoneVerifiedAt: { [Op.ne]: null } } : { email: id.value, emailVerifiedAt: { [Op.ne]: null } };
    const user = await User.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
    if (!user) return { created: false, reason: 'ACCOUNT_NOT_FOUND', target: masked(id) };
    if (user.status !== 'active') return { created: false, reason: 'ACCOUNT_NOT_ACTIVE', target: masked(id) };

    for (const role of ROLES) {
      const row = await UserRole.findOne({ where: { userId: user.id, role }, transaction });
      if (row) await row.update({ status: 'active', activatedAt: row.activatedAt ?? new Date() }, { transaction });
      else await UserRole.create({ userId: user.id, role, status: 'active', activatedAt: new Date() }, { transaction });
    }

    const existing = await StaffMember.findOne({ where: { userId: user.id }, transaction });
    if (existing) await existing.update({ isMaster: true, status: existing.status === 'active' ? 'active' : 'invited' }, { transaction });
    else {
      // The employee id is unique; a demo master may hold the default.
      const taken = await StaffMember.count({ where: { employeeId }, transaction });
      await StaffMember.create({ userId: user.id, employeeId: taken ? `${employeeId}-${user.id.slice(0, 4)}` : employeeId, team: 'Platform', isMaster: true, status: 'invited' }, { transaction });
    }
    if (name && !user.displayName) await user.update({ displayName: name }, { transaction });
    await user.increment('authzVersion', { transaction });
    await audit.record({ action: 'staff.master_bootstrapped', actor: { id: null, role: 'cli' }, entityType: 'user', entityId: user.id, meta: { via: id.type } }, { transaction });
    return { created: true, userId: user.id, target: masked(id) };
  });
}

module.exports = { bootstrapMaster };
