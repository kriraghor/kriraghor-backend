'use strict';

/**
 * M20 rules (§6, v3), pure: no database, no clock (callers pass `now` and today's Dhaka date).
 *  - Money: fee = round(price × fee_bps / 10,000), half up; net = price − fee. A ৳400 pass at 5% →
 *    fee ৳20, the owner gets ৳380.
 *  - Dates are Dhaka calendar dates (YYYY-MM-DD); Asia/Dhaka has no daylight saving (UTC+6).
 *  - Opening hours are windows per weekday (0 = Sunday), some marked women-only; a window may close
 *    at 24:00 but never runs past midnight.
 *  - Passes: gyms sell subscriptions only (product owner, 2 Nov 2026). A pass runs its package's days
 *    from a start date up to gym.pass_advance_days ahead. Redemption is once per Dhaka day, while the
 *    gym is open; passes refund in full until their first use (Q110).
 *  - Day passes sold before 2 Nov 2026 still run out their dates: `admission`, `cancelPlan` and
 *    `expiresAt` keep their day rules until those have drained (kind `day` stays readable on history).
 *  - QR token `v1.<passId>.<nonce>.<sig>` signed with a keyed hash the caller passes in; a 6-character
 *    backup code in Crockford base32 (no I, L, O, U).
 *  - Trainer subscriptions run in periods of gym.subscription_days; renewal opens
 *    gym.subscription_renew_notice_days before the end and is accepted until the end of the grace
 *    days; the member may cancel the first gym.subscription_cancel_days of a period for a full refund;
 *    a period is released to the trainer disputes.window_trainer_hours after it ends.
 *  - M24 prompt 3: the distance from the viewer to a gym (its pin, else its area's centre) for the
 *    directory's nearest sort and radius.
 */
const DHAKA_MS = 6 * 3600000;
const DAY_MS = 86400000;
// M24 §7.1 (G2): 6 months, 12 months and custom days (1–366) join day, month and quarter.
const KINDS = ['month', 'quarter', 'half_year', 'year', 'custom'];
const CHANNELS = ['desk', 'online', 'both'];
/** M24: a package sold online (public page, live_snapshot, passes); `desk` packages are the gym's own books only. */
const soldOnline = (p) => (p.channel ?? 'both') !== 'desk';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ---------------------------------------------------------------- dates (Dhaka calendar)

