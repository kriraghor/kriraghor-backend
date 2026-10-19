'use strict';

/**
 * M20 public reads on kriraghor.com/gym (no sign-in): live gyms by area and facility, sorted by the
 * day pass price, rating or newest; a gym page (photos, address, weekly hours with women-only
 * windows, facilities, packages, open now); the fitness trainers (M11 profiles in role
 * fitness_trainer) with their active monthly plans. Only the public version (live_snapshot) is read.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const storage = require('../../common/storage');
const { Gym, TrainerPlan } = require('../../models');
const { Area, Facility } = require('../catalog').reference;
const hireDirectory = require('../hire').directory;
const rules = require('./gym.rules');
const c = require('./gym.common');

const named = (r) => ({ id: r.id, key: r.key, nameEn: r.nameEn, nameBn: r.nameBn });

async function lookups(gyms) {
  const [areas, facilities] = await Promise.all([
    Area.findAll({ where: { id: [...new Set(gyms.map((g) => g.liveSnapshot.areaId))] } }),
    Facility.findAll({ where: { id: [...new Set(gyms.flatMap((g) => g.liveSnapshot.facilityIds ?? []))] }, order: [['sort', 'ASC']] }),
  ]);
  return { areas: new Map(areas.map((a) => [a.id, named(a)])), facilities: new Map(facilities.map((f) => [f.id, { ...named(f), icon: f.icon ?? null }])) };
}

function card(g, { areas, facilities }, now = new Date()) {
  const s = g.liveSnapshot;
  const price = (k) => s.packages.find((p) => p.kind === k)?.price ?? null;
  return {
    id: g.id,
    slug: g.slug,
    name: s.name,
    area: areas.get(s.areaId) ?? null,
    cover: s.photos[0] ? storage.publicUrl(s.photos[0].key) : null,
    facilities: (s.facilityIds ?? []).map((id) => facilities.get(id)).filter(Boolean),
    dayPrice: price('day'),
    monthPrice: price('month'),
    quarterPrice: price('quarter'),
    womenOnlyHours: s.hours.some((h) => h.womenOnly),
    openNow: Boolean(rules.openWindowAt(s.hours, now)),
    ratingAvg: g.ratingAvg ?? null,
    ratingCount: g.ratingCount,
    taking: g.status === 'live',
  };
}

const SORTS = { price: [['publicDayPricePoisha', 'ASC']], rating: [['ratingAvg', 'DESC NULLS LAST'], ['ratingCount', 'DESC']], newest: [['firstLiveAt', 'DESC']] };

/** GET /gym/gyms?areaId&facility&q&sort&cursor&limit. */
async function list({ areaId, facility, q, sort = 'price', cursor, limit = 24 } = {}) {
  const where = {
    status: 'live',
    ...(areaId ? { publicAreaId: areaId } : {}),
    ...(q ? { publicName: { [Op.iLike]: `%${q}%` } } : {}),
  };
  const rows = await Gym.findAll({ where, order: [...SORTS[sort], ['id', 'ASC']] });
  const filtered = facility ? rows.filter((g) => (g.liveSnapshot.facilityIds ?? []).includes(facility)) : rows;
  const offset = cursor ? Number(cursor) : 0;
  const page = filtered.slice(offset, offset + limit);
  const maps = await lookups(page);
  return { items: page.map((g) => card(g, maps)), total: filtered.length, nextCursor: offset + limit < filtered.length ? String(offset + limit) : null };
}

/** GET /gym/gyms/:slug: the gym page (live or paused gyms; a paused gym sells nothing). */
async function detail(slug) {
  const g = await Gym.findOne({ where: { slug } });
  if (!g || !g.liveSnapshot || !['live', 'paused'].includes(g.status)) throw E.notFound('Gym');
  const s = g.liveSnapshot;
  const maps = await lookups([g]);
  const cfg = c.config();
  return {
    ...card(g, maps),
    addressLine: s.addressLine,
    lat: s.lat ?? null,
    lng: s.lng ?? null,
    about: s.about ?? null,
    photos: s.photos.map(c.photoView),
    hours: s.hours,
    packages: s.packages,
    advanceDays: cfg.advanceDays,
    today: c.today(),
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
