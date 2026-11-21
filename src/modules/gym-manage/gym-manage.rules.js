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
 *  - Prompt 3: the entrance tablet QR (domain `gym-entrance:`, current or previous window, M24-FR-51),
 *    the plan day mapping (§6.10), the plan content limits from settings (M24-FR-62), the tick window
 *    (M24-FR-65) and the latest tick per item and date.
 */
const { normalizePhone } = require('../../common/identifiers');

const DHAKA_MS = 6 * 3600000;
const DAY_MS = 86400000;

const TIERS = Object.freeze(['free', 'basic', 'standard', 'pro']);
// M27 round 1 adds expenses (with the cash drawer), lockers, pos (counter shop and stock) and pnl (profit and loss).
const FEATURES = Object.freeze(['attendance', 'reminders', 'online_fees', 'reports', 'trainers', 'plans', 'multi_gym', 'expenses', 'lockers', 'pos', 'pnl', 'classes', 'points', 'notices', 'leads', 'staff_attendance', 'equipment', 'payroll', 'visits', 'progress', 'desk_mode', 'whatsapp']);
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

// ---------------------------------------------------------------- trial visits (product owner, 9 Nov 2026)

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const minuteOfDay = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** Minutes after midnight in Dhaka of an instant. */
const dhakaMinute = (at) => Math.floor(((new Date(at).getTime() + DHAKA_MS) % DAY_MS) / 60000);
/** The instant a visit starts: its Dhaka date and arrival time. */
const visitStartAt = (date, arriveAt) => new Date(instantOf(date).getTime() + minuteOfDay(arriveAt) * 60000);

/**
 * Why a person cannot book a free visit, or null. Checked in this order: the gym takes visits (switched on
 * and on its plan); not the gym's own owner or staff; not already a member with a running membership; the
 * day is today or within `aheadDays`, and later today the time has not passed; the time falls inside one of
 * the gym's opening windows that day; the person's visits at this gym (booked, attended, no-show) are
 * under the gym's limit; the day still has a place.
 */
function visitBlock({ open, own, member, date, arriveAt, today, nowMinute, aheadDays, windows, usedByPerson, perPerson, bookedThatDay, cap }) {
  if (!open) return 'GYM_VISITS_CLOSED';
  if (own) return 'GYM_VISIT_OWN_GYM';
  if (member) return 'GYM_VISIT_MEMBER';
  if (!isDate(date) || !HHMM.test(arriveAt ?? '')) return 'GYM_VISIT_DATE';
  if (date < today || date > addDays(today, aheadDays)) return 'GYM_VISIT_DATE';
  const minute = minuteOfDay(arriveAt);
  if (date === today && minute <= nowMinute) return 'GYM_VISIT_DATE';
  if (!windows.some((w) => minute >= minuteOfDay(w.openTime) && minute < minuteOfDay(w.closeTime))) return 'GYM_VISIT_HOURS';
  if (usedByPerson >= perPerson) return 'GYM_VISIT_LIMIT';
  if (bookedThatDay >= cap) return 'GYM_VISIT_FULL';
  return null;
}

/** M20-FR-20: is a clock time ("HH:MM") outside what a special day leaves open? Closed: always; changed hours: outside its windows. */
const outsideSpecialDay = (day, hhmm) => day.kind === 'closed' || !day.windows.some((w) => minuteOfDay(hhmm) >= minuteOfDay(w.openTime) && minuteOfDay(hhmm) < minuteOfDay(w.closeTime));
/** The reason a guest or a class member reads when a special day cancels their booking. */
const specialDayReason = (day) => `${day.kind === 'closed' ? 'The gym is closed' : 'The gym’s hours changed'}: ${day.title}`.slice(0, 300);

/** Why a visit cannot be cancelled, or null: only a booked one; the guest up to `cutoffMinutes` before the start, the gym until the day ends. */
function visitCancelBlock({ visit, by, now, cutoffMinutes, today }) {
  if (visit.status !== 'booked') return 'GYM_VISIT_STATE';
  if (by === 'guest' && now.getTime() > visitStartAt(visit.visitDate, visit.arriveAt).getTime() - cutoffMinutes * 60000) return 'GYM_VISIT_CANCEL_CLOSED';
  if (by === 'gym' && visit.visitDate < today) return 'GYM_VISIT_STATE';
  return null;
}

/** Why the desk cannot check a guest in, or null: a booked visit for today. */
function visitCheckInBlock({ visit, today }) {
  if (visit.status !== 'booked') return 'GYM_VISIT_STATE';
  return visit.visitDate === today ? null : 'GYM_VISIT_NOT_TODAY';
}

/** The guest's QR for the desk: v1.gv.<visitId>.<nonce>.<sig> (HMAC domain gym-visit:); no personal data. */
const visitToken = ({ visitId, nonce }, sign) => `v1.gv.${visitId}.${nonce}.${sign(`gym-visit:${visitId}:${nonce}`).slice(0, 32)}`;
const looksLikeVisitToken = (text) => String(text ?? '').trim().startsWith('v1.gv.');

