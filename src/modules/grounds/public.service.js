'use strict';

/**
 * M09 read side (§5.6, FR-25, FR-27): only `live` grounds, always from their public version
 * (live_snapshot), never the owner's unreviewed working copy. A ground whose owner role is suspended
 * is paused by the consumer, so `live` already means the owner is active.
 *
 *   GET /grounds         filters (sport, area, near + radius, price band, surface, facilities, indoor),
 *                        facet counts (each facet counted with the other filters), sorts cheapest,
 *                        nearest, newest and most open hours today (FR-26, through the M10 port); cursor = offset
 *   GET /grounds/:slug   facts, courts with hours, facilities, rules, price table, v3 payment line
 *   POST /grounds/:id/quote  the public price of a slot (M10 uses the same calculator)
 */
const { E } = require('../../common/errors');
const storage = require('../../common/storage');
const { Ground, CourtHours, PricingRule, Sport, Surface, Facility } = require('../../models');
const directory = require('../users/directory.service');
const pr = require('./pricing.rules');
const rules = require('./grounds.rules');
const occupancy = require('./occupancy.port');
const c = require('./grounds.common');
const pricing = require('./pricing.service');

/** M17: the average shows once the ground has reviews.min_count_display published reviews. */
const shownRating = (g) => (g.ratingCount >= require('../settings/settings.service').get('reviews.min_count_display') ? (g.ratingAvg ?? null) : null);

/** Lowest and highest hourly rate in the coming week across the public courts. */
function priceBand(r, courtIds) {
  let lo = Infinity;
  let hi = 0;
  const fromDate = pr.dhakaParts(new Date()).date;
  for (const courtId of courtIds.length ? courtIds : [null]) {
    for (const row of pr.heatmap(r, { fromDate, courtId })) {
      for (const cell of row.cells) {
        lo = Math.min(lo, cell.rate);
        hi = Math.max(hi, cell.rate);
      }
    }
  }
  return { from: lo, to: hi };
}

/** Every live ground with its public version and published pricing (small enough for step 1). */
async function liveGrounds() {
  const grounds = await Ground.findAll({ where: { status: 'live' } });
  const prices = grounds.length ? await PricingRule.findAll({ where: { groundId: grounds.map((g) => g.id), status: 'published' } }) : [];
  return grounds
    .map((g) => ({ g, s: g.liveSnapshot, price: prices.find((p) => p.groundId === g.id) }))
    .filter((x) => x.s && x.price)
    .map((x) => ({ ...x, rules: c.rulesOf(x.price), band: priceBand(c.rulesOf(x.price), x.s.courts.map((k) => k.id)) }));
}

const keysOf = async (Model, keys) => (keys?.length ? (await Model.findAll({ where: { key: keys } })).map((r) => r.id) : null);

