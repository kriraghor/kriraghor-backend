'use strict';

/**
 * M11 directory on kriraghor.com/hiring (FR-01 to FR-07): live profiles of active people by category,
 * role, experience, unit, sport, area and search, sorted by rating, rate (the normalised hourly rate,
 * FR-03), jobs done or experience; the profile page with rates, the verified credential level and a
 * 14-day busy strip (times only: jobs and the pro's blocked time, Round B1); a non-binding quote; the
 * member's shortlist. Reads the public version (live_snapshot) only. Round B1: cards carry the photo,
 * the reply stats (FR-52) and "available today" (FR-05, derived from blocks and jobs, never stored).
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { HireProfile, HireShortlist } = require('../../models');
const { Area } = require('../catalog').reference;
const directory = require('../users').directory;
const authz = require('../auth').authz;
const kyc = require('../kyc').kyc;
const taxonomy = require('../catalog').hireReads;
const profiles = require('./profiles.service');
const availability = require('./availability.service');
const rules = require('./hire.rules');
const video = require('./video.rules');
const c = require('./hire.common');

const { fail } = c;
const DAY = 86400000;
/** M17: the average shows once there are reviews.min_count_display published reviews (FR-35). */
const shownRating = (x) => (x.ratingCount >= require('../settings').settings.get('reviews.min_count_display') ? (x.ratingAvg ?? null) : null);

/** GET /hire/taxonomy: categories with their roles (M03), for the directory and the pro desk. */
const categories = () => taxonomy.taxonomy();

async function areaMap(ids) {
  const rows = await Area.findAll({ where: { id: [...new Set(ids.filter(Boolean))] } });
  return new Map(rows.map((a) => [a.id, { id: a.id, key: a.key, nameEn: a.nameEn, nameBn: a.nameBn, isDhakaMetro: a.isDhakaMetro, dhakaZone: a.dhakaZone ?? null }]));
}

async function cards(rows, { unit = null, viewer = null } = {}) {
  const [names, areas, saved, freeToday] = await Promise.all([
    directory.publicNames(rows.map((p) => p.userId)),
    areaMap(rows.map((p) => p.liveSnapshot.baseAreaId)),
    viewer ? HireShortlist.findAll({ where: { userId: viewer, profileId: rows.map((p) => p.id), removedAt: null }, attributes: ['profileId'] }) : [],
    availability.availableToday(rows.map((p) => p.userId)),
  ]);
  const savedIds = new Set(saved.map((s) => s.profileId));
  const out = [];
  for (const p of rows) {
    const [role, card] = await Promise.all([taxonomy.role(p.roleId), profiles.currentCard(p.id)]);
    const items = (card?.items ?? []).map((i) => ({ unit: i.unit, format: i.format ?? null, rate: i.ratePoisha }));
    const shown = unit ? items.filter((i) => i.unit === unit) : items;
    const s = p.liveSnapshot;
    out.push({
      id: p.id,
      slug: p.slug,
      name: names.get(p.userId)?.displayName ?? '',
      avatarUrl: names.get(p.userId)?.avatarUrl ?? null,
      headline: s.headline,
      specialisation: s.specialisation,
      experienceLevel: s.experienceLevel,
      years: s.years,
      role: { key: role.key, nameEn: role.nameEn, nameBn: role.nameBn, categoryKey: role.categoryKey },
      area: areas.get(s.baseAreaId) ?? null,
      rateFrom: shown.length ? Math.min(...shown.map((i) => i.rate)) : null,
      rateUnit: shown[0]?.unit ?? null,
      units: [...new Set(items.map((i) => i.unit))],
      ratingAvg: shownRating(p),
      ratingCount: p.ratingCount,
      jobsDone: p.jobsDone,
      acceptanceRate: p.acceptanceRate ?? null,
      medianReplyMinutes: p.medianReplyMinutes ?? null,
      availableToday: p.status === 'live' && Boolean(freeToday.get(p.userId)),
      // M11-FR-16: a play badge on the card; the page carries the video itself.
      hasIntroVideo: Boolean(video.introVideoView(s.introVideoUrl, c.config().introVideoProviders)),
      shortlisted: savedIds.has(p.id),
    });
  }
  return out;
}

