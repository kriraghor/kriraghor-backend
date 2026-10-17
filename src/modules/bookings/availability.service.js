'use strict';

/**
 * GET /grounds/:id/availability?date=YYYY-MM-DD (FR-01 to FR-03, public). A per-court grid of
 * half-hour cells on the Dhaka day: past, closed, booked, yours or open, with the hourly rate from
 * the published pricing version. The occupancy of a ground and day is cached in Redis for
 * booking.availability_cache_seconds and dropped on every slot write (bookings.common.touch); the
 * viewer's own cells ("yours") are worked out per request, so the cache holds no personal view.
 */
const { E } = require('../../common/errors');
const { getRedis } = require('../../common/redis');
const logger = require('../../common/logger');
const config = require('../../config');
const settings = require('../settings/settings.service');
const reads = require('../grounds/grounds.reads');
const pr = require('../grounds/pricing.rules');
const grules = require('../grounds/grounds.rules');
const c = require('./bookings.common');
const rules = require('./bookings.rules');

const DAY = 24 * 60 * 60 * 1000;

async function occupancy(groundId, courtIds, day) {
  // Tests read right after a write; the cache drop runs after commit without being awaited.
  const ttl = config.isTest ? 0 : settings.get('booking.availability_cache_seconds');
  const field = day;
  if (ttl > 0) {
    try {
      const hit = await getRedis().hget(c.cacheKey(groundId), field);
      if (hit) return JSON.parse(hit);
    } catch (err) {
      logger.warn({ err: err.message }, 'availability cache read failed');
    }
  }
  const from = pr.dhakaInstant(day, 0);
  const rows = await c.overlapping({ courtIds, from, to: new Date(from.getTime() + DAY) });
  const slim = rows.map((r) => ({ courtId: r.courtId, start: c.iso(r.start), end: c.iso(r.end), bookerUserId: r.bookerUserId ?? null }));
  if (ttl > 0) {
    try {
      await getRedis().multi().hset(c.cacheKey(groundId), field, JSON.stringify(slim)).expire(c.cacheKey(groundId), ttl).exec();
    } catch (err) {
      logger.warn({ err: err.message }, 'availability cache write failed');
    }
  }
  return slim;
}

async function forDay(groundId, { date }, viewer = null) {
  const g = await reads.ground(groundId);
  if (!g || !['live', 'paused'].includes(g.status)) throw E.notFound('Ground');
  const now = new Date();
  const today = pr.dhakaParts(now).date;
  const windowDays = settings.get('booking.window_days');
  const lastDay = pr.dhakaParts(new Date(now.getTime() + windowDays * DAY)).date;
  const day = date ?? today;
  if (day < today || day > lastDay) throw c.fail('OUT_OF_RANGE', { from: today, to: lastDay });
  const courtIds = g.courts.map((k) => k.id);
  const [hours, version, busy] = await Promise.all([reads.hoursFor(courtIds), reads.publishedVersionAt(g.id, now), occupancy(g.id, courtIds, day)]);
  const open = settings.get('booking.grid_open');
  const close = settings.get('booking.grid_close');
  const cells = [];
  for (let m = grules.toMin(open); m < grules.toMin(close); m += 30) cells.push(m);
  const dow = pr.dhakaParts(pr.dhakaInstant(day, 12 * 60)).dow;
  return {
    groundId: g.id,
    date: day,
    window: { from: today, to: lastDay },
    bookable: g.bookable,
    cutoffMin: g.bookingCutoffMin,
    minBookingMin: version?.minBookingMin ?? null,
    lengths: version ? [...new Set([...settings.get('booking.min_length_options_min'), 180])].filter((x) => x >= version.minBookingMin) : [],
    courts: g.courts.map((k) => {
      const rows = hours.filter((h) => h.courtId === k.id);
      return {
        id: k.id,
        name: k.name,
        combinableGroup: k.combinableGroup ?? null,
        cells: cells.map((m) => {
          const start = pr.dhakaInstant(day, m);
          const end = new Date(start.getTime() + rules.HALF_HOUR);
          const slot = busy.find((b) => b.courtId === k.id && new Date(b.start) < end && new Date(b.end) > start);
          const state = g.bookable
            ? rules.cellState({ start, now, cutoffMin: g.bookingCutoffMin, open: grules.isOpenAt(rows.find((h) => h.dow === dow), m), occupiedBy: slot ?? null, viewerId: viewer?.id ?? null })
            : 'closed';
          return { start: start.toISOString(), time: grules.toHHMM(m), state, rate: version ? pr.hourlyRate(pr.courtBase(version, k.id), version, Math.floor(m / 60), dow) : null };
        }),
      };
    }),
  };
}

module.exports = { forDay };
