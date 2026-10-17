'use strict';

/**
 * Test fixtures for M10 (the e2e suite and postman/run-m10.js): an owner with an active ground_owner
 * role and a live ground with its public version, courts open around the clock and a published price
 * of ৳2,000/h with no multipliers and a 25% advance, so the CLAUDE.md worked example holds at any
 * hour. The M09 suite covers the real listing flow (documents, review); these skip it.
 */
const h = require('../helpers');

const { models } = h;
let seq = 0;

async function refresh(who) {
  const r = await h.refreshWeb(who.cookie).expect(200);
  who.accessToken = r.body.accessToken;
  who.cookie = r.headers['set-cookie'] ?? who.cookie; // refresh tokens rotate
  return who;
}

/** A member with an active ground_owner role. */
async function owner(name = 'Kamal Hossain') {
  const m = await h.signupUser({ name });
  await h.verifyMember(m.user.id);
  await models.UserRole.create({ userId: m.user.id, role: 'ground_owner', status: 'active', activatedAt: new Date() });
  await models.User.increment('authzVersion', { where: { id: m.user.id } });
  return refresh(m);
}

/** A live ground with `courts` courts, open 00:00–24:00 every day, ৳2,000/h flat (`base`), 25% advance. */
async function liveGround(o, { courts = 1, name = `Arena ${(seq += 1)}`, base = 200000, combinable = false } = {}) {
  const area = await models.Area.findOne({ where: { key: 'dhanmondi' } });
  const sport = await models.Sport.findOne({ where: { key: 'football' } });
  const surface = await models.Surface.findOne({ where: { key: 'artificial_turf' } });
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(seq += 1)}`;
  const g = await models.Ground.create({ ownerId: o.user.id, name, slug, areaId: area.id, addressLine: 'Road 8A, Dhanmondi', lat: 23.7465, lng: 90.376, status: 'draft' });
  const rows = [];
  for (let i = 0; i < courts; i += 1) {
    const k = await models.Court.create({ groundId: g.id, name: `Court ${i + 1}`, sportIds: [sport.id], surfaceId: surface.id, status: 'active', sort: i, combinableGroup: combinable ? 'main' : null });
    for (let dow = 0; dow < 7; dow += 1) await models.CourtHours.create({ courtId: k.id, dow, isClosed: false, openTime: '00:00', closeTime: '24:00' });
    rows.push(k);
  }
  await g.update({
    status: 'live',
    liveVersion: 1,
    firstLiveAt: new Date(),
    liveSnapshot: {
      version: 1,
      name,
      areaId: area.id,
      addressLine: g.addressLine,
      lat: g.lat,
      lng: g.lng,
      isIndoor: false,
      facilityIds: [],
      bookingCutoffMin: 0,
      requiresOfficial: [],
      photos: [],
      courts: rows.map((k) => ({ id: k.id, name: k.name, sportIds: k.sportIds, surfaceId: k.surfaceId, combinableGroup: k.combinableGroup, sort: k.sort })),
    },
  });
  await models.PricingRule.create({
    groundId: g.id,
    version: 1,
    status: 'published',
    basePricePoisha: base,
    courtBaseOverrides: {},
    peakFromHour: 17,
    peakPct: 0,
    weekendPct: 0,
    earlyToHour: 8,
    earlyPct: 0,
    advancePct: 25,
    seriesDiscountPct: 10,
    minBookingMin: 60,
    fullRefundHours: 24,
    halfRefundHours: 6,
    checkinGraceMin: 15,
    effectiveFrom: new Date(Date.now() - 86400000),
  });
  return { id: g.id, slug, courts: rows.map((k) => k.id) };
}

const HALF = 30 * 60 * 1000;

/** Move a booking (and its active slots) so it starts at `start` (floored to the half-hour). */
async function moveTo(b, start) {
  const s = new Date(Math.floor(new Date(start).getTime() / HALF) * HALF);
  const e = new Date(s.getTime() + (b.endAt - b.startAt));
  await models.sequelize.query('UPDATE bookings SET start_at = :s, end_at = :e WHERE id = :id', { replacements: { s, e, id: b.id } });
  await models.sequelize.query("UPDATE booking_slots SET period = tstzrange(:s, :e, '[)') WHERE booking_id = :id AND status = 'active'", { replacements: { s, e, id: b.id } });
  return b.reload();
}

module.exports = { owner, liveGround, moveTo, refresh, HALF };