/** { visitId, nonce } of a well-formed, correctly signed visit token, else null. */
function parseVisitToken(token, { sign, equal = (a, b) => a === b }) {
  const parts = String(token ?? '').trim().split('.');
  if (parts.length !== 5 || parts[0] !== 'v1' || parts[1] !== 'gv' || !UUID.test(parts[2]) || !/^[0-9a-f]{16,32}$/.test(parts[3]) || !SIG.test(parts[4])) return null;
  const [, , visitId, nonce, sig] = parts;
  return equal(sig, sign(`gym-visit:${visitId}:${nonce}`).slice(0, 32)) ? { visitId, nonce } : null;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A 6-character visit code (Crockford base32) from random bytes. */
const visitCode = (bytes) => Array.from(bytes.subarray(0, 6), (b) => CROCKFORD[b % 32]).join('');
/** A typed code as stored: upper case, without spaces or dashes, I/L read as 1 and O as 0; else null. */
function normalizeVisitCode(text) {
  const v = String(text ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return /^[0-9A-HJKMNP-TV-Z]{6}$/.test(v) ? v : null;
}

/** A booked visit whose day has passed without a check-in becomes a no-show. */
const visitNoShow = (visit, today) => visit.status === 'booked' && visit.visitDate < today;

// ---------------------------------------------------------------- the SMS add-on (prompt 3b, M24-FR-96 to FR-100, §6.7)

/**
 * Why a member notice cannot go by SMS now, or null (§6.7): the platform switch is off (`off`), the plan
 * is Free (`tier`), the owner's add-on is not active (`addon`), the gym did not choose this kind for SMS
 * and it was not chosen for this one message (`kind`), the balance does not cover the hold (`balance`).
 */
function smsBlock({ enabled, tier, addonStatus, kind, kinds = [], explicit = false, balance, reserve }) {
  if (!enabled) return 'off';
  if (tier === 'free') return 'tier';
  if (addonStatus !== 'active') return 'addon';
  if (!explicit && !kinds.includes(kind)) return 'kind';
  return balance >= reserve ? null : 'balance';
}

/**
 * The settle entry's units (§6.7): a message that was not sent gives the whole hold back; a sent one
 * keeps its segments, never more than the hold and what is left after it, so the balance never goes
 * below 0. May be 0 (exactly what was held) or negative (more than was held, while units are left).
 */
function smsSettleUnits({ reserve, segments, sent, balanceAfterReserve }) {
  if (!sent) return reserve;
  const used = Math.min(Math.max(0, segments), reserve + Math.max(0, balanceAfterReserve));
  return reserve - used;
}

/** The balance crossing a debit makes (FR-100): `depleted` below one hold, `low` below the low mark, else null. */
function smsCrossing({ before, after, low, reserve }) {
  if (before >= reserve && after < reserve) return 'depleted';
  if (before >= low && after < low && after >= reserve) return 'low';
  return null;
}

/** The month's allowance still unused: the allowance is spent first (§6.7). */
const smsAllowanceLeft = ({ granted, used }) => Math.max(0, granted - Math.max(0, used));

/**
 * What is left of a bought bundle when it expires: the units beyond the allowance are bundle units, spent
 * oldest first, so a bundle keeps at most what the newer bundles do not account for.
 */
const smsBundleLeft = ({ units, pool, newer }) => Math.max(0, Math.min(units, pool - newer));

/** A short code for a pay link in an SMS (10 Crockford characters, ~50 bits). */
const shortCode = (bytes) => Array.from(bytes.subarray(0, 10), (b) => CROCKFORD[b % 32]).join('');
const looksLikeShortCode = (text) => /^[0-9A-HJKMNP-TV-Z]{10}$/.test(String(text ?? ''));

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

// ================================================================ prompt 2: online money, reminders, billing

// ---------------------------------------------------------------- months (Dhaka calendar)

/** Whole months from the month of `from` to the month of `to` (both YYYY-MM-DD). */
const monthsBetween = (from, to) => (yearOf(to) - yearOf(from)) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
/** The first day of the month `n` months after the month of `date`. */
function addMonths(date, n) {
  const total = yearOf(date) * 12 + Number(date.slice(5, 7)) - 1 + n;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}
const lastOfMonth = (date) => addDays(addMonths(date, 1), -1);
const daysInMonth = (date) => daysBetween(firstOfMonth(date), addMonths(date, 1));
/** The month before the one `today` is in: { start, end, month: 'YYYY-MM' } (invoices and the monthly report run in arrears). */
function previousMonth(today) {
  const start = addMonths(today, -1);
  return { start, end: lastOfMonth(start), month: monthOf(start) };
}

// ---------------------------------------------------------------- §6.3 provider charge

/** Provider charge methods M06 reports; an unknown method uses the highest configured rate (never under-recovers). */
const PROVIDER_METHODS = Object.freeze(['bkash', 'nagad', 'card']);

/**
 * charge = passthrough ? round_half_up(amount × bps(method) ÷ 10,000) : 0 (M24-FR-43). The bps used is
 * returned too, for the snapshot on the fee payment row (0 when the pass-through is off).
 */
function providerCharge({ amount, method, passthrough, bpsMap }) {
  if (!passthrough) return { bps: 0, charge: 0 };
  const rates = bpsMap ?? {};
  const bps = Number.isInteger(rates[method]) ? rates[method] : Math.max(0, ...Object.values(rates).filter(Number.isInteger));
  return { bps, charge: mulDivRound(amount, bps, 10000) };
}

// ---------------------------------------------------------------- §6.5 effective fee and overrides

/** Is an override active at `at`? status active ∧ valid_from ≤ at ∧ (valid_to IS NULL ∨ at < valid_to). */
const overrideActive = (o, at) => o.status === 'active' && new Date(o.validFrom).getTime() <= at.getTime() && (!o.validTo || at.getTime() < new Date(o.validTo).getTime());

/**
 * effective(key, { gymId, ownerId, at }) = gym override ?? owner override ?? setting (M24-FR-94).
 * `overrides` are the candidate rows (any status); `setting` is { value, version }.
 * → { value, source: gym_override | owner_override | setting, overrideId, settingVersion, validTo }
 */
function effectiveFee({ key, gymId = null, ownerId, at, overrides = [], setting }) {
  const live = overrides.filter((o) => o.key === key && overrideActive(o, at));
  const gym = gymId ? live.find((o) => o.scopeType === 'gym' && o.scopeId === gymId) : null;
  const owner = live.find((o) => o.scopeType === 'owner' && o.scopeId === ownerId);
  const o = gym ?? owner;
  if (o) return { value: Number(o.value), source: gym ? 'gym_override' : 'owner_override', overrideId: o.id, settingVersion: null, validTo: o.validTo ?? null };
  return { value: setting.value, source: 'setting', overrideId: null, settingVersion: setting.version, validTo: null };
}

/** An override value outside the setting's bounds (M24-FR-94) → 'GYM_OVERRIDE_OUT_OF_BOUNDS', else null. */
const overrideBlock = ({ value, min, max }) => (value < min || value > max ? 'GYM_OVERRIDE_OUT_OF_BOUNDS' : null);

// ---------------------------------------------------------------- §6.6 the owner's subscription

/** The tier that fits an owner's month (§6.6, G18): Pro with gym_saas.pro_min_gyms gyms with members, else by the peak. */
const ownerFitTier = ({ peak, gymsWithMembers, cfg }) => (gymsWithMembers >= cfg.proMinGyms ? 'pro' : fitTier(peak, cfg));

/** billed tier = max(highest tier chosen during the month, fit tier) (M24-FR-82, FR-87, G20). */
const billedTier = ({ monthMaxTier, fit }) => higherTier(monthMaxTier, fit);

/** The founding partner month index of a period: 1 for the first month on a paid tier. */
const foundingMonthIndex = ({ paidTierSince, periodStart }) => monthsBetween(firstOfMonth(paidTierSince), periodStart) + 1;

/** freeUntil and discountUntil (last days) of a founding partner, or nulls (the billing page, M24-FR-88). */
function foundingWindow({ foundingPartner, paidTierSince, freeMonths, discountMonths }) {
  if (!foundingPartner || !paidTierSince) return { freeUntil: null, discountUntil: null };
  return {
    freeUntil: freeMonths > 0 ? lastOfMonth(addMonths(paidTierSince, freeMonths - 1)) : null,
    discountUntil: discountMonths > 0 ? lastOfMonth(addMonths(paidTierSince, freeMonths + discountMonths - 1)) : null,
  };
}

const TIER_LABELS = { free: ['Free', 'ফ্রি'], basic: ['Basic', 'বেসিক'], standard: ['Standard', 'স্ট্যান্ডার্ড'], pro: ['Pro', 'প্রো'] };

/**
 * The monthly invoice of an owner for a period, in arrears (§6.6, M24-FR-84):
 *   tier line   = price(billed tier)
 *   first month = round(tier line × days on the subscription in the month ÷ days in the month)
 *   founding    = month index ≤ free months → − base; ≤ free + discount months → − round(base × pct ÷ 100)
 *                 (base = the tier line after the first-month proration)
 *   referrals   = one line per referral amount, quantity × amount
 *   vat         = enabled ? round(subtotal × pct ÷ 100) : 0
 *   total       = max(0, subtotal) + vat; 0 → no invoice
 * Lines carry kind, EN and BN descriptions, quantity, unit and amount (discounts negative).
 */
function invoiceLines({ periodStart, periodEnd, tier, prices, startedOn, founding, referrals = [], smsAddon = null, vat }) {
  const lines = [];
  const price = tier === 'free' ? 0 : prices[tier];
  let base = 0;
  if (price > 0) {
    const [en, bn] = TIER_LABELS[tier];
    lines.push({ kind: 'tier', descriptionEn: `Plan: ${en}`, descriptionBn: `প্যাকেজ: ${bn}`, quantity: 1, unitPoisha: price, amountPoisha: price });
    base = price;
    if (startedOn > periodStart && startedOn <= periodEnd) {
      const days = daysBetween(startedOn, periodEnd) + 1;
      base = mulDivRound(price, days, daysInMonth(periodStart));
      lines.push({ kind: 'proration', descriptionEn: `First month: ${days} of ${daysInMonth(periodStart)} days`, descriptionBn: `প্রথম মাস: ${daysInMonth(periodStart)} দিনের ${days} দিন`, quantity: 1, unitPoisha: base - price, amountPoisha: base - price });
    }
    if (founding?.partner && founding.paidTierSince) {
      const index = foundingMonthIndex({ paidTierSince: founding.paidTierSince, periodStart });
      if (index >= 1 && index <= founding.freeMonths) {
        lines.push({ kind: 'founding_free', descriptionEn: 'Founding partner: free month', descriptionBn: 'ফাউন্ডিং পার্টনার: বিনামূল্যের মাস', quantity: 1, unitPoisha: -base, amountPoisha: -base });
      } else if (index >= 1 && index <= founding.freeMonths + founding.discountMonths && founding.discountPct > 0) {
        const off = mulDivRound(base, founding.discountPct, 100);
        lines.push({ kind: 'founding_discount', descriptionEn: `Founding partner discount ${founding.discountPct}%`, descriptionBn: `ফাউন্ডিং পার্টনার ছাড় ${founding.discountPct}%`, quantity: 1, unitPoisha: -off, amountPoisha: -off });
      }
    }
  }
  const byAmount = new Map();
  for (const r of referrals) byAmount.set(r.amount, (byAmount.get(r.amount) ?? 0) + 1);
  for (const [amount, n] of [...byAmount].sort((a, b) => b[0] - a[0])) {
    lines.push({ kind: 'referral', descriptionEn: `Referral fee × ${n}`, descriptionBn: `রেফারেল ফি × ${n}`, quantity: n, unitPoisha: amount, amountPoisha: amount * n });
  }
  // M24 prompt 3b (§6.6): the SMS add-on when it was active on any day of the month, at the price then.
  if (smsAddon?.price > 0) lines.push({ kind: 'sms_addon', descriptionEn: 'SMS add-on', descriptionBn: 'SMS অ্যাড-অন', quantity: 1, unitPoisha: smsAddon.price, amountPoisha: smsAddon.price });
  const subtotal = Math.max(0, lines.reduce((s, l) => s + l.amountPoisha, 0));
  const vatPoisha = vat?.enabled ? Math.round((subtotal * vat.pct) / 100) : 0;
  if (vatPoisha > 0) lines.push({ kind: 'vat', descriptionEn: `VAT ${vat.pct}%`, descriptionBn: `ভ্যাট ${vat.pct}%`, quantity: 1, unitPoisha: vatPoisha, amountPoisha: vatPoisha });
  return { lines, subtotal, vat: vatPoisha, total: subtotal + vatPoisha };
}

/** An SMS bundle invoice (M24-FR-98): one line of bundles × price, and VAT when enabled. */
function bundleInvoiceLines({ bundles, size, price, vat }) {
  const amount = bundles * price;
  const lines = [{ kind: 'sms_bundle', descriptionEn: `SMS bundle: ${bundles} × ${size} SMS`, descriptionBn: `SMS বান্ডেল: ${bundles} × ${size}টি SMS`, quantity: bundles, unitPoisha: price, amountPoisha: amount }];
  const vatPoisha = vat?.enabled ? Math.round((amount * vat.pct) / 100) : 0;
  if (vatPoisha > 0) lines.push({ kind: 'vat', descriptionEn: `VAT ${vat.pct}%`, descriptionBn: `ভ্যাট ${vat.pct}%`, quantity: 1, unitPoisha: vatPoisha, amountPoisha: vatPoisha });
  return { lines, subtotal: amount, vat: vatPoisha, total: amount + vatPoisha, units: bundles * size };
}

/** M24 §25: a WhatsApp units bundle invoice (the SMS bundle's lines with the WhatsApp line). */
function whatsappBundleLines({ bundles, size, price, vat }) {
  const calc = bundleInvoiceLines({ bundles, size, price, vat });
  calc.lines[0] = { ...calc.lines[0], kind: 'whatsapp_bundle', descriptionEn: `WhatsApp bundle: ${bundles} × ${size} units`, descriptionBn: `WhatsApp বান্ডেল: ${bundles} × ${size} ইউনিট` };
  return calc;
}

/**
 * M24 §25: why a WhatsApp message cannot hold its units now, or null: off (the platform), tier (below the
 * plan of the whatsapp feature), restricted (an overdue invoice), addon (WhatsApp not switched on), balance.
 */
function whatsappBlock({ enabled, featureOk, restricted, addonStatus, balance, units }) {
  if (!enabled) return 'off';
  if (!featureOk) return 'tier';
  if (restricted) return 'restricted';
  if (addonStatus !== 'active') return 'addon';
  return balance >= units ? null : 'balance';
}

// ---------------------------------------------------------------- dunning (M24-FR-86, §8.6, §8.7)

/** The due date (Dhaka) of an invoice issued on `issuedOn`, and the instant it turns overdue (the next day starts). */
function invoiceDue({ issuedOn, dueDays }) {
  const dueOn = addDays(issuedOn, dueDays);
  return { dueOn, dueAt: instantOf(addDays(dueOn, 1)) };
}

/** The last day before restriction: the due date + gym_saas.grace_days; restricted from the next day. */
const restrictOn = ({ dueAt, graceDays }) => addDays(dhakaDate(new Date(new Date(dueAt).getTime() - 1)), graceDays);

/** Is the overdue invoice past its grace (restrict the subscription)? */
const pastGrace = ({ dueAt, graceDays, now }) => now.getTime() >= new Date(dueAt).getTime() + graceDays * DAY_MS;

/** The invoice reminder due today, if any (§10): 'd-3' from 3 days before the due date, 'd0' on it. */
function invoiceReminderKey({ dueAt, today }) {
  const dueOn = dhakaDate(new Date(new Date(dueAt).getTime() - 1));
  if (today === dueOn) return 'd0';
  if (today >= addDays(dueOn, -3) && today < dueOn) return 'd-3';
  return null;
}

/**
 * The subscription status after dunning (§8.6): restricted when an overdue invoice is past its grace,
 * past_due when any invoice is overdue, active otherwise (closed stays closed).
 */
function subscriptionStatus({ status, invoices, now, graceDays }) {
  if (status === 'closed') return 'closed';
  const overdue = invoices.filter((i) => i.status === 'overdue');
  if (overdue.some((i) => pastGrace({ dueAt: i.dueAt, graceDays, now }))) return 'restricted';
  return overdue.length ? 'past_due' : 'active';
}

// ---------------------------------------------------------------- §6.9 reminder schedule

/**
 * The once-key of a scheduled member reminder due `today`, or null (§6.9, M24-FR-55, FR-56):
 *   renewal_due  each renewal_remind_days before ends_on   'd-7', 'd-3', 'd-1' (M27-FR-29)
 *   ends_today   on ends_on                          'd0'
 *   expired      the day after ends_on               'd+1'
 *   overdue      each overdue_remind_days after due_on  'd+3'
 */
function reminderKey(kind, { today, endsOn = null, dueOn = null, renewalDays = [], overdueDays = [] }) {
  if (kind === 'renewal_due') {
    const left = endsOn ? daysBetween(today, endsOn) : -1;
    return renewalDays.includes(left) ? `d-${left}` : null;
  }
  if (kind === 'ends_today') return endsOn === today ? 'd0' : null;
  if (kind === 'expired') return endsOn && addDays(endsOn, 1) === today ? 'd+1' : null;
  const late = dueOn ? daysBetween(dueOn, today) : 0;
  return overdueDays.includes(late) ? `d+${late}` : null;
}

/** "HH:MM" Dhaka has been reached at `now` (the morning summary, §6.9). */
function timeReached({ now, time }) {
  const local = new Date(now.getTime() + DHAKA_MS);
  const [h, m] = time.split(':').map(Number);
  return local.getUTCHours() * 60 + local.getUTCMinutes() >= h * 60 + m;
}

// ---------------------------------------------------------------- online fees (§5.5)

/** Why the gym cannot take online fees (M24-FR-02, FR-40, edge case 15): role, tier or restricted; null when it can. */
function onlineFeesBlock({ ownerRoleActive, hasOnlineFees, restricted, gymSuspended }) {
  if (!ownerRoleActive) return 'role';
  if (!hasOnlineFees) return 'tier';
  if (restricted || gymSuspended) return 'restricted';
  return null;
}

/** The link amount (M24-FR-40): up to the outstanding, all of it by default. */
function linkAmount({ requested = null, status, outstanding }) {
  if (!['unpaid', 'partial'].includes(status) || outstanding <= 0) return { block: 'GYM_DUE_STATE' };
  const amount = requested ?? outstanding;
  if (amount < 1 || amount > outstanding) return { block: 'GYM_PAYMENT_EXCEEDS_DUE' };
  return { amount };
}

/**
 * What a captured fee payment does (M24-FR-42, edge cases 11 and 12): recorded when the due still needs
 * at least the amount (a link that expired meanwhile still counts), otherwise refunded whole.
 */
function captureDecision({ dueStatus, outstanding, amount, linkStatus }) {
  if (!['open', 'expired'].includes(linkStatus)) return 'refund';
  if (!['unpaid', 'partial'].includes(dueStatus) || outstanding < amount) return 'refund';
  return 'record';
}

/**
 * Why an owner refund of an online fee is refused (M24-FR-44): after release (or once its release time
 * has come) GYM_REFUND_WINDOW_CLOSED; once per payment; at most what is left of the amount.
 */
function refundBlock({ link, now, amount, alreadyRefunded }) {
  if (link.releasedAt || !link.releaseAt || now.getTime() >= new Date(link.releaseAt).getTime()) return 'GYM_REFUND_WINDOW_CLOSED';
  if (alreadyRefunded) return 'GYM_PAYMENT_NOT_REVERSIBLE';
  if (amount < 1 || amount > link.amountPoisha - link.refundedPoisha) return 'GYM_REFUND_EXCEEDS_PAID';
  return null;
}

/** The payment-link token (M24-FR-40, §7.3): v1.<linkId>.<nonce>.<sig>, HMAC domain `gym-pay:`. */
const payLinkToken = ({ linkId, nonce }, sign) => `v1.${linkId}.${nonce}.${sign(`gym-pay:${linkId}:${nonce}`).slice(0, 32)}`;

function parsePayLinkToken(token, { sign, equal = (a, b) => a === b }) {
  const parts = String(token ?? '').trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !UUID.test(parts[1]) || !/^[A-Za-z0-9_-]{8,24}$/.test(parts[2]) || !SIG.test(parts[3])) return null;
  return equal(parts[3], sign(`gym-pay:${parts[1]}:${parts[2]}`).slice(0, 32)) ? { linkId: parts[1], nonce: parts[2] } : null;
}

/** "Rafiq" from "Rafiq Hasan": the only part of a name the public link page shows (M24-FR-41, §4.1). */
const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0];

