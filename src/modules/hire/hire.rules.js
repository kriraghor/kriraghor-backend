'use strict';

/**
 * M11 pure rules (step 1): the quote per engagement (§6.3), rate limits per role and unit (Q74), the
 * directory's normalised rate (FR-03), the automatic checks (§6.5), the request and job state
 * machines and who may move them (§8), the match-day windows (FR-30, FR-31, FR-35), cancellation
 * tiers (§6.6), reply and payment deadlines (FR-23, FR-25) and contact masking before payment (v3).
 * No I/O; 100% branch coverage (jest.config).
 */
const { feeOf } = require('../../common/money');

const MIN = 60000;
const HOUR = 60 * MIN;
const DHAKA = 6 * HOUR;
const ms = (d) => new Date(d).getTime();
const LEVELS = ['amateur', 'semi_pro', 'pro', 'national'];
const levelRank = (l) => LEVELS.indexOf(l);

// ---------------------------------------------------------------- quote (§6.3)

/** Round to the nearest ৳50, half up (5,000 poisha). */
const round50 = (p) => Math.floor((p + 2500) / 5000) * 5000;

/** The travel zone of a venue for a pro (Q70): home if the same area, else outside Dhaka metro, else the area's Dhaka zone. */
function zoneOf({ venueAreaId, baseAreaId, isDhakaMetro, dhakaZone }) {
  if (venueAreaId === baseAreaId) return 'home';
  if (!isDhakaMetro) return 'outside';
  return dhakaZone === 'south' ? 'south' : 'north';
}

/** Night work: a start at or after 18:00 Dhaka time (the hirer may also mark a floodlit game). */
const isNight = (start) => new Date(ms(start) + DHAKA).getUTCHours() >= 18;

/** The expected length of an engagement in hours: the session's hours, or the match format's length. */
const hoursOf = ({ unit, format, hours, matchHours }) => (unit === 'hourly' ? hours : matchHours[format] ?? matchHours.default);

/**
 * One engagement's price from a rate card: { lines: [{ key, amount }], total } or { error }.
 *   items: [{ unit, format, rate }]; card: { nightPct, shortNoticePct, shortNoticeHours, travel: { north, south, outside } }
 */
function quoteEngagement({ unit, format = null, hours, night, start, requestedAt, zone, items, card }) {
  const item = items.find((i) => i.unit === unit && (i.format ?? null) === (unit === 'match' ? format : null));
  if (!item) return { error: 'UNIT_NOT_OFFERED' };
  const base = unit === 'hourly' ? Math.round(item.rate * hours) : item.rate;
  const lines = [{ key: 'base', amount: base }];
  if (night && card.nightPct > 0) lines.push({ key: 'night', amount: Math.round((base * card.nightPct) / 100) });
  if (ms(start) - ms(requestedAt) < card.shortNoticeHours * HOUR && card.shortNoticePct > 0) lines.push({ key: 'short_notice', amount: Math.round((base * card.shortNoticePct) / 100) });
  if (zone !== 'home' && card.travel[zone] > 0) lines.push({ key: `travel_${zone}`, amount: card.travel[zone] });
  return { lines, total: round50(lines.reduce((n, l) => n + l.amount, 0)) };
}

/** Money for one job (or a total): the fee at the snapshotted bps and the pro's net. */
function money(totals, feeBps) {
  const total = totals.reduce((n, t) => n + t, 0);
  const fee = feeOf(total, feeBps);
  return { total, fee, net: total - fee };
}


// ---------------------------------------------------------------- rate cards (Q74)

/**
 * The allowed range of a rate: the role's base hourly rate × the unit factor (hours for a session,
 * the match multiplier, or the format's length) × the band, up to the top experience multiplier.
 */
function rateLimits({ baseHourly, unit, format = null, matchHours, unitMultipliers, experienceMultipliers, band }) {
  const factor = unit === 'hourly' ? 1 : format ? matchHours[format] ?? matchHours.default : unitMultipliers.match;
  const top = Math.max(...Object.values(experienceMultipliers));
  return { min: Math.floor(baseHourly * factor * band.min), max: Math.ceil(baseHourly * factor * top * band.max) };
}

/** Problems with a rate card for a role (field errors), or [] when it is fine. */
function rateCardErrors({ role, items, card, limitsFor, maxJobsCap, nightPctMax, shortPctMax }) {
  const errors = [];
  if (!items.length) errors.push({ field: 'items', message: 'Add at least one rate' });
  for (const [i, it] of items.entries()) {
    const field = `items[${i}]`;
    if (!role.allowedUnits.includes(it.unit)) errors.push({ field, message: 'This role is not hired by that unit' });
    else if (it.unit === 'match' && role.formatPriced && !role.formats.includes(it.format)) errors.push({ field, message: 'Choose one of the role’s match formats' });
    else if (it.unit === 'match' && !role.formatPriced && it.format) errors.push({ field, message: 'This role has one match rate' });
    else if (it.unit === 'hourly' && it.format) errors.push({ field, message: 'An hourly rate has no format' });
    else {
      const l = limitsFor(it.unit, it.format ?? null);
      if (it.rate < l.min || it.rate > l.max) errors.push({ field, message: `Between ${l.min / 100} and ${l.max / 100} taka` });
    }
  }
  const keys = items.map((it) => `${it.unit}:${it.format ?? ''}`);
  if (new Set(keys).size !== keys.length) errors.push({ field: 'items', message: 'One rate per unit and format' });
  if (card.nightPct > nightPctMax) errors.push({ field: 'nightPct', message: `At most ${nightPctMax}%` });
  if (card.shortNoticePct > shortPctMax) errors.push({ field: 'shortNoticePct', message: `At most ${shortPctMax}%` });
  if (card.maxJobsPerDay > maxJobsCap) errors.push({ field: 'maxJobsPerDay', message: `At most ${maxJobsCap}` });
  return errors;
}