const SORTS = {
  rating: (a, b) => (b.ratingAvg ?? -1) - (a.ratingAvg ?? -1) || b.jobsDone - a.jobsDone,
  rate: (a, b) => (a.norm ?? Infinity) - (b.norm ?? Infinity),
  jobs: (a, b) => b.jobsDone - a.jobsDone,
  experience: (a, b) => rules.levelRank(b.experienceLevel) - rules.levelRank(a.experienceLevel) || b.years - a.years,
};

/** GET /hire/profiles?category&role&exp&unit&sport&areaId&q&sort&cursor&limit. */
async function list({ category, role, exp, unit, sport, areaId, q, sort = 'rating', cursor, limit = 20 } = {}, viewer = null) {
  const tax = await taxonomy.taxonomy();
  const roles = tax.flatMap((cat) => cat.roles).filter((r) => (!category || r.categoryKey === category) && (!role || r.key === role) && (!unit || r.allowedUnits.includes(unit)) && (!sport || r.sportKeys.includes(sport) || !r.sportKeys.length));
  const where = {
    status: 'live',
    roleId: roles.map((r) => r.id),
    ...(exp?.length ? { publicExperienceLevel: exp } : {}),
    ...(areaId ? { publicAreaId: areaId } : {}),
    ...(q ? { publicHeadline: { [Op.iLike]: `%${q}%` } } : {}),
  };
  const rows = await HireProfile.findAll({ where });
  const members = await Promise.all(rows.map((p) => authz.loadPrincipal(p.userId)));
  const listed = rows.filter((p, i) => members[i]?.roles?.member === 'active' && members[i]?.user?.status !== 'suspended');
  const sorted = listed
    .map((p) => ({ p, norm: p.normalisedHourlyPoisha, ratingAvg: shownRating(p), jobsDone: p.jobsDone, experienceLevel: p.liveSnapshot.experienceLevel, years: p.liveSnapshot.years }))
    .sort(SORTS[sort] ?? SORTS.rating)
    .map((x) => x.p);
  const offset = cursor ? Number(cursor) : 0;
  const page = sorted.slice(offset, offset + limit);
  const counts = Object.fromEntries(tax.map((cat) => [cat.key, listed.filter((p) => cat.roles.some((r) => r.id === p.roleId)).length]));
  return { items: await cards(page, { unit, viewer }), total: sorted.length, counts, nextCursor: offset + limit < sorted.length ? String(offset + limit) : null };
}

/** GET /hire/profiles/:slug: the profile page. */
async function page(slug, viewer = null) {
  const p = await HireProfile.findOne({ where: { slug } });
  if (!p || !p.liveSnapshot || !['live', 'paused'].includes(p.status)) throw E.notFound('Profile');
  const [card] = await cards([p], { viewer });
  const role = await taxonomy.role(p.roleId);
  const rc = await profiles.currentCard(p.id);
  const credential = role.requiresCredential || role.credentialTiers.length ? await kyc.credentialFor(p.userId, role.key) : null;
  const tier = credential ? role.credentialTiers.find((t) => t.level === credential.level) : null;
  const now = Date.now();
  const strip = await availability.busyFor(p.userId, { from: new Date(now), to: new Date(now + 14 * DAY) });
  const busy = rules.mergeSpans([...strip.spans, ...strip.jobs.map((j) => ({ start: j.startAt, end: j.endAt }))]);
  return {
    ...card,
    bio: p.liveSnapshot.bio,
    introVideo: video.introVideoView(p.liveSnapshot.introVideoUrl, c.config().introVideoProviders),
    sportKeys: p.liveSnapshot.sportKeys,
    worksWithU16: p.liveSnapshot.worksWithU16,
    taking: p.status === 'live',
    role: { ...card.role, allowedUnits: role.allowedUnits, formatPriced: role.formatPriced, formats: role.formats },
    credential: credential ? { level: credential.level, labelEn: tier?.labelEn ?? null, labelBn: tier?.labelBn ?? null, verified: true } : null,
    rateCard: profiles.cardView(rc),
    busy: busy.map((j) => ({ start: c.iso(j.start), end: c.iso(j.end) })),
  };
}

