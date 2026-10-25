'use strict';

/**
 * M02 KYC rules (§6). Pure functions, no I/O, 100% branch coverage. Dates of birth are 'YYYY-MM-DD'
 * strings; "today" is the Asia/Dhaka calendar day (UTC+6, no DST).
 */
const DHAKA_OFFSET_MS = 6 * 3600 * 1000;

// ---------------------------------------------------------------- NID number (FR-06, §6.3)

/**
 * Digits only, 10 (smart card), 13 (legacy) or 17 long. A 13-digit legacy number becomes 17 by prefixing
 * the 4-digit birth year, so the same person is caught as a duplicate whichever form they type.
 * Returns { value } or { error }.
 */
function normaliseNid(input, birthYear) {
  const digits = String(input ?? '').replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return { error: 'NID_FORMAT_INVALID' };
  if (digits.length === 10 || digits.length === 17) return { value: digits };
  if (digits.length === 13 && /^\d{4}$/.test(String(birthYear))) return { value: `${birthYear}${digits}` };
  return { error: 'NID_FORMAT_INVALID' };
}

const maskNid = (nid) => `•••• ${String(nid).slice(-4)}`;

// ---------------------------------------------------------------- date of birth (§6.3 age_ok)

const dhakaToday = (now) => new Date(now.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);

/** Whole years between a date of birth and the Dhaka calendar day of `now`. */
function ageOn(dob, now) {
  const [y, m, d] = dob.split('-').map(Number);
  const [ty, tm, td] = dhakaToday(now).split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/**
 * null when the DOB is acceptable; otherwise why not. §6.3 age_ok: the holder must be at least
 * kyc.min_age_years (18 since 25 Oct 2026, product owner) on today's Dhaka calendar day.
 */
function dobBlock(dob, now, minAge) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(`${dob}T00:00:00Z`))) return 'DOB_INVALID';
  if (dob > dhakaToday(now)) return 'DOB_IN_FUTURE';
  if (ageOn(dob, now) < minAge) return 'UNDER_MIN_AGE';
  return null;
}

/**
 * The earliest birth year that can still be under minAge today in Dhaka (one year of slack), used to
 * prefilter NID documents on fields_public.birthYear before decrypting any date of birth.
 */
const underAgeFromYear = (now, minAge) => Number(dhakaToday(now).slice(0, 4)) - minAge - 1;

// ---------------------------------------------------------------- consent (M02-FR-05, 25 Oct 2026)

/**
 * The consent sent with a document: { accepted: true, version } where version is the current consent
 * version. Old clients sending `consent: true` get CONSENT_REQUIRED, so nobody submits without ticking
 * the box that showed the current text. null when the consent is valid.
 */
function consentBlock(consent, currentVersion) {
  if (!consent || typeof consent !== 'object' || consent.accepted !== true) return 'CONSENT_REQUIRED';
  if (consent.version !== currentVersion) return 'CONSENT_VERSION_STALE';
  return null;
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toBnDigits = (s) => String(s).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);

/** Fill {name} placeholders (unknown names stay as they are); Bangla text gets Bangla digits. */
function fillText(template, vars, { bn = false } = {}) {
  return template.replace(/\{(\w+)\}/g, (whole, k) => {
    if (vars[k] === undefined || vars[k] === null) return whole;
    return bn ? toBnDigits(vars[k]) : String(vars[k]);
  });
}

// ---------------------------------------------------------------- files (FR-03, FR-04 lite)

const ALLOWED = ['image/jpeg', 'image/png', 'application/pdf'];

// The type from the first bytes (shared with M21 screenshots).
const { sniffMime } = require('../../common/filetype');

/** null when the upload is acceptable; otherwise the error code. */
function fileBlock({ declared, sniffed, size, max }) {
  if (!size) return 'FILE_EMPTY';
  if (size > max) return 'FILE_TOO_LARGE';
  if (!ALLOWED.includes(declared) || !sniffed) return 'FILE_TYPE_NOT_ALLOWED';
  if (declared !== sniffed) return 'FILE_TYPE_MISMATCH';
  return null;
}