/** FR-03: the rate the directory sorts by: hourly, else a match (or the T20 / cheapest format) over the match multiplier. */
function normalisedHourly(items, matchMultiplier) {
  const hourly = items.find((i) => i.unit === 'hourly');
  if (hourly) return hourly.rate;
  const matches = items.filter((i) => i.unit === 'match');
  if (!matches.length) return null;
  const pick = matches.find((i) => !i.format) ?? matches.find((i) => i.format === 'T20') ?? matches.reduce((a, b) => (b.rate < a.rate ? b : a));
  return Math.round(pick.rate / matchMultiplier);
}

// ---------------------------------------------------------------- jobs and checks (§6.5)

/** The busy period guarding a job: the job widened by half the travel buffer on each side. */
const busyOf = ({ start, end, bufferMin }) => ({ from: new Date(ms(start) - (bufferMin / 2) * MIN), to: new Date(ms(end) + (bufferMin / 2) * MIN) });

const dhakaDay = (d) => new Date(ms(d) + DHAKA).toISOString().slice(0, 10);

/**
 * The automatic checks the pro sees on a request, and that accept re-runs (§6.5).
 *   jobs: [{ start, u16 }]; credential: { level, expiresOn } | null; clashes: [jobCode]; perDay: { 'YYYY-MM-DD': count }
 * Returns [{ key, ok }].
 */
function checks({ role, experienceLevel, credential, policeUntil, jobs, clashes, perDay, maxPerDay, now, leadMin }) {
  const days = [...new Set(jobs.map((j) => dhakaDay(j.start)))];
  const lastDay = jobs.map((j) => dhakaDay(j.start)).sort().pop();
  const u16Days = jobs.filter((j) => j.u16).map((j) => dhakaDay(j.start));
  return [
    {
      key: 'credential',
      ok: !role.requiresCredential || Boolean(credential && levelRank(credential.level) >= levelRank(experienceLevel) && (!credential.expiresOn || credential.expiresOn >= lastDay)),
    },
    { key: 'police_clearance', ok: !u16Days.length || !role.policeCheckForU16 || Boolean(policeUntil && u16Days.every((d) => policeUntil >= d)) },
    { key: 'free', ok: clashes.length === 0 },
    { key: 'daily_limit', ok: days.every((d) => (perDay[d] ?? 0) + jobs.filter((j) => dhakaDay(j.start) === d).length <= maxPerDay) },
    { key: 'in_future', ok: jobs.every((j) => ms(j.start) > ms(now) + leadMin * MIN) },
  ];
}

// ---------------------------------------------------------------- state machines (§8)

const REQUEST = {
  accept: { from: ['pending'], to: 'accepted_unpaid', by: ['pro'] },
  decline: { from: ['pending'], to: 'declined', by: ['pro'] },
  expire: { from: ['pending'], to: 'expired', by: ['system'] },
  withdraw: { from: ['pending', 'accepted_unpaid'], to: 'withdrawn', by: ['hirer'] },
  pay: { from: ['accepted_unpaid'], to: 'confirmed', by: ['system'] },
  lapse: { from: ['accepted_unpaid'], to: 'lapsed', by: ['system'] },
  complete: { from: ['confirmed'], to: 'completed', by: ['system'] },
  cancel: { from: ['confirmed'], to: 'cancelled', by: ['system'] },
};
const ACTIVE_JOB = ['reserved', 'scheduled', 'checked_in', 'live', 'completed_marked'];
const JOB = {
  pay: { from: ['reserved'], to: 'scheduled', by: ['system'] },
  void: { from: ['reserved'], to: 'void', by: ['system'] },
  check_in: { from: ['scheduled'], to: 'checked_in', by: ['pro'] },
  start: { from: ['checked_in'], to: 'live', by: ['pro'] },
  complete: { from: ['checked_in', 'live'], to: 'completed_marked', by: ['pro'] },
  confirm: { from: ['completed_marked'], to: 'released', by: ['hirer'] },
  auto_release: { from: ['completed_marked'], to: 'released', by: ['system'] },
  cancel: { from: ['scheduled'], to: 'cancelled', by: ['hirer'] },
  withdraw: { from: ['scheduled'], to: 'withdrawn', by: ['pro'] },
  platform_cancel: { from: ['scheduled', 'checked_in'], to: 'cancelled', by: ['staff'] },
  dispute: { from: ['scheduled', 'checked_in', 'live', 'completed_marked'], to: 'disputed', by: ['hirer'] },
  dispute_release: { from: ['disputed'], to: 'released', by: ['dispute'] },
  dispute_refund: { from: ['disputed'], to: 'refunded', by: ['dispute'] },
};
const step = (table) => (action, from, actor) => {
  const t = table[action];
  return t && t.by.includes(actor) && t.from.includes(from) ? t.to : null;
};
const nextRequest = step(REQUEST);
const nextJob = step(JOB);

