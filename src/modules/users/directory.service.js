'use strict';

/**
 * M01 directory: read-only lookups other modules use instead of reading M01 tables directly
 * ("a module owns its tables"). M08 uses it to find recipients and their contact details.
 * Contact details never leave the backend (no API returns them through this service).
 */
const { Op } = require('sequelize');
const { User, StaffMember, StaffPermission } = require('../../models');

/** Map userId → { phone, email, emailVerified, locale, status }. Missing users are absent. */
async function contactFor(userIds, { transaction } = {}) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const users = await User.findAll({ where: { id: ids }, attributes: ['id', 'phone', 'phoneVerifiedAt', 'email', 'emailVerifiedAt', 'locale', 'status', 'displayName'], transaction });
  return new Map(
    users.map((u) => [
      u.id,
      { phone: u.phoneVerifiedAt ? u.phone : null, email: u.emailVerifiedAt ? u.email : null, locale: u.locale, status: u.status, displayName: u.displayName },
    ])
  );
}

/** Active master admins (with two-factor set up). */
async function masters() {
  const rows = await StaffMember.findAll({ where: { isMaster: true, status: 'active' }, attributes: ['userId'] });
  return rows.map((r) => r.userId);
}

/** Active staff holding a permission, plus every active master (masters hold every permission). */
async function withPermission(permission) {
  const grants = await StaffPermission.findAll({ where: { permission, revokedAt: { [Op.is]: null } }, attributes: ['userId'] });
  const active = await StaffMember.findAll({ where: { status: 'active', userId: grants.map((g) => g.userId) }, attributes: ['userId'] });
  return [...new Set([...active.map((r) => r.userId), ...(await masters())])];
}

/**
 * Map userId → { status, isStaff, displayName } (M06: who may pay or be paid). Staff accounts are
 * separate users that cannot use the customer apps (ADR-004), so they cannot be payers.
 */
async function accounts(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const users = await User.findAll({ where: { id: ids }, attributes: ['id', 'status', 'displayName'] });
  const staff = await StaffMember.findAll({ where: { userId: ids, status: { [Op.ne]: 'offboarded' } }, attributes: ['userId'] });
  const staffIds = new Set(staff.map((s) => s.userId));
  return new Map(users.map((u) => [u.id, { status: u.status, isStaff: staffIds.has(u.id), displayName: u.displayName }]));
}

/**
 * Map userId → { displayName, legalName, kycStatus } for staff checking a payout account (M07 §4.1:
 * the account must be in the payee's NID name). The NID number itself never leaves M01.
 */
async function identities(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const users = await User.findAll({ where: { id: ids }, attributes: ['id', 'displayName', 'legalName', 'kycStatus'] });
  return new Map(users.map((u) => [u.id, { displayName: u.displayName, legalName: u.legalName ?? null, kycStatus: u.kycStatus }]));
}

/** M02-FR-07: how many other users already hold this NID hash (verified members). */
async function nidHashHolders(nidHash, exceptUserId, { transaction } = {}) {
  return User.count({ where: { nidHash, id: { [Op.ne]: exceptUserId } }, transaction });
}

module.exports = { contactFor, masters, withPermission, accounts, identities, nidHashHolders };