/** Every slot the requirement lists has exactly one file, and nothing else. */
function slotsBlock(slots, files = {}) {
  const given = Object.keys(files);
  if (slots.some((s) => !files[s]) || given.some((s) => !slots.includes(s))) return 'FILES_INCOMPLETE';
  if (new Set(given.map((s) => files[s])).size !== given.length) return 'FILES_INCOMPLETE';
  return null;
}

// ---------------------------------------------------------------- automatic checks (§6.3; M05 runs them on every claim)

/**
 * The checks shown to the reviewer. `blocks` checks must pass before approval. An NID already verified
 * on another account can never be overridden (M01 keeps nid_hash unique: LOCKED_CHECKS); one only
 * waiting for review elsewhere can be, by a master (M05 Q46), when this member is the real holder.
 */
function checks({ verifiedHolders, pendingHolders, reusedFiles }) {
  return [
    { key: 'nid_format', ok: true, blocks: true },
    { key: 'age_ok', ok: true, blocks: true },
    { key: 'nid_unique', ok: verifiedHolders === 0, blocks: true, detail: verifiedHolders ? `Verified on ${verifiedHolders} other account(s)` : null },
    { key: 'nid_pending_elsewhere', ok: pendingHolders === 0, blocks: true, detail: pendingHolders ? `Waiting for review on ${pendingHolders} other account(s)` : null },
    { key: 'file_type', ok: true, blocks: false, detail: 'Type and size checked; virus scan not yet available' },
    { key: 'file_reused', ok: reusedFiles === 0, blocks: false, detail: reusedFiles ? `${reusedFiles} file(s) also uploaded by another account` : null },
  ];
}
const LOCKED_CHECKS = ['nid_unique'];

// ---------------------------------------------------------------- the member role (M01) and the badge (§6.2, §6.4)

/** Member role and users.kyc_status after a KYC event. */
const MEMBER_AFTER = {
  submitted: { role: 'in_review', kyc: 'pending' },
  approved: { role: 'active', kyc: 'verified' },
  changes_requested: { role: 'changes_requested', kyc: 'unverified' },
  rejected: { role: 'rejected', kyc: 'rejected' },
};

/** Member statuses a KYC event may move from (an active or suspended member is never moved by M02). */
const MEMBER_FROM = {
  submitted: ['applied', 'documents_pending', 'in_review', 'changes_requested', 'rejected'],
  // rejected: a master reopened a rejection and approved it (M05 FR-21).
  approved: ['applied', 'documents_pending', 'in_review', 'changes_requested', 'rejected'],
  changes_requested: ['applied', 'documents_pending', 'in_review'],
  rejected: ['applied', 'documents_pending', 'in_review'],
};
const memberMove = (event, from) => (MEMBER_FROM[event].includes(from) ? MEMBER_AFTER[event] : null);

/** §6.4 badge from the checklist items' statuses. */
function badge(items) {
  if (items.every((i) => i.status === 'approved')) return 'fully_verified';
  if (items.some((i) => i.status === 'in_review')) return 'documents_in_review';
  return 'verification_needed';
}

// ---------------------------------------------------------------- business-role documents (ground owners M09, shop owners M12)

/** Business document types; each belongs to a role through its requirement row (kept per role, M12). */
const BUSINESS_TYPES = ['trade_license', 'deed_or_lease', 'tin', 'bin', 'credential', 'police_clearance', 'org_registration'];

/**
 * Which business role a document is for: the one asked for, else the only applied role that needs
 * this type. Returns { role } or { error } (ROLE_NOT_APPLIED, ROLE_AMBIGUOUS).
 */
