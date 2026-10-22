'use strict';

/**
 * Round B1 availability calendars (M11 §4, FR-05, FR-14): the demo referee and the demo trainer mark
 * a weekly repeat and two one-off blocks in the next two weeks, through PUT /pro/availability/blocks
 * as the pro (so the horizon, overlap and booked-job checks apply). Runs in both profiles, after the
 * hire profiles exist.
 *
 * Re-running keeps a calendar that still has an upcoming one-off block and its repeat; otherwise it
 * saves the blocks again relative to today (the PUT replaces only the one-off blocks in its range and
 * the weekly repeats, so a saved calendar is never duplicated).
 */
const rt = require('../runtime');
const D = require('../data');

const { models } = rt;
const day = 86400000;
const DHAKA = 6 * 3600000;

/** 00:00 Dhaka `days` days from today. */
function dhakaMidnight(days) {
  const d = new Date(Date.now() + DHAKA + days * day);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - DHAKA);
}
/** HH:MM Dhaka `days` days from today. */
function dhakaTime(days, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(dhakaMidnight(days).getTime() + (h * 60 + m) * 60000);
}

/** The PUT body for one calendar: the next 14 days, the one-off blocks and every weekly repeat. */
function bodyFor(spec) {
  return {
    from: dhakaMidnight(0).toISOString(),
    to: dhakaMidnight(14).toISOString(),
    blocks: spec.blocks.map((b) => ({ start: dhakaTime(b.inDays, b.from).toISOString(), end: dhakaTime(b.inDays, b.to).toISOString(), reason: b.reason })),
    repeats: spec.repeats.map((r) => ({ weekdays: r.weekdays, from: r.from, to: r.to, ...(r.until ? { until: r.until } : {}), reason: r.reason })),
  };
}

const upper = (period) => {
  const b = period?.[1];
  const v = b !== null && typeof b === 'object' && !(b instanceof Date) ? b.value : b;
  return v === null || v === undefined || v === Infinity ? null : new Date(v);
};

/** True when the person's calendar already shows an upcoming one-off block and a weekly repeat. */
async function current(userId) {
  const rows = await models.AvailabilityBlock.findAll({ where: { userId, status: 'active' } });
  const now = Date.now();
  return rows.some((b) => b.repeatRule) && rows.some((b) => !b.repeatRule && upper(b.period) && upper(b.period).getTime() > now);
}

/** `pros`: the rows L.pros returns (actor, n, …). Returns what happened per person. */
async function run(pros) {
  const out = [];
  for (const spec of D.AVAILABILITY) {
    const p = pros.find((x) => x.n === spec.n);
    if (!p) continue;
    if (await current(p.actor.userId)) {
      out.push(`${p.name}: kept`);
      continue;
    }
    // A booked job in the way (BLOCK_OVER_JOB): leave the calendar as it is.
    const r = await rt.put(p.actor, '/pro/availability/blocks', bodyFor(spec), { ok: [409] });
    out.push(`${p.name}: ${r?.code ? `skipped (${r.code})` : `${r.blocks.length} blocks, ${r.repeats.length} weekly`}`);
  }
  return out;
}

module.exports = { run, bodyFor, dhakaMidnight, dhakaTime };
