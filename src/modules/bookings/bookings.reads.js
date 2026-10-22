'use strict';

/**
 * What other modules read from M10 (they never query its tables):
 *   facts(bookingId)                  code, ground and court names, times and money, for M08 messages
 *   bookingFact(bookingId)            one booking as an M19 fact (v3 money; no names or phones)
 *   exportFacts({ since, until })     bookings changed in [since, until), for the M19 reconcile
 *   courtDays(courtIds, day)          open and booked half-hours per court on a Dhaka day (M19 occupancy)
 *   courtsOfBooking(bookingId)        the courts and Dhaka days a booking touches
 *   seriesBookingIds(seriesId)        the bookings of a series (they are created without booking events)
 *   pendingActions(principal, role)   M19 "Needs your action": check-ins due today, unrecorded balances, holds to pay
 *   reviewSource(bookingId)           M17 reviews: who booked which ground, its status and end
 *   playedBy(userId, since)           M17 "rate your games": the member's played bookings that ended after since
 *   reliabilityFacts(userId, since)   M18 owner and booker reliability (counts only)
 */
const { Op } = require('sequelize');
const { Booking } = require('../../models');
const reads = require('../grounds').reads;
const pr = require('../grounds').pricingRules;
const rules = require('./bookings.rules');

const PLAYED = ['checked_in', 'completed'];

async function facts(bookingId) {
  const b = await Booking.findByPk(bookingId);
  if (!b) return null;
  const g = await reads.ground(b.groundId);
  const groundName = await require('../grounds').grounds.facts(b.groundId).then((f) => f?.name ?? '');
  return {
    code: b.code,
    groundName,
    courts: (g?.courts ?? []).filter((k) => b.courtIds.includes(k.id)).map((k) => k.name).join(', '),
    start: b.startAt,
    end: b.endAt,
    paidOnline: b.onlinePoisha,
    dueAtVenue: rules.balanceDue({ total: b.totalPoisha, online: b.onlinePoisha }),
    refund: b.refundPoisha,
    retained: b.retainedPoisha,
    bookerUserId: b.bookerUserId,
    ownerId: b.ownerId,
  };
}

function factOf(b, areaId) {
  return {
    bookingId: b.id,
    sourceVersion: new Date(b.updatedAt).getTime(),
    code: b.code,
    ownerId: b.ownerId,
    groundId: b.groundId,
    courtIds: b.courtIds,
    areaId: areaId ?? null,
    source: b.source,
    status: b.status,
    bookerUserId: b.bookerUserId ?? null,
    seriesId: b.seriesId ?? null,
    startAt: b.startAt,
    endAt: b.endAt,
    halfHours: Math.round((b.endAt - b.startAt) / rules.HALF_HOUR),
    total: b.totalPoisha,
    online: b.onlinePoisha,
    refund: b.refundPoisha,
    retained: b.retainedPoisha,
    fee: b.feePoisha,
    venueCollected: b.balanceCollectedPoisha ?? 0,
    confirmedAt: b.confirmedAt ?? null,
    cancelledAt: b.cancelledAt ?? null,
  };
}

const areaOf = async (groundId, cache) => {
  if (!cache.has(groundId)) cache.set(groundId, (await reads.ground(groundId))?.areaId ?? null);
  return cache.get(groundId);
};

async function bookingFact(bookingId) {
  const b = await Booking.findByPk(bookingId);
  return b ? factOf(b, await areaOf(b.groundId, new Map())) : null;
}

async function exportFacts({ since, until }) {
  const rows = await Booking.findAll({ where: { updatedAt: { [Op.gte]: since, [Op.lt]: until } }, order: [['updatedAt', 'ASC']] });
  const cache = new Map();
  const out = [];
  for (const b of rows) out.push(factOf(b, await areaOf(b.groundId, cache)));
  return out;
}

/** The courts and Dhaka days a booking's time touches (occupancy rebuilds). */
async function courtsOfBooking(bookingId) {
  const b = await Booking.findByPk(bookingId, { attributes: ['courtIds', 'startAt', 'endAt'] });
  if (!b) return null;
  const days = new Set([pr.dhakaParts(b.startAt).date, pr.dhakaParts(new Date(b.endAt.getTime() - 1)).date]);
  return { courtIds: b.courtIds, days: [...days] };
}

const seriesBookingIds = async (seriesId) => (await Booking.findAll({ where: { seriesId }, attributes: ['id'] })).map((b) => b.id);

const courtDays = (courtIds, day) => require('./occupancy.impl').courtDays(courtIds, day);

