'use strict';

const { User, UserRole, StaffMember, StaffPermission, OAuthIdentity } = require('../../models');
const { ROLES, PERMISSION_LIST } = require('../../common/enums');

/**
 * Load the authorisation context ("principal") for a user from the database.
 * Roles and permissions are never taken from the JWT (M01-FR-08).
 * TODO(M01-FR-08): cache in Redis keyed by authz_version once Redis is introduced.
 */
async function loadPrincipal(userId) {
  const user = await User.findByPk(userId, {
    include: [
      { model: UserRole, as: 'roles' },
      { model: StaffMember, as: 'staff' },
      { model: StaffPermission, as: 'staffPermissions', where: { revokedAt: null }, required: false },
      { model: OAuthIdentity, as: 'identities' },
    ],
  });
  if (!user) return null;

  const roles = Object.fromEntries(user.roles.map((r) => [r.role, r.status]));
  const staff = user.staff && user.staff.status !== 'offboarded' ? user.staff : null;
  const isMaster = Boolean(staff?.isMaster && roles[ROLES.MASTER_ADMIN] === 'active');
  const isStaff = Boolean(staff && (roles[ROLES.STAFF] === 'active' || isMaster));
  const permissions = isMaster
    ? new Set(PERMISSION_LIST)
    : new Set(isStaff ? user.staffPermissions.map((p) => p.permission) : []);

  return {
    id: user.id,
    user,
    roles, // { member: 'active', ground_owner: 'in_review', ... }
    activeRoles: Object.keys(roles).filter((r) => roles[r] === 'active'),
    permissions,
    isStaff,
    isMaster,
    staff,
  };
}

function hasRole(principal, role) {
  return principal.roles[role] === 'active';
}

function hasPermission(principal, permission) {
  return principal.isMaster || principal.permissions.has(permission);
}

/** Increment authz_version: every outstanding access token becomes stale (AUTHZ_STALE). */
async function bumpVersion(userId, { transaction } = {}) {
  await User.increment('authzVersion', { by: 1, where: { id: userId }, transaction });
}

module.exports = { loadPrincipal, hasRole, hasPermission, bumpVersion };