// ---------------------------------------------------------------- reports (§5.9)

/** churn = left ÷ active at the start (M24-FR-71), 4 decimals; null when nobody was active. */
const churn = ({ left, activeAtStart }) => (activeAtStart > 0 ? Math.round((left * 10000) / activeAtStart) / 10000 : null);

/** A report period: 'YYYY-MM' (a month) or { from, to } dates; defaults to this month up to today. */
function reportPeriod({ month = null, from = null, to = null, today }) {
  if (month) {
    const start = `${month}-01`;
    return { from: start, to: lastOfMonth(start), month };
  }
  const f = from ?? firstOfMonth(today);
  return { from: f, to: to ?? today, month: null };
}

/**
 * The period a report compares with (dashboards, M24-FR-154): the same length just before. A month is
 * compared with the month before over the same number of days so far (1 to 20 November with 1 to 20
 * October, never with the whole of October), clamped to that month's end. A range ending after today
 * counts only up to today.
 */
function previousPeriod({ from, to, month }, today) {
  const end = to > today ? (today < from ? from : today) : to;
  const days = daysBetween(from, end);
  if (month) {
    const start = addMonths(from, -1);
    const last = lastOfMonth(start);
    const stop = addDays(start, days);
    return { from: start, to: stop > last ? last : stop, month: monthOf(start) };
  }
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -days), to: prevTo, month: null };
}

