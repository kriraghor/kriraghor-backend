'use strict';

/**
 * Audit redactor (M04-FR-03). before/after/meta never hold raw personal or secret data:
 *  - phone numbers keep their last 3 digits, emails keep the first letter and the domain;
 *  - NID, date of birth, TIN, account numbers, tokens, secrets, passwords, hashes and file/object
 *    keys are replaced by "[redacted]" (so the diff still shows that they changed).
 * Setting keys ("key") and IDs are kept. Pure, 100% branch coverage.
 */
const REMOVE = [
  /^nid/i,
  /nid(hash|last4|number)?$/i,
  /^dob$|dateofbirth|birth_?date/i,
  /^tin$|tin_?number/i,
  /account_?(no|number|num)$/i,
  /^iban$/i,
  /token/i,
  /secret/i,
  /password/i,
  /hash$/i,
  /(api|private|secret|file|object|access|storage)_?key$/i,
];
const PHONE = /phone|mobile|msisdn/i;
const EMAIL = /e?mail$/i;
const REDACTED = '[redacted]';

function maskPhone(v) {
  const digits = String(v).replace(/\D/g, '');
  return digits.length <= 3 ? '***' : `${'*'.repeat(digits.length - 3)}${digits.slice(-3)}`;
}

function maskEmail(v) {
  const s = String(v);
  const at = s.indexOf('@');
  return at < 1 ? REDACTED : `${s[0]}***${s.slice(at)}`;
}

function redact(value, key = '') {
  if (value === null || value === undefined) return value;
  if (key && REMOVE.some((re) => re.test(key))) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  if (key && PHONE.test(key)) return maskPhone(value);
  if (key && EMAIL.test(key)) return maskEmail(value);
  return value;
}

module.exports = { redact, maskPhone, maskEmail, REDACTED };
