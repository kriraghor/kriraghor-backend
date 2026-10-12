'use strict';

const { z } = require('zod');

// Bangladesh mobile: +880 1[3-9]XXXXXXXX (operator prefixes 13–19).
const BD_MOBILE = /^\+8801[3-9]\d{8}$/;

/** Normalise "01712345678", "8801712345678", "+880 1712-345678" → "+8801712345678". */
function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  let d = input.replace(/[\s\-()]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('880')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  const e164 = `+880${d}`;
  return BD_MOBILE.test(e164) ? e164 : null;
}

function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  const e = input.trim().toLowerCase();
  return z.email().safeParse(e).success ? e : null;
}

// Username: 3–30 chars, starts with a letter, letters/digits/dot/underscore, stored lower-case.
const USERNAME = /^[a-z][a-z0-9._]{2,29}$/;
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'support', 'help', 'kriraghor', 'staff', 'master', 'system', 'api',
  'official', 'moderator', 'security', 'billing', 'payments', 'payout', 'noreply', 'no-reply', 'info',
]);

/** Returns the normalised username, or null if it does not meet the rules. */
function normalizeUsername(input) {
  if (typeof input !== 'string') return null;
  const u = input.trim().toLowerCase().replace(/^@/, '');
  if (!USERNAME.test(u) || u.endsWith('.') || u.includes('..')) return null;
  return u;
}
const isReservedUsername = (u) => RESERVED_USERNAMES.has(u);

/**
 * Parse an identifier the user typed (phone or email).
 * Returns { type: 'phone'|'email', value } or null.
 */
function parseIdentifier(input) {
  const phone = normalizePhone(input);
  if (phone) return { type: 'phone', value: phone };
  const email = normalizeEmail(input);
  if (email) return { type: 'email', value: email };
  return null;
}

function maskPhone(e164) {
  return e164 ? `${e164.slice(0, 7)}•••${e164.slice(-3)}` : null;
}

function maskEmail(email) {
  if (!email) return null;
  const [u, d] = email.split('@');
  return `${u.slice(0, 2)}•••@${d}`;
}

/** Sign-in identifier: phone, email or username (username only works with a password). */
function parseLoginIdentifier(input) {
  const id = parseIdentifier(input);
  if (id) return id;
  const username = normalizeUsername(input);
  return username ? { type: 'username', value: username } : null;
}

const loginIdentifierSchema = z
  .string()
  .trim()
  .min(3)
  .max(191)
  .transform((v, ctx) => {
    const id = parseLoginIdentifier(v);
    if (!id) {
      ctx.addIssue({ code: 'custom', message: 'Enter your mobile number, email or username.' });
      return z.NEVER;
    }
    return id;
  });

const usernameSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const u = normalizeUsername(v);
    if (!u) {
      ctx.addIssue({ code: 'custom', message: 'Use 3–30 letters, numbers, dots or underscores, starting with a letter.' });
      return z.NEVER;
    }
    if (isReservedUsername(u)) {
      ctx.addIssue({ code: 'custom', message: 'That username is reserved. Choose another one.' });
      return z.NEVER;
    }
    return u;
  });

const identifierSchema = z
  .string()
  .trim()
  .min(3)
  .max(191)
  .transform((v, ctx) => {
    const id = parseIdentifier(v);
    if (!id) {
      ctx.addIssue({ code: 'custom', message: 'Enter a Bangladeshi mobile number (01XXXXXXXXX) or an email address.' });
      return z.NEVER;
    }
    return id;
  });

module.exports = {
  normalizePhone,
  normalizeEmail,
  normalizeUsername,
  isReservedUsername,
  parseIdentifier,
  parseLoginIdentifier,
  maskPhone,
  maskEmail,
  identifierSchema,
  loginIdentifierSchema,
  usernameSchema,
  BD_MOBILE,
};
