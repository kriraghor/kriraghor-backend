'use strict';

/**
 * M23 big events: the event hub over M21 tournaments (Kriraghor staff, manage_esports).
 *
 *   draft ─publish (a published tournament linked)─▶ published ─cancel (nothing running)─▶ cancelled
 *   Viewers see a phase worked out from the dates and the tournaments: upcoming, live, ended.
 *
 * Stages link M21 tournaments: qualifiers name the invite-only final they feed and how many go through
 * (events.rules.linkBlock). The prize total is computed from the tournaments' prize pools; sponsors
 * are placements only (no money in the app). Streams embed from the parsed video reference only.
 */
const crypto = require('crypto');
const { UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const storage = require('../../common/storage');
const { sniffMime } = require('../../common/filetype');
const { uuid7 } = require('../../common/uuid7');
const models = require('../../models');
const audit = require('../audit').audit;
const reads = require('../esports').reads;
const streamRules = require('../esports').streamsRules;
const rules = require('./events.rules');
const c = require('./events.common');
const feed = require('./feed.service');
const alerts = require('./alerts.service');

const { sequelize, EsportsEvent, EsportsEventStage, EsportsEventStream, EsportsEventSponsor, EsportsEventFollow } = models;

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const VISIBLE = ['published', 'cancelled'];

// ---------------------------------------------------------------- views

const stagesOf = (eventId, transaction) => EsportsEventStage.findAll({ where: { eventId, status: 'active' }, order: [['sort', 'ASC'], ['createdAt', 'ASC']], transaction });

function head(e, tournaments, followers) {
  return {
    id: e.id,
    slug: e.slug,
    titleEn: e.titleEn,
    titleBn: e.titleBn,
    taglineEn: e.taglineEn ?? null,
    taglineBn: e.taglineBn ?? null,
    bannerUrl: e.bannerKey ? storage.publicUrl(e.bannerKey) : null,
    accentHex: e.accentHex,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    status: e.status,
    phase: rules.phase(e, tournaments),
    featured: e.featured,
    prizeTotal: c.money(rules.prizeTotal(tournaments)),
    followers,
    cancelReason: e.cancelReason ?? null,
  };
}

const publicTournament = (t) => ({
  id: t.id,
  slug: t.slug,
  titleEn: t.titleEn,
  titleBn: t.titleBn,
  status: t.status,
  entryUnit: t.entryUnit,
  entryPolicy: t.entryPolicy,
  maxSlots: t.maxSlots,
  prizePool: t.prizePool,
  entryFee: t.entryFee,
  registrationOpensAt: t.registrationOpensAt,
  registrationClosesAt: t.registrationClosesAt,
  startsAt: t.startsAt,
});

const streamView = (s, source) => ({ id: s.id, source, tournamentId: s.tournamentId ?? null, platform: s.platform, url: s.url, title: s.title, isLive: s.isLive, embedUrl: streamRules.embedFor(s.videoRef) });
const sponsorView = (s) => ({ id: s.id, name: s.name, tier: s.tier, logoUrl: s.logoKey ? storage.publicUrl(s.logoKey) : null, url: s.url ?? null, sort: s.sort });

async function followerCounts(ids) {
  if (!ids.length) return new Map();
  const rows = await EsportsEventFollow.findAll({ where: { eventId: ids, status: 'active' }, attributes: ['eventId', [sequelize.fn('COUNT', sequelize.col('id')), 'n']], group: ['eventId'], raw: true });
  return new Map(rows.map((r) => [r.eventId, Number(r.n)]));
}

/** Cards for lists: the event with its phase and prize total. */
async function cards(events) {
  const stages = events.length ? await EsportsEventStage.findAll({ where: { eventId: events.map((e) => e.id), status: 'active' } }) : [];
  const summaries = await reads.tournamentSummary(stages.map((s) => s.tournamentId));
  const counts = await followerCounts(events.map((e) => e.id));
  return events.map((e) => head(e, stages.filter((s) => s.eventId === e.id).map((s) => summaries.get(s.tournamentId)).filter(Boolean), counts.get(e.id) ?? 0));
}

/** The public bundle (no viewer-specific data, so it is cacheable): GET /esports/events/:slug. */
async function bundle(slugOrId) {
  const e = await EsportsEvent.findOne({ where: /^[0-9a-f-]{36}$/.test(slugOrId) ? { id: slugOrId } : { slug: slugOrId } });
  if (!e || !VISIBLE.includes(e.status)) throw E.notFound('Event');
  return bundleOf(e);
}

async function bundleOf(e, { staff = false } = {}) {
  const stages = await stagesOf(e.id);
  const summaries = await reads.tournamentSummary(stages.map((s) => s.tournamentId));
  const tournaments = stages.map((s) => summaries.get(s.tournamentId)).filter(Boolean);
  const [streams, tStreams, sponsors, followers, quals, polls, feedPage] = await Promise.all([
    EsportsEventStream.findAll({ where: { eventId: e.id, status: 'active' }, order: [['sort', 'ASC']] }),
    reads.streamsOf(tournaments.map((t) => t.id)),
    EsportsEventSponsor.findAll({ where: { eventId: e.id, status: 'active' }, order: [['tier', 'ASC'], ['sort', 'ASC']] }),
    followerCounts([e.id]),
    require('./qualifications.service').publicList(e.id),
    require('./audience.service').publicPolls(e.id, { staff }),
    feed.page(e.id),
  ]);
  const tierOrder = { title: 0, gold: 1, partner: 2 };
  return {
    event: { ...head(e, tournaments, followers.get(e.id) ?? 0), aboutMdEn: e.aboutMdEn, aboutMdBn: e.aboutMdBn },
    stages: stages.map((s) => ({
      id: s.id,
      role: s.role,
      labelEn: s.labelEn,
      labelBn: s.labelBn,
      sort: s.sort,
      qualifyCount: s.qualifyCount ?? null,
      finalTournamentId: s.finalTournamentId ?? null,
      tournament: summaries.get(s.tournamentId) ? publicTournament(summaries.get(s.tournamentId)) : null,
    })),
    qualifications: quals,
    streams: [...streams.map((s) => streamView(s, 'event')), ...tStreams.map((s) => streamView(s, 'tournament'))],
    sponsors: sponsors.map(sponsorView).sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || a.sort - b.sort),
    polls,
    feed: feedPage,
  };
}

