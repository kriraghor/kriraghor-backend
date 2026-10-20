'use strict';

/**
 * M09 series, step 2 (FR-19 to FR-24, §4.3, §7.7). A weekly slot for a team, booked by the owner:
 * the weeks are computed on the Dhaka wall clock and stored as real M10 bookings (source `series`,
 * paid at the venue, Q64) in the same transaction, through the occupancy port. Every week is checked
 * for clashes; a clash returns 409 SERIES_CLASHES with the weeks unless skipClashingWeeks. The price
 * per session is snapshotted: round10(price × (1 − series %)) on the published version (§6.1).
 * Skip and restore change one future week; end cancels the future weeks (no penalty, no refund).
 */
const { E } = require('../../common/errors');
const { encrypt } = require('../../common/crypto');
const { sequelize, BookingSeries, Court } = require('../../models');
const audit = require('../audit').audit;
const events = require('../events').events;
const settings = require('../settings').settings;
const rules = require('./grounds.rules');
const pr = require('./pricing.rules');
const c = require('./grounds.common');
const reads = require('./grounds.reads');
const occupancy = require('./occupancy.port');

const { fail } = c;

function view(s, bookings = null) {
  return {
    id: s.id,
    groundId: s.groundId,
    courtId: s.courtId,
    teamName: s.teamName,
    phoneLast4: s.contactPhoneLast4 ?? null,
    dow: s.dow,
    startTime: s.startTime,
    lengthMin: s.lengthMin,
    weeks: s.weeks,
    firstDate: s.firstDate,
    discountPct: s.discountPct,
    pricePerSession: s.pricePerSessionPoisha,
    status: s.status,
    ...(bookings ? { sessions: bookings.map((b) => ({ id: b.id, code: b.code, week: b.seriesWeek, start: b.startAt.toISOString(), end: b.endAt.toISOString(), status: b.status })) } : {}),
  };
}

const publish = (transaction, name, s, extra, actor) =>
  events.publish(transaction, { name, aggregateType: 'booking_series', aggregateId: s.id, payload: { seriesId: s.id, groundId: s.groundId, ownerId: s.ownerId, ...extra }, actor });

/** Validate a series and check every week: { g, court, version, weeks: [{…, clash}] , price }. */
async function plan(principal, groundId, body, { transaction } = {}) {
  const g = await c.owned(principal, groundId, { transaction });
  if (g.status !== 'live') throw fail('GROUND_NOT_BOOKABLE');
  const court = await Court.findOne({ where: { id: body.courtId, groundId: g.id, status: 'active' }, transaction });
  if (!court) throw fail('COURT_UNKNOWN');
  const version = await reads.publishedVersionAt(g.id, new Date(), { transaction });
  if (!version) throw fail('PRICING_MISSING');
  const block = rules.seriesBlock({
    firstDate: body.firstDate,
    dow: body.dow,
    startTime: body.startTime,
    lengthMin: body.lengthMin,
    weeks: body.weeks,
    weeksOptions: settings.get('booking.series_weeks_options'),
    minBookingMin: version.minBookingMin,
    today: pr.dhakaParts(new Date()).date,
  });
  if (block) throw fail(block);
  const weeks = rules.seriesWeeks(body);
  const now = new Date();
  for (const w of weeks) {
    if (w.start <= now) w.clash = 'past';
    else if (!(await reads.isOpen([court.id], w.start, body.lengthMin, { transaction }))) w.clash = 'closed';
    else {
      const conflicts = await occupancy.findConflicts({ courtIds: [court.id], from: w.start, to: w.end }, { transaction });
      w.clash = conflicts.length ? conflicts[0].kind : null;
    }
  }
  const price = pr.seriesPrice(pr.price(version, [court.id], weeks[0].start, body.lengthMin), version.seriesDiscountPct);
  return { g, court, version, weeks, price };
}

const weeksView = (weeks) => weeks.map((w) => ({ week: w.week, date: w.date, start: w.start.toISOString(), end: w.end.toISOString(), clash: w.clash }));

/** POST /me/grounds/:id/series/preview */
async function preview(principal, groundId, body) {
  const p = await plan(principal, groundId, body);
  return { pricePerSession: p.price, discountPct: p.version.seriesDiscountPct, total: p.price * p.weeks.filter((w) => !w.clash).length, weeks: weeksView(p.weeks) };
}

