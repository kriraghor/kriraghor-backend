'use strict';

/**
 * M10's side of the M17 review-sources port (source `booking`, subject `ground`; Q98): the member who
 * booked rates the venue once the booking was played (checked in or completed) and has ended, within
 * reviews.window_days of its end. The venue owner replies.
 */
const { Booking } = require('../../models');
const reads = require('./bookings.reads');

const PLAYED = ['checked_in', 'completed'];

async function source(bookingId, { transaction } = {}) {
  const b = await Booking.findByPk(bookingId, { transaction });
  if (!b) return null;
  return { ref: b.code, subjectId: b.groundId, ownerId: b.ownerId, payerId: b.bookerUserId ?? null, doneAt: PLAYED.includes(b.status) ? b.endAt : null };
}

async function reviewableBy(userId, since) {
  const rows = await reads.playedBy(userId, since);
  return rows.map((b) => ({ sourceId: b.bookingId, ref: b.code, subjectId: b.groundId, doneAt: b.end, extra: { bookingId: b.bookingId, code: b.code, groundId: b.groundId, end: b.end } }));
}

async function subject(groundId) {
  const f = await require('../grounds').grounds.facts(groundId);
  return f ? { name: f.name, slug: f.slug ?? null } : null;
}

function register() {
  require('../trust').reviewSources.register('booking', { subjectType: 'ground', codes: { notPayer: 'NOT_YOUR_BOOKING', notDone: 'NOT_PLAYED' }, source, reviewableBy, subject });
}

module.exports = { register, source, reviewableBy, subject };
