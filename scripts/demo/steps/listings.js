'use strict';

/**
 * Public listings, each created by its owner through the API, submitted, and approved by the demo
 * reviewer on the Moderation desk (M05), exactly as a real listing goes live. Re-running skips what
 * an earlier run already finished.
 */
const fs = require('fs');
const path = require('path');
const rt = require('../runtime');
const people = require('./people');
const D = require('../data');

const { models } = rt;
const PHOTOS = path.join(__dirname, '..', 'photos');
const photo = (file) => fs.readFileSync(path.join(PHOTOS, file));
const day = 86400000;

// ---------------------------------------------------------------- catalogue lookups
const cache = new Map();
async function byKey(model, key, where = {}) {
  const k = `${model}:${key}:${JSON.stringify(where)}`;
  if (!cache.has(k)) {
    const row = await models[model].findOne({ where: { key, ...where } });
    if (!row) throw new Error(`${model} ${key} not found`);
    cache.set(k, row);
  }
  return cache.get(k);
}
const ids = async (model, keys) => Promise.all(keys.map(async (k) => (await byKey(model, k)).id));
/** The area's centre, nudged so two listings never share a point. */
async function place(areaKey, i = 0) {
  const a = await byKey('Area', areaKey);
  return { areaId: a.id, lat: Number(a.lat) + 0.003 * ((i % 3) - 1), lng: Number(a.lng) + 0.003 * (((i + 1) % 3) - 1) };
}

async function done(entity, label) {
  return rt.marked(entity, label);
}

// ---------------------------------------------------------------- owners
async function owners(reviewer) {
  const out = {};
  for (const o of D.OWNERS) {
    const a = await people.member(o.n, o.name);
    await people.verifyNid(a, reviewer);
    await people.businessRole(a, o.role, reviewer);
    out[o.n] = a;
  }
  return out;
}

// ---------------------------------------------------------------- venues (M09)
async function venues(owner, reviewer) {
  const out = [];
  for (const [i, v] of D.VENUES.entries()) {
    const label = `ground:${v.name}`;
    let id = await done('ground', label);
    const o = owner[v.owner];
    if (!id) {
      const where = await place(v.area, i);
      id = (await rt.post(o, '/me/grounds', { name: v.name, ...where, addressLine: v.addressLine, isIndoor: Boolean(v.isIndoor), description: v.description, rulesText: v.rulesText, facilityIds: await ids('Facility', v.facilities), basePricePoisha: v.base })).id;
      await rt.mark('ground', id, label);
    }
    let g = await models.Ground.findByPk(id);
    if (g.status === 'draft') {
      const courts = await models.Court.count({ where: { groundId: id } });
      for (const [k, c] of v.courts.entries()) {
        if (k < courts) continue;
        await rt.post(o, `/me/grounds/${id}/courts`, { name: c.name, sportIds: await ids('Sport', c.sports), surfaceId: (await byKey('Surface', c.surface)).id, sizeText: c.sizeText ?? null, capacityText: c.capacityText ?? null, sort: k, hours: v.hours });
      }
      const photos = await models.GroundPhoto.count({ where: { groundId: id } });
      for (const file of v.photos.slice(photos)) await rt.post(o, `/me/grounds/${id}/photos`, undefined, { raw: photo(file), contentType: 'image/jpeg' });
      await rt.put(o, `/me/grounds/${id}/pricing/draft`, { basePricePoisha: v.base, ...v.pricing });
      await rt.post(o, `/me/grounds/${id}/submit`);
      g = await g.reload();
    }
    if (g.status !== 'live') await people.review(reviewer, 'ground', id);
    out.push({ id, ...v });
  }
  return out;
}

// ---------------------------------------------------------------- shops and products (M12)
const future = (days) => new Date(Date.now() + days * day).toISOString().slice(0, 10);