/** The quote of each engagement for a profile now (the request snapshots the same lines). */
async function quoteFor(p, { unit, engagements }, now = new Date()) {
  const role = await taxonomy.role(p.roleId);
  if (!role.allowedUnits.includes(unit)) throw fail('UNIT_NOT_OFFERED');
  const card = await profiles.currentCard(p.id);
  if (!card) throw fail('PROFILE_NOT_AVAILABLE');
  const cfg = c.config();
  const areas = await areaMap(engagements.map((e) => e.venueAreaId));
  const { items, card: cc } = profiles.cardForQuote(card);
  const lines = engagements.map((e) => {
    const area = areas.get(e.venueAreaId);
    if (!area) throw fail('AREA_UNKNOWN');
    const format = unit === 'match' && role.formatPriced ? e.format ?? null : null;
    const hours = rules.hoursOf({ unit, format, hours: e.hours, matchHours: cfg.matchHours });
    const zone = rules.zoneOf({ venueAreaId: area.id, baseAreaId: p.liveSnapshot.baseAreaId, isDhakaMetro: area.isDhakaMetro, dhakaZone: area.dhakaZone });
    const night = Boolean(e.night) || rules.isNight(e.start);
    const q = rules.quoteEngagement({ unit, format, hours, night, start: e.start, requestedAt: now, zone, items, card: cc });
    if (q.error) throw fail(q.error);
    const end = new Date(new Date(e.start).getTime() + hours * 3600000);
    return { start: new Date(e.start).toISOString(), end: end.toISOString(), hours, format, night, u16: Boolean(e.u16), zone, venueAreaId: area.id, venueText: e.venueText, venueGroundId: e.venueGroundId ?? null, lines: q.lines, total: q.total };
  });
  return { rateCardId: card.id, rateCardVersion: card.version, maxJobsPerDay: card.maxJobsPerDay, lines, total: lines.reduce((n, l) => n + l.total, 0) };
}

/** POST /hire/profiles/:id/quote: not binding. */
async function quote(id, body) {
  const p = await HireProfile.findByPk(id);
  if (!p || p.status !== 'live') throw fail('PROFILE_NOT_AVAILABLE');
  const q = await quoteFor(p, body);
  return { lines: q.lines, total: q.total };
}

// ---------------------------------------------------------------- shortlist (FR-07)

async function shortlist(principal) {
  const rows = await HireShortlist.findAll({ where: { userId: principal.id, removedAt: null }, order: [['createdAt', 'DESC']] });
  const live = await HireProfile.findAll({ where: { id: rows.map((r) => r.profileId), status: ['live', 'paused'] } });
  return { items: await cards(live.filter((p) => p.liveSnapshot), { viewer: principal.id }) };
}

async function setShortlisted(principal, profileId, on) {
  const row = await HireShortlist.findOne({ where: { userId: principal.id, profileId, removedAt: null } });
  if (on && !row) {
    const p = await HireProfile.findByPk(profileId);
    if (!p || !p.liveSnapshot) throw E.notFound('Profile');
    if ((await HireShortlist.count({ where: { userId: principal.id, removedAt: null } })) >= c.config().shortlistMax) throw fail('SHORTLIST_LIMIT');
    await HireShortlist.create({ userId: principal.id, profileId });
  }
  if (!on && row) await row.update({ removedAt: new Date() });
  return { shortlisted: on };
}

module.exports = { categories, list, page, quote, quoteFor, shortlist, setShortlisted, areaMap };