/**
 * One row per day from `from` to `to` (both included), filled from `rows` keyed by `date`, so a day
 * without visits or payments still has its zero (the dashboard trend, M24-FR-153). `fields` are the
 * numeric columns to carry; a missing one is 0.
 */
function fillDays(from, to, rows, fields) {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out = [];
  for (let d = from, i = 0; d <= to && i < 400; d = addDays(d, 1), i += 1) {
    const r = byDate.get(d);
    out.push({ date: d, ...Object.fromEntries(fields.map((f) => [f, Number(r?.[f] ?? 0)])) });
  }
  return out;
}

// ---------------------------------------------------------------- prompt 3: the entrance QR (M24-FR-51)

/** The entrance tablet QR payload: v1.ge.<gymId>.<window>.<sig> (HMAC domain gym-entrance:); no personal data. */
const entranceToken = ({ gymId, window }, sign) => `v1.ge.${gymId}.${window}.${sign(`gym-entrance:${gymId}:${window}`).slice(0, 32)}`;

/** { gymId } of a well-formed entrance token signed for the current or the previous window, else null. */
function parseEntranceToken(token, { sign, equal = (a, b) => a === b, nowMs, seconds }) {
  const parts = String(token ?? '').trim().split('.');
  if (parts.length !== 5 || parts[0] !== 'v1' || parts[1] !== 'ge' || !UUID.test(parts[2]) || !/^\d{1,12}$/.test(parts[3]) || !SIG.test(parts[4])) return null;
  const [, , gymId, w, sig] = parts;
  const window = Number(w);
  const current = windowOf(nowMs, seconds);
  if (window !== current && window !== current - 1) return null;
  return equal(sig, sign(`gym-entrance:${gymId}:${window}`).slice(0, 32)) ? { gymId } : null;
}

