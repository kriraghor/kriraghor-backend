'use strict';

const passport = require('passport');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const config = require('../config');
const { Session } = require('../models');
const { E } = require('../common/errors');
const authz = require('../modules/auth/authz.service');

const LAST_SEEN_THROTTLE_MS = 60 * 1000;

/**
 * passport-jwt strategy (M01-FR-07/08/10):
 *  - verifies signature, issuer, audience, expiry (passport-jwt)
 *  - session must exist, be unrevoked and unexpired
 *  - authz version in the token must match users.authz_version (else AUTHZ_STALE → client refreshes)
 *  - account must be active
 *  - staff sessions: two-factor completed, idle timeout and absolute lifetime enforced
 * On success req.user = principal, req.auth = { sessionId }.
 */
passport.use(
  'jwt',
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.auth.accessSecret,
      issuer: config.auth.issuer,
      audience: 'api',
      algorithms: ['HS256'],
      passReqToCallback: true,
    },
    async (req, payload, done) => {
      try {
        if (payload.typ !== 'access') return done(null, false);

        const session = await Session.findByPk(payload.sid);
        const now = Date.now();
        if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt.getTime() < now) {
          return done(E.unauthorized('SESSION_REVOKED', 'Your session has ended. Sign in again.'));
        }

        const principal = await authz.loadPrincipal(payload.sub);
        if (!principal) return done(E.unauthorized('SESSION_REVOKED', 'Your session has ended. Sign in again.'));
        if (principal.user.authzVersion !== payload.av) {
          return done(E.unauthorized('AUTHZ_STALE', 'Your access changed. Refresh your session.'));
        }
        if (principal.user.status === 'suspended') return done(E.forbidden('ACCOUNT_SUSPENDED', 'Your account is suspended'));
        if (principal.user.status !== 'active') return done(E.forbidden('ACCOUNT_BANNED', 'Your account is not active'));

        if (principal.isStaff) {
          if (!session.twoFactorAt) return done(E.forbidden('TWO_FACTOR_REQUIRED', 'Sign in again with two-factor authentication'));
          const idle = now - session.lastSeenAt.getTime() > config.staff.idleTimeoutMs;
          // Absolute lifetime counts from the 2FA moment, which is carried across refresh rotations.
          const tooOld = now - session.twoFactorAt.getTime() > config.staff.sessionMaxMs;
          if (idle || tooOld) {
            await session.update({ revokedAt: new Date(), revokeCause: idle ? 'idle' : 'expired' });
            return done(E.unauthorized('SESSION_REVOKED', 'You were signed out for inactivity. Sign in again.'));
          }
        }

        if (now - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
          await Session.update({ lastSeenAt: new Date() }, { where: { id: session.id } });
        }

        req.auth = { sessionId: session.id, familyId: session.familyId };
        return done(null, principal);
      } catch (err) {
        return done(err);
      }
    }
  )
);

module.exports = passport;