/** GET /esports/events: published events; `featured` and `tournamentId` narrow; live and upcoming first. */
async function list({ featured, tournamentId, limit = 20 } = {}) {
  const where = { status: 'published' };
  if (featured !== undefined) where.featured = featured;
  if (tournamentId) {
    const stage = await EsportsEventStage.findOne({ where: { tournamentId, status: 'active' } });
    if (!stage) return { items: [] };
    where.id = stage.eventId;
  }
  const rows = await EsportsEvent.findAll({ where, order: [['startsAt', 'DESC']], limit: 100 });
  const items = await cards(rows);
  const rank = { live: 0, upcoming: 1, ended: 2 };
  items.sort((a, b) => rank[a.phase] - rank[b.phase] || (a.phase === 'upcoming' ? new Date(a.startsAt) - new Date(b.startsAt) : new Date(b.startsAt) - new Date(a.startsAt)));
  return { items: items.slice(0, limit) };
}

/** GET /admin/esports/events */
async function adminList({ status } = {}) {
  const rows = await EsportsEvent.findAll({ where: status ? { status } : {}, order: [['startsAt', 'DESC']], limit: 200 });
  return { items: await cards(rows) };
}

/** GET /admin/esports/events/:id: the bundle plus drafts, staff fields and the link check. */
async function adminGet(id) {
  const e = await EsportsEvent.findByPk(id);
  if (!e) throw E.notFound('Event');
  const b = await bundleOf(e, { staff: true });
  const stages = await stagesOf(e.id);
  return { ...b, linkCheck: await linkCheck(stages), lockVersion: e.lockVersion, createdBy: e.createdBy, publishedAt: e.publishedAt ?? null };
}

// ---------------------------------------------------------------- authoring

