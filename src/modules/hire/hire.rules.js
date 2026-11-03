'use strict';

/**
 * M11 pure rules (step 1): the quote per engagement (§6.3), rate limits per role and unit (Q74), the
 * directory's normalised rate (FR-03), the automatic checks (§6.5), the request and job state
 * machines and who may move them (§8), the match-day windows (FR-30, FR-31, FR-35), cancellation
 * tiers (§6.6), reply and payment deadlines (FR-23, FR-25) and contact masking before payment (v3).
 * Round B1: the pro's stats (FR-52: jobs done, acceptance rate, median reply), the insights buckets
 * (M19 §6.3 Pro), availability blocks and weekly repeats (FR-05, FR-14) and profile completeness.
 * No I/O; 100% branch coverage (jest.config).
 */
const { feeOf } = require('../../common/money');

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
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
function checks({ role, experienceLevel, credential, policeUntil, jobs, clashes, perDay, maxPerDay, now, leadMin, blocked = [] }) {
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
    // Round B1 (FR-05, §6.5 "no blocked availability overlapping [start, end)"): the pro's own calendar.
    { key: 'available', ok: blocked.length === 0 },
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

// ---------------------------------------------------------------- pro stats (FR-52, M19 §6.3)

/** Request statuses that mean the pro said yes (the request may have lapsed, been withdrawn or cancelled since). */
const ACCEPTED = ['accepted_unpaid', 'confirmed', 'completed', 'cancelled', 'lapsed', 'withdrawn'];

/** The median of a list of numbers, or null for an empty list. */
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Acceptance rate and median reply time over the requests created in the trailing window (M19 §6.3):
 *   accepted = said yes (decided, not declined: accepted_unpaid, confirmed, completed, or cancelled,
 *   lapsed or withdrawn after acceptance); rate = accepted / (accepted + declined + expired), in % with
 *   two decimals, null when nothing was asked; reply = median(decided_at − created_at) in whole minutes.
 *   rows: [{ status, createdAt, decidedAt }]. A request withdrawn before the reply counts nowhere.
 */
function requestStats(rows, { now, windowDays }) {
  const since = ms(now) - windowDays * DAY;
  const recent = rows.filter((r) => ms(r.createdAt) >= since);
  const decided = recent.filter((r) => r.decidedAt);
  const accepted = decided.filter((r) => ACCEPTED.includes(r.status)).length;
  const declined = recent.filter((r) => r.status === 'declined').length;
  const expired = recent.filter((r) => r.status === 'expired').length;
  const asked = accepted + declined + expired;
  const reply = median(decided.map((r) => (ms(r.decidedAt) - ms(r.createdAt)) / MIN));
  return { accepted, declined, expired, acceptanceRate: asked ? Math.round((accepted / asked) * 10000) / 100 : null, medianReplyMinutes: reply === null ? null : Math.round(reply) };
}

/** Rating over several profiles: the count-weighted average of each profile's M17 average. */
function ratingOf(profiles) {
  const count = profiles.reduce((n, p) => n + p.ratingCount, 0);
  const sum = profiles.reduce((n, p) => n + (p.ratingAvg ?? 0) * p.ratingCount, 0);
  return { avg: count ? Math.round((sum / count) * 100) / 100 : null, count };
}

// ---------------------------------------------------------------- insights buckets (M19 FR-02, §6.3 Pro)

const PERIODS = { '7w': { unit: 'week', count: 7 }, qtr: { unit: 'week', count: 13 }, yr: { unit: 'month', count: 12 } };
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const addMonths = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
};
/** The UTC instant of 00:00 Dhaka on a 'YYYY-MM-DD'. */
const dhakaMidnight = (date) => new Date(Date.parse(`${date}T00:00:00Z`) - DHAKA);

/**
 * The buckets of a period on the Dhaka calendar, oldest first (the last holds today), and the windows
 * to compare: the period so far ([from, tomorrow)) against the same number of days one period earlier
 * (7 or 13 weeks, or 12 months, back). Dates are 'YYYY-MM-DD'; each window is [from, to).
 */
function periodBuckets(period, today, weekStart = 'mon') {
  const { unit, count } = PERIODS[period];
  const buckets = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    if (unit === 'week') {
      const from = addDays(addDays(today, -((weekdayOf(today) - WEEKDAYS[weekStart] + 7) % 7)), -7 * i);
      buckets.push({ key: from, from, to: addDays(from, 7) });
    } else {
      const from = addMonths(today, -i);
      buckets.push({ key: from.slice(0, 7), from, to: addMonths(from, 1) });
    }
  }
  const from = buckets[0].from;
  const tomorrow = addDays(today, 1);
  const previousFrom = unit === 'week' ? addDays(from, -7 * count) : addMonths(from, -count);
  return { buckets, from, to: buckets[buckets.length - 1].to, current: { from, to: tomorrow }, previous: { from: previousFrom, to: addDays(previousFrom, daysBetween(from, tomorrow)) } };
}