/** Seconds until the token of the current window is replaced (the tablet refreshes then). */
const secondsLeft = (nowMs, seconds) => (windowOf(nowMs, seconds) + 1) * seconds - Math.floor(nowMs / 1000);

// ---------------------------------------------------------------- prompt 3: plans and diet charts (§5.8, §6.10)

const PLAN_KINDS = Object.freeze(['workout', 'diet']);

/**
 * §6.10: the workout day of a date is days[(date − starts_on) mod days.length]; null before the start,
 * after the end or for an empty plan. A diet chart is the same every day.
 */
function dayIndexFor({ date, startsOn, endsOn = null, days }) {
  if (!days || date < startsOn || (endsOn && date > endsOn)) return null;
  return daysBetween(startsOn, date) % days;
}

/** The 7 days from `today` with the workout day index of each (null outside the assignment). */
const weekOf = ({ today, startsOn, endsOn = null, days }) =>
  Array.from({ length: 7 }, (_, i) => addDays(today, i)).map((date) => ({ date, index: dayIndexFor({ date, startsOn, endsOn, days }) }));

/** Every item of a plan (workout: across the days; diet: across the meals). */
const itemsOf = (content) => (content.kind === 'workout' ? content.days.flatMap((d) => d.items) : content.meals.flatMap((m) => m.items));

