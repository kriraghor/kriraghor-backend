'use strict';

/**
 * What other modules read from M10 (they never query its tables):
 *   facts(bookingId)   code, ground and court names, times and money, for M08 messages
 */
const { Booking } = require('../../models');
const reads = require('../grounds/grounds.reads');
const rules = require('./bookings.rules');

async function facts(bookingId) {
  const b = await Booking.findByPk(bookingId);
  if (!b) return null;
  const g = await reads.ground(b.groundId);
  const groundName = await require('../grounds/grounds.service').facts(b.groundId).then((f) => f?.name ?? '');
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

module.exports = { facts };