/** Sum day rows [{ day, amount }] inside [from, to). */
const sumDays = (rows, { from, to }) => rows.reduce((n, r) => (r.day >= from && r.day < to ? n + r.amount : n), 0);

/** Day rows into the buckets: [{ key, from, amount }]. */
const bucketize = (rows, buckets) => buckets.map((b) => ({ key: b.key, from: b.from, amount: sumDays(rows, b) }));

/** Change in percent with one decimal; null when there is nothing to compare with. */
const delta = (current, previous) => (previous ? Math.round(((current - previous) / previous) * 1000) / 10 : null);

/** Releasing soon: jobs marked complete, waiting for the manager or the auto-release ([{ net, releaseAt }]). */
function releasingSoon(jobs) {
  const times = jobs.filter((j) => j.releaseAt).map((j) => ms(j.releaseAt));
  return { net: jobs.reduce((n, j) => n + j.net, 0), count: jobs.length, nextAt: times.length ? new Date(Math.min(...times)) : null };
}

/** Who hires you: hirers grouped by key (a team, or 'individual'), most jobs first, at most `limit`. */
function rankHirers(rows, limit) {
  const by = new Map();
  for (const r of rows) {
    const cur = by.get(r.key) ?? { key: r.key, label: r.label, jobs: 0 };
    cur.jobs += 1;
    by.set(r.key, cur);
  }
  return [...by.values()].sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label)).slice(0, limit);
}

// ---------------------------------------------------------------- availability (FR-05, FR-14, §7)

/** 'HH:MM' → minutes after midnight. */
const hm = (s) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

/**
 * One weekly repeat rule's spans that touch [from, to): every listed weekday (0 = Sunday, Dhaka
 * calendar), from rule.from to rule.to that day, while the rule is valid ([validFrom, validTo), validTo
 * null = open). Times are Dhaka wall-clock; to > from (no overnight spans).
 */
function expandRepeat(rule, { validFrom, validTo = null }, { from, to }) {
  const lo = Math.max(ms(from), ms(validFrom));
  const hi = Math.min(ms(to), validTo === null ? Infinity : ms(validTo));
  const out = [];
  if (lo >= hi) return out;
  for (let day = dhakaDay(lo); day <= dhakaDay(hi - 1); day = addDays(day, 1)) {
    if (!rule.weekdays.includes(weekdayOf(day))) continue;
    const midnight = ms(dhakaMidnight(day));
    const s = midnight + hm(rule.from) * MIN;
    const e = midnight + hm(rule.to) * MIN;
    if (s < hi && e > lo) out.push({ start: new Date(s), end: new Date(e) });
  }
  return out;
}

/**
 * Stored blocks expanded for a range: a one-off block is its own period; a repeat block's period is
 * the rule's validity. blocks: [{ id, start, end, reason, repeat }] → [{ blockId, start, end, reason, repeat }].
 */
function expandBlocks(blocks, range) {
  const out = [];
  for (const b of blocks) {
    if (b.repeat) {
      for (const sp of expandRepeat(b.repeat, { validFrom: b.start, validTo: b.end ?? null }, range)) out.push({ blockId: b.id, ...sp, reason: b.reason ?? null, repeat: true });
    } else if (ms(b.start) < ms(range.to) && ms(b.end) > ms(range.from)) {
      out.push({ blockId: b.id, start: new Date(b.start), end: new Date(b.end), reason: b.reason ?? null, repeat: false });
    }
  }
  return out.sort((a, b) => ms(a.start) - ms(b.start));
}