function fieldsOf(body) {
  const out = {};
  for (const k of ['titleEn', 'titleBn', 'taglineEn', 'taglineBn', 'aboutMdEn', 'aboutMdBn', 'featured']) if (body[k] !== undefined) out[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
  if (body.accentHex !== undefined) out.accentHex = body.accentHex.toLowerCase();
  if (body.startsAt !== undefined) out.startsAt = new Date(body.startsAt);
  if (body.endsAt !== undefined) out.endsAt = new Date(body.endsAt);
  return out;
}

/** POST /admin/esports/events: a draft. */
async function create(actor, body, req) {
  const f = fieldsOf(body);
  const block = rules.eventBlock({ startsAt: f.startsAt, endsAt: f.endsAt, accentHex: f.accentHex });
  if (block) throw c.fail(block);
  return sequelize.transaction(async (transaction) => {
    const id = uuid7();
    const e = await EsportsEvent.create({ id, slug: rules.slugify(f.titleEn, id.slice(-6)), ...f, status: 'draft', createdBy: actor.id }, { transaction });
    await audit.record({ action: 'esports_event.created', actor, entityType: 'esports_event', entityId: e.id, after: { titleEn: e.titleEn, startsAt: e.startsAt }, req }, { transaction });
    return adminView(e);
  });
}

const adminView = (e) => ({ ...head(e, [], 0), aboutMdEn: e.aboutMdEn, aboutMdBn: e.aboutMdBn, lockVersion: e.lockVersion });

/** PATCH /admin/esports/events/:id: any field while draft or published (the slug never changes). */
async function update(actor, id, body, req) {
  return sequelize.transaction(async (transaction) => {
    const e = await EsportsEvent.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!e) throw E.notFound('Event');
    if (e.status === 'cancelled') throw c.fail('EVENT_STATE');
    const f = fieldsOf(body);
    const block = rules.eventBlock({ startsAt: f.startsAt ?? e.startsAt, endsAt: f.endsAt ?? e.endsAt, accentHex: f.accentHex });
    if (block) throw c.fail(block);
    await e.update({ ...f, updatedBy: actor.id, lockVersion: e.lockVersion + 1 }, { transaction });
    await audit.record({ action: 'esports_event.updated', actor, entityType: 'esports_event', entityId: e.id, after: { fields: Object.keys(f), lockVersion: e.lockVersion }, req }, { transaction });
    c.ping(transaction, e.id, 'esports_event.phase_changed');
    return adminView(e);
  });
}

/** POST /admin/esports/events/:id/banner (raw image): public bucket, a new key each time. */
async function uploadBanner(actor, id, { contentType, body }, req) {
  const { key, size } = await putImage(`esports-events/${id}/banner`, contentType, body);
  return sequelize.transaction(async (transaction) => {
    const e = await EsportsEvent.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!e) throw E.notFound('Event');
    await e.update({ bannerKey: key, updatedBy: actor.id, lockVersion: e.lockVersion + 1 }, { transaction });
    await audit.record({ action: 'esports_event.banner_uploaded', actor, entityType: 'esports_event', entityId: e.id, meta: { sizeBytes: size }, req }, { transaction });
    return adminView(e);
  });
}

async function putImage(prefix, contentType, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!buf.length) throw c.fail('FILE_EMPTY');
  if (buf.length > c.config().bannerMaxBytes) throw c.fail('FILE_TOO_LARGE');
  if (!IMAGE_TYPES[declared]) throw c.fail('FILE_TYPE_NOT_ALLOWED');
  if (sniffMime(buf) !== declared) throw c.fail('FILE_TYPE_MISMATCH');
  const key = `${prefix}-${crypto.randomBytes(6).toString('hex')}.${IMAGE_TYPES[declared]}`;
  await storage.putPublic(key, buf, declared);
  return { key, size: buf.length };
}

/** The link check for the saved stages (shown on the desk; also enforced on save). */
async function linkCheck(stages, { transaction } = {}) {
  const summaries = await reads.tournamentSummary(stages.map((s) => s.tournamentId), { transaction });
  const out = [];
  for (const f of stages.filter((s) => s.role === 'final')) {
    const final = summaries.get(f.tournamentId);
    const qualifiers = stages.filter((s) => s.role === 'qualifier' && s.finalTournamentId === f.tournamentId).map((s) => ({ ...summaries.get(s.tournamentId), qualifyCount: s.qualifyCount }));
    out.push({ finalTournamentId: f.tournamentId, block: final ? rules.linkBlock(final, qualifiers, c.config().gapMinutes) : 'EVENT_STAGES_INVALID', qualifying: qualifiers.reduce((s, q) => s + q.qualifyCount, 0) });
  }
  return out;
}