const dhakaDate = (at) => new Date(new Date(at).getTime() + DHAKA_MS).toISOString().slice(0, 10);
const dateMs = (date) => Date.parse(`${date}T00:00:00Z`);
const addDays = (date, n) => new Date(dateMs(date) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((dateMs(to) - dateMs(from)) / DAY_MS);
const dowOf = (date) => new Date(dateMs(date)).getUTCDay();
/** The instant of a Dhaka wall-clock date and minutes after its midnight. */
const instantOf = (date, minutes = 0) => new Date(dateMs(date) - DHAKA_MS + minutes * 60000);
/** Minutes after Dhaka midnight of an instant. */
function minuteOf(at) {
  const d = new Date(new Date(at).getTime() + DHAKA_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
const toMin = (hhmm) => (hhmm === '24:00' ? 1440 : Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)));

// ---------------------------------------------------------------- money

const feeOf = (price, feeBps) => Math.floor((price * feeBps + 5000) / 10000);
const money = (price, feeBps) => {
  const fee = feeOf(price, feeBps);
  return { price, fee, net: price - fee };
};

// ---------------------------------------------------------------- opening hours

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** Problems with a week of opening windows ({ dow, openTime, closeTime, womenOnly }), or []. */
function hoursErrors(rows, { maxPerDay = 4, step = 15 } = {}) {
  const errors = [];
  const byDay = new Map();
  rows.forEach((r, i) => {
    const field = `hours.${i}`;
    if (!Number.isInteger(r.dow) || r.dow < 0 || r.dow > 6) return errors.push({ field, message: 'Choose a weekday (0 = Sunday … 6 = Saturday)' });
    if (!TIME.test(r.openTime) || !(TIME.test(r.closeTime) || r.closeTime === '24:00')) return errors.push({ field, message: 'Times are HH:MM' });
    const open = toMin(r.openTime);
    const close = toMin(r.closeTime);
    if (open % step || close % step) return errors.push({ field, message: `Times are on the ${step}-minute mark` });
    if (close <= open) return errors.push({ field, message: 'A window closes after it opens, on the same day' });
    const day = byDay.get(r.dow) ?? [];
    if (day.some((w) => open < w.close && w.open < close)) return errors.push({ field, message: 'Windows on the same day overlap' });
    day.push({ open, close });
    byDay.set(r.dow, day);
    if (day.length > maxPerDay) errors.push({ field, message: `At most ${maxPerDay} windows a day` });
    return null;
  });
  return errors;
}

const windowsOn = (hours, dow) => hours.filter((h) => h.dow === dow).sort((a, b) => toMin(a.openTime) - toMin(b.openTime));
const opensOn = (hours, date) => windowsOn(hours, dowOf(date)).length > 0;
const hasOpenDay = (hours) => hours.length > 0;

/** The window open at an instant, or null. */
function openWindowAt(hours, at) {
  const date = dhakaDate(at);
  const minute = minuteOf(at);
  return windowsOn(hours, dowOf(date)).find((w) => minute >= toMin(w.openTime) && minute < toMin(w.closeTime)) ?? null;
}

/** When the gym closes for the last time on a date (null when it does not open). */
function closingOn(hours, date) {
  const w = windowsOn(hours, dowOf(date));
  return w.length ? instantOf(date, Math.max(...w.map((x) => toMin(x.closeTime)))) : null;
}

// ---------------------------------------------------------------- packages

/** The days a package of a kind covers (custom: the days the owner chose, M24-FR-24). */
const daysOf = (kind, cfg, customDays = null) => (kind === 'custom' ? customDays : { month: cfg.monthDays, quarter: cfg.quarterDays, half_year: cfg.halfYearDays, year: cfg.yearDays }[kind]);

/**
 * Problems with a gym's active packages ({ kind, price }), or []: a quarter costs at least a month. M24-FR-24:
 * to submit the gym for review (`submit`) at least one package must be sold online, so a private gym may
 * save desk packages only; at most `maxCustom` custom packages (gym_manage.max_custom_packages) when given.
 */
function packageErrors(packages, { maxCustom = null }, { submit = true } = {}) {
  const errors = [];
  const price = (k) => packages.find((p) => p.kind === k)?.price ?? null;
  const month = price('month');
  const quarter = price('quarter');
  if (submit && !packages.length) errors.push({ field: 'packages', message: 'Add a package sold online' });
  if (quarter !== null && month !== null && quarter < month) errors.push({ field: 'packages.quarter', message: 'A quarter pass costs at least a month pass' });
  if (maxCustom !== null && packages.filter((p) => p.kind === 'custom').length > maxCustom) errors.push({ field: 'packages', message: `At most ${maxCustom} custom packages` });
  return errors;
}

// ---------------------------------------------------------------- buying a pass

/** The dates a pass covers, or { block }: it starts from today to advanceDays − 1 ahead and runs `days` days. */
function validity({ days, from, today, advanceDays }) {
  const ahead = daysBetween(today, from);
  if (ahead < 0 || ahead >= advanceDays) return { block: 'DATE_OUT_OF_RANGE' };
  return { validFrom: from, validTo: addDays(from, days - 1) };
}

// ---------------------------------------------------------------- redeeming

/**
 * Why a pass cannot be admitted now, or null. The wrong gym comes first, so a desk learns nothing
 * about another gym's passes; `usedTodayAt` is the earlier admission today, if any.
 */
function redeemBlock({ pass, gymId, today, at, hours, usedTodayAt = null }) {
  if (pass.gymId !== gymId) return { code: 'PASS_WRONG_GYM' };
  if (pass.status === 'redeemed') return { code: 'PASS_ALREADY_REDEEMED', at: pass.lastRedeemedAt };
  if (pass.status !== 'active') return { code: 'PASS_NOT_ACTIVE', status: pass.status };
  if (today < pass.validFrom || today > pass.validTo) return { code: 'PASS_NOT_VALID_TODAY', validFrom: pass.validFrom, validTo: pass.validTo };
  if (usedTodayAt) return { code: 'PASS_ALREADY_REDEEMED', at: usedTodayAt };
  if (!openWindowAt(hours, at)) return { code: 'GYM_CLOSED_NOW' };
  return null;
}

/** What an admission does to the pass: a day pass is used up; the first admission releases the money. */
const admission = (pass) => ({ status: pass.kind === 'day' ? 'redeemed' : 'active', release: !pass.firstRedeemedAt });

// ---------------------------------------------------------------- cancelling and expiry (Q110)

/**
 * The member's cancel: a day pass before its date, a month or quarter pass before its first use (and
 * before it ends), refunded in full; otherwise refused.
 */
function cancelPlan({ pass, today }) {
  if (pass.status !== 'active') return { block: 'PASS_NOT_ACTIVE' };
  if (pass.kind === 'day') return today < pass.validFrom ? { refund: pass.pricePoisha } : { block: 'PASS_NOT_REFUNDABLE' };
  if (pass.firstRedeemedAt || today > pass.validTo) return { block: 'PASS_NOT_REFUNDABLE' };
  return { refund: pass.pricePoisha };
}

/** When an active pass expires: a day pass when the gym closes on its date; others after their last day. */
function expiresAt(pass, hours) {
  if (pass.kind === 'day') return closingOn(hours, pass.validFrom) ?? instantOf(addDays(pass.validFrom, 1));
  return instantOf(addDays(pass.validTo, 1));
}

// ---------------------------------------------------------------- QR token and backup code

/** The QR payload; `sign(text)` is a keyed hash (hex). The token carries no personal data. */
const tokenOf = ({ passId, nonce }, sign) => `v1.${passId}.${nonce}.${sign(`gym-pass:${passId}:${nonce}`).slice(0, 32)}`;

/** { passId, nonce } of a well-formed token with a valid signature, else null. */
function parseToken(token, sign, equal = (a, b) => a === b) {
  const parts = String(token ?? '').trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !/^[0-9a-f-]{36}$/i.test(parts[1]) || !/^[A-Za-z0-9_-]{8,24}$/.test(parts[2]) || !/^[0-9a-f]{32}$/.test(parts[3])) return null;
  const [, passId, nonce, sig] = parts;
  return equal(sig, sign(`gym-pass:${passId}:${nonce}`).slice(0, 32)) ? { passId, nonce } : null;
}

