'use strict';

const passport = require('passport');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const config = require('../config');
const { E } = require('../common/errors');
const { AUDIENCES, checkAccessPayload } = require('../modules/auth/access.service');

/**
 * Two passport-jwt strategies (ADR-004):
 *  - 'jwt'       customer access tokens (aud "api"): kriraghor.com, esports, vendor, mobile
 *  - 'jwt-admin' staff access tokens   (aud "admin"): admin.kriraghor.com only
 * passport-jwt verifies signature, issuer and expiry. The audience is checked here so a token
 * for the other audience gets TOKEN_AUDIENCE_INVALID instead of a generic 401.
 * Session, authz-version, status and staff checks live in access.service (shared with Socket.IO).
 * On success req.user = principal, req.auth = { sessionId, familyId, audience }.
 */
function strategy(audience) {
  return new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.auth.accessSecret,
      issuer: config.auth.issuer,
      algorithms: ['HS256'],
      passReqToCallback: true,
    },
    async (req, payload, done) => {
      try {
        if (payload.aud !== audience) return done(E.unauthorized('TOKEN_AUDIENCE_INVALID', 'This sign-in is not valid here'));
        const { principal, auth } = await checkAccessPayload(payload, audience);
        req.auth = auth;
        return done(null, principal);
      } catch (err) {
        return done(err);
      }
    }
  );
}

passport.use('jwt', strategy(AUDIENCES.API));
passport.use('jwt-admin', strategy(AUDIENCES.ADMIN));

module.exports = passport;