/**
 * PUT /admin/esports/events/:id/stages: replace the stage list. Every final passes linkBlock; a
 * tournament is in one event at a time. Qualifiers already finalised keep their qualifications.
 */
async function setStages(actor, id, { stages }, req) {
  const block = rules.stagesBlock(stages, c.config().maxStages);
  if (block) throw c.fail(block);
  return sequelize.transaction(async (transaction) => {
    const e = await EsportsEvent.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!e) throw E.notFound('Event');
    if (e.status === 'cancelled') throw c.fail('EVENT_STATE');
    const summaries = await reads.tournamentSummary(stages.map((s) => s.tournamentId), { transaction });
    if (summaries.size !== stages.length) throw E.notFound('Tournament');
    for (const s of stages) {
      const t = summaries.get(s.tournamentId);
      if (t.organiserType !== 'kriraghor') throw c.fail('EVENT_TOURNAMENT_NOT_OURS');
    }
    const check = await linkCheck(
      stages.map((s) => ({ ...s, qualifyCount: s.qualifyCount ?? null, finalTournamentId: s.finalTournamentId ?? null })),
      { transaction }
    );
    const bad = check.find((x) => x.block);
    if (bad) throw c.fail(bad.block, { finalTournamentId: bad.finalTournamentId });
    await EsportsEventStage.update({ status: 'removed' }, { where: { eventId: e.id, status: 'active' }, transaction });
    for (const [i, s] of stages.entries()) {
      try {
        await sequelize.transaction({ transaction }, (sp) =>
          EsportsEventStage.create(
            { eventId: e.id, tournamentId: s.tournamentId, role: s.role, labelEn: s.labelEn.trim(), labelBn: s.labelBn.trim(), sort: i, qualifyCount: s.role === 'qualifier' ? s.qualifyCount : null, finalTournamentId: s.role === 'qualifier' ? s.finalTournamentId : null, createdBy: actor.id },
            { transaction: sp }
          )
        );
      } catch (err) {
        if (err instanceof UniqueConstraintError) throw c.fail('EVENT_TOURNAMENT_IN_OTHER_EVENT', { tournamentId: s.tournamentId });
        throw err;
      }
    }
    await e.update({ updatedBy: actor.id, lockVersion: e.lockVersion + 1 }, { transaction });
    await audit.record({ action: 'esports_event.stages_set', actor, entityType: 'esports_event', entityId: e.id, after: { stages: stages.length, finals: stages.filter((s) => s.role === 'final').length }, req }, { transaction });
    c.ping(transaction, e.id, 'esports_event.phase_changed');
    return { items: (await stagesOf(e.id, transaction)).map((s) => ({ id: s.id, tournamentId: s.tournamentId, role: s.role, labelEn: s.labelEn, labelBn: s.labelBn, sort: s.sort, qualifyCount: s.qualifyCount ?? null, finalTournamentId: s.finalTournamentId ?? null })) };
  });
}

/** POST /admin/esports/events/:id/publish: needs a published tournament linked. */
async function publish(actor, id, req) {
  return sequelize.transaction(async (transaction) => {
    const e = await EsportsEvent.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!e) throw E.notFound('Event');
    if (e.status !== 'draft') throw c.fail('EVENT_STATE');
    const summaries = await reads.tournamentSummary((await stagesOf(e.id, transaction)).map((s) => s.tournamentId), { transaction });
    if (![...summaries.values()].some((t) => !['draft', 'review', 'cancelled'].includes(t.status))) throw c.fail('EVENT_NOT_PUBLISHABLE');
    await e.update({ status: 'published', publishedAt: new Date(), publishedBy: actor.id, lockVersion: e.lockVersion + 1 }, { transaction });
    await c.publish(transaction, 'esports_event.published', 'esports_event', e.id, { eventId: e.id, startsAt: e.startsAt.toISOString() }, actor);
    await audit.record({ action: 'esports_event.published', actor, entityType: 'esports_event', entityId: e.id, after: { status: 'published' }, req }, { transaction });
    return adminView(e);
  });
}

