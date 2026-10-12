'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const { E } = require('../../common/errors');

const { accessSecret, specialSecret, accessTtl, issuer } = config.auth;

/**
 * Access token: short-lived, carries only identity + session + authz version.
 * Roles/permissions are always re-read server-side (M01-FR-08).
 */
function signAccess({ userId, sessionId, authzVersion }) {
  const token = jwt.sign({ sid: sessionId, av: authzVersion, typ: 'access' }, accessSecret, {
    subject: userId,
    issuer,
    audience: 'api',
    expiresIn: accessTtl,
    algorithm: 'HS256',
  });
  const { exp } = jwt.decode(token);
  return { accessToken: token, accessTokenExpiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * Special-purpose tokens signed with a different secret so they can never be
 * confused with access tokens: signup, 2FA challenge, step-up.
 */
const SPECIAL_TTL = { signup: '10m', mfa_challenge: '5m', step_up: '5m' };

function signSpecial(typ, claims, subject) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ ...claims, typ }, specialSecret, {
    subject,
    issuer,
    audience: typ,
    expiresIn: SPECIAL_TTL[typ],
    jwtid: jti,
    algorithm: 'HS256',
  });
  const { exp } = jwt.decode(token);
  return { token, jti, expiresAt: new Date(exp * 1000) };
}

const INVALID = {
  signup: () => E.badRequest('SIGNUP_TOKEN_INVALID', 'Your verification expired. Request a new code.'),
  mfa_challenge: () => E.unauthorized('CHALLENGE_INVALID', 'Your sign-in attempt expired. Sign in again.'),
  step_up: () => E.forbidden('STEP_UP_REQUIRED', 'Confirm it is you to continue'),
};

function verifySpecial(typ, token) {
  try {
    const payload = jwt.verify(token, specialSecret, { issuer, audience: typ, algorithms: ['HS256'] });
    if (payload.typ !== typ) throw new Error('typ mismatch');
    return payload;
  } catch {
    throw INVALID[typ]();
  }
}

module.exports = { signAccess, signSpecial, verifySpecial };
