'use strict';

/**
 * M24 gym management rules (§6), pure: no database, no clock (callers pass `today` and `now`), 100%
 * branch coverage (CLAUDE.md: money and points). Dates are Dhaka calendar dates (YYYY-MM-DD, UTC+6, no
 * daylight saving); money is BIGINT poisha with half-up rounding.
 *  - §6.1 memberships: end date, renewal start with grace, status by date, freeze and early unfreeze,
 *    the change credit (the §6.1 example is a unit test).
 *  - §6.2 dues: outstanding and status; overdue.
 *  - §6.8 the entry decision and the desk card's flags.
 *  - §3.5 tiers: features from gym_saas.feature_min_tiers, the tier that fits a member count.
 *  - Codes: member codes {SHORT}-0001 and yearly receipt numbers {SHORT}-R26-000001 (M24-FR-10, FR-33).
 *  - Tokens: the rotating member QR (HMAC domain `gym-member:`, the current or previous window,
 *    M24-FR-50) and the receipt link (domain `gym-receipt:`, no expiry, M24-FR-37). The keyed hash is
 *    passed in (`sign`), so this file never reads a secret.
 *  - Import rows (M24-FR-75): the template's columns, dates, taka amounts and every row error.
 */
const { normalizePhone } = require('../../common/identifiers');

const DHAKA_MS = 6 * 3600000;
const DAY_MS = 86400000;

const TIERS = Object.freeze(['free', 'basic', 'standard', 'pro']);
const FEATURES = Object.freeze(['attendance', 'reminders', 'online_fees', 'reports', 'trainers', 'plans', 'multi_gym']);
const METHODS = Object.freeze(['cash', 'owner_bkash', 'owner_nagad', 'card_counter', 'other']);
const LEFT_REASONS = Object.freeze(['price', 'moved', 'injury', 'other_gym', 'schedule', 'unknown', 'other']);
const SHORT_CODE = /^[A-Z]{2,6}$/;
/** M24-FR-25: a membership starts at most this many days ahead (a spec constant, not a setting). */
const ASSIGN_AHEAD_DAYS = 60;
/** Desk flag: a membership ending within this many days is "expiring" (FR-23 list filter, 7 days). */
const EXPIRING_DAYS = 7;

// ---------------------------------------------------------------- dates (Dhaka calendar)