function businessRoleFor({ asked, requirementRoles, appliedRoles }) {
  if (asked) return requirementRoles.includes(asked) && appliedRoles.includes(asked) ? { role: asked } : { error: requirementRoles.includes(asked) ? 'ROLE_NOT_APPLIED' : 'DOC_TYPE_NOT_REQUIRED' };
  const candidates = requirementRoles.filter((r) => appliedRoles.includes(r));
  if (candidates.length === 1) return { role: candidates[0] };
  return { error: candidates.length ? 'ROLE_AMBIGUOUS' : requirementRoles.length ? 'ROLE_NOT_APPLIED' : 'DOC_TYPE_NOT_REQUIRED' };
}

/**
 * Check submitted fields against a requirement's field_schema. Each schema entry:
 * { key, type: text|digits|date|enum, required, min, max, options, future }. Unknown keys are refused.
 * Returns a VALIDATION_FAILED errors list, or null when the fields are fine.
 */
function fieldsBlock(schema, fields = {}, today) {
  const errors = [];
  const known = new Set(schema.map((f) => f.key));
  for (const k of Object.keys(fields)) if (!known.has(k)) errors.push({ field: `fields.${k}`, message: 'Not a field of this document' });
  for (const f of schema) {
    const v = fields[f.key];
    const field = `fields.${f.key}`;
    if (v === undefined || v === null || v === '') {
      if (f.required) errors.push({ field, message: 'Required' });
      continue;
    }
    const s = String(v).trim();
    if (f.type === 'enum') {
      if (!f.options.includes(s)) errors.push({ field, message: `One of ${f.options.join(', ')}` });
    } else if (f.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) errors.push({ field, message: 'A date as YYYY-MM-DD' });
      else if (f.future && s <= today) errors.push({ field, message: 'This date has passed' });
    } else if ((f.type === 'digits' && !/^\d+$/.test(s)) || s.length < (f.min ?? 1) || s.length > (f.max ?? 120)) {
      errors.push({ field, message: f.type === 'digits' ? `${f.min ?? 1} to ${f.max ?? 120} digits` : `${f.min ?? 1} to ${f.max ?? 120} characters` });
    }
  }
  return errors.length ? errors : null;
}

/** The checks shown for a business document: the file and, when it has one, the expiry date. */
function businessChecks({ reusedFiles, expiresOn, today }) {
  return [
    { key: 'file_type', ok: true, blocks: false, detail: 'Type and size checked; virus scan not yet available' },
    { key: 'file_reused', ok: reusedFiles === 0, blocks: false, detail: reusedFiles ? `${reusedFiles} file(s) also uploaded by another account` : null },
    ...(expiresOn ? [{ key: 'not_expired', ok: expiresOn > today, blocks: true, detail: `Valid until ${expiresOn}` }] : []),
  ];
}

/**
 * A business role (ground_owner …) after one of its documents moves. Activation is separate: it
 * needs every required document approved (roleComplete) and an active member role (M01).
 */
const BUSINESS_AFTER = { submitted: 'in_review', changes_requested: 'changes_requested', rejected: 'rejected' };
const businessMove = (event, from) => (BUSINESS_AFTER[event] && MEMBER_FROM[event].includes(from) ? BUSINESS_AFTER[event] : null);

/** Every `always` requirement of the role has an approved current document. */
const roleComplete = (requirements, approvedTypes) => requirements.filter((r) => r.docType && r.required === 'always').every((r) => approvedTypes.includes(r.docType));

/** Badge for a business role: optional items that were never sent do not hold it back. */
const roleBadge = (items) => badge(items.filter((i) => i.required !== 'optional' || i.status !== 'missing'));

module.exports = {
  BUSINESS_TYPES,
  businessRoleFor,
  fieldsBlock,
  businessChecks,
  businessMove,
  roleComplete,
  roleBadge,
  ALLOWED,
  LOCKED_CHECKS,
  MEMBER_AFTER,
  normaliseNid,
  maskNid,
  dhakaToday,
  ageOn,
  dobBlock,
  underAgeFromYear,
  consentBlock,
  fillText,
  toBnDigits,
  sniffMime,
  fileBlock,
  slotsBlock,
  checks,
  memberMove,
  badge,
};
