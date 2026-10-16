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

/** null when the DOB is acceptable; otherwise why not. */
function dobBlock(dob, now, minAge) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(`${dob}T00:00:00Z`))) return 'DOB_INVALID';
  if (dob > dhakaToday(now)) return 'DOB_IN_FUTURE';
  if (ageOn(dob, now) < minAge) return 'UNDER_MIN_AGE';
  return null;
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

module.exports = {
  ALLOWED,
  LOCKED_CHECKS,
  MEMBER_AFTER,
  normaliseNid,
  maskNid,
  dhakaToday,
  ageOn,
  dobBlock,
  sniffMime,
  fileBlock,
  slotsBlock,
  checks,
  memberMove,
  badge,
};