const dhakaDate = (at) => new Date(new Date(at).getTime() + DHAKA_MS).toISOString().slice(0, 10);
const dateMs = (date) => Date.parse(`${date}T00:00:00Z`);
const addDays = (date, n) => new Date(dateMs(date) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((dateMs(to) - dateMs(from)) / DAY_MS);
const monthOf = (date) => date.slice(0, 7);
const firstOfMonth = (date) => `${date.slice(0, 7)}-01`;
const yearOf = (date) => Number(date.slice(0, 4));
/** The instant a Dhaka date starts. */
const instantOf = (date) => new Date(dateMs(date) - DHAKA_MS);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(dateMs(v)) && new Date(dateMs(v)).toISOString().slice(0, 10) === v;

/** Is `date` within [today − back, today + ahead]? */
const inWindow = ({ date, today, back = 0, ahead = 0 }) => date >= addDays(today, -back) && date <= addDays(today, ahead);

// ---------------------------------------------------------------- §6.1 memberships

/** ends_on = starts_on + days − 1 + frozen_days (inclusive). */
const endsOn = ({ startsOn, days, frozenDays = 0 }) => addDays(startsOn, days - 1 + frozenDays);

/** status by date: upcoming before the start, expired after the end, active otherwise. */
function statusByDate({ startsOn, endsOn: end, today }) {
  if (startsOn > today) return 'upcoming';
  return end < today ? 'expired' : 'active';
}

/** Days left including today (0 once ended; the full length before it starts). */
const daysLeft = ({ startsOn, endsOn: end, today }) => Math.max(0, daysBetween(startsOn > today ? startsOn : today, end) + 1);

/**
 * The start of a renewal (M24-FR-27): continuous (the day after the old end) when renewed within
 * gym_manage.renew_grace_days of the old end; otherwise the chosen date (today by default), which may
 * not be in the past.
 */
function renewStart({ today, oldEndsOn, graceDays, chosen = null }) {
  if (today <= addDays(oldEndsOn, graceDays)) return { startsOn: addDays(oldEndsOn, 1), continuous: true };
  const start = chosen ?? today;
  if (start < today) return { block: 'GYM_DATE_OUT_OF_RANGE' };
  return { startsOn: start, continuous: false };
}

/** Do two inclusive date ranges overlap? */
const overlaps = (a, b) => a.startsOn <= b.endsOn && b.startsOn <= a.endsOn;

/**
 * A new freeze (M24-FR-28): from today or later, inside the active membership, not overlapping another
 * scheduled or running freeze, within gym_manage.max_freeze_days and gym_manage.max_freezes. The end
 * date moves by the frozen days. Returns { days, endsOn, startsNow } or { block, meta }.
 */
function freezePlan({ membership, fromOn, toOn, today, freezes = [], maxDays, maxCount }) {
  if (!['active', 'frozen'].includes(membership.status)) return { block: 'GYM_MEMBERSHIP_STATE', meta: { reason: 'not_active' } };
  if (fromOn < today || toOn < fromOn || fromOn > membership.endsOn) return { block: 'GYM_DATE_OUT_OF_RANGE', meta: { from: today, to: membership.endsOn } };
  if (freezes.some((f) => ['scheduled', 'active'].includes(f.status) && overlaps({ startsOn: fromOn, endsOn: toOn }, { startsOn: f.fromOn, endsOn: f.toOn }))) {
    return { block: 'GYM_MEMBERSHIP_STATE', meta: { reason: 'freeze_overlap' } };
  }
  const days = daysBetween(fromOn, toOn) + 1;
  if (membership.frozenDays + days > maxDays) return { block: 'GYM_FREEZE_LIMIT', meta: { limit: 'days', max: maxDays, used: membership.frozenDays } };
  if (membership.freezesCount + 1 > maxCount) return { block: 'GYM_FREEZE_LIMIT', meta: { limit: 'count', max: maxCount, used: membership.freezesCount } };
  return { days, endsOn: addDays(membership.endsOn, days), startsNow: fromOn === today };
}

/**
 * Ending a freeze early (M24-FR-28): a running freeze ends today (today is not frozen) and gives back
 * to_on − today + 1 days; a scheduled one is cancelled and gives back all its days. A freeze already
 * over gives nothing back.
 */
function unfreezePlan({ freeze, today }) {
  if (freeze.status === 'scheduled') return { cancel: true, giveBack: daysBetween(freeze.fromOn, freeze.toOn) + 1 };
  if (freeze.status !== 'active' || today > freeze.toOn) return { block: 'GYM_MEMBERSHIP_STATE' };
  const endedEarlyOn = today < freeze.fromOn ? freeze.fromOn : today;
  return { endedEarlyOn, giveBack: daysBetween(endedEarlyOn, freeze.toOn) + 1 };
}

/** round(a × b ÷ c), half up, for non-negative integers. */
const mulDivRound = (a, b, c) => Math.floor((2 * a * b + c) / (2 * c));

/**
 * The credit of a package change on day c (M24-FR-29, §6.1): remaining = max(0, old end − c + 1),
 * total = days + frozen days, credit = round(paid × remaining ÷ total).
 */
function changeCredit({ days, frozenDays = 0, endsOn: end, paid, changeOn }) {
  const remaining = Math.max(0, daysBetween(changeOn, end) + 1);
  const total = days + frozenDays;
  return { remaining, total, credit: mulDivRound(paid, remaining, total) };
}

/** A membership's due (M24-FR-32): price + admission fee − discount. */
const dueAmount = ({ price, admissionFee = 0, discount = 0 }) => price + admissionFee - discount;

/** The default due of a package change: max(0, new price + admission − discount − credit). */
const changeDue = ({ price, admissionFee = 0, discount = 0, credit }) => Math.max(0, dueAmount({ price, admissionFee, discount }) - credit);

/**
 * A member's status from their running membership (§8.1), unless they left or were removed: active
 * (or frozen) while one runs; a member who is `new` (never started, or re-joined) stays new until a
 * membership starts; anyone else without a running membership is expired.
 */
function memberStatus({ current, status }) {
  if (['left', 'removed'].includes(status)) return status;
  if (current) return current.status === 'frozen' ? 'frozen' : 'active';
  return status === 'new' ? 'new' : 'expired';
}

// ---------------------------------------------------------------- §6.2 dues

/** outstanding and status (§6.2); `voided` ends the due. */
function dueState({ amount, paid, waived, voided = false }) {
  if (voided) return { outstanding: 0, status: 'void' };
  const outstanding = Math.max(0, amount - paid - waived);
  if (outstanding === 0) return { outstanding, status: paid > 0 ? 'paid' : 'waived' };
  return { outstanding, status: paid > 0 ? 'partial' : 'unpaid' };
}

const isOverdue = ({ status, dueOn, today }) => ['unpaid', 'partial'].includes(status) && dueOn < today;

/** Why a counter payment is refused (M24-FR-33), or null. */
function paymentBlock({ status, outstanding, amount, min }) {
  if (!['unpaid', 'partial'].includes(status) || outstanding <= 0) return 'GYM_DUE_STATE';
  if (amount < min || amount > outstanding) return 'GYM_PAYMENT_EXCEEDS_DUE';
  return null;
}

/** Why a reversal is refused (M24-FR-35), or null: once per payment, never a reversal or an online payment. */
function reversalBlock({ payment, alreadyReversed }) {
  if (payment.amountPoisha <= 0 || payment.method === 'online' || alreadyReversed) return 'GYM_PAYMENT_NOT_REVERSIBLE';
  return null;
}

// ---------------------------------------------------------------- §6.8 entry policy and the desk card

/**
 * reasons = expired (no running membership, the last one ended) ∪ frozen ∪ none (never had one) ∪
 * unpaid (an overdue due) ∪ visit_limit; decision allow, warn or block by the gym's policy.
 */
function entryDecision({ current, hadMembership, overdue, visits = 0, policy }) {
  const reasons = [];
  if (!current) reasons.push(hadMembership ? 'expired' : 'none');
  else if (current.status === 'frozen') reasons.push('frozen');
  if (overdue) reasons.push('unpaid');
  if (current?.visitLimit && visits >= current.visitLimit) reasons.push('visit_limit');
  if (!reasons.length || policy === 'allow') return { reasons, decision: 'allow' };
  return { reasons, decision: policy === 'block' ? 'block' : 'warn' };
}

/** The desk card's flags (M24-FR-47): expired, frozen, unpaid, expiring, visitLimitReached. */
function deskFlags({ current, hadMembership, overdue, visits = 0, today }) {
  const flags = [];
  if (!current && hadMembership) flags.push('expired');
  if (current?.status === 'frozen') flags.push('frozen');
  if (overdue) flags.push('unpaid');
  if (current && daysBetween(today, current.endsOn) < EXPIRING_DAYS) flags.push('expiring');
  if (current?.visitLimit && visits >= current.visitLimit) flags.push('visitLimitReached');
  return flags;
}

// ---------------------------------------------------------------- §3.5 tiers

const tierRank = (tier) => TIERS.indexOf(tier);
const higherTier = (a, b) => (tierRank(a) >= tierRank(b) ? a : b);

/** The lowest tier of a feature (gym_saas.feature_min_tiers); an unknown feature needs Pro. */
const minTierOf = (featureMinTiers, feature) => featureMinTiers?.[feature] ?? 'pro';
const hasFeature = (tier, feature, featureMinTiers) => tierRank(tier) >= tierRank(minTierOf(featureMinTiers, feature));
const featuresOf = (tier, featureMinTiers) => Object.fromEntries(FEATURES.map((f) => [f, hasFeature(tier, f, featureMinTiers)]));

/** The tier that fits a number of active members (§6.6). */
function fitTier(count, { freeMax, basicMax, standardMax }) {
  if (count <= freeMax) return 'free';
  if (count <= basicMax) return 'basic';
  return count <= standardMax ? 'standard' : 'pro';
}

/** The member limit of a tier (null: no limit). */
const tierLimit = (tier, { freeMax, basicMax, standardMax }) => ({ free: freeMax, basic: basicMax, standard: standardMax })[tier] ?? null;

/**
 * Choosing a tier (M24-FR-82): the chosen tier changes at once; month_max_tier keeps the highest
 * chosen in the current Dhaka month (a new month starts from the new choice).
 */
function chooseTier({ monthOf: month, monthMaxTier, today, tier }) {
  const thisMonth = firstOfMonth(today);
  return { chosenTier: tier, monthOf: thisMonth, monthMaxTier: month === thisMonth ? higherTier(monthMaxTier, tier) : tier };
}

// ---------------------------------------------------------------- codes

const memberCode = (short, seq) => `${short}-${String(seq).padStart(4, '0')}`;
const receiptNo = (short, year, seq) => `${short}-R${String(year % 100).padStart(2, '0')}-${String(seq).padStart(6, '0')}`;
/** The next receipt counter: restarts at 1 in a new calendar year (Dhaka). */
const nextReceipt = ({ receiptYear, receiptSeq, year }) => (receiptYear === year ? { receiptYear, receiptSeq: receiptSeq + 1 } : { receiptYear: year, receiptSeq: 1 });

// ---------------------------------------------------------------- tokens

const SIG = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const windowOf = (nowMs, seconds) => Math.floor(nowMs / 1000 / seconds);

/** The member QR payload (M24-FR-50): v1.gm.<memberId>.<window>.<sig>; no personal data. */
const memberToken = ({ memberId, window }, sign) => `v1.gm.${memberId}.${window}.${sign(`gym-member:${memberId}:${window}`).slice(0, 32)}`;

/** When a member token of a window stops being shown (the desk still accepts it one window more). */
const memberTokenExpiry = (window, seconds) => new Date((window + 1) * seconds * 1000);

const looksLikeMemberToken = (text) => String(text ?? '').startsWith('v1.gm.');

/** { memberId } of a well-formed token signed for the current or the previous window, else null. */
function parseMemberToken(token, { sign, equal = (a, b) => a === b, nowMs, seconds }) {
  const parts = String(token ?? '').trim().split('.');
  if (parts.length !== 5 || parts[0] !== 'v1' || parts[1] !== 'gm' || !UUID.test(parts[2]) || !/^\d{1,12}$/.test(parts[3]) || !SIG.test(parts[4])) return null;
  const [, , memberId, w, sig] = parts;
  const window = Number(w);
  const current = windowOf(nowMs, seconds);
  if (window !== current && window !== current - 1) return null;
  return equal(sig, sign(`gym-member:${memberId}:${window}`).slice(0, 32)) ? { memberId } : null;
}

/** The receipt link token (M24-FR-37): v1.<feePaymentId>.<sig>, no expiry. */
const receiptToken = (id, sign) => `v1.${id}.${sign(`gym-receipt:${id}`).slice(0, 32)}`;

function parseReceiptToken(token, { sign, equal = (a, b) => a === b }) {
  const parts = String(token ?? '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !UUID.test(parts[1]) || !SIG.test(parts[2])) return null;
  return equal(parts[2], sign(`gym-receipt:${parts[1]}`).slice(0, 32)) ? { feePaymentId: parts[1] } : null;
}

// ---------------------------------------------------------------- import rows (M24-FR-75)

/** Template columns → accepted header spellings (case and spacing ignored). */
const IMPORT_COLUMNS = Object.freeze({
  name: ['name', 'member name', 'full name', 'নাম'],
  phone: ['phone', 'mobile', 'phone number', 'mobile number', 'ফোন', 'মোবাইল'],
  gender: ['gender', 'sex', 'লিঙ্গ'],
  birthDate: ['date of birth', 'dob', 'birth date', 'birthday', 'জন্ম তারিখ'],
  package: ['package', 'plan', 'প্যাকেজ'],
  startsOn: ['start', 'start date', 'starts on', 'শুরু'],
  endsOn: ['end', 'end date', 'ends on', 'শেষ'],
  lastPaidOn: ['last payment date', 'last paid on', 'paid on', 'শেষ পেমেন্টের তারিখ'],
  lastPaid: ['last payment amount', 'last payment', 'paid', 'শেষ পেমেন্ট'],
  amountDue: ['amount due', 'due', 'বকেয়া'],
  memberCode: ['member code', 'code', 'id', 'সদস্য কোড'],
});

const squash = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_]+/g, ' ');

