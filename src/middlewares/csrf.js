'use strict';

const config = require('../config');
const { E } = require('../common/errors');
const { compile, requestOrigin } = require('../common/origins');
const cookies = require('../modules/auth/cookies');
const sessions = require('../modules/auth/session.service');

const allowCustomer = compile(config.corsOrigins);
const allowAdmin = compile(config.adminOrigins);

const isMobileBodyToken = (req) => req.get('x-client-type') === 'mobile' && Boolean(req.body?.refreshToken);
const originRejected = () => E.forbidden('CSRF_ORIGIN_REJECTED', 'This request did not come from a Kriraghor app');

/** Every admin auth endpoint must come from the admin portal's origin (ADR-004). */
function requireAdminOrigin(req, _res, next) {
  return allowAdmin(requestOrigin(req)) ? next() : next(originRejected());
}

/**
 * CSRF defence for endpoints that act on a cookie (ADR-004 §CSRF), in three layers:
 *  1. SameSite on the refresh cookie (Lax for customers, Strict for admin);
 *  2. the Origin (or Referer) must be on the allowlist: CORS_ORIGINS, or ADMIN_ORIGINS for admin;
 *  3. X-CSRF-Token must equal the CSRF cookie, and its HMAC must bind it to this session family.
 * Mobile clients that send the refresh token in the body use no cookies, so they skip the check.
 */
function requireCsrf(audience) {
  const allowed = audience === 'admin' ? allowAdmin : allowCustomer;
  const names = cookies.names(audience);
  return async (req, _res, next) => {
    try {
      if (audience === 'api' && isMobileBodyToken(req) && !req.cookies?.[names.refresh]) return next();
      if (!allowed(requestOrigin(req))) return next(originRejected());

      const header = req.get('x-csrf-token');
      const cookie = req.cookies?.[names.csrf];
      if (!header || !cookie || header !== cookie) return next(E.forbidden('CSRF_TOKEN_INVALID', 'Reload the page and try again'));

      // Binding check. Unknown or ended sessions fall through to the normal refresh error.
      const live = await sessions.peek(req.cookies?.[names.refresh]);
      if (live && !cookies.verifyCsrfBinding(header, audience, live.familyId)) {
        return next(E.forbidden('CSRF_TOKEN_INVALID', 'Reload the page and try again'));
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireCsrf, requireAdminOrigin };