/**
 * Checks of the plan content that need the live settings (M24-FR-62): at most gym_manage.plan_max_items
 * per workout day or meal, at most gym_manage.diet_max_meals meals, and day keys, meal refs and item
 * refs unique in the plan (ticks stay attached to refs across versions). The shape is the zod schema's.
 * → [{ field, message }].
 */
function planContentErrors(content, { maxItems, maxMeals }) {
  const workout = content.kind === 'workout';
  const groups = workout
    ? content.days.map((d, i) => ({ path: `content.days[${i}]`, keyField: 'key', key: d.key, items: d.items }))
    : content.meals.map((m, i) => ({ path: `content.meals[${i}]`, keyField: 'ref', key: m.ref, items: m.items }));
  const errors = [];
  if (!workout && groups.length > maxMeals) errors.push({ field: 'content.meals', message: `At most ${maxMeals} meals` });
  const keys = new Set();
  const refs = new Set();
  for (const g of groups) {
    if (keys.has(g.key)) errors.push({ field: `${g.path}.${g.keyField}`, message: 'Must be unique in the plan' });
    keys.add(g.key);
    if (g.items.length > maxItems) errors.push({ field: `${g.path}.items`, message: `At most ${maxItems} items` });
    g.items.forEach((item, j) => {
      if (refs.has(item.ref)) errors.push({ field: `${g.path}.items[${j}].ref`, message: 'Must be unique in the plan' });
      refs.add(item.ref);
    });
  }
  return errors;
}

/** The item refs a member may tick on a date: that day's exercises, or every item of the diet chart; null outside the assignment. */
function itemRefsFor(content, { date, startsOn, endsOn = null }) {
  if (content.kind === 'diet') return date < startsOn || (endsOn && date > endsOn) ? null : new Set(itemsOf(content).map((i) => i.ref));
  const index = dayIndexFor({ date, startsOn, endsOn, days: content.days.length });
  return index === null ? null : new Set(content.days[index].items.map((i) => i.ref));
}

/** M24-FR-65: a tick is for today or up to gym_manage.plan_log_back_days back, inside the assignment. */
function logWindowBlock({ localDate, today, backDays, startsOn, endsOn = null }) {
  if (localDate > today || localDate < addDays(today, -backDays) || localDate < startsOn || (endsOn && localDate > endsOn)) return 'GYM_PLAN_LOG_WINDOW';
  return null;
}

/** The latest log per (date, item): rows newest first → Map('date|ref' → row) (append-only; the latest wins). */
function latestLogs(rows) {
  const out = new Map();
  for (const r of rows) {
    const k = `${r.localDate}|${r.itemRef}`;
    if (!out.has(k)) out.set(k, r);
  }
  return out;
}

/** A member ticks only an active assignment of a gym they are still linked to and have not left (M24-FR-67). */
const planReadOnly = ({ assignmentStatus, linked, memberStatus }) => assignmentStatus !== 'active' || !linked || ['left', 'removed'].includes(memberStatus);

/**
 * M27-FR-30: body mass index from height (cm) and weight (kg), one decimal, with its WHO band; null when
 * either is missing.
 */
function bmiOf({ heightCm, weightKg }) {
  if (!heightCm || !weightKg) return null;
  const m = heightCm / 100;
  const value = Math.round((weightKg / (m * m)) * 10) / 10;
  const band = value < 18.5 ? 'under' : value < 25 ? 'normal' : value < 30 ? 'over' : 'obese';
  return { value, band };
}

// ---------------------------------------------------------------- a member renews by themselves (M24 §19)

/**
 * Why a member cannot renew their own membership, or null (M24-FR-121, FR-122). `latest` is the member's
 * newest membership among active, frozen and expired; `upcoming` one that has not started. In order: the
 * gym switched member renewals off (or its panel is read-only); the member left or was removed; a renewal
 * already waits; there is nothing to renew; the running membership still has more than `daysBefore` days.
 */
function selfRenewBlock({ open, restricted = false, memberStatus, latest, upcoming, today, daysBefore }) {
  if (!open) return { code: 'GYM_SELF_RENEW_OFF', meta: { reason: 'off' } };
  if (restricted) return { code: 'GYM_SELF_RENEW_OFF', meta: { reason: 'restricted' } };
  if (['left', 'removed'].includes(memberStatus)) return { code: 'GYM_MEMBER_STATE', meta: { reason: memberStatus } };
  if (upcoming) return { code: 'GYM_RENEWAL_EXISTS', meta: { membershipId: upcoming.id } };
  if (!latest) return { code: 'GYM_NOTHING_TO_RENEW' };
  if (latest.status !== 'expired' && daysBetween(today, latest.endsOn) > daysBefore) return { code: 'GYM_RENEW_TOO_EARLY', meta: { from: addDays(latest.endsOn, -daysBefore) } };
  return null;
}

/**
 * Why a member cannot cancel a renewal, or null (M24-FR-125): only one they made themselves, that has not
 * started, with nothing paid on it. Anything else goes through the desk.
 */
function selfRenewCancelBlock({ membership, paidPoisha = 0 }) {
  if (!membership) return { code: 'GYM_NOTHING_TO_RENEW' };
  if (membership.createdVia !== 'member') return { code: 'GYM_MEMBERSHIP_STATE', meta: { reason: 'made_at_desk' } };
  if (membership.status !== 'upcoming') return { code: 'GYM_MEMBERSHIP_STATE', meta: { reason: membership.status } };
  if (paidPoisha > 0) return { code: 'GYM_MEMBERSHIP_STATE', meta: { reason: 'paid' } };
  return null;
}

// ---------------------------------------------------------------- desk mode with a PIN (M24 §21, ADR-010)

const DESK_PIN = /^\d{4}$/;

/**
 * Why a desk PIN is refused, or null (M24-FR-134): four digits; not one digit four times; not a run up or
 * down (1234, 9876, 0123); not the last four digits of the person's own phone.
 */
function deskPinBlock({ pin, phoneLast4 = null }) {
  const text = String(pin ?? '');
  if (!DESK_PIN.test(text)) return 'format';
  const d = [...text].map(Number);
  if (d.every((x) => x === d[0])) return 'repeat';
  const step = d[1] - d[0];
  if (Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - d[i - 1] === step)) return 'run';
  if (phoneLast4 && text === String(phoneLast4)) return 'phone';
  return null;
}