/** { map: field → column index } or { missing: [fields] } (name and phone are required). */
function headerMap(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const key = squash(h);
    for (const [field, names] of Object.entries(IMPORT_COLUMNS)) if (map[field] === undefined && names.includes(key)) map[field] = i;
  });
  const missing = ['name', 'phone'].filter((f) => map[f] === undefined);
  return missing.length ? { missing } : { map };
}

/**
 * A date cell: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY or DD.MM.YYYY text, or a spreadsheet Date (exceljs
 * gives UTC midnight). Empty → null; anything else → undefined (invalid).
 */
function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
  const s = String(value).trim();
  if (!s) return null;
  let iso = s;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isDate(iso) ? iso : undefined;
}

/** A taka cell (৳ and commas allowed, up to 2 decimals) → poisha. Empty → null; invalid → undefined. */
function parseTaka(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).replace(/[৳,\s]/g, '').replace(/^tk\.?/i, '');
  if (!s) return null;
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : undefined;
}

const GENDERS = { male: 'male', m: 'male', পুরুষ: 'male', female: 'female', f: 'female', নারী: 'female', other: 'other', o: 'other', অন্যান্য: 'other' };

/** The package a cell names: by title, or by kind key (month, quarter, half_year, year, day). */
function findPackage(text, packages) {
  const key = squash(text);
  return packages.find((p) => squash(p.title) === key) ?? packages.find((p) => p.kind !== 'custom' && squash(p.kind) === key.replace(/ /g, '_')) ?? null;
}

