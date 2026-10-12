'use strict';

const crypto = require('crypto');
const argon2 = require('@node-rs/argon2');
const config = require('../../config');
const { E } = require('../../common/errors');

// argon2id with m=64 MiB, t=3, p=1 (M01-FR-05).
const HASH_OPTIONS = { memoryCost: 65536, timeCost: 3, parallelism: 1, algorithm: 2 /* Argon2id */ };

// Cheap local deny-list; the k-anonymity HIBP check below covers the long tail.
const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123',
  '11111111', '00000000', 'iloveyou', 'abc12345', 'bangladesh', 'kriraghor', 'football', 'cricket123',
]);

async function isBreached(password) {
  if (!config.passwordBreachCheck) return false;
  const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split('\n').some((line) => {
      const [hashSuffix, count] = line.trim().split(':');
      return hashSuffix === suffix && Number(count) > 0;
    });
  } catch {
    return false; // fail open: availability over a best-effort check
  }
}

/** Throws PASSWORD_WEAK / PASSWORD_BREACHED. */
async function assertAcceptable(password, { identifiers = [] } = {}) {
  const lower = password.toLowerCase();
  if (password.length < 8 || password.length > 128) {
    throw E.badRequest('PASSWORD_WEAK', 'Use at least 8 characters', 'Passwords must be 8–128 characters.');
  }
  if (COMMON.has(lower) || identifiers.some((id) => id && lower.includes(String(id).toLowerCase().replace('+880', '')))) {
    throw E.badRequest('PASSWORD_WEAK', 'Choose a less common password');
  }
  if (await isBreached(password)) {
    throw E.badRequest('PASSWORD_BREACHED', 'This password has appeared in a data breach. Choose another one.');
  }
}

const hash = (password) => argon2.hash(password, HASH_OPTIONS);
const verify = async (hashValue, password) => {
  if (!hashValue) return false;
  try {
    return await argon2.verify(hashValue, password);
  } catch {
    return false;
  }
};

// Equalise timing for unknown accounts: always run one real argon2 verification.
let dummyHash;
async function dummyVerify(password) {
  dummyHash ??= await hash('kriraghor-timing-equaliser');
  await verify(dummyHash, password);
}

module.exports = { hash, verify, dummyVerify, assertAcceptable };