/** POST /admin/esports/events/:id/cancel: never cancels tournaments; refused while one is running. */
async function cancel(actor, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const e = await EsportsEvent.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!e) throw E.notFound('Event');
    if (e.status === 'cancelled') throw c.fail('EVENT_STATE');
    const summaries = await reads.tournamentSummary((await stagesOf(e.id, transaction)).map((s) => s.tournamentId), { transaction });
    const block = rules.cancelBlock([...summaries.values()]);
    if (block) throw c.fail(block);
    const wasPublished = e.status === 'published';
    await e.update({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: actor.id, cancelReason: reason, lockVersion: e.lockVersion + 1 }, { transaction });
    if (wasPublished) await feed.add(transaction, e.id, { kind: 'event_cancelled', textEn: reason, actorId: actor.id });
    await c.publish(transaction, 'esports_event.cancelled', 'esports_event', e.id, { eventId: e.id }, actor);
    await audit.record({ action: 'esports_event.cancelled', actor, entityType: 'esports_event', entityId: e.id, after: { status: 'cancelled' }, reason, req }, { transaction });
    c.ping(transaction, e.id, 'esports_event.phase_changed');
    return adminView(e);
  });
}

// ---------------------------------------------------------------- streams and sponsors

/**
 * PUT /admin/esports/events/:id/streams: the event's own broadcast (YouTube, Facebook, TikTok). A
 * stream that was not live before and is now live alerts followers (cooldown) and goes in the feed.
 */
async function setStreams(actor, id, { streams }, req) {
  const parsed = streams.map((s) => streamRules.parseStream(s.platform, s.url));
  if (parsed.some((p) => p.error)) throw c.fail('STREAM_URL_INVALID');
  return sequelize.transaction(async (transaction) => {
    const e = await EsportsEvent.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!e) throw E.notFound('Event');
    if (e.status === 'cancelled') throw c.fail('EVENT_STATE');
    const wasLive = new Set((await EsportsEventStream.findAll({ where: { eventId: e.id, status: 'active', isLive: true }, attributes: ['url'], transaction })).map((s) => s.url));
    await EsportsEventStream.update({ status: 'removed' }, { where: { eventId: e.id, status: 'active' }, transaction });
    let started = null;
    for (const [i, s] of streams.entries()) {
      const row = await EsportsEventStream.create({ eventId: e.id, platform: s.platform, url: s.url, videoRef: parsed[i].ref, title: s.title.trim(), isLive: Boolean(s.isLive), sort: i }, { transaction });
      if (row.isLive && !wasLive.has(row.url)) started = started ?? row;
    }
    if (started && e.status === 'published') await streamStarted(e.id, started.id, null, { transaction });
    await audit.record({ action: 'esports_event.streams_set', actor, entityType: 'esports_event', entityId: e.id, after: { streams: streams.length, live: streams.filter((s) => s.isLive).length }, req }, { transaction });
    c.ping(transaction, e.id, 'esports_event.stream_changed');
    return { items: (await EsportsEventStream.findAll({ where: { eventId: e.id, status: 'active' }, order: [['sort', 'ASC']], transaction })).map((s) => streamView(s, 'event')) };
  });
}

/** A stream went live (the event's own, or M21's esports_stream.live_started): feed item and alert. */
async function streamStarted(eventId, streamId, tournamentId, { transaction }) {
  await feed.add(transaction, eventId, { kind: 'stream_live', tournamentId, refId: streamId });
  c.ping(transaction, eventId, 'esports_event.stream_changed');
  return alerts.send(eventId, 'stream_live', `stream_live:${streamId}`, { transaction });
}

/** M21 esports_stream.live_started on a tournament in a published event. */
async function onTournamentStreamLive({ tournamentId, streamId }, { transaction }) {
  const s = await require('./qualifications.service').stageOf(tournamentId, { transaction });
  if (!s || s.event.status !== 'published') return null;
  return streamStarted(s.event.id, streamId, tournamentId, { transaction });
}