/**
 * What one more wrong PIN does (M24-FR-137). `failed` counts this try. Below the limit: nothing but the
 * tries left. At the limit: the person is locked for a while and their lockouts in a row go up; at
 * `maxLockouts` the PIN is cleared and must be set again from their own sign-in.
 */
function deskPinWrong({ failed, lockouts, failLimit, maxLockouts }) {
  if (failed < failLimit) return { lock: false, clear: false, left: failLimit - failed };
  return { lock: true, clear: lockouts + 1 >= maxLockouts, left: 0 };
}

/**
 * Where a request from a device in desk mode goes (M24-FR-139). `control`: the desk-mode endpoints and
 * sign-out, always allowed (as the sign-in that opened the desk). `gym`: the desk gym's panel, the list
 * of gyms and the gym's pass desk, which need a live unlock and run as the unlocked person. Anything else
 * is `outside` and refused: a device in desk mode does nothing but its gym's work.
 */
function deskRoute({ method, path, gymId }) {
  const p = String(path).split('?')[0].replace(/\/+$/, '');
  if (p === '/manage/desk-mode' || p.startsWith('/manage/desk-mode/')) return 'control';
  if (method === 'POST' && p === '/auth/logout') return 'control';
  const gym = `/manage/gyms/${gymId}`;
  if (p === gym || p.startsWith(`${gym}/`)) return 'gym';
  if (method === 'GET' && p === '/manage/gyms') return 'gym';
  // The panel's header and workplace list, read as the unlocked person.
  if (method === 'GET' && (p === '/me' || p === '/me/workplaces')) return 'gym';
  if (p === `/me/gyms/${gymId}/redemptions` || p === `/me/gyms/${gymId}/passes`) return 'gym';
  return 'outside';
}

/** Is an unlock still live at `now` (not ended, not past its idle time)? */
const deskUnlockLive = (u, now) => Boolean(u) && !u.endedAt && new Date(u.expiresAt).getTime() > now.getTime();

/** When an unlock touched at `now` runs out: `idleMinutes` later (M24-FR-136). */
const deskIdleUntil = (now, idleMinutes) => new Date(now.getTime() + idleMinutes * 60000);

// ---------------------------------------------------------------- the desk through a lost connection (M24 §22)

/** The desk copy's stamp (M24-FR-144): the gym and the server time the copy was made, signed. */
const snapshotStamp = ({ gymId, ms }, sign) => `v1.gso.${gymId}.${ms}.${sign(`gym-desk-snapshot:${gymId}:${ms}`).slice(0, 32)}`;

/** The gym and server time of a desk copy's stamp, or null when it is not one the server made. */
function parseSnapshotStamp(stamp, { sign, equal = (a, b) => a === b }) {
  const parts = String(stamp ?? '').split('.');
  if (parts.length !== 5 || parts[0] !== 'v1' || parts[1] !== 'gso' || !UUID.test(parts[2]) || !/^\d{1,15}$/.test(parts[3]) || !SIG.test(parts[4])) return null;
  const [, , gymId, ms, sig] = parts;
  return equal(sig, sign(`gym-desk-snapshot:${gymId}:${ms}`).slice(0, 32)) ? { gymId, ms: Number(ms) } : null;
}

/** One member in the desk copy (M24-FR-144): who, the running package, today's flags and entry decision. */
function snapshotMember({ member, current, hadMembership, overdue, visits = 0, policy, today, inToday }) {
  const d = entryDecision({ current, hadMembership, overdue, visits, policy });
  return {
    id: member.id,
    memberCode: member.memberCode,
    displayName: member.displayName,
    phoneLast4: member.phoneLast4 ?? null,
    package: current ? { title: current.title, endsOn: current.endsOn, status: current.status } : null,
    flags: deskFlags({ current, hadMembership, overdue, visits, today }),
    reasons: d.reasons,
    decision: d.decision,
    inToday: Boolean(inToday),
  };
}

/**
 * When an offline item was taken (M24-FR-147): the stamp's server time plus the time that passed on the
 * device. A time past the server's clock by more than the skew becomes the time it arrived (flag
 * time_adjusted); one older than maxHours is kept, since it can never be earlier than the signed stamp, and
 * flagged late.
 */
function offlineTakenAt({ stampMs, elapsedMs, nowMs, maxHours, skewSeconds }) {
  const raw = stampMs + elapsedMs;
  if (raw > nowMs + skewSeconds * 1000) return { at: new Date(nowMs), flags: ['time_adjusted'] };
  if (raw < nowMs - maxHours * 3600000) return { at: new Date(raw), flags: ['late'] };
  return { at: new Date(Math.min(raw, nowMs)), flags: [] };
}

/**
 * Why an offline item cannot be applied (it is parked for the owner, M24-FR-149), or null: the member was
 * removed (or, for a check-in, has left), the due was voided, already settled, or now owes less than the
 * cash taken.
 */
function offlinePark({ kind, memberStatus, due = null, amount = 0 }) {
  if (memberStatus === 'removed') return 'member_removed';
  if (kind === 'checkin') return memberStatus === 'left' ? 'member_left' : null;
  const state = dueState({ amount: due.amountPoisha, paid: due.paidPoisha, waived: due.waivedPoisha, voided: due.status === 'void' });
  if (state.status === 'void') return 'due_void';
  if (state.outstanding === 0) return 'due_paid';
  return amount > state.outstanding ? 'due_changed' : null;
}

/**
 * Who an offline item is recorded for (M24-FR-148): the person the device names when they work at the gym
 * with the permission the item needs, otherwise the sender. The device's word stands when it names the
 * sender, or a desk unlock of that person at this gym; otherwise it is flagged unverified_taker. A PIN that
 * was only checked on the device is always flagged pin_on_device.
 */
function offlineTaker({ takenBy, senderId, eligible, unlockMatches, pinOnDevice }) {
  const flags = [];
  if (pinOnDevice) flags.push('pin_on_device');
  else if (takenBy !== senderId && !(eligible && unlockMatches)) flags.push('unverified_taker');
  return { recordedAs: eligible ? takenBy : senderId, flags };
}

