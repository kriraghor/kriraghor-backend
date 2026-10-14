'use strict';

const passport = require('./passport');
const { E } = require('../common/errors');
const authz = require('../modules/auth/authz.service');
const gate = require('../modules/auth/gate.service');
const authService = require('../modules/auth/auth.service');

function authenticateWith(strategyName) {
  return (req, res, next) => {
    passport.authenticate(strategyName, { session: false }, (err, principal, info) => {
      if (err) return next(err);
      if (!principal) {
        const expired = info?.name === 'TokenExpiredError';
        return next(E.unauthorized(expired ? 'TOKEN_EXPIRED' : 'AUTH_REQUIRED', expired ? 'Your session needs a refresh' : 'Sign in to continue'));
      }
      req.user = principal;
      return next();
    })(req, res, next);
  };
}

/** Require a valid customer access token (aud "api"). Sets req.user (principal). */
const authenticate = authenticateWith('jwt');

/** Require a valid staff access token (aud "admin", ADR-004). Used by /admin/* and /auth/step-up. */
const authenticateAdmin = authenticateWith('jwt-admin');

/** Like authenticate, but anonymous requests continue with req.user = null. */
function optionalAuth(req, res, next) {
  if (!req.get('authorization')) {
    req.user = null;
    return next();
  }
  return authenticate(req, res, next);
}

/** Require at least one of the given roles to be ACTIVE. */
function requireRoles(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(E.unauthorized());
    if (roles.some((r) => authz.hasRole(req.user, r))) return next();
    return next(E.forbidden('ROLE_REQUIRED', 'You do not have access to this area', undefined, { roles }));
  };
}

/** Staff permission flags; master admins hold every permission. Implies staff. */
function requirePermission(...permissions) {
  return (req, _res, next) => {
    if (!req.user) return next(E.unauthorized());
    if (!req.user.isStaff) return next(E.forbidden('PERMISSION_REQUIRED', 'Staff access is required'));
    const missing = permissions.filter((p) => !authz.hasPermission(req.user, p));
    if (missing.length) return next(E.forbidden('PERMISSION_REQUIRED', 'You do not have permission to do this', undefined, { missing }));
    return next();
  };
}

/** Staff holding at least one of the given permissions (masters hold every permission). */
function requireAnyPermission(...permissions) {
  return (req, _res, next) => {
    if (!req.user) return next(E.unauthorized());
    if (!req.user.isStaff) return next(E.forbidden('PERMISSION_REQUIRED', 'Staff access is required'));
    if (permissions.some((p) => authz.hasPermission(req.user, p))) return next();
    return next(E.forbidden('PERMISSION_REQUIRED', 'You do not have permission to do this', undefined, { anyOf: permissions }));
  };
}

/** Staff only. Use after authenticateAdmin (an admin-audience token already implies staff). */
function requireStaff(req, _res, next) {
  if (!req.user) return next(E.unauthorized());
  if (!req.user.isStaff) return next(E.forbidden('PERMISSION_REQUIRED', 'Staff access is required'));
  return next();
}

function requireMaster(req, _res, next) {
  if (!req.user) return next(E.unauthorized());
  if (!req.user.isMaster) return next(E.forbidden('MASTER_REQUIRED', 'Only a master admin can do this'));
  return next();
}

/** Single-use, scope-bound step-up token in the `X-Step-Up` header (M01-FR-11). */
function requireStepUp(scope) {
  return async (req, _res, next) => {
    try {
      await authService.consumeStepUp(req.get('x-step-up'), { principal: req.user, sessionId: req.auth.sessionId, scope });
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** Public-site gate for business actions, e.g. requireGate('book_ground'). */
function requireGate(action) {
  return (req, _res, next) => {
    const result = gate.evaluateAction(req.user, action);
    if (!result) return next(new Error(`Unknown gate action: ${action}`));
    if (result.allowed) return next();
    const status = result.code === 'AUTH_REQUIRED' ? 401 : 403;
    const err = status === 401 ? E.unauthorized() : E.forbidden(result.code, 'You cannot do this yet', undefined, { next: result.next, role: result.role });
    return next(err);
  };
}

module.exports = { authenticate, authenticateAdmin, optionalAuth, requireRoles, requirePermission, requireAnyPermission, requireStaff, requireMaster, requireStepUp, requireGate };