async function shops(owner, reviewer) {
  const out = [];
  for (const [i, s] of D.SHOPS.entries()) {
    const o = owner[s.owner];
    const label = `shop:${s.name}`;
    let shopId = await done('shop', label);
    if (!shopId) {
      const where = await place(s.area, i + 1);
      shopId = (await rt.post(o, '/shop/profile', { shopType: s.shopType, name: s.name, ...where, addressLine: s.addressLine, about: s.about })).id;
      await rt.mark('shop', shopId, label);
    }
    const shop = await models.Shop.findByPk(shopId);
    if (shop.status === 'draft') await rt.post(o, '/shop/profile/submit');
    if (shop.status !== 'live') await people.review(reviewer, 'shop', shopId);

    for (const [k, p] of s.products.entries()) {
      const plabel = `product:${s.name}:${p.title}`;
      let pid = await done('product', plabel);
      if (!pid) {
        const type = await byKey('ItemType', p.type);
        const supplement = s.shopType === 'supplements';
        const extra = (v) => ({
          ...(p.prices?.[v] ? { priceOverridePoisha: p.prices[v] } : {}),
          ...(supplement ? { expiryDate: future(300 + k * 30), batchNo: `MF-${2026}${String(k + 1).padStart(2, '0')}${String(v ?? 0).slice(0, 3).toUpperCase()}` } : {}),
        });
        const variants = p.axis ? p.values.map((v) => ({ attributes: { [p.axis]: v, ...(p.fixed ?? {}) }, openingStock: p.stock, ...extra(v) })) : [{ attributes: { ...(p.fixed ?? {}) }, openingStock: p.stock, ...extra('std') }];
        const body = { itemTypeId: type.id, title: p.title, brand: p.brand, description: p.description, specs: p.specs, basePricePoisha: p.price, variants, ...(supplement ? { importer: s.importer, bstiRegNo: `BSTI-DEMO-${k + 1}` } : {}) };
        pid = (await rt.post(o, '/shop/products', body)).id;
        await rt.mark('product', pid, plabel);
      }
      let prod = await models.Product.findByPk(pid);
      if (prod.status === 'draft') {
        const have = await models.ProductPhoto.count({ where: { ownerType: 'product', ownerId: pid, status: 'active' } });
        for (const file of p.photos.slice(have)) await rt.post(o, `/shop/products/${pid}/photos`, undefined, { raw: photo(file), contentType: 'image/jpeg' });
        await rt.post(o, `/shop/products/${pid}/submit`);
        prod = await prod.reload();
      }
      if (prod.status !== 'live') await people.review(reviewer, 'product', pid);
    }
    out.push({ id: shopId, ...s });
  }
  return out;
}

// ---------------------------------------------------------------- gyms (M20)
async function gyms(owner, reviewer) {
  const out = [];
  for (const [i, g] of D.GYMS.entries()) {
    const o = owner[g.owner];
    const label = `gym:${g.name}`;
    let id = await done('gym', label);
    if (!id) {
      const where = await place(g.area, i + 2);
      id = (await rt.post(o, '/me/gyms', { name: g.name, ...where, addressLine: g.addressLine, about: g.about, facilityIds: await ids('Facility', g.facilities) })).id;
      await rt.mark('gym', id, label);
    }
    let row = await models.Gym.findByPk(id);
    if (row.status === 'draft') {
      const have = await models.GymPhoto.count({ where: { gymId: id } });
      for (const file of g.photos.slice(have)) await rt.post(o, `/me/gyms/${id}/photos`, undefined, { raw: photo(file), contentType: 'image/jpeg' });
      await rt.put(o, `/me/gyms/${id}/hours`, { hours: g.hours });
      await rt.put(o, `/me/gyms/${id}/packages`, { packages: g.packages });
      await rt.post(o, `/me/gyms/${id}/submit`);
      row = await row.reload();
    }
    if (row.status !== 'live') await people.review(reviewer, 'gym', id);
    out.push({ id, ...g });
  }
  return out;
}

