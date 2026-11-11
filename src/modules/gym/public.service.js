'use strict';

/**
 * M20 public reads for the gym app on gym.kriraghor.com (no sign-in; M24-FR-103): live gyms by area and facility, sorted by the
 * monthly price, rating or newest; a gym page (photos, address, weekly hours with women-only
 * windows, facilities, packages, open now); the fitness trainers (M11 profiles in role
 * fitness_trainer) with their active monthly plans. Only the public version (live_snapshot) is read.
 * M24 prompt 3: the directory sorts by distance from a position sent with the query, filters by a radius
 * and a monthly price cap, and the gym page says whether it takes join requests (gym-manage facade).
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const storage = require('../../common/storage');
const { Gym, TrainerPlan } = require('../../models');
const { Area, Facility } = require('../catalog').reference;
const hireDirectory = require('../hire').directory;
const rules = require('./gym.rules');
const c = require('./gym.common');
const specialDays = require('./special-days.service');

/** M17: the average shows once there are reviews.min_count_display published reviews (FR-35). */
const shownRating = (x) => (x.ratingCount >= require('../settings').settings.get('reviews.min_count_display') ? (x.ratingAvg ?? null) : null);
const named = (r) => ({ id: r.id, key: r.key, nameEn: r.nameEn, nameBn: r.nameBn });

async function lookups(gyms) {
  const [areas, facilities] = await Promise.all([
    Area.findAll({ where: { id: [...new Set(gyms.map((g) => g.liveSnapshot.areaId))] } }),
    Facility.findAll({ where: { id: [...new Set(gyms.flatMap((g) => g.liveSnapshot.facilityIds ?? []))] }, order: [['sort', 'ASC']] }),
  ]);
  return { areas: new Map(areas.map((a) => [a.id, named(a)])), facilities: new Map(facilities.map((f) => [f.id, { ...named(f), icon: f.icon ?? null }])) };
}

/** `special`: the gym's special days covering today (M20-FR-19), so a holiday shows as closed. */
function card(g, { areas, facilities }, now = new Date(), distanceM = null, special = []) {
  const s = g.liveSnapshot;
  const todays = rules.specialOn(special, rules.dhakaDate(now));
  const price = (k) => s.packages.find((p) => p.kind === k)?.price ?? null;
  return {
    id: g.id,
    slug: g.slug,
    name: s.name,
    area: areas.get(s.areaId) ?? null,
    cover: s.photos[0] ? storage.publicUrl(s.photos[0].key) : null,
    facilities: (s.facilityIds ?? []).map((id) => facilities.get(id)).filter(Boolean),
    monthPrice: price('month'),
    quarterPrice: price('quarter'),
    womenOnlyHours: s.hours.some((h) => h.womenOnly),
    openNow: Boolean(rules.openWindowAt(s.hours, now, special)),
    specialToday: todays ? { kind: todays.kind, title: todays.title } : null,
    ratingAvg: shownRating(g),
    ratingCount: g.ratingCount,
    taking: g.status === 'live',
    distanceM,
  };
}

const SORTS = { price: [['publicMonthPricePoisha', 'ASC NULLS LAST']], rating: [['ratingAvg', 'DESC NULLS LAST'], ['ratingCount', 'DESC']], newest: [['firstLiveAt', 'DESC']] };

const monthPriceOf = (g) => g.liveSnapshot.packages.find((p) => p.kind === 'month')?.price ?? null;

/**
 * GET /gym/gyms?areaId&facility&q&priceMax&lat&lng&radiusKm&sort&cursor&limit (M24 prompt 3, §4.1).
 * With a position each card carries distanceM (the gym's pin, else its area's centre: a gym with
 * neither is last in the nearest sort and outside every radius); the default sort is then nearest, as
 * on the venues page. priceMax caps the monthly package. The position is used for this answer only.
 */