/** Spans merged where they overlap or touch, times only (what the public sees). */
function mergeSpans(spans) {
  const sorted = spans.map((s) => ({ start: ms(s.start), end: ms(s.end) })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out.map((s) => ({ start: new Date(s.start), end: new Date(s.end) }));
}

/** The spans overlapping [start, end). */
const overlapping = (spans, start, end) => spans.filter((s) => ms(s.start) < ms(end) && ms(s.end) > ms(start));

/** Whether any time in [from, to) is free of the busy spans. */
function hasFreeTime(spans, from, to) {
  let cursor = ms(from);
  if (cursor >= ms(to)) return false;
  for (const s of mergeSpans(spans)) {
    if (ms(s.start) > cursor) return true;
    cursor = Math.max(cursor, ms(s.end));
    if (cursor >= ms(to)) return false;
  }
  return true;
}

/** The last instant blocks may reach: 00:00 Dhaka after `horizonDays` whole days from today. */
const horizonEnd = (now, horizonDays) => dhakaMidnight(addDays(dhakaDay(now), horizonDays + 1));

/**
 * Field errors in a calendar save (PUT /pro/availability/blocks), or []:
 *   the range [from, to) from today (00:00 Dhaka) to the horizon; each block inside the range, start <
 *   end, no two blocks overlapping; each repeat rule from < to, until not past the horizon.
 */
function blockErrors({ range, blocks, repeats = [], now, horizonDays }) {
  const errors = [];
  const today = dhakaMidnight(dhakaDay(now));
  const limit = horizonEnd(now, horizonDays);
  if (ms(range.from) >= ms(range.to)) errors.push({ field: 'to', message: 'The range must end after it starts' });
  if (ms(range.from) < ms(today)) errors.push({ field: 'from', message: 'Past days cannot be changed' });
  if (ms(range.to) > ms(limit)) errors.push({ field: 'to', message: `At most ${horizonDays} days ahead` });
  const sorted = blocks.map((b, i) => ({ ...b, i })).sort((a, b) => ms(a.start) - ms(b.start));
  for (const [n, b] of sorted.entries()) {
    const field = `blocks[${b.i}]`;
    if (ms(b.start) >= ms(b.end)) errors.push({ field, message: 'A block must end after it starts' });
    else if (ms(b.start) < ms(range.from) || ms(b.end) > ms(range.to)) errors.push({ field, message: 'Keep blocks inside the range' });
    else if (n > 0 && ms(b.start) < ms(sorted[n - 1].end)) errors.push({ field, message: 'Blocks overlap' });
  }
  for (const [i, r] of repeats.entries()) {
    const field = `repeats[${i}]`;
    if (hm(r.from) >= hm(r.to)) errors.push({ field, message: 'A repeat must end after it starts, the same day' });
    else if (r.until && ms(dhakaMidnight(addDays(r.until, 1))) > ms(limit)) errors.push({ field, message: `At most ${horizonDays} days ahead` });
  }
  return errors;
}

/** Replace a set: stored rows to remove (not wanted any more) and wanted items to add (not stored yet), by a key. */
function replacePlan(existing, wanted, keyOf) {
  const keep = new Set(wanted.map(keyOf));
  const have = new Set(existing.map(keyOf));
  const add = [];
  for (const w of wanted) {
    if (!have.has(keyOf(w))) add.push(w);
    have.add(keyOf(w));
  }
  return { remove: existing.filter((e) => !keep.has(keyOf(e))), add };
}

// ---------------------------------------------------------------- completeness (Round B1)

/** Completeness of a step list: { score 0–100, steps }. */
const scoreOf = (steps) => ({ score: steps.length ? Math.round((steps.filter((s) => s.done).length / steps.length) * 100) : 100, steps });

/**
 * A hire profile's completeness for its owner. facts: { photo, rateCard, credentialApplies, credential,
 * policeClearance, availability, payoutAccount } (booleans). The police clearance step shows only for
 * under-16 work, the credential step only for roles with credential levels. "availability" is done once
 * the pro has used the calendar (any block saved, kept or removed): there is no "always free" switch.
 */
function completeness({ headline, bio, worksWithU16 }, f, { bioMinChars }) {
  return scoreOf([
    { key: 'photo', done: Boolean(f.photo) },
    { key: 'headline', done: Boolean(headline?.trim()) },
    { key: 'bio', done: (bio ?? '').trim().length >= bioMinChars },
    { key: 'rateCard', done: Boolean(f.rateCard) },
    ...(f.credentialApplies ? [{ key: 'credential', done: Boolean(f.credential) }] : []),
    ...(worksWithU16 ? [{ key: 'policeClearance', done: Boolean(f.policeClearance) }] : []),
    { key: 'availability', done: Boolean(f.availability) },
    { key: 'payoutAccount', done: Boolean(f.payoutAccount) },
  ]);
}

// ---------------------------------------------------------------- contact masking (v3)

/** Contact details (phone, long numbers, email, links) are not allowed in messages before payment. */
const { hasContact } = require('../../common/contact');

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
  ACCEPTED,
  median,
  requestStats,
  ratingOf,
  PERIODS,
  addDays,
  dhakaMidnight,
  periodBuckets,
  sumDays,
  bucketize,
  delta,
  releasingSoon,
  rankHirers,
  hm,
  expandRepeat,
  expandBlocks,
  mergeSpans,
  overlapping,
  hasFreeTime,
  horizonEnd,
  blockErrors,
  replacePlan,
  scoreOf,
  completeness,
};