/** M19 action provider: what the owner or member should do next (counts only). */
async function pendingActions(principal, role, now = new Date()) {
  if (role === 'ground_owner') {
    const soon = new Date(now.getTime() + 60 * 60 * 1000);
    const [checkIns, unrecorded, dueBalance] = await Promise.all([
      Booking.count({ where: { ownerId: principal.id, status: 'confirmed', startAt: { [Op.lte]: soon }, endAt: { [Op.gt]: now } } }),
      Booking.count({ where: { ownerId: principal.id, balanceStatus: 'unrecorded' } }),
      Booking.count({ where: { ownerId: principal.id, status: ['checked_in', 'completed'], balanceStatus: 'due' } }),
    ]);
    return [
      ...(checkIns ? [{ key: 'check_in_due', count: checkIns, severity: 'high', dueAt: now.toISOString(), href: '/vendor/bookings' }] : []),
      ...(unrecorded ? [{ key: 'balance_unrecorded', count: unrecorded, severity: 'high', dueAt: null, href: '/vendor/bookings' }] : []),
      ...(dueBalance ? [{ key: 'balance_due', count: dueBalance, severity: 'normal', dueAt: null, href: '/vendor/bookings' }] : []),
    ];
  }
  const holds = await Booking.findAll({ where: { bookerUserId: principal.id, status: 'pending_payment', holdExpiresAt: { [Op.gt]: now } }, order: [['holdExpiresAt', 'ASC']], attributes: ['id', 'holdExpiresAt'] });
  return holds.map((b) => ({ key: 'hold_to_pay', count: 1, severity: 'high', dueAt: b.holdExpiresAt.toISOString(), href: `/me/bookings/${b.id}` }));
}

/**
 * Round B3 staff to-do of one venue: check-ins due within the hour (bookings.check_in) and venue
 * balances to collect (bookings.collect_balance). Counts only; never money.
 */
async function staffActions(groundId, permissions, now = new Date()) {
  const items = [];
  const href = `/vendor/bookings?groundId=${groundId}`;
  if (permissions.includes('bookings.check_in')) {
    const soon = new Date(now.getTime() + 60 * 60 * 1000);
    const n = await Booking.count({ where: { groundId, status: 'confirmed', startAt: { [Op.lte]: soon }, endAt: { [Op.gt]: now } } });
    if (n) items.push({ key: 'check_in_due', count: n, severity: 'high', dueAt: now.toISOString(), href });
  }
  if (permissions.includes('bookings.collect_balance')) {
    const n = await Booking.count({ where: { groundId, status: ['checked_in', 'completed'], balanceStatus: 'due' } });
    if (n) items.push({ key: 'balance_due', count: n, severity: 'normal', dueAt: null, href });
  }
  return items;
}

const reviewView = (b) => ({ bookingId: b.id, code: b.code, groundId: b.groundId, ownerId: b.ownerId, bookerUserId: b.bookerUserId ?? null, status: b.status, start: b.startAt, end: b.endAt });

async function reviewSource(bookingId) {
  const b = await Booking.findByPk(bookingId);
  return b ? reviewView(b) : null;
}

async function playedBy(userId, since, now = new Date()) {
  const rows = await Booking.findAll({ where: { bookerUserId: userId, status: PLAYED, endAt: { [Op.gt]: since, [Op.lte]: now } }, order: [['endAt', 'DESC']], limit: 50 });
  return rows.map(reviewView);
}
// Owner cancels that are not the owner's fault (M10 FR-19, Q22): the same list as the booking service.
const PENALTY_FREE = ['weather', 'waterlogged', 'closure'];

/**
 * M18 reliability over bookings confirmed since `since`:
 *   owner   sample: app bookings confirmed at the owner's grounds; cancels: owner cancels that were penalised
 *   booker  sample: the member's confirmed bookings; noShows: no-shows not fully refunded by a dispute;
 *           lateCancels: member cancels within `lateHours` of the start
 */
async function reliabilityFacts(userId, since, { lateHours }) {
  const asOwner = await Booking.findAll({ where: { ownerId: userId, source: 'app', confirmedAt: { [Op.gte]: since } }, attributes: ['status', 'cancelReason'] });
  const asBooker = await Booking.findAll({ where: { bookerUserId: userId, confirmedAt: { [Op.gte]: since } }, attributes: ['status', 'startAt', 'cancelledAt', 'onlinePoisha', 'refundPoisha'] });
  const overturned = (b) => b.onlinePoisha > 0 && b.refundPoisha >= b.onlinePoisha;
  return {
    owner: { sample: asOwner.length, cancels: asOwner.filter((b) => b.status === 'cancelled_by_owner' && !PENALTY_FREE.includes(b.cancelReason)).length },
    booker: {
      sample: asBooker.length,
      noShows: asBooker.filter((b) => b.status === 'no_show' && !overturned(b)).length,
      lateCancels: asBooker.filter((b) => b.status === 'cancelled' && b.cancelledAt && b.startAt - b.cancelledAt < lateHours * 3600000).length,
    },
  };
}

module.exports = { reliabilityFacts, reviewSource, playedBy, pendingActions, staffActions, facts, bookingFact, exportFacts, courtsOfBooking, seriesBookingIds, courtDays };