/**
 * Validate the rows of a file (raw cell arrays, header removed) against the gym's desk packages and
 * existing members. `hashPhone(e164)` is the keyed phone hash (the caller's). Returns one report row
 * per line: { n, status: 'ok' | 'error', errors: [{ field, code }], value } where `value` holds the
 * parsed fields (the caller keeps phones out of anything it stores).
 */
function validateImportRows(rows, { map, packages, existingHashes = new Set(), existingCodes = new Set(), hashPhone, today }) {
  const seenHashes = new Map();
  const seenCodes = new Map();
  const cell = (row, field) => (map[field] === undefined ? null : row[map[field]] ?? null);
  return rows.map((row, i) => {
    const n = i + 2; // the header is line 1
    const errors = [];
    const err = (field, code) => errors.push({ field, code });
    const name = String(cell(row, 'name') ?? '').trim();
    if (name.length < 2 || name.length > 80) err('name', 'name_invalid');
    const phone = normalizePhone(String(cell(row, 'phone') ?? '').replace(/\.0$/, ''));
    let phoneHash = null;
    if (!phone) err('phone', 'phone_invalid');
    else {
      phoneHash = hashPhone(phone);
      if (existingHashes.has(phoneHash)) err('phone', 'duplicate_phone_in_gym');
      else if (seenHashes.has(phoneHash)) err('phone', 'duplicate_phone_in_file');
      else seenHashes.set(phoneHash, n);
    }
    const genderText = squash(cell(row, 'gender'));
    const gender = genderText ? GENDERS[genderText] : null;
    if (gender === undefined) err('gender', 'gender_invalid');
    const birthDate = parseDate(cell(row, 'birthDate'));
    if (birthDate === undefined || (birthDate && birthDate > today)) err('birthDate', 'date_invalid');
    const codeText = String(cell(row, 'memberCode') ?? '').trim().toUpperCase();
    if (codeText) {
      if (!/^[A-Z0-9-]{1,12}$/.test(codeText)) err('memberCode', 'code_invalid');
      else if (existingCodes.has(codeText)) err('memberCode', 'duplicate_code_in_gym');
      else if (seenCodes.has(codeText)) err('memberCode', 'duplicate_code_in_file');
      else seenCodes.set(codeText, n);
    }
    const packageText = String(cell(row, 'package') ?? '').trim();
    const pkg = packageText ? findPackage(packageText, packages) : null;
    if (packageText && !pkg) err('package', 'unknown_package');
    const startsOn = parseDate(cell(row, 'startsOn'));
    const endText = parseDate(cell(row, 'endsOn'));
    if (startsOn === undefined) err('startsOn', 'date_invalid');
    if (endText === undefined) err('endsOn', 'date_invalid');
    const lastPaid = parseTaka(cell(row, 'lastPaid'));
    const amountDue = parseTaka(cell(row, 'amountDue'));
    const lastPaidOn = parseDate(cell(row, 'lastPaidOn'));
    if (lastPaid === undefined) err('lastPaid', 'amount_invalid');
    if (amountDue === undefined) err('amountDue', 'amount_invalid');
    if (lastPaidOn === undefined || (lastPaidOn && lastPaidOn > today)) err('lastPaidOn', 'date_invalid');
    if (lastPaid > 0 && !lastPaidOn) err('lastPaidOn', 'date_required');
    let ends = endText ?? null;
    if (pkg) {
      if (!startsOn) err('startsOn', 'date_required');
      else if (!ends) ends = addDays(startsOn, pkg.days - 1);
      if (startsOn && ends && ends < startsOn) err('endsOn', 'end_before_start');
      else if (startsOn && ends && daysBetween(startsOn, ends) + 1 > 366) err('endsOn', 'too_long');
    } else if (startsOn || endText || lastPaid > 0 || amountDue > 0) {
      err('package', 'package_required');
    }
    const value = { name, phone, phoneHash, gender: gender ?? null, birthDate: birthDate || null, memberCode: codeText || null, packageId: pkg?.id ?? null, startsOn: pkg ? startsOn : null, endsOn: pkg ? ends : null, lastPaid: lastPaid || 0, lastPaidOn: lastPaidOn || null, amountDue: amountDue || 0 };
    return { n, status: errors.length ? 'error' : 'ok', errors, value };
  });
}

module.exports = {
  TIERS,
  FEATURES,
  METHODS,
  LEFT_REASONS,
  SHORT_CODE,
  ASSIGN_AHEAD_DAYS,
  EXPIRING_DAYS,
  IMPORT_COLUMNS,
  dhakaDate,
  addDays,
  daysBetween,
  monthOf,
  firstOfMonth,
  yearOf,
  instantOf,
  isDate,
  inWindow,
  endsOn,
  statusByDate,
  daysLeft,
  renewStart,
  overlaps,
  freezePlan,
  unfreezePlan,
  changeCredit,
  dueAmount,
  changeDue,
  memberStatus,
  dueState,
  isOverdue,
  paymentBlock,
  reversalBlock,
  entryDecision,
  deskFlags,
  tierRank,
  higherTier,
  minTierOf,
  hasFeature,
  featuresOf,
  fitTier,
  tierLimit,
  chooseTier,
  memberCode,
  receiptNo,
  nextReceipt,
  windowOf,
  memberToken,
  memberTokenExpiry,
  looksLikeMemberToken,
  parseMemberToken,
  receiptToken,
  parseReceiptToken,
  headerMap,
  parseDate,
  parseTaka,
  findPackage,
  validateImportRows,
};
