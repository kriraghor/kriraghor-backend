'use strict';

const jwt = require('jsonwebtoken');
const config = require('../../config');
const { Session } = require('../../models');
const { E } = require('../../common/errors');
const authz = require('./authz.service');
const limits = require('./limits');

const LAST_SEEN_THROTTLE_MS = 60 * 1000;
const AUDIENCES = Object.freeze({ API: 'api', ADMIN: 'admin' });

const sessionEnded = () => E.unauthorized('SESSION_REVOKED', 'Your session has ended. Sign in again.');

/**
 * Checks after the JWT signature, issuer, audience and expiry are verified (M01-FR-07/08/10, ADR-004):
 *  - the session exists, belongs to the subject, is unrevoked and unexpired, and has the token's audience;
 *  - the authz version in the token matches users.authz_version (otherwise AUTHZ_STALE, and the client refreshes);
 *  - the account is active;
 *  - staff sessions passed two-factor and are within the idle timeout and absolute lifetime.
 * Shared by the passport strategies (HTTP) and the Socket.IO handshake.
 * Returns { principal, auth: { sessionId, familyId, audience } } or throws an AppError.
 */
async function checkAccessPayload(payload, audience) {
  if (payload.typ !== 'access') throw E.unauthorized();

  const session = await Session.findByPk(payload.sid);
  const now = Date.now();
  if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt.getTime() < now) throw sessionEnded();
  if (session.audience !== audience) throw E.unauthorized('TOKEN_AUDIENCE_INVALID', 'This sign-in is not valid here');

  const principal = await authz.loadPrincipal(payload.sub);
  if (!principal) throw sessionEnded();
  if (principal.user.authzVersion !== payload.av) throw E.unauthorized('AUTHZ_STALE', 'Your access changed. Refresh your session.');
  if (principal.user.status === 'suspended') throw E.forbidden('ACCOUNT_SUSPENDED', 'Your account is suspended');
  if (principal.user.status !== 'active') throw E.forbidden('ACCOUNT_BANNED', 'Your account is not active');

  // Q33 (answered by ADR-004): staff use separate accounts, so a staff principal never holds a customer session.
  if (audience === AUDIENCES.API && principal.isStaff) throw E.forbidden('STAFF_USE_ADMIN_PORTAL', 'Staff accounts sign in at the admin portal');
  if (audience === AUDIENCES.ADMIN) {
    if (!principal.isStaff) throw E.forbidden('NOT_STAFF', 'This sign-in is for Kriraghor staff only');
    if (!session.twoFactorAt) throw E.forbidden('TWO_FACTOR_REQUIRED', 'Sign in again with two-factor authentication');
    const idle = now - session.lastSeenAt.getTime() > limits.staffIdleMs();
    // Absolute lifetime counts from the 2FA moment, which is carried across refresh rotations.
    const tooOld = now - session.twoFactorAt.getTime() > limits.staffSessionMaxMs();
    if (idle || tooOld) {
      await session.update({ revokedAt: new Date(), revokeCause: idle ? 'idle' : 'expired' });
      throw E.unauthorized('SESSION_REVOKED', 'You were signed out for inactivity. Sign in again.');
    }
  }

  if (now - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    await Session.update({ lastSeenAt: new Date() }, { where: { id: session.id } });
  }
  return { principal, auth: { sessionId: session.id, familyId: session.familyId, audience } };
}

/** Verify a raw access token for `audience` (used by the Socket.IO handshake). */
async function verifyAccessToken(token, audience) {
  if (!token) throw E.unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, config.auth.accessSecret, { issuer: config.auth.issuer, algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw E.unauthorized('TOKEN_EXPIRED', 'Your session needs a refresh');
    throw E.unauthorized();
  }
  if (payload.aud !== audience) throw E.unauthorized('TOKEN_AUDIENCE_INVALID', 'This sign-in is not valid here');
  return checkAccessPayload(payload, audience);
}

module.exports = { AUDIENCES, checkAccessPayload, verifyAccessToken };