/** GET /grounds */
async function list(q) {
  const [sportIds, surfaceIds, facilityIds] = await Promise.all([keysOf(Sport, q.sport ? [q.sport] : null), keysOf(Surface, q.surface), keysOf(Facility, q.facilities)]);
  const near = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : null;
  const all = (await liveGrounds()).map((x) => ({ ...x, distanceM: near ? rules.distanceM(near, x.s) : null }));

  const tests = {
    sport: (x) => !sportIds || x.s.courts.some((k) => k.sportIds.some((id) => sportIds.includes(id))),
    area: (x) => !q.areaId || x.s.areaId === q.areaId,
    radius: (x) => !near || !q.radiusKm || x.distanceM <= q.radiusKm * 1000,
    price: (x) => (q.priceMin === undefined || x.band.from >= q.priceMin) && (q.priceMax === undefined || x.band.from <= q.priceMax),
    surface: (x) => !surfaceIds || x.s.courts.some((k) => surfaceIds.includes(k.surfaceId)),
    facilities: (x) => !facilityIds || facilityIds.every((id) => x.s.facilityIds.includes(id)),
    indoor: (x) => q.indoor === undefined || x.s.isIndoor === q.indoor,
  };
  const pass = (x, except) => Object.entries(tests).every(([k, t]) => k === except || t(x));
  const matched = all.filter((x) => pass(x));

  // Facets: each one counted with every other filter applied (FR-25).
  const count = (except, ids) => {
    const m = new Map();
    for (const x of all.filter((y) => pass(y, except))) for (const id of new Set(ids(x))) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  };
  const sportCounts = count('sport', (x) => x.s.courts.flatMap((k) => k.sportIds));
  const surfaceCounts = count('surface', (x) => x.s.courts.map((k) => k.surfaceId));
  const facilityCounts = count('facilities', (x) => x.s.facilityIds);
  const indoorCounts = count('indoor', (x) => [String(x.s.isIndoor)]);

  // FR-26: free half-hours left today on every public court (M10 slots), as hours.
  const today = pr.dhakaParts(new Date()).date;
  const openHours = async (x) => {
    if (x.openHours === undefined) {
      const per = await occupancy.openHalfHours(x.s.courts.map((k) => k.id), today);
      x.openHours = Object.values(per).reduce((n, v) => n + v, 0) / 2;
    }
    return x.openHours;
  };
  const sort = q.sort ?? (near ? 'nearest' : 'cheapest');
  if (sort === 'most_open') for (const x of matched) await openHours(x);
  const order = {
    most_open: (a, b) => b.openHours - a.openHours || a.band.from - b.band.from,
    cheapest: (a, b) => a.band.from - b.band.from || a.g.name.localeCompare(b.g.name),
    nearest: (a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity) || a.band.from - b.band.from,
    newest: (a, b) => new Date(b.g.firstLiveAt) - new Date(a.g.firstLiveAt),
  }[sort];
  matched.sort(order);
  const offset = Number(q.cursor ?? 0);
  const page = matched.slice(offset, offset + q.limit);
  for (const x of page) await openHours(x);

  const names = await c.catalogueNames({
    areaIds: page.map((x) => x.s.areaId),
    sportIds: [...page.flatMap((x) => x.s.courts.flatMap((k) => k.sportIds)), ...sportCounts.keys()],
    surfaceIds: [...page.flatMap((x) => x.s.courts.map((k) => k.surfaceId)), ...surfaceCounts.keys()],
    facilityIds: [...facilityCounts.keys()],
  });
  const facet = (counts, map) => [...counts.entries()].map(([id, n]) => ({ ...map.get(id), count: n })).filter((f) => f.key);
  return {
    items: page.map((x) => card(x, names)),
    total: matched.length,
    nextCursor: offset + q.limit < matched.length ? String(offset + q.limit) : null,
    facets: {
      sports: facet(sportCounts, names.sports),
      surfaces: facet(surfaceCounts, names.surfaces),
      facilities: facet(facilityCounts, names.facilities),
      indoor: { indoor: indoorCounts.get('true') ?? 0, outdoor: indoorCounts.get('false') ?? 0 },
    },
    sort,
  };
}

function card({ g, s, band, distanceM, openHours }, names) {
  const sports = [...new Set(s.courts.flatMap((k) => k.sportIds))].map((id) => names.sports.get(id)).filter(Boolean);
  const surfaces = [...new Set(s.courts.map((k) => k.surfaceId))].map((id) => names.surfaces.get(id)).filter(Boolean);
  return {
    id: g.id,
    slug: g.slug,
    name: s.name,
    area: names.areas.get(s.areaId) ?? null,
    coverUrl: s.photos[0] ? storage.publicUrl(s.photos[0].key) : null,
    sports,
    surfaces,
    isIndoor: s.isIndoor,
    courtsCount: s.courts.length,
    priceFromPoisha: band.from,
    distanceM,
    openHoursToday: openHours ?? null,
    ratingAvg: shownRating(g),
    ratingCount: g.ratingCount,
  };
}

