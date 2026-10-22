'use strict';

/**
 * Round B3: an owner's account or business role changed, so their staff's access tokens go stale
 * (authz_version) and their panels reload the workplaces. Access itself never waits for this: the
 * principal is loaded on every request and drops workplaces of owners who are not live at once.
 * Registered once per process (registry.registerAll). Idempotent: bumping twice only refreshes twice.
 */
const { onEvent } = require('../events').consumers;
const rules = require('./business-members.rules');
const svc = require('./business-members.service');

const OWNER_ROLES = new Set(Object.values(rules.OWNER_ROLE));
const ownerChanged = (e, { transaction }) => svc.bumpStaffOf(e.payload.userId, { transaction });
const roleChanged = (e, ctx) => (OWNER_ROLES.has(e.payload.role) || e.payload.role === 'member' ? ownerChanged(e, ctx) : 0);

function registerBusinessMemberConsumers() {
  onEvent('user.suspended', 'business-members.owner-suspended', ownerChanged);
  onEvent('user.banned', 'business-members.owner-banned', ownerChanged);
  onEvent('user.restored', 'business-members.owner-restored', ownerChanged);
  onEvent('user_role.suspended', 'business-members.role-suspended', roleChanged);
  onEvent('user_role.reinstated', 'business-members.role-reinstated', roleChanged);
  onEvent('user_role.activated', 'business-members.role-activated', roleChanged);
  onEvent('user_role.rejected', 'business-members.role-rejected', roleChanged);
}

module.exports = { registerBusinessMemberConsumers, ownerChanged, roleChanged };