/** parked, flagged (applied with flags) or applied (M24-FR-149). */
const offlineOutcome = ({ park, flags }) => (park ? 'parked' : flags.length ? 'flagged' : 'applied');

/**
 * Why an offline item cannot be resolved that way (M24-FR-150), or null: only flagged and parked items wait,
 * once. Parked cash is applied to another due of the member or recorded as returned; everything else is
 * marked checked.
 */
function offlineResolveBlock({ item, action }) {
  if (item.outcome === 'applied' || item.resolution) return 'GYM_OFFLINE_ITEM_STATE';
  const parkedCash = item.outcome === 'parked' && item.kind === 'cash_fee';
  if (action === 'checked') return parkedCash ? 'GYM_OFFLINE_ITEM_STATE' : null;
  return parkedCash ? null : 'GYM_OFFLINE_ITEM_STATE';
}

// ---------------------------------------------------------------- body progress (M24 §20)

/** The measurements of a body entry with their allowed range (kg, %, cm), one decimal each. */
const BODY_FIELDS = Object.freeze({ weightKg: [10, 400], bodyFatPct: [2, 70], chestCm: [10, 300], waistCm: [10, 300], hipsCm: [10, 300], armCm: [10, 300], thighCm: [10, 300] });
const bodyGiven = (values) => Object.keys(BODY_FIELDS).filter((k) => values[k] !== null && values[k] !== undefined);

/**
 * Why a body entry cannot be saved, or null (M24-FR-128, FR-129): at least one measurement, each inside its
 * range, measured today or up to `backdateDays` back.
 */
function bodyEntryBlock({ values, measuredOn, today, backdateDays }) {
  const given = bodyGiven(values);
  if (!given.length) return { code: 'GYM_BODY_EMPTY' };
  const bad = given.find((k) => values[k] < BODY_FIELDS[k][0] || values[k] > BODY_FIELDS[k][1]);
  if (bad) return { code: 'GYM_BODY_RANGE', meta: { field: bad, min: BODY_FIELDS[bad][0], max: BODY_FIELDS[bad][1] } };
  const from = addDays(today, -backdateDays);
  if (measuredOn > today || measuredOn < from) return { code: 'GYM_DATE_OUT_OF_RANGE', meta: { from, to: today } };
  return null;
}

/**
 * A member's progress (M24-FR-130): the entries oldest first, each with the BMI its weight gives at the
 * member's height, and per measurement the change from the first entry that has it to the latest (null with
 * fewer than two).
 */
function progressOf(entries, heightCm = null) {
  const sorted = [...entries].sort((a, b) => a.measuredOn.localeCompare(b.measuredOn));
  const series = sorted.map((e) => ({ ...e, bmi: bmiOf({ heightCm, weightKg: e.weightKg })?.value ?? null }));
  const change = {};
  for (const k of Object.keys(BODY_FIELDS)) {
    const have = sorted.filter((e) => e[k] !== null && e[k] !== undefined);
    const [first, last] = [have[0], have[have.length - 1]];
    change[k] = have.length >= 2 ? { from: first[k], to: last[k], delta: Math.round((last[k] - first[k]) * 10) / 10, fromOn: first.measuredOn, toOn: last.measuredOn } : null;
  }
  return { series, change };
}

/**
 * M27-FR-28: the VAT inside a VAT-inclusive amount at a rate in basis points (15% = 1500), rounded half up
 * to the poisha: vat = round(amount × bps ÷ (10000 + bps)); net = amount − vat. No VAT when bps is null or 0.
 */
function vatPart(amount, bps) {
  if (!bps) return { vat: 0, net: amount };
  const vat = Math.round((amount * bps) / (10000 + bps));
  return { vat, net: amount - vat };
}

/** M27-FR-40: a visit's length in whole minutes (never negative). */
const visitMinutes = (checkedInAt, checkedOutAt) => Math.max(0, Math.floor((new Date(checkedOutAt).getTime() - new Date(checkedInAt).getTime()) / 60000));

module.exports = {
  visitStartAt,
  dhakaMinute,
  visitBlock,
  outsideSpecialDay,
  specialDayReason,
  visitCancelBlock,
  visitCheckInBlock,
  visitToken,
  looksLikeVisitToken,
  parseVisitToken,
  visitCode,
  normalizeVisitCode,
  visitNoShow,
  smsBlock,
  bundleInvoiceLines,
  whatsappBundleLines,
  whatsappBlock,
  smsSettleUnits,
  smsCrossing,
  smsAllowanceLeft,
  smsBundleLeft,
  shortCode,
  looksLikeShortCode,
  visitMinutes,
  bmiOf,
  deskPinBlock,
  deskPinWrong,
  deskRoute,
  deskUnlockLive,
  deskIdleUntil,
  snapshotStamp,
  parseSnapshotStamp,
  snapshotMember,
  offlineTakenAt,
  offlinePark,
  offlineTaker,
  offlineOutcome,
  offlineResolveBlock,
  selfRenewBlock,
  selfRenewCancelBlock,
  BODY_FIELDS,
  bodyGiven,
  bodyEntryBlock,
  progressOf,
  vatPart,
  entranceToken,
  parseEntranceToken,
  secondsLeft,
  PLAN_KINDS,
  dayIndexFor,
  weekOf,
  itemsOf,
  planContentErrors,
  itemRefsFor,
  logWindowBlock,
  latestLogs,
  planReadOnly,
  PROVIDER_METHODS,
  monthsBetween,
  addMonths,
  lastOfMonth,
  daysInMonth,
  previousMonth,
  providerCharge,
  overrideActive,
  effectiveFee,
  overrideBlock,
  ownerFitTier,
  billedTier,
  foundingMonthIndex,
  foundingWindow,
  invoiceLines,
  invoiceDue,
  restrictOn,
  pastGrace,
  invoiceReminderKey,
  subscriptionStatus,
  reminderKey,
  timeReached,
  onlineFeesBlock,
  linkAmount,
  captureDecision,
  refundBlock,
  payLinkToken,
  parsePayLinkToken,
  firstName,
  churn,
  reportPeriod,
  previousPeriod,
  fillDays,
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