/** A 6-character Crockford base32 code from six random bytes. */
const backupCode = (bytes) => Array.from(bytes.slice(0, 6), (b) => CROCKFORD[b % 32]).join('');

/** What a person typed, as a code: upper case, no spaces or dashes, O→0 and I/L→1; null if not 6 valid characters. */
function normalizeCode(input) {
  const s = String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{6}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------- trainer subscriptions

/** A period of `days` days from a start date (the end is the last day included). */
const periodOf = (start, days) => ({ periodStart: start, periodEnd: addDays(start, days - 1) });

/** The money of a period leaves escrow this long after the period's last day ends. */
const releaseAtOf = (periodEnd, windowHours) => new Date(instantOf(addDays(periodEnd, 1)).getTime() + windowHours * 3600000);

/** The last moment a renewal is accepted: the end of the grace days after the period. */
const graceUntil = (periodEnd, graceDays) => instantOf(addDays(periodEnd, graceDays + 1));

/**
 * Where a paid period stands for renewal: `active`, `renewal_due` (from noticeDays before the end),
 * `grace` (after the end, inside the grace days) or `lapsed` (after the grace days).
 */
function renewalPhase({ today, periodEnd, noticeDays, graceDays }) {
  if (today > addDays(periodEnd, graceDays)) return 'lapsed';
  if (today > periodEnd) return 'grace';
  if (daysBetween(today, periodEnd) < noticeDays) return 'renewal_due';
  return 'active';
}

/** A paid period refunds in full in its first cancelDays days (from its start); else it runs out. */
const inCancelWindow = ({ today, periodStart, cancelDays }) => today < addDays(periodStart, cancelDays);

/** A subscription starts today or within startDays. */
const startBlock = ({ start, today, startDays }) => {
  const ahead = daysBetween(today, start);
  return ahead < 0 || ahead >= startDays ? 'DATE_OUT_OF_RANGE' : null;
};

/** Problems with a trainer plan, or []. */
function planErrors(plan, { min, max }) {
  const errors = [];
  if (!Number.isInteger(plan.price) || plan.price < min || plan.price > max) errors.push({ field: 'price', message: `Between ${min / 100} and ${max / 100} taka a month` });
  if (plan.where === 'gym' && !plan.gymId) errors.push({ field: 'gymId', message: 'Choose the gym' });
  if (plan.where === 'home' && !plan.areaId) errors.push({ field: 'areaId', message: 'Choose the area you cover' });
  return errors;
}

// ---------------------------------------------------------------- M24 prompt 3: the directory by distance

/** Great-circle distance in metres (the same haversine as grounds' distanceM; copied, no cross-module import). */
function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Where a gym is on the map: its own pin, else its area's centre, else nowhere (null). */
function gymPoint({ lat, lng }, area) {
  if (lat !== null && lat !== undefined && lng !== null && lng !== undefined) return { lat: Number(lat), lng: Number(lng) };
  return area ? { lat: Number(area.lat), lng: Number(area.lng) } : null;
}

module.exports = {
  distanceM,
  gymPoint,
  KINDS,
  CHANNELS,
  soldOnline,
  CROCKFORD,
  dhakaDate,
  addDays,
  daysBetween,
  dowOf,
  instantOf,
  minuteOf,
  toMin,
  feeOf,
  money,
  hoursErrors,
  windowsOn,
  opensOn,
  hasOpenDay,
  openWindowAt,
  closingOn,
  daysOf,
  packageErrors,
  validity,
  redeemBlock,
  admission,
  cancelPlan,
  expiresAt,
  tokenOf,
  parseToken,
  backupCode,
  normalizeCode,
  periodOf,
  releaseAtOf,
  graceUntil,
  renewalPhase,
  inCancelWindow,
  startBlock,
  planErrors,
};