async function sponsorCount(eventId, transaction) {
  return EsportsEventSponsor.count({ where: { eventId, status: 'active' }, transaction });
}

/** POST /admin/esports/events/:id/sponsors */
async function addSponsor(actor, id, body, req) {
  if (body.url && !rules.httpsUrl(body.url)) throw c.fail('SPONSOR_URL_INVALID');
  return sequelize.transaction(async (transaction) => {
    const e = await EsportsEvent.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!e) throw E.notFound('Event');
    if (e.status === 'cancelled') throw c.fail('EVENT_STATE');
    if ((await sponsorCount(e.id, transaction)) >= c.config().maxSponsors) throw c.fail('SPONSOR_LIMIT');
    const s = await EsportsEventSponsor.create({ eventId: e.id, name: body.name.trim(), tier: body.tier, url: body.url ?? null, sort: body.sort ?? 0, createdBy: actor.id }, { transaction });
    await audit.record({ action: 'esports_event.sponsor_added', actor, entityType: 'esports_event', entityId: e.id, after: { sponsorId: s.id, tier: s.tier }, req }, { transaction });
    c.ping(transaction, e.id, 'esports_event.phase_changed');
    return sponsorView(s);
  });
}

async function sponsorFor(eventId, sponsorId, transaction) {
  const s = await EsportsEventSponsor.findOne({ where: { id: sponsorId, eventId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
  if (!s) throw E.notFound('Sponsor');
  return s;
}

/** PATCH /admin/esports/events/:id/sponsors/:sponsorId */
async function updateSponsor(actor, id, sponsorId, body, req) {
  if (body.url && !rules.httpsUrl(body.url)) throw c.fail('SPONSOR_URL_INVALID');
  return sequelize.transaction(async (transaction) => {
    const s = await sponsorFor(id, sponsorId, transaction);
    const patch = {};
    for (const k of ['name', 'tier', 'url', 'sort']) if (body[k] !== undefined) patch[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
    await s.update(patch, { transaction });
    await audit.record({ action: 'esports_event.sponsor_updated', actor, entityType: 'esports_event', entityId: id, after: { sponsorId: s.id, fields: Object.keys(patch) }, req }, { transaction });
    c.ping(transaction, id, 'esports_event.phase_changed');
    return sponsorView(s);
  });
}

/** POST /admin/esports/events/:id/sponsors/:sponsorId/remove (status, never deleted). */
async function removeSponsor(actor, id, sponsorId, req) {
  return sequelize.transaction(async (transaction) => {
    const s = await sponsorFor(id, sponsorId, transaction);
    await s.update({ status: 'removed' }, { transaction });
    await audit.record({ action: 'esports_event.sponsor_removed', actor, entityType: 'esports_event', entityId: id, after: { sponsorId: s.id }, req }, { transaction });
    c.ping(transaction, id, 'esports_event.phase_changed');
    return { id: s.id, status: s.status };
  });
}

/** POST /admin/esports/events/:id/sponsors/:sponsorId/logo (raw image). */
async function uploadSponsorLogo(actor, id, sponsorId, { contentType, body }, req) {
  const { key, size } = await putImage(`esports-events/${id}/sponsor-${sponsorId}`, contentType, body);
  return sequelize.transaction(async (transaction) => {
    const s = await sponsorFor(id, sponsorId, transaction);
    await s.update({ logoKey: key }, { transaction });
    await audit.record({ action: 'esports_event.sponsor_updated', actor, entityType: 'esports_event', entityId: id, after: { sponsorId: s.id, fields: ['logo'] }, meta: { sizeBytes: size }, req }, { transaction });
    return sponsorView(s);
  });
}

module.exports = {
  bundle,
  bundleOf,
  cards,
  list,
  adminList,
  adminGet,
  create,
  update,
  uploadBanner,
  setStages,
  publish,
  cancel,
  setStreams,
  onTournamentStreamLive,
  addSponsor,
  updateSponsor,
  removeSponsor,
  uploadSponsorLogo,
  stagesOf,
};
