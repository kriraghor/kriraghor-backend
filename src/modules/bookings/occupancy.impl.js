'use strict';

/**
 * M10's implementation of the M09 OccupancyPort (M09 §2.3, M10 §2.4). booking_slots is the one
 * occupancy table, so every source (bookings, walk-ins, series weeks, closures) is checked and
 * written here (FR-33, FR-35). M09 calls the port inside its own transactions.
 *
 *   findConflicts({ courtIds, from, to, outsideHours?, ignore? })  all sources, with labels
 *   countUpcoming({ groundId?, courtIds? })                        pending_payment + confirmed
 *   openHalfHours(courtIds, day)                                   free half-hours per court ("most open hours")
 *   reserveClosure / releaseClosure / shortenClosure               M09 closures (FR-15 to FR-18)
 *   materialiseSeries / setSeriesWeek / endSeries                  M09 series (FR-19 to FR-24)
 */
const { Op } = require('sequelize');
const { sequelize, Booking, BookingSlot } = require('../../models');
const { nextCode } = require('../../common/sequences');
const { feeOf } = require('../../common/money');
const occupancyPort = require('../grounds/occupancy.port');
const reads = require('../grounds/grounds.reads');
const pr = require('../grounds/pricing.rules');
const grules = require('../grounds/grounds.rules');
const fees = require('../payments').fees;
const c = require('./bookings.common');
const rules = require('./bookings.rules');

const HALF = rules.HALF_HOUR;

function label(row) {
  if (row.source === 'closure') return { kind: 'closure', id: row.closureId, label: 'Closure' };
  return { kind: 'booking', id: row.bookingId, code: row.code, label: row.teamName ?? row.code, status: row.status, source: row.source };
}

const conflictOf = (row) => ({ ...label(row), courtId: row.courtId, start: c.iso(row.start), end: c.iso(row.end) });

/** Does every half-hour of [start, end) fall inside these hours rows (one court)? */
function insideHours(rows, start, end) {
  for (let t = new Date(start).getTime(); t < new Date(end).getTime(); t += HALF) {
    const { hour, minute, dow } = pr.dhakaParts(t);
    if (!grules.isOpenAt(rows.find((h) => h.dow === dow), hour * 60 + minute)) return false;
  }
  return true;
}

async function findConflicts({ courtIds, from = null, to = null, outsideHours = null, ignore = {} }, { transaction } = {}) {
  if (outsideHours) {
    // FR-08: upcoming bookings that would fall outside the new hours (closures do not matter).
    const rows = await c.overlapping({ courtIds, from: new Date(), to: new Date('9999-12-31T00:00:00Z') }, { transaction });
    return rows.filter((r) => r.source !== 'closure' && !insideHours(outsideHours, r.start, r.end)).map(conflictOf);
  }
  const rows = await c.overlapping({ courtIds, from, to, ignoreBookingId: ignore.bookingId ?? null, ignoreClosureId: ignore.closureId ?? null }, { transaction });
  return rows.map(conflictOf);
}

async function countUpcoming({ groundId = null, courtIds = null }, { transaction } = {}) {
  const where = { status: [...rules.UPCOMING], endAt: { [Op.gt]: new Date() } };
  if (groundId) where.groundId = groundId;
  if (courtIds) where.courtIds = { [Op.overlap]: courtIds };
  return Booking.count({ where, transaction });
}

/** Free half-hours per court on a Dhaka day (FR-26 "most open hours"), from now when it is today. */
async function openHalfHours(courtIds, day) {
  if (!courtIds.length) return {};
  const hours = await reads.hoursFor(courtIds);
  const from = pr.dhakaInstant(day, 0);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  const busy = await c.overlapping({ courtIds, from, to });
  const now = Date.now();
  const out = {};
  for (const courtId of courtIds) {
    const rows = hours.filter((h) => h.courtId === courtId);
    let n = 0;
    for (let t = from.getTime(); t < to.getTime(); t += HALF) {
      if (t < now) continue;
      if (!insideHours(rows, t, t + HALF)) continue;
      if (busy.some((b) => b.courtId === courtId && new Date(b.start).getTime() < t + HALF && new Date(b.end).getTime() > t)) continue;
      n += 1;
    }
    out[courtId] = n;
  }
  return out;
}

/**
 * M19 occupancy (M10 §6.6, FR-35): per court on a Dhaka day, the open half-hours (inside the hours,
 * minus closures) and the booked ones (every non-closure source with an active slot).
 */
async function courtDays(courtIds, day) {
  if (!courtIds.length) return [];
  const [hours, courts] = await Promise.all([reads.hoursFor(courtIds), reads.courts(courtIds)]);
  const from = pr.dhakaInstant(day, 0);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  const busy = await c.overlapping({ courtIds, from, to });
  const owners = new Map();
  const out = [];
  for (const k of courts) {
    if (!owners.has(k.groundId)) owners.set(k.groundId, (await reads.ground(k.groundId))?.ownerId ?? null);
    const rows = hours.filter((h) => h.courtId === k.id);
    const mine = busy.filter((b) => b.courtId === k.id);
    const covers = (b, t) => new Date(b.start).getTime() < t + HALF && new Date(b.end).getTime() > t;
    let open = 0;
    let booked = 0;
    for (let t = from.getTime(); t < to.getTime(); t += HALF) {
      if (!insideHours(rows, t, t + HALF) || mine.some((b) => b.source === 'closure' && covers(b, t))) continue;
      open += 1;
      if (mine.some((b) => b.source !== 'closure' && covers(b, t))) booked += 1;
    }
    out.push({ courtId: k.id, groundId: k.groundId, ownerId: owners.get(k.groundId), day, openHh: open, bookedHh: booked });
  }
  return out;
}

