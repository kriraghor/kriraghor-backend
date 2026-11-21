'use strict';

/**
 * M19 pure rules (§6, FR-02 to FR-06): periods and buckets on the Asia/Dhaka calendar, deltas, the v3
 * meaning of "earned" for a booking, occupancy, repeat teams, GTV and take rate; since Round B2 the
 * counted sub-orders, average order, unused share, Dhaka hours, top lists and the organiser's totals
 * (§6.3). 100% branch coverage.
 * Dates are 'YYYY-MM-DD' strings (Dhaka calendar days); money is integer poisha.
 */
const DHAKA_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Dhaka calendar day of an instant. */
const dhakaDate = (at) => new Date(new Date(at).getTime() + DHAKA_MS).toISOString().slice(0, 10);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const dow = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** The first day of the week holding `date` (analytics.week_start, Q107). */
const weekStart = (date, start = 'mon') => addDays(date, -((dow(date) - DOW[start] + 7) % 7));
const monthStart = (date) => `${date.slice(0, 7)}-01`;
const addMonths = (month, n) => {
  const d = new Date(`${month}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
};

// 30d (20 Nov 2026, dashboards round 2): 30 Dhaka days, today the last (partial) one.
const PERIODS = { '30d': { unit: 'day', count: 30 }, '7w': { unit: 'week', count: 7 }, qtr: { unit: 'week', count: 13 }, yr: { unit: 'month', count: 12 } };
const isPeriod = (p) => Object.hasOwn(PERIODS, p);

/** FR-02: the buckets of a period, oldest first; the last one holds today. Each is [from, to). */
function buckets(period, today, start = 'mon') {
  const { unit, count } = PERIODS[period];
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    if (unit === 'day') {
      const from = addDays(today, -i);
      out.push({ key: from, from, to: addDays(from, 1) });
    } else if (unit === 'week') {
      const from = addDays(weekStart(today, start), -7 * i);
      out.push({ key: from, from, to: addDays(from, 7) });
    } else {
      const from = addMonths(monthStart(today), -i);
      out.push({ key: from.slice(0, 7), from, to: addMonths(from, 1) });
    }
  }
  return out;
}

/** FR-05: the same buckets a year earlier (52 weeks, so days keep their weekday; or 12 months). */
function lastYear(period, list) {
  const shift = PERIODS[period].unit === 'month' ? (b) => addMonths(b, -12) : (b) => addDays(b, -364);
  return list.map((b) => ({ key: b.key, from: shift(b.from), to: shift(b.to) }));
}

/**
 * FR-04: the window to compare the current bucket with: the same elapsed part of the previous bucket
 * (Monday to today against last Monday to the same weekday).
 */
function comparable(list, today) {
  const cur = list[list.length - 1];
  // Day buckets (30d): one day against the day before is noise; the whole period (to today) is compared
  // with the same number of days just before it.
  if (daysBetween(cur.from, cur.to) === 1) {
    const span = daysBetween(list[0].from, cur.to);
    return { current: { from: list[0].from, to: cur.to }, previous: { from: addDays(list[0].from, -span), to: list[0].from } };
  }
  const prev = list[list.length - 2];
  const elapsed = Math.min(daysBetween(cur.from, today) + 1, daysBetween(cur.from, cur.to));
  return { current: { from: cur.from, to: addDays(cur.from, elapsed) }, previous: { from: prev.from, to: addDays(prev.from, Math.min(elapsed, daysBetween(prev.from, prev.to))) } };
}

/**
 * The window a tile's headline and the "this period" charts cover: the last bucket (this week, this month),
 * or with day buckets (30d) the whole period.
 */
function headline(list) {
  const cur = list[list.length - 1];
  return daysBetween(cur.from, cur.to) === 1 ? { from: list[0].from, to: cur.to } : { from: cur.from, to: cur.to };
}

/** FR-04: percent for amounts and counts, points for rates; null when there is nothing to compare. */
function delta(current, previous, kind = 'amount') {
  if (current === null || previous === null) return null;
  if (kind === 'rate') return Math.round((current - previous) * 1000) / 10;
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Sum day rows into buckets: rows [{ day, …fields }] → [{ key, …sums }]. */
function bucketize(rows, list, fields) {
  return list.map((b) => {
    const sums = Object.fromEntries(fields.map((f) => [f, 0]));
    for (const r of rows) if (r.day >= b.from && r.day < b.to) for (const f of fields) sums[f] += Number(r[f] ?? 0);
    return { key: b.key, from: b.from, ...sums };
  });
}

/** Sum day rows inside [from, to). */
const sumWindow = (rows, { from, to }, field) => rows.reduce((n, r) => (r.day >= from && r.day < to ? n + Number(r[field] ?? 0) : n), 0);

/** Statuses that count as a booking (§6.1). */
const COUNTED = new Set(['confirmed', 'checked_in', 'completed', 'no_show']);

/**
 * What a booking earned the owner, gross of the Kriraghor fee (Q105), under v3:
 * played (checked in or completed): the total; no-show or member cancel: the retained advance;
 * owner or platform cancel, an expired hold, a skipped week, or not yet played: nothing.
 */
function earned({ status, total, retained }) {
  if (status === 'checked_in' || status === 'completed') return total;
  if (status === 'no_show' || status === 'cancelled') return retained;
  return 0;
}

/** Who booked, for repeat teams: the member, else the series, else the walk-in booking itself. */
const bookerKey = ({ bookerUserId, seriesId, bookingId }) => (bookerUserId ? `user:${bookerUserId}` : seriesId ? `series:${seriesId}` : `walkin:${bookingId}`);

/** booked / open half-hours; null with no open time. */
const occupancy = (booked, open) => (open > 0 ? Math.round((booked / open) * 1000) / 1000 : null);

/** Share of bookers with two or more bookings (repeat teams, last 90 days); null with no bookers. */
function repeatShare(countsByKey) {
  const counts = Object.values(countsByKey);
  if (!counts.length) return null;
  return Math.round((counts.filter((n) => n >= 2).length / counts.length) * 1000) / 1000;
}

/** Q106: GTV = online GMV + venue money recorded by owners. Take rate = fee revenue / GTV. */
const gtv = ({ online, venue }) => online + venue;
const takeRate = (fee, total) => (total > 0 ? Math.round((fee / total) * 10000) / 10000 : null);

/** FR-06: a chart that splits a tile must add up to it. */
const addsUp = (parts, total) => parts.reduce((n, x) => n + x, 0) === total;

// ---------------------------------------------------------------- Round B2: shops, gyms, organisers (§6.3)

/** Sub-order statuses that count as a sale: placed and not given back (pending payment, rejected, expired, cancelled and refunded are not). */
const SHOP_COUNTED = new Set(['placed', 'accepted', 'shipped', 'delivered', 'completed', 'disputed']);

/** Average order (and any money average): whole poisha, rounded half up; null with nothing to divide by. */
const average = (total, count) => (count > 0 ? Math.round(total / count) : null);

/** A share (unused passes of the ended ones): a fraction to three places; null with nothing to compare. */
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null);

/** The Dhaka hour (0–23) of an instant. */
const dhakaHour = (at) => new Date(new Date(at).getTime() + DHAKA_MS).getUTCHours();

/** The Dhaka days of a bucket [from, to), oldest first. */
function daysOf({ from, to }) {
  const out = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Ascending order of two keys: numbers as numbers, anything else as text. */
const byKey = (x, y) => (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)));

/** The first `n` rows by `field` (largest first), ties by `key` ascending so the order is stable. */
const top = (rows, field, n, key) => [...rows].sort((a, b) => b[field] - a[field] || byKey(a[key], b[key])).slice(0, n);

/** Events that still take teams or play matches (the Teams tile counts these). */
const RUNNING = new Set(['registration_open', 'registration_closed', 'live']);

/**
 * The organiser's tiles from M14's events (M14 §4.1 KPIs summed over the organisation):
 * teams approved of the places, waiting, unpaid and reserve from running events; matches played of
 * all non-cancelled matches; entry-fee money (collected, held, released, refunded) of every event.
 */
function organiserTotals(tournaments) {
  const t = { approved: 0, maxTeams: 0, waiting: 0, unpaid: 0, reserve: 0, matches: 0, played: 0, collected: 0, held: 0, released: 0, refunded: 0 };
  for (const x of tournaments) {
    if (RUNNING.has(x.status)) {
      t.approved += x.approved;
      t.maxTeams += x.maxTeams;
      t.waiting += x.waiting;
      t.unpaid += x.unpaid;
      t.reserve += x.reserve;
    }
    t.matches += x.matches;
    t.played += x.played;
    t.collected += x.money.collected;
    t.held += x.money.held;
    t.released += x.money.released;
    t.refunded += x.money.refunded;
  }
  return t;
}

module.exports = {
  DHAKA_MS,
  PERIODS,
  COUNTED,
  dhakaDate,
  addDays,
  daysBetween,
  weekStart,
  monthStart,
  addMonths,
  isPeriod,
  buckets,
  lastYear,
  comparable,
  headline,
  delta,
  bucketize,
  sumWindow,
  earned,
  bookerKey,
  occupancy,
  repeatShare,
  gtv,
  takeRate,
  addsUp,
  SHOP_COUNTED,
  RUNNING,
  average,
  share,
  dhakaHour,
  daysOf,
  top,
  organiserTotals,
};