// ---------------------------------------------------------------- hire profiles (M11) and trainers (M20)
async function liveProfile(a, reviewer, p) {
  const label = `hire:${p.n}`;
  let id = await done('hire_profile', label);
  if (!id) {
    const area = await byKey('Area', p.area);
    id = (await rt.post(a, '/pro/profiles', { roleKey: p.roleKey, headline: p.headline, ...(p.specialisation ? { specialisation: p.specialisation } : {}), sportKeys: p.sports ?? [], experienceLevel: p.level, years: p.years, baseAreaId: area.id, bio: p.bio })).id;
    await rt.put(a, `/pro/profiles/${id}/rate-card`, p.card);
    await rt.mark('hire_profile', id, label);
  }
  const row = await models.HireProfile.findByPk(id);
  if (['draft', 'changes_requested'].includes(row.status)) await rt.post(a, `/pro/profiles/${id}/submit`);
  if (row.status !== 'live') await people.review(reviewer, 'hire_profile', id);
  return id;
}

async function pros(reviewer, gymRows) {
  const out = [];
  for (const p of D.PROS) {
    const a = await people.member(p.n, p.name);
    await people.verifyNid(a, reviewer);
    await people.hireRole(a, { platformRole: p.platformRole ?? 'pro', roleKey: p.roleKey, credential: p.credential }, reviewer);
    out.push({ actor: a, profileId: await liveProfile(a, reviewer, p), ...p });
  }
  for (const t of D.TRAINERS) {
    const a = await people.member(t.n, t.name);
    await people.verifyNid(a, reviewer);
    await people.hireRole(a, { platformRole: 'pro', roleKey: 'fitness_trainer' }, reviewer);
    const card = { items: [{ unit: 'hourly', rate: t.rate }], nightPct: 0, shortNoticePct: 0, shortNoticeHours: 24, travel: { north: 20000, south: 30000, outside: 100000 }, maxJobsPerDay: 4 };
    const profileId = await liveProfile(a, reviewer, { n: t.n, roleKey: 'fitness_trainer', headline: t.headline, sports: ['gym'], level: 'semi_pro', years: t.years, area: t.area, bio: t.bio, card });
    const plans = await rt.get(a, '/pro/trainer-plans');
    if (!(plans.items ?? plans).length) {
      const gym = t.plan.gym ? gymRows.find((g) => g.name === t.plan.gym) : null;
      await rt.post(a, '/pro/trainer-plans', { profileId, title: t.plan.title, description: `${t.headline}. Programme reviewed every month.`, sessionsPerMonth: t.plan.sessionsPerMonth, price: t.plan.price, whereKind: t.plan.whereKind, ...(gym ? { gymId: gym.id } : {}), ...(t.plan.whereKind !== 'gym' ? { areaId: (await byKey('Area', t.area)).id } : {}) });
    }
    out.push({ actor: a, profileId, trainer: true, ...t });
  }
  return out;
}

// ---------------------------------------------------------------- esports players (M21)
async function players(reviewer) {
  const out = [];
  for (const p of D.PLAYERS) {
    const a = await people.member(p.n, p.name, { username: p.username });
    const game = await byKey('EsportsGame', p.game);
    let prof = await models.EsportsGameProfile.findOne({ where: { userId: a.userId, gameId: game.id } });
    if (!prof) {
      const up = await rt.post(a, '/me/esports/uploads', undefined, { raw: photo('banner-lights.jpg'), contentType: 'image/jpeg' });
      // 12-digit UIDs starting 9999: outside the ranges the games hand out, so no real player is blocked.
      const created = await rt.post(a, '/me/esports/profiles', { gameId: game.id, uid: `9999${String(p.n).padStart(8, '0')}`, ign: p.ign, screenshotKey: up.key });
      prof = await models.EsportsGameProfile.findByPk(created.id);
    }
    if (prof.status !== 'verified') await people.review(reviewer, 'game_profile', prof.id);
    a.profileId = prof.id;
    a.game = p.game;
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------- esports events (M21) and the showcase (M23)
async function tournamentBody(e, { free }) {
  const game = await byKey('EsportsGame', e.game);
  const mode = await models.EsportsMode.findOne({ where: { gameId: game.id, key: e.mode ?? 'solo' } });
  const maps = await models.EsportsMap.findAll({ where: { gameId: game.id }, order: [['sort', 'ASC']] });
  const preset = await models.EsportsPointsPreset.findOne({ where: { gameId: game.id }, order: [['sort', 'ASC']] });
  // 21:00 Dhaka on the start day.
  const d = new Date(Date.now() + e.startsInDays * day);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15, 0));
  const matches = e.matches ?? 1;
  return {
    gameId: game.id,
    modeId: mode.id,
    titleEn: e.titleEn,
    titleBn: e.titleBn,
    tier: e.tier ?? 'daily',
    format: matches > 1 ? 'series' : 'single_match',
    entryFee: free ? 0 : e.fee ?? 0,
    maxSlots: e.slots ?? mode.maxTeams,
    minParticipants: e.min ?? 2,
    prizes: (e.prizes ?? [100000, 50000, 25000]).map((amount, i) => ({ place: i + 1, amount })),
    killReward: e.killReward ?? 0,
    pointsPresetId: preset.id,
    registrationOpensAt: new Date(Date.now() + (e.opensInMin ?? 3) * 60000).toISOString(),
    matches: Array.from({ length: matches }, (_, i) => ({ mapId: maps[i % maps.length].id, startsAt: new Date(start.getTime() + i * 3600000).toISOString() })),
    rulesMd: e.rulesMd ?? 'Mobile devices only, no emulators. Join the room 10 minutes before the start. Teaming up or hacks mean disqualification.',
    featured: Boolean(e.featured),
    ...(e.entryPolicy ? { entryPolicy: e.entryPolicy } : {}),
  };
}