/** A confirmed request closes when every job is settled: completed if any was paid out, else cancelled. */
function requestAfterJobs(statuses) {
  if (statuses.some((s) => ACTIVE_JOB.includes(s) || s === 'disputed')) return null;
  return statuses.some((s) => s === 'released') ? 'completed' : 'cancelled';
}

// ---------------------------------------------------------------- windows (FR-23, FR-25, FR-30, FR-31, FR-35)

/** Reply by: reply_hours from now, but no later than the cut-off before the first start. */
const replyBy = ({ now, firstStart, replyHours, beforeStartMin }) => new Date(Math.min(ms(now) + replyHours * HOUR, ms(firstStart) - beforeStartMin * MIN));
/** Pay by: the payment window from acceptance, but no later than the cut-off before the first start. */
const payBy = ({ now, firstStart, windowMin, beforeStartMin }) => new Date(Math.min(ms(now) + windowMin * MIN, ms(firstStart) - beforeStartMin * MIN));

/** Check-in opens openMin before the start and closes at the end; late after lateMin before the start. */
function checkIn({ now, start, end, openMin, lateMin }) {
  if (ms(now) < ms(start) - openMin * MIN) return { block: 'TOO_EARLY' };
  if (ms(now) >= ms(end)) return { block: 'JOB_ENDED' };
  return { late: ms(now) > ms(start) - lateMin * MIN };
}

/** The start (toss) opens openMin before the scheduled start. */
const startBlock = ({ now, start, openMin }) => (ms(now) < ms(start) - openMin * MIN ? 'TOO_EARLY' : null);

/** A no-show can be reported afterMin after the start without a check-in, until the window after the end. */
function noShowBlock({ now, start, end, checkedIn, afterMin, windowHours }) {
  if (checkedIn) return 'CHECKED_IN';
  if (ms(now) < ms(start) + afterMin * MIN) return 'NO_SHOW_NOT_YET';
  if (ms(now) >= ms(end) + windowHours * HOUR) return 'DISPUTE_WINDOW_CLOSED';
  return null;
}

/** A problem with the work can be reported once the pro marks it complete, until it is released. */
const problemBlock = ({ status }) => (status === 'completed_marked' ? null : 'DISPUTE_NOT_ELIGIBLE');

/** Released automatically autoHours after the pro marks the job complete. */
const releaseAt = ({ completedAt, autoHours }) => new Date(ms(completedAt) + autoHours * HOUR);

// ---------------------------------------------------------------- cancellation (§6.6)

/**
 * The manager cancels a confirmed job: free more than freeHours before the start; the lower fee
 * between highHours and freeHours; the higher fee under highHours. The fee goes to the pro minus the
 * platform's share (feeBps); the rest is refunded.
 */
function cancelPlan({ now, start, quote, freeHours, highHours, pctMid, pctHigh, feeBps }) {
  const left = ms(start) - ms(now);
  const tier = left > freeHours * HOUR ? 'free' : left > highHours * HOUR ? 'mid' : 'high';
  const pct = { free: 0, mid: pctMid, high: pctHigh }[tier];
  const cancelFee = Math.round((quote * pct) / 100);
  const platform = feeOf(cancelFee, feeBps);
  return { tier, pct, cancelFee, refund: quote - cancelFee, proGets: cancelFee - platform, platformFee: platform };
}

// ---------------------------------------------------------------- contact masking (v3)

const PHONE = /(\+?88)?0?1[3-9](?:[\s.-]?\d){8}/;
const DIGITS = /(?:\d[\s.-]?){9,}/;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const LINK = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|net|org|bd|me|io|co)\b/i;
/** Contact details (phone, long numbers, email, links) are not allowed in messages before payment. */
const hasContact = (text) => PHONE.test(text) || DIGITS.test(text) || EMAIL.test(text) || LINK.test(text);

module.exports = {
  LEVELS,
  levelRank,
  round50,
  zoneOf,
  isNight,
  hoursOf,
  quoteEngagement,
  money,
  rateLimits,
  rateCardErrors,
  normalisedHourly,
  busyOf,
  dhakaDay,
  checks,
  REQUEST,
  JOB,
  ACTIVE_JOB,
  nextRequest,
  nextJob,
  requestAfterJobs,
  replyBy,
  payBy,
  checkIn,
  startBlock,
  noShowBlock,
  problemBlock,
  releaseAt,
  cancelPlan,
  hasContact,
};
