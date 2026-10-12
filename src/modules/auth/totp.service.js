'use strict';

const { authenticator } = require('otplib');
const { encrypt, decrypt } = require('../../common/crypto');
const { E } = require('../../common/errors');

const ISSUER = 'Kriraghor';
const STEP_SECONDS = 30;

// RFC 6238 defaults (SHA-1, 6 digits, 30 s) so every authenticator app works.
// window: 1 accepts the previous/next step to tolerate clock drift.
authenticator.options = { step: STEP_SECONDS, window: 1 };

function createSecret(label) {
  const secret = authenticator.generateSecret();
  return {
    secret,
    secretEnc: encrypt(secret),
    otpauthUrl: authenticator.keyuri(label, ISSUER, secret),
  };
}

/**
 * Verify a TOTP code for a staff member and reject replays of the same time step
 * (staff_members.totp_last_step). Returns the matched step so the caller can persist it.
 */
function verifyCode(staff, code, { secretEnc } = {}) {
  const enc = secretEnc ?? staff.totpSecretEnc;
  if (!enc) throw E.forbidden('TWO_FACTOR_REQUIRED', 'Set up two-factor sign-in first');
  if (!/^\d{6}$/.test(String(code))) throw E.badRequest('TOTP_INVALID', 'Enter the 6-digit code from your authenticator app');

  const delta = authenticator.checkDelta(String(code), decrypt(enc));
  if (delta === null) throw E.badRequest('TOTP_INVALID', 'That code is not right. Try the latest code from your app.');

  const step = Math.floor(Date.now() / 1000 / STEP_SECONDS) + delta;
  if (staff.totpLastStep != null && step <= Number(staff.totpLastStep)) {
    throw E.badRequest('TOTP_REPLAYED', 'That code was already used. Wait for the next one.');
  }
  return step;
}

module.exports = { createSecret, verifyCode };