/** A Kriraghor-run tournament drafted by the master and approved by the reviewer. */
async function esportsTournament(master, reviewer, e, opts) {
  const label = `esports:${e.key ?? e.titleEn}`;
  let id = await done('esports_tournament', label);
  if (!id) {
    id = (await rt.post(master, '/admin/esports/tournaments', await tournamentBody(e, opts))).id;
    await rt.mark('esports_tournament', id, label);
  }
  const t = await models.EsportsTournament.findByPk(id);
  if (t.status === 'draft') await rt.post(master, `/admin/esports/tournaments/${id}/submit`);
  if (['draft', 'review'].includes(t.status)) await people.review(reviewer, 'esports_tournament', id);
  return id;
}

async function esports(master, reviewer, { free }) {
  const out = [];
  for (const e of D.ESPORTS) out.push(await esportsTournament(master, reviewer, e, { free }));
  return out;
}

async function showcase(master, reviewer) {
  const S = D.SHOWCASE;
  const q = [];
  for (const s of S.qualifiers) q.push({ ...s, id: await esportsTournament(master, reviewer, { key: s.key, game: 'free_fire', mode: 'solo', titleEn: s.titleEn, titleBn: s.titleBn, tier: 'weekly', slots: 48, min: 12, prizes: [200000, 100000, 50000], startsInDays: s.startsInDays, opensInMin: 1 }, { free: true }) });
  const finalId = await esportsTournament(master, reviewer, { key: S.final.key, game: 'free_fire', mode: 'solo', titleEn: S.final.titleEn, titleBn: S.final.titleBn, tier: 'major', slots: 12, min: 6, prizes: S.final.prizes, killReward: 10000, startsInDays: S.final.startsInDays, opensInMin: 60 * 24 * 12, entryPolicy: 'invite', featured: true }, { free: true });

  let id = await done('esports_event', 'showcase');
  if (!id) {
    const startsAt = new Date(Date.now() + (S.qualifiers[0].startsInDays - 1) * day).toISOString();
    const endsAt = new Date(Date.now() + (S.final.startsInDays + 1) * day).toISOString();
    id = (await rt.post(master, '/admin/esports/events', { titleEn: S.titleEn, titleBn: S.titleBn, taglineEn: S.taglineEn, taglineBn: S.taglineBn, aboutMdEn: S.aboutMd, aboutMdBn: S.taglineBn, accentHex: S.accentHex, startsAt, endsAt, featured: true })).id;
    await rt.mark('esports_event', id, 'showcase');
    await rt.post(master, `/admin/esports/events/${id}/banner`, undefined, { raw: photo(S.banner), contentType: 'image/jpeg' });
    await rt.put(master, `/admin/esports/events/${id}/stages`, {
      stages: [
        { tournamentId: finalId, role: 'final', labelEn: 'Grand final', labelBn: 'গ্র্যান্ড ফাইনাল' },
        ...q.map((s, i) => ({ tournamentId: s.id, role: 'qualifier', labelEn: `Qualifier ${i + 1}`, labelBn: `কোয়ালিফায়ার ${i + 1}`, qualifyCount: s.qualify, finalTournamentId: finalId })),
      ],
    });
    for (const sp of S.sponsors) await rt.post(master, `/admin/esports/events/${id}/sponsors`, sp);
    await rt.post(master, `/admin/esports/events/${id}/polls`, { questionEn: S.poll.questionEn, questionBn: S.poll.questionBn, options: S.poll.options.map(([labelEn, labelBn]) => ({ labelEn, labelBn })) });
  }
  const ev = await models.EsportsEvent.findByPk(id);
  if (ev.status === 'draft') await rt.post(master, `/admin/esports/events/${id}/publish`);
  return id;
}