/** GET /grounds/:slug (a live ground only; a paused one is hidden). */
async function detail(slug) {
  const g = await Ground.findOne({ where: { slug, status: 'live' } });
  if (!g?.liveSnapshot) throw E.notFound('Ground');
  const s = g.liveSnapshot;
  const { published } = await c.pricingOf(g.id);
  if (!published) throw E.notFound('Ground');
  const r = c.rulesOf(published);
  const courtIds = s.courts.map((k) => k.id);
  const hours = courtIds.length ? await CourtHours.findAll({ where: { courtId: courtIds }, order: [['dow', 'ASC']] }) : [];
  const names = await c.catalogueNames({ areaIds: [s.areaId], sportIds: s.courts.flatMap((k) => k.sportIds), surfaceIds: s.courts.map((k) => k.surfaceId), facilityIds: s.facilityIds });
  const owner = (await directory.publicNames([g.ownerId])).get(g.ownerId);
  const band = priceBand(r, courtIds);
  const policy = pricing.policy();
  const fromDate = pr.dhakaParts(new Date()).date;
  return {
    id: g.id,
    slug: g.slug,
    name: s.name,
    area: names.areas.get(s.areaId) ?? null,
    addressLine: s.addressLine,
    lat: s.lat,
    lng: s.lng,
    isIndoor: s.isIndoor,
    description: s.description,
    rulesText: s.rulesText,
    bookingCutoffMin: s.bookingCutoffMin,
    requiresOfficial: s.requiresOfficial,
    facilities: s.facilityIds.map((id) => names.facilities.get(id)).filter(Boolean),
    photos: s.photos.map((p) => ({ id: p.id, url: storage.publicUrl(p.key) })),
    courts: s.courts.map((k) => ({
      id: k.id,
      name: k.name,
      sports: k.sportIds.map((id) => names.sports.get(id)).filter(Boolean),
      surface: names.surfaces.get(k.surfaceId) ?? null,
      sizeText: k.sizeText,
      capacityText: k.capacityText,
      combinableGroup: k.combinableGroup,
      hours: c.hoursOf(hours, k.id),
    })),
    pricing: {
      version: published.version,
      basePricePoisha: r.basePricePoisha,
      fromPoisha: band.from,
      toPoisha: band.to,
      minBookingMin: r.minBookingMin,
      advancePct: r.advancePct,
      peakFromHour: r.peakFromHour,
      peakPct: r.peakPct,
      weekendPct: r.weekendPct,
      earlyToHour: r.earlyToHour,
      earlyPct: r.earlyPct,
      week: pr.heatmap(r, { fromDate }),
    },
    // v3: pay the advance or in full online; the advance is not refunded if the member cancels.
    payment: {
      allowFullPayment: policy.allowFullPayment,
      advanceRefundable: policy.advanceRefundable,
      refundAboveAdvanceOnCancel: policy.refundAboveAdvanceOnCancel,
      fullRefundHours: policy.advanceRefundable ? r.fullRefundHours : null,
      halfRefundHours: policy.advanceRefundable ? r.halfRefundHours : null,
    },
    owner: { displayName: owner?.displayName ?? null },
    ratingAvg: shownRating(g),
    ratingCount: g.ratingCount,
    bookingOpen: g.status === 'live', // M10: live grounds take bookings
    version: g.liveVersion,
  };
}

/** POST /grounds/:id/quote: the public price of a slot on public courts (FR-13, M10 shares it). */
async function quote(groundId, { courtIds, start, minutes }) {
  const g = await Ground.findOne({ where: { id: groundId, status: 'live' } });
  if (!g?.liveSnapshot) throw E.notFound('Ground');
  const publicCourts = new Set(g.liveSnapshot.courts.map((k) => k.id));
  if (!courtIds.every((id) => publicCourts.has(id))) throw c.fail('COURT_UNKNOWN');
  const { rules: r, version } = await pricing.rulesFor(g.id, { useDraft: false });
  return { ...(await pricing.priceSlot(g.id, { courtIds, start, minutes, rules: r })), rulesVersion: version };
}

module.exports = { list, detail, quote, priceBand };
