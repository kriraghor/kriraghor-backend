'use strict';

const crypto = require('crypto');
const config = require('../config');

/** SHA-256 hex digest (refresh tokens are stored hashed, never in plain text). */
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Keyed hash used for OTP codes so a DB leak does not reveal live codes. */
const hmac = (value, secret = config.otp.hashSecret) =>
  crypto.createHmac('sha256', secret).update(value).digest('hex');

const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');

/** Uniform random numeric code, e.g. OTP "048213". */
function randomDigits(length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += crypto.randomInt(0, 10).toString();
  return out;
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** AES-256-GCM envelope for secrets at rest (e.g. TOTP seeds). Output: iv.tag.ciphertext (base64url). */
function encrypt(plain, key = config.crypto.dataKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

function decrypt(payload, key = config.crypto.dataKey) {
  const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

module.exports = { sha256, hmac, randomToken, randomDigits, timingSafeEqualHex, encrypt, decrypt };