// ---------------------------------------------------------------- closures (M09 FR-15 to FR-18)

const reserveClosure = (closure, { transaction }) =>
  c.reserve({ groundId: closure.groundId, courtIds: closure.courtIds, start: closure.startsAt, end: closure.endsAt, source: 'closure', closureId: closure.id }, { transaction, code: 'SLOT_UNAVAILABLE' });

const releaseClosure = (closure, { transaction }) => c.release({ closureId: closure.id }, 'reopened', { transaction, groundId: closure.groundId });

async function shortenClosure(closure, end, { transaction }) {
  await BookingSlot.update({ period: c.range(closure.startsAt, end) }, { where: { closureId: closure.id, status: 'active' }, transaction });
  c.touch(closure.groundId, transaction);
}

// ---------------------------------------------------------------- series (M09 FR-19 to FR-24)

/**
 * Create the bookings of a series (source `series`, paid at the venue, Q64) with their slots, in
 * the caller's transaction. `weeks` come from grounds.rules.seriesWeeks; `skip` lists clashing weeks
 * the owner chose to skip (they are created as `skipped`, with no slot).
 */
async function materialiseSeries(series, weeks, { skip = new Set(), rules: r, transaction }) {
  const fee = fees.snapshot('grounds');
  const out = [];
  for (const w of weeks) {
    const skipped = skip.has(w.week);
    const b = await Booking.create(
      {
        code: await nextCode('BK', transaction),
        source: 'series',
        groundId: series.groundId,
        ownerId: series.ownerId,
        courtIds: [series.courtId],
        teamName: series.teamName,
        contactPhoneEnc: series.contactPhoneEnc,
        contactPhoneLast4: series.contactPhoneLast4,
        startAt: w.start,
        endAt: w.end,
        status: skipped ? 'skipped' : 'confirmed',
        pricingRuleId: series.pricingRuleId,
        pricePoisha: series.pricePerSessionPoisha,
        totalPoisha: series.pricePerSessionPoisha,
        advancePct: 0,
        advancePoisha: 0,
        paymentChoice: 'venue',
        onlinePoisha: 0,
        feeBps: fee.feeBps,
        feePoisha: feeOf(series.pricePerSessionPoisha, fee.feeBps),
        graceMin: r.checkinGraceMin,
        minBookingMin: r.minBookingMin,
        seriesId: series.id,
        seriesWeek: w.week,
        confirmedAt: skipped ? null : new Date(),
        createdBy: series.createdBy,
      },
      { transaction }
    );
    if (!skipped) await c.reserve({ groundId: b.groundId, courtIds: b.courtIds, start: b.startAt, end: b.endAt, source: 'series', bookingId: b.id }, { transaction });
    out.push(b);
  }
  return out;
}

/** Skip or restore one future week (FR-22). Restore re-checks the slot (409 SLOT_UNAVAILABLE). */
async function setSeriesWeek(series, week, action, { transaction }) {
  const b = await Booking.findOne({ where: { seriesId: series.id, seriesWeek: week }, transaction, lock: transaction.LOCK.UPDATE });
  if (!b) return null;
  const to = rules.next(action, b.status);
  if (!to || rules.cancelBlock({ start: b.startAt, now: new Date() })) throw c.fail('BOOKING_STATE');
  if (action === 'skip') await c.release({ bookingId: b.id }, 'skipped', { transaction, groundId: b.groundId });
  else await c.reserve({ groundId: b.groundId, courtIds: b.courtIds, start: b.startAt, end: b.endAt, source: 'series', bookingId: b.id }, { transaction });
  await b.update({ status: to }, { transaction });
  return b;
}

/** End a series (FR-23): future confirmed weeks are cancelled by the owner with reason series_ended, no penalty; skipped weeks stay skipped. */
async function endSeries(series, { actor, transaction }) {
  const now = new Date();
  const future = await Booking.findAll({ where: { seriesId: series.id, status: 'confirmed', startAt: { [Op.gt]: now } }, transaction, lock: transaction.LOCK.UPDATE });
  for (const b of future) {
    await c.release({ bookingId: b.id }, 'cancelled', { transaction, groundId: b.groundId });
    await b.update({ status: 'cancelled_by_owner', cancelledAt: now, cancelActor: 'owner', cancelReason: 'series_ended', updatedBy: actor?.id ?? null }, { transaction });
  }
  return future.length;
}

/** Bookings of a series for the owner's view. */
const seriesBookings = (seriesId, { transaction } = {}) => Booking.findAll({ where: { seriesId }, order: [['seriesWeek', 'ASC']], transaction });

function register() {
  occupancyPort.register({ findConflicts, countUpcoming, openHalfHours, reserveClosure, releaseClosure, shortenClosure, materialiseSeries, setSeriesWeek, endSeries, seriesBookings });
}

module.exports = { register, findConflicts, countUpcoming, openHalfHours, courtDays, insideHours, sequelize };