async function list({ areaId, facility, q, priceMax, lat, lng, radiusKm, sort, cursor, limit = 24 } = {}) {
  const near = lat !== undefined && lng !== undefined ? { lat, lng } : null;
  const order = sort ?? (near ? 'nearest' : 'price');
  const where = {
    status: 'live',
    ...(areaId ? { publicAreaId: areaId } : {}),
    ...(q ? { publicName: { [Op.iLike]: `%${q}%` } } : {}),
  };
  const rows = await Gym.findAll({ where, order: [...(SORTS[order] ?? SORTS.price), ['id', 'ASC']] });
  let filtered = rows.filter((g) => (!facility || (g.liveSnapshot.facilityIds ?? []).includes(facility)) && (priceMax === undefined || (monthPriceOf(g) !== null && monthPriceOf(g) <= priceMax)));
  const distance = new Map();
  if (near) {
    const centres = new Map((await Area.findAll({ where: { id: [...new Set(filtered.map((g) => g.liveSnapshot.areaId))] }, attributes: ['id', 'lat', 'lng'] })).map((a) => [a.id, a]));
    for (const g of filtered) {
      const at = rules.gymPoint({ lat: g.liveSnapshot.lat, lng: g.liveSnapshot.lng }, centres.get(g.liveSnapshot.areaId));
      distance.set(g.id, at ? rules.distanceM(near, at) : null);
    }
    if (radiusKm) filtered = filtered.filter((g) => distance.get(g.id) !== null && distance.get(g.id) <= radiusKm * 1000);
  }
  // The rating sort uses the shown rating, so a gym below reviews.min_count_display doesn't rank by a hidden average (M17-FR-35).
  if (order === 'rating') filtered.sort((a, b) => (shownRating(b) ?? -1) - (shownRating(a) ?? -1) || b.ratingCount - a.ratingCount || (a.id < b.id ? -1 : 1));
  if (order === 'nearest') filtered.sort((a, b) => (distance.get(a.id) ?? Infinity) - (distance.get(b.id) ?? Infinity) || (a.id < b.id ? -1 : 1));
  const offset = cursor ? Number(cursor) : 0;
  const page = filtered.slice(offset, offset + limit);
  const maps = await lookups(page);
  const now = new Date();
  const special = await specialDays.onDateFor(page.map((g) => g.id), rules.dhakaDate(now));
  return { items: page.map((g) => card(g, maps, now, distance.get(g.id) ?? null, special.get(g.id) ?? [])), total: filtered.length, nextCursor: offset + limit < filtered.length ? String(offset + limit) : null };
}

/** GET /gym/gyms/:slug: the gym page (live or paused gyms; a paused gym sells nothing). */
async function detail(slug) {
  const g = await Gym.findOne({ where: { slug } });
  if (!g || !g.liveSnapshot || !['live', 'paused'].includes(g.status)) throw E.notFound('Gym');
  const s = g.liveSnapshot;
  const maps = await lookups([g]);
  const cfg = c.config();
  const now = new Date();
  const special = await specialDays.publicFor(g.id, rules.dhakaDate(now));
  return {
    ...card(g, maps, now, null, special),
    addressLine: s.addressLine,
    lat: s.lat ?? null,
    lng: s.lng ?? null,
    about: s.about ?? null,
    photos: s.photos.map(c.photoView),
    hours: s.hours,
    specialDays: special,
    packages: s.packages,
    advanceDays: cfg.advanceDays,
    today: c.today(),
    // M24-FR-16: whether "Join this gym" shows (gym-manage decides: live, managed, switched on).
    joinRequestsOpen: await require('../gym-manage').joins.openFor(g.id),
  };
}

/** GET /gym/trainers?areaId&sort: fitness trainers (M11 directory) with their active monthly plans. */
async function trainers({ areaId, sort = 'rating', cursor } = {}, viewer = null) {
  const page = await hireDirectory.list({ role: 'fitness_trainer', areaId, sort, cursor, limit: 24 }, viewer);
  const plans = await TrainerPlan.findAll({ where: { profileId: page.items.map((i) => i.id), status: 'active' }, order: [['pricePoisha', 'ASC']] });
  return {
    items: page.items.map((t) => {
      const mine = plans.filter((p) => p.profileId === t.id);
      return { ...t, planFrom: mine.length ? mine[0].pricePoisha : null, plans: mine.length };
    }),
    nextCursor: page.nextCursor ?? null,
  };
}

module.exports = { list, detail, trainers };