/**
 * Registration opens a minute after an event is approved. Wait for that moment, then run the
 * lifecycle step the worker runs every minute, so the events show as open straight away.
 */
async function openRegistrations() {
  const lifecycle = require('../../../src/modules/esports/esports.lifecycle');
  const ids = (await models.DemoRecord.findAll({ where: { entity: 'esports_tournament' } })).map((r) => r.entityId);
  const due = (await models.EsportsTournament.findAll({ where: { id: ids, status: 'scheduled' } })).filter((t) => new Date(t.registrationOpensAt).getTime() - Date.now() < 3 * 60000);
  if (!due.length) return 0;
  const wait = Math.max(...due.map((t) => new Date(t.registrationOpensAt).getTime() - Date.now())) + 2000;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  await lifecycle.tick();
  await rt.drain();
  return due.length;
}

// ---------------------------------------------------------------- sports events (M14)
async function sports(reviewer) {
  const o = await people.member(11, D.OWNERS.find((x) => x.n === 11).name);
  let orgId = await done('organisation', 'sports-org');
  if (!orgId) {
    orgId = (await rt.post(o, '/me/organisations', { name: D.SPORTS_ORG.name, kind: 'sports', about: D.SPORTS_ORG.about })).id;
    await rt.mark('organisation', orgId, 'sports-org');
  }
  const org = await models.Organisation.findByPk(orgId);
  if (org.status === 'draft') await rt.post(o, `/me/organisations/${orgId}/submit`);
  if (org.status !== 'verified') await people.review(reviewer, 'organisation', orgId);

  const dhaka = (ms) => new Date(ms + 6 * 3600000).toISOString().slice(0, 10);
  const out = [];
  for (const e of D.SPORTS_EVENTS) {
    const label = `sports:${e.key}`;
    let id = await done('sports_tournament', label);
    if (!id) {
      const start = Date.now() + e.startInDays * day;
      id = (
        await rt.post(o, `/org/${orgId}/sports/tournaments`, {
          sportKey: e.sportKey,
          name: e.name,
          format: e.format,
          minTeams: e.minTeams,
          maxTeams: e.maxTeams,
          squadMin: e.squadMin,
          squadMax: e.squadMax,
          entryFeePoisha: 0,
          registrationOpensAt: new Date(Date.now() - 60000).toISOString(),
          registrationClosesAt: new Date(start - 3 * day).toISOString(),
          startDate: dhaka(start),
          endDate: dhaka(start + 14 * day),
          venues: [{ venueText: e.venue, areaId: (await byKey('Area', e.area)).id, courts: ['Main'] }],
        })
      ).id;
      await rt.mark('sports_tournament', id, label);
    }
    const t = await models.Tournament.findByPk(id);
    if (t.status === 'draft') await rt.post(o, `/org/${orgId}/sports/tournaments/${id}/submit`);
    if (['draft', 'in_review', 'pending_review'].includes(t.status)) await people.review(reviewer, 'tournament', id);
    out.push(id);
  }
  return { organiser: o, orgId, events: out };
}

module.exports = { owners, venues, shops, gyms, pros, players, esports, esportsTournament, tournamentBody, showcase, openRegistrations, sports, byKey, place, photo };
