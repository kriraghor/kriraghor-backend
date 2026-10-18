'use strict';

/**
 * M01 directory: read-only lookups other modules use instead of reading M01 tables directly
 * ("a module owns its tables"). M08 uses it to find recipients and their contact details.
 * Contact details never leave the backend (no API returns them through this service).
 */
const { Op } = require('sequelize');
const { User, UserRole, StaffMember, StaffPermission } = require('../../models');

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

/** M21: an active account by username (squad invites, public player pages); null when unknown. */
async function byUsername(username, { transaction } = {}) {
  if (!username) return null;
  const u = await User.findOne({ where: { username: String(username).toLowerCase() }, attributes: ['id', 'username', 'displayName', 'status'], transaction });
  return u ? { id: u.id, username: u.username, displayName: u.displayName, status: u.status } : null;
}

/** M21 public pages: id → { username, displayName } (never phone, email or legal name). */
async function publicNames(userIds, { transaction } = {}) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const users = await User.findAll({ where: { id: ids }, attributes: ['id', 'username', 'displayName'], transaction });
  return new Map(users.map((u) => [u.id, { username: u.username ?? null, displayName: u.displayName }]));
}

/** M19 live counts: verified members (active member role) and active business roles. */
async function counts() {
  const [verifiedMembers, businesses] = await Promise.all([
    UserRole.count({ where: { role: 'member', status: 'active' } }),
    UserRole.count({ where: { role: ['ground_owner', 'shop_owner', 'organiser', 'gym_owner'], status: 'active' } }),
  ]);
  return { verifiedMembers, businesses };
}

/** M16: the active account whose verified phone this is (E.164), or null. Phones never leave the backend. */
async function byVerifiedPhone(e164, { transaction } = {}) {
  const u = await User.findOne({ where: { phone: e164, status: 'active', phoneVerifiedAt: { [Op.ne]: null } }, attributes: ['id'], transaction });
  return u ? u.id : null;
}

/** M16: the caller's own verified phone (E.164) or null, for matching invites sent to it. */
async function verifiedPhoneOf(userId, { transaction } = {}) {
  const u = await User.findByPk(userId, { attributes: ['phone', 'phoneVerifiedAt'], transaction });
  return u && u.phoneVerifiedAt ? u.phone : null;
}

/**
 * M16 eligibility (internal only, never serialised): KYC status, whether the member role is active,
 * the NID date of birth and the self-declared gender.
 */
async function eligibilityIdentity(userIds, { transaction } = {}) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const users = await User.findAll({ where: { id: ids }, attributes: ['id', 'kycStatus', 'dob', 'gender', 'status', 'phoneVerifiedAt'], transaction });
  const members = new Set((await UserRole.findAll({ where: { userId: ids, role: 'member', status: 'active' }, attributes: ['userId'], transaction })).map((r) => r.userId));
  return new Map(users.map((u) => [u.id, { kycStatus: u.kycStatus, memberActive: members.has(u.id), dob: u.dob ?? null, gender: u.gender ?? null, active: u.status === 'active', phoneVerified: Boolean(u.phoneVerifiedAt) }]));
}

module.exports = { counts, contactFor, masters, withPermission, accounts, identities, nidHashHolders, byUsername, publicNames, byVerifiedPhone, verifiedPhoneOf, eligibilityIdentity };