/** POST /me/grounds/:id/series (FR-19 to FR-21). */
async function create(principal, groundId, body, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await plan(principal, groundId, body, { transaction });
    const clashing = p.weeks.filter((w) => w.clash);
    if (clashing.length && !body.skipClashingWeeks) throw fail('SERIES_CLASHES', { meta: { weeks: weeksView(clashing) } });
    if (clashing.length === p.weeks.length) throw fail('SERIES_CLASHES', { meta: { weeks: weeksView(clashing) } });
    const s = await BookingSeries.create(
      {
        groundId: p.g.id,
        courtId: p.court.id,
        ownerId: p.g.ownerId,
        teamName: body.teamName,
        contactPhoneEnc: body.phone ? encrypt(body.phone) : null,
        contactPhoneLast4: body.phone ? body.phone.slice(-4) : null,
        dow: body.dow,
        startTime: body.startTime,
        lengthMin: body.lengthMin,
        weeks: body.weeks,
        firstDate: body.firstDate,
        pricingRuleId: p.version.id,
        discountPct: p.version.seriesDiscountPct,
        pricePerSessionPoisha: p.price,
        createdBy: principal.id,
      },
      { transaction }
    );
    const bookings = await occupancy.materialiseSeries(s, p.weeks, { skip: new Set(clashing.map((w) => w.week)), rules: p.version, transaction });
    await audit.record({ action: 'booking_series.created', actor: principal, entityType: 'booking_series', entityId: s.id, after: view(s), meta: { groundId: p.g.id, skipped: clashing.map((w) => w.week) }, req }, { transaction });
    await publish(transaction, 'booking_series.created', s, { weeks: s.weeks, skipped: clashing.length }, principal);
    return view(s, bookings);
  });
}

async function ownedSeries(principal, id, { transaction, lock = false } = {}) {
  const s = await BookingSeries.findByPk(id, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!s) throw E.notFound('Series');
  await c.owned(principal, s.groundId, { transaction });
  return s;
}

/** GET /me/grounds/:id/series */
async function list(principal, groundId) {
  const g = await c.owned(principal, groundId);
  const rows = await BookingSeries.findAll({ where: { groundId: g.id }, order: [['createdAt', 'DESC']] });
  return { items: rows.map((s) => view(s)) };
}

/** GET /me/series/:id */
async function get(principal, id) {
  const s = await ownedSeries(principal, id);
  return view(s, await occupancy.seriesBookings(s.id));
}

/** POST /me/series/:id/weeks/:week/skip | restore (FR-22). */
async function setWeek(principal, id, week, action, req) {
  return sequelize.transaction(async (transaction) => {
    const s = await ownedSeries(principal, id, { transaction, lock: true });
    if (s.status !== 'active') throw fail('SERIES_STATE');
    const b = await occupancy.setSeriesWeek(s, week, action, { transaction });
    if (!b) throw E.notFound('Week');
    await audit.record({ action: `booking_series.week_${action === 'skip' ? 'skipped' : 'restored'}`, actor: principal, entityType: 'booking_series', entityId: s.id, after: { week, status: b.status }, req }, { transaction });
    await publish(transaction, `booking_series.week_${action === 'skip' ? 'skipped' : 'restored'}`, s, { week }, principal);
    return view(s, await occupancy.seriesBookings(s.id, { transaction }));
  });
}

/** POST /me/series/:id/end (FR-23). */
async function end(principal, id, { reason = null }, req) {
  return sequelize.transaction(async (transaction) => {
    const s = await ownedSeries(principal, id, { transaction, lock: true });
    if (s.status !== 'active') throw fail('SERIES_STATE');
    const n = await occupancy.endSeries(s, { actor: principal, transaction });
    await s.update({ status: 'ended', endedAt: new Date(), endedBy: principal.id, endReason: reason, updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'booking_series.ended', actor: principal, entityType: 'booking_series', entityId: s.id, after: { status: 'ended', cancelled: n }, reason, req }, { transaction });
    await publish(transaction, 'booking_series.ended', s, { cancelled: n }, principal);
    return view(s, await occupancy.seriesBookings(s.id, { transaction }));
  });
}

module.exports = { preview, create, list, get, setWeek, end, view };
