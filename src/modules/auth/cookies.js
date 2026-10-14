'use strict';

const crypto = require('crypto');
const config = require('../../config');
const limits = require('./limits');

/**
 * Auth cookies (ADR-004). Names come from COOKIE_PREFIX so staging never collides with prod.
 *
 * | Cookie         | Audience | Domain              | HttpOnly | SameSite | Path         | Value                 |
 * |----------------|----------|---------------------|----------|----------|--------------|-----------------------|
 * | {p}_rt         | api      | host-only (api.)    | yes      | Lax      | /api/v1/auth | refresh token         |
 * | {p}_art        | admin    | host-only (api.)    | yes      | Strict   | /api/v1/auth | admin refresh token   |
 * | {p}_si/_asi    | both     | COOKIE_HINT_DOMAIN  | no       | Lax      | /            | "1" (routing hint)    |
 * | {p}_csrf/_acsrf| both     | COOKIE_HINT_DOMAIN  | no       | Lax      | /            | CSRF token            |
 *
 * The hint cookies carry no identity and never authorise anything; Next.js middleware reads them
 * only to decide whether to show the signed-in shell. The CSRF token is bound to the session family
 * with an HMAC, so a token minted for one session is useless with another.
 */
const { cookies: NAMES } = config.auth;
const refreshPath = `${config.apiPrefix}/auth`;

const isAdmin = (audience) => audience === 'admin';
const names = (audience) =>
  isAdmin(audience)
    ? { refresh: NAMES.adminRefresh, signedIn: NAMES.adminSignedIn, csrf: NAMES.adminCsrf }
    : { refresh: NAMES.refresh, signedIn: NAMES.signedIn, csrf: NAMES.csrf };

const maxAgeMs = (audience) => limits.refreshTtlMs(audience);

const refreshOptions = (audience) => ({
  httpOnly: true,
  secure: config.auth.cookieSecure,
  sameSite: isAdmin(audience) ? 'strict' : 'lax',
  path: refreshPath,
});
const hintOptions = () => ({ httpOnly: false, secure: config.auth.cookieSecure, sameSite: 'lax', path: '/', domain: config.auth.hintDomain });

function hmac(audience, familyId, nonce) {
  return crypto.createHmac('sha256', config.auth.csrfSecret).update(`${audience}:${familyId}:${nonce}`).digest('base64url');
}

function mintCsrf(audience, familyId) {
  const nonce = crypto.randomBytes(18).toString('base64url');
  return `${nonce}.${hmac(audience, familyId, nonce)}`;
}

/** True when `token` was minted for this audience and session family. Constant-time compare. */
function verifyCsrfBinding(token, audience, familyId) {
  const [nonce, mac] = String(token).split('.');
  if (!nonce || !mac) return false;
  const expected = Buffer.from(hmac(audience, familyId, nonce));
  const given = Buffer.from(mac);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Set the refresh cookie and the hint and CSRF cookies after sign-in or refresh. */
function setSessionCookies(res, { audience, refreshToken, familyId }) {
  const n = names(audience);
  const maxAge = maxAgeMs(audience);
  res.cookie(n.refresh, refreshToken, { ...refreshOptions(audience), maxAge });
  res.cookie(n.signedIn, '1', { ...hintOptions(), maxAge });
  res.cookie(n.csrf, mintCsrf(audience, familyId), { ...hintOptions(), maxAge });
}

function clearSessionCookies(res, audience) {
  const n = names(audience);
  res.clearCookie(n.refresh, refreshOptions(audience));
  res.clearCookie(n.signedIn, hintOptions());
  res.clearCookie(n.csrf, hintOptions());
}

module.exports = { names, setSessionCookies, clearSessionCookies, mintCsrf, verifyCsrfBinding };
