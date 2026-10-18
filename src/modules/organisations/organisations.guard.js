'use strict';

/**
 * M22-FR-03: every organiser request is scoped by the caller's membership of :orgId, never by the
 * body. A non-member, or a member without the role, gets a 404 (not a 403), so organisations cannot
 * probe each other's ids. Sets req.org = { id, role, isAdmin, ownerId, status, row }.
 *   requireOrgRole('admin')  owner or admin
 *   requireOrgRole('staff')  owner, admin or staff
 *   { verified: true }       the organisation must be verified (the console)
 */
const { E } = require('../../common/errors');
const organisations = require('./organisations.service');

const ALLOWED = { admin: ['owner', 'admin'], staff: ['owner', 'admin', 'staff'] };

function requireOrgRole(level, { verified = true } = {}) {
  return async (req, _res, next) => {
    try {
      const m = await organisations.membership(req.user.id, req.params.orgId);
      if (!m || !ALLOWED[level].includes(m.role) || (verified && !['verified', 'suspended'].includes(m.org.status))) throw E.notFound('Organisation');
      req.org = { id: m.org.id, role: m.role, isAdmin: m.isAdmin, ownerId: m.org.ownerUserId, status: m.org.status, name: m.org.name, row: m.org };
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireOrgRole };
