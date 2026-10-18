'use strict';

/**
 * M21 tournaments (FR-06, FR-07, FR-29, FR-30). Kriraghor is organiser #1.
 *
 *   draft ─submit─▶ review (M05 kind esports_tournament) ─approved─▶ scheduled (prize table locked,
 *   settings snapshotted) ─time─▶ registration_open ─▶ registration_closed ─▶ check_in ─▶ live ─▶
 *   results_pending ─finalise─▶ finalised ─▶ paid_out;  any state before finalised ─cancel─▶ cancelled
 *
 * Time-based moves run in esports.lifecycle (job esports.tick). Step 1 formats: single_match and
 * series (one main stage); groups to finals come in step 2. A draft's prize places, stage and matches
 * are configuration with no dependants yet, so editing a draft replaces them.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const realtime = require('../../common/realtime');
const { uuid7 } = require('../../common/uuid7');
const models = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const settings = require('../settings/settings.service');
const moderation = require('../moderation/moderation.service');
const { organiser, isOrganised, fail, game: gameRow, mode: modeRow, maps: mapRows, preset: presetRow, snapshot, setting, rooms, money } = require('./esports.common');
const rules = require('./esports.rules');

const { sequelize, EsportsTournament, EsportsPrizePlace, EsportsStage, EsportsMatch, EsportsStream, EsportsRegistration, EsportsGame, EsportsMode, EsportsMap } = models;

// ---------------------------------------------------------------- views

async function catalogueNames(gameIds, modeIds, mapIds) {
  const [games, modes, maps] = await Promise.all([
    EsportsGame.findAll({ where: { id: [...new Set(gameIds)] } }),
    EsportsMode.findAll({ where: { id: [...new Set(modeIds)] } }),
    EsportsMap.findAll({ where: { id: [...new Set(mapIds)] } }),
  ]);
  const by = (rows) => new Map(rows.map((r) => [r.id, r]));
  return { games: by(games), modes: by(modes), maps: by(maps) };
}

/** M22: the organisers of these tournaments (M14 lite), for "by {organisation}" on cards. */
async function organisersOf(rows) {
  const ids = rows.map((t) => t.organisationId).filter(Boolean);
  return ids.length ? require('../organisations/organisations.service').publicRefs(ids) : new Map();
}
const named = (r) => (r ? { id: r.id, key: r.key, nameEn: r.nameEn, nameBn: r.nameBn } : null);

/** Slots taken (holding a slot) and the waitlist length, per tournament. */
async function slotCounts(ids) {
  if (!ids.length) return new Map();
  const rows = await EsportsRegistration.findAll({
    where: { tournamentId: ids, status: [...rules.HOLDING, 'waitlisted', 'offered'] },
    attributes: ['tournamentId', 'status', [sequelize.fn('COUNT', sequelize.col('id')), 'n']],
    group: ['tournamentId', 'status'],
    raw: true,
  });
  const out = new Map(ids.map((id) => [id, { taken: 0, waitlist: 0 }]));
  for (const r of rows) {
    const c = out.get(r.tournamentId);
    if (rules.HOLDING.includes(r.status)) c.taken += Number(r.n);
    else c.waitlist += Number(r.n);
  }
  return out;
}

function card(t, names, counts) {
  const mode = names.modes.get(t.modeId);
  return {
    id: t.id,
    slug: t.slug,
    titleEn: t.titleEn,
    titleBn: t.titleBn,
    game: named(names.games.get(t.gameId)),
    mode: mode ? { ...named(mode), teamSize: mode.teamSize, maxSubs: mode.maxSubs } : null,
    tier: t.tier,
    format: t.format,
    entryUnit: t.entryUnit,
    entryFee: money(t.entryFeePoisha),
    prizePool: money(t.prizePoolPoisha),
    killReward: money(t.killRewardPoisha),
    maxPaidKills: t.maxPaidKills ?? null,
    organisationId: t.organisationId ?? null,
    organiser: t.organisationId ? (names.orgs?.get(t.organisationId) ?? null) : null,
    maxSlots: t.maxSlots,
    minParticipants: t.minParticipants,
    slotsTaken: counts.get(t.id)?.taken ?? 0,
    waitlist: counts.get(t.id)?.waitlist ?? 0,
    registrationOpensAt: t.registrationOpensAt,
    registrationClosesAt: t.registrationClosesAt,
    startsAt: t.startsAt,
    status: t.status,
    featured: t.featured,
  };
}

async function detailOf(t, { staff = false, transaction } = {}) {
  const [prizes, stages, matches, streams] = await Promise.all([
    EsportsPrizePlace.findAll({ where: { tournamentId: t.id }, order: [['place', 'ASC']], transaction }),
    EsportsStage.findAll({ where: { tournamentId: t.id }, order: [['seq', 'ASC']], transaction }),
    EsportsMatch.findAll({ where: { tournamentId: t.id }, order: [['seq', 'ASC']], transaction }),
    EsportsStream.findAll({ where: { tournamentId: t.id, status: 'active' }, order: [['sort', 'ASC']], transaction }),
  ]);
  const names = await catalogueNames([t.gameId], [t.modeId], matches.map((m) => m.mapId));
  names.orgs = await organisersOf([t]);
  const counts = await slotCounts([t.id]);
  return {
    ...card(t, names, counts),
    rulesMd: t.rulesMd,
    placementPoints: t.placementPoints,
    killPoints: t.killPoints,
    prizes: prizes.map((p) => ({ place: p.place, amount: money(p.amountPoisha) })),
    stages: stages.map((s) => ({ id: s.id, seq: s.seq, nameEn: s.nameEn, nameBn: s.nameBn, kind: s.kind, checkinOpensAt: s.checkinOpensAt, checkinClosesAt: s.checkinClosesAt })),
    matches: matches.map((m) => ({ id: m.id, stageId: m.stageId, seq: m.seq, map: named(names.maps.get(m.mapId)), startsAt: m.startsAt, status: m.status, resultsPostedAt: m.resultsPostedAt ?? null, disputeClosesAt: m.disputeClosesAt ?? null })),
    streams: streams.map((s) => ({ id: s.id, matchId: s.matchId ?? null, platform: s.platform, url: s.url, title: s.title, isLive: s.isLive, startsAt: s.startsAt ?? null })),
    publishedAt: t.publishedAt ?? null,
    finalisedAt: t.finalisedAt ?? null,
    cancelReason: t.cancelReason ?? null,
    ...(staff
      ? {
          submissionId: t.submissionId ?? null,
          pointsPresetId: t.pointsPresetId ?? null,
          settingsSnapshot: t.settingsSnapshot ?? null,
          settlement: t.settlement ?? null,
          createdBy: t.createdBy,
          lockVersion: t.lockVersion,
          updatedAt: t.updatedAt,
        }
      : {}),
  };
}

// ---------------------------------------------------------------- lists

const decodeCursor = (c) => {
  if (!c) return null;
  const i = c.lastIndexOf('_');
  return { at: new Date(c.slice(0, i)), id: c.slice(i + 1) };
};

/** GET /esports/tournaments (public) and /admin/esports/tournaments (staff, every status). */
async function list({ game, mode, tier, status, featured, organisationId, cursor, limit = 20, staff = false }) {
  const where = {};
  if (organisationId) where.organisationId = organisationId;
  if (game) {
    const g = await EsportsGame.findOne({ where: { [Op.or]: [{ key: game }, ...(/^[0-9a-f-]{36}$/.test(game) ? [{ id: game }] : [])] } });
    where.gameId = g ? g.id : null;
  }
  if (mode) where.modeId = mode;
  if (tier) where.tier = tier;
  if (featured !== undefined) where.featured = featured;
  const allowed = staff ? Object.keys(rules.TOURNAMENT) : rules.PUBLIC;
  where.status = status ? (Array.isArray(status) ? status : [status]).filter((s) => allowed.includes(s)) : staff ? allowed : rules.PUBLIC.filter((s) => s !== 'cancelled');
  const after = decodeCursor(cursor);
  if (after) where[Op.or] = [{ startsAt: { [Op.gt]: after.at } }, { startsAt: after.at, id: { [Op.gt]: after.id } }];
  const rows = await EsportsTournament.findAll({ where, order: [['startsAt', 'ASC'], ['id', 'ASC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const names = await catalogueNames(page.map((t) => t.gameId), page.map((t) => t.modeId), []);
  names.orgs = await organisersOf(page);
  const counts = await slotCounts(page.map((t) => t.id));
  const last = page[page.length - 1];
  return { items: page.map((t) => card(t, names, counts)), nextCursor: rows.length > limit ? `${last.startsAt.toISOString()}_${last.id}` : null };
}

/** GET /esports/tournaments/:slugOrId (public; drafts and tournaments in review are hidden). */
async function publicDetail(slugOrId) {
  const t = await EsportsTournament.findOne({ where: /^[0-9a-f-]{36}$/.test(slugOrId) ? { id: slugOrId } : { slug: slugOrId } });
  if (!t || !rules.PUBLIC.includes(t.status)) throw E.notFound('Tournament');
  return detailOf(t);
}

async function adminDetail(id) {
  const t = await EsportsTournament.findByPk(id);
  if (!t) throw E.notFound('Tournament');
  return detailOf(t, { staff: true });
}

// ---------------------------------------------------------------- authoring (FR-06)

/** Resolve a body into tournament fields, prize rows and match rows (validates catalogue refs). */
async function resolveDraft(body, { transaction } = {}) {
  const game = await gameRow(body.gameId, { transaction });
  const mode = await modeRow(body.modeId, game.id, { transaction });
  await mapRows(body.matches.map((m) => m.mapId), game.id, { transaction });
  let placementPoints = body.placementPoints;
  let killPoints = body.killPoints;
  if (body.pointsPresetId) {
    const p = await presetRow(body.pointsPresetId, game.id, { transaction });
    placementPoints = placementPoints ?? p.placementPoints;
    killPoints = killPoints ?? p.killPoints;
  }
  if (!placementPoints || killPoints === undefined || killPoints === null) throw fail('POINTS_INVALID');
  const matches = body.matches.map((m) => ({ mapId: m.mapId, startsAt: new Date(m.startsAt) })).sort((a, b) => a.startsAt - b.startsAt);
  const startsAt = matches[0].startsAt;
  const closes = body.registrationClosesAt ? new Date(body.registrationClosesAt) : new Date(startsAt.getTime() - settings.get('esports.registration_close_minutes') * 60000);
  const prizes = body.prizes.map((p) => ({ place: p.place, amount: p.amount }));
  return {
    mode,
    fields: {
      gameId: game.id,
      modeId: mode.id,
      titleEn: body.titleEn.trim(),
      titleBn: body.titleBn.trim(),
      tier: body.tier,
      format: body.format,
      entryUnit: mode.teamSize > 1 ? 'squad' : 'player',
      entryFeePoisha: body.entryFee,
      maxSlots: body.maxSlots,
      minParticipants: body.minParticipants,
      prizePoolPoisha: prizes.reduce((s, p) => s + p.amount, 0),
      killRewardPoisha: body.killReward ?? 0,
      maxPaidKills: body.maxPaidKills ?? null,
      pointsPresetId: body.pointsPresetId ?? null,
      placementPoints,
      killPoints,
      registrationOpensAt: new Date(body.registrationOpensAt),
      registrationClosesAt: closes,
      startsAt,
      rulesMd: body.rulesMd ?? '',
      featured: Boolean(body.featured),
    },
    prizes,
    matches,
  };
}

/** Stage and matches of a draft (one main stage in step 1); check-in from the live settings. */
async function writeSchedule(t, matches, { transaction, snap = null }) {
  const open = snap?.['esports.checkin_open_minutes'] ?? settings.get('esports.checkin_open_minutes');
  const close = snap?.['esports.checkin_close_minutes'] ?? settings.get('esports.checkin_close_minutes');
  const w = rules.checkinWindow(matches[0].startsAt, open, close);
  const stage = await EsportsStage.create({ tournamentId: t.id, seq: 1, nameEn: 'Main', nameBn: 'মূল পর্ব', kind: 'main', checkinOpensAt: w.opensAt, checkinClosesAt: w.closesAt }, { transaction });
  for (const [i, m] of matches.entries()) {
    await EsportsMatch.create({ tournamentId: t.id, stageId: stage.id, seq: i + 1, mapId: m.mapId, startsAt: m.startsAt }, { transaction });
  }
}

/** M22: an organiser's per-kill reward needs a cap, so the prize fund can be sized (Q126 for organisers). */
function killCapBlock(fields, organised) {
  return organised && fields.killRewardPoisha > 0 && !fields.maxPaidKills ? 'ESPORTS_KILL_CAP_REQUIRED' : null;
}

/**
 * POST /admin/esports/tournaments (manage_esports): a draft. With `org` (the M22 console) the draft
 * belongs to that organisation (organiser_type organisation).
 */
async function createDraft(actor, body, req, { org = null } = {}) {
  return sequelize.transaction(async (transaction) => {
    const d = await resolveDraft(body, { transaction });
    if (killCapBlock(d.fields, Boolean(org))) throw fail('ESPORTS_KILL_CAP_REQUIRED');
    const id = uuid7();
    const owner = org ? { organiserType: 'organisation', organisationId: org.id } : {};
    const t = await EsportsTournament.create({ id, slug: rules.slugify(d.fields.titleEn, id.slice(-6)), ...d.fields, ...owner, status: 'draft', createdBy: actor.id }, { transaction });
    await EsportsPrizePlace.bulkCreate(d.prizes.map((p) => ({ tournamentId: t.id, place: p.place, amountPoisha: p.amount })), { transaction });
    await writeSchedule(t, d.matches, { transaction });
    await audit.record({ action: 'esports_tournament.created', actor, entityType: 'esports_tournament', entityId: t.id, after: { titleEn: t.titleEn, entryFee: t.entryFeePoisha, prizePool: t.prizePoolPoisha }, req }, { transaction });
    return detailOf(t, { staff: true, transaction });
  });
}

const EDITABLE_AFTER_PUBLISH = ['titleEn', 'titleBn', 'rulesMd', 'featured'];

/**
 * PATCH /admin/esports/tournaments/:id. A draft takes the whole body (its prize table and schedule are
 * replaced); after submit only the title, rules and featured flag change (edge case 18).
 */
async function update(actor, id, body, req) {
  return sequelize.transaction(async (transaction) => {
    const t = await EsportsTournament.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!t) throw E.notFound('Tournament');
    if (['finalised', 'paid_out', 'cancelled'].includes(t.status)) throw fail('ESPORTS_TOURNAMENT_STATE');
    const before = { titleEn: t.titleEn, status: t.status, lockVersion: t.lockVersion };
    if (t.status === 'draft' && body.gameId) {
      const d = await resolveDraft({ ...body }, { transaction });
      if (killCapBlock(d.fields, isOrganised(t))) throw fail('ESPORTS_KILL_CAP_REQUIRED');
      await t.update({ ...d.fields, updatedBy: actor.id, lockVersion: t.lockVersion + 1 }, { transaction });
      await EsportsPrizePlace.destroy({ where: { tournamentId: t.id }, transaction });
      await EsportsMatch.destroy({ where: { tournamentId: t.id }, transaction });
      await EsportsStage.destroy({ where: { tournamentId: t.id }, transaction });
      await EsportsPrizePlace.bulkCreate(d.prizes.map((p) => ({ tournamentId: t.id, place: p.place, amountPoisha: p.amount })), { transaction });
      await writeSchedule(t, d.matches, { transaction });
      // M22: the prize fund follows the draft (a top-up is needed; a smaller pool than deposited is refused).
      if (isOrganised(t)) await organiser.onDraftChanged(t, { transaction });
    } else {
      if (rules.lockedChange(body).length) throw fail('ESPORTS_PRIZE_TABLE_LOCKED', { fields: rules.lockedChange(body) });
      const patch = Object.fromEntries(EDITABLE_AFTER_PUBLISH.filter((k) => body[k] !== undefined).map((k) => [k, typeof body[k] === 'string' ? body[k].trim() : body[k]]));
      await t.update({ ...patch, updatedBy: actor.id, lockVersion: t.lockVersion + 1 }, { transaction });
    }
    await audit.record({ action: 'esports_tournament.updated', actor, entityType: 'esports_tournament', entityId: t.id, before, after: { titleEn: t.titleEn, lockVersion: t.lockVersion }, req }, { transaction });
    realtime.toRoom(rooms.tournament(t.id), 'esports.status_changed', { tournamentId: t.id, status: t.status });
    return detailOf(t, { staff: true, transaction });
  });
}

/** POST /admin/esports/tournaments/:id/submit: draft → review (M05; another reviewer approves, FR-07). */
async function submit(actor, id, req) {
  return sequelize.transaction(async (transaction) => {
    const t = await EsportsTournament.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!t) throw E.notFound('Tournament');
    if (!rules.canTournament(t.status, 'review')) throw fail('ESPORTS_TOURNAMENT_STATE');
    const prizes = await EsportsPrizePlace.findAll({ where: { tournamentId: t.id }, transaction });
    const matches = await EsportsMatch.findAll({ where: { tournamentId: t.id }, order: [['seq', 'ASC']], transaction });
    const mode = await EsportsMode.findByPk(t.modeId, { transaction });
    const block = rules.draftBlock(
      {
        prizes: prizes.map((p) => ({ place: p.place, amount: p.amountPoisha })),
        maxSlots: t.maxSlots,
        minParticipants: t.minParticipants,
        entryUnit: t.entryUnit,
        format: t.format,
        registrationOpensAt: t.registrationOpensAt,
        registrationClosesAt: t.registrationClosesAt,
        startsAt: t.startsAt,
        matches: matches.map((m) => ({ startsAt: m.startsAt })),
        placementPoints: t.placementPoints,
      },
      mode,
      new Date()
    );
    if (block) throw fail(block);
    // M22: an organiser tournament needs an active contract, no long-overdue invoice and a funded prize pool.
    if (isOrganised(t)) await organiser.submitBlock(t, { transaction });
    const game = await EsportsGame.findByPk(t.gameId, { transaction });
    const org = isOrganised(t) ? (await organisersOf([t])).get(t.organisationId) : null;
    const sub = await moderation.submit(
      {
        kind: 'esports_tournament',
        subjectId: t.id,
        payload: {
          tournamentId: t.id,
          gameKey: game.key,
          modeKey: mode.key,
          entryUnit: t.entryUnit,
          entryFee: t.entryFeePoisha,
          maxSlots: t.maxSlots,
          minParticipants: t.minParticipants,
          prizes: prizes.map((p) => ({ place: p.place, amount: p.amountPoisha })).sort((a, b) => a.place - b.place),
          prizePool: t.prizePoolPoisha,
          killReward: t.killRewardPoisha,
          maxPaidKills: t.maxPaidKills ?? null,
          organisationId: t.organisationId ?? null,
          organiserName: org?.name ?? null,
          matches: matches.length,
          registrationOpensAt: t.registrationOpensAt.toISOString(),
          startsAt: t.startsAt.toISOString(),
        },
        title: t.titleEn,
        submittedBy: actor.id,
        isEdit: Boolean(t.submissionId),
      },
      { transaction }
    );
    await t.update({ status: 'review', submissionId: sub.id, updatedBy: actor.id }, { transaction });
    await audit.record({ action: 'esports_tournament.submitted', actor, entityType: 'esports_tournament', entityId: t.id, after: { status: 'review' }, req }, { transaction });
    return detailOf(t, { staff: true, transaction });
  });
}

/** M05 checks for a tournament: the draft rules again (hard), and a soft warning for a large subsidy risk. */
async function checksFor(tournamentId, { transaction }) {
  const t = await EsportsTournament.findByPk(tournamentId, { transaction });
  if (!t) return [];
  const prizes = await EsportsPrizePlace.findAll({ where: { tournamentId }, transaction });
  const matches = await EsportsMatch.findAll({ where: { tournamentId }, order: [['seq', 'ASC']], transaction });
  const mode = await EsportsMode.findByPk(t.modeId, { transaction });
  const block = rules.draftBlock(
    {
      prizes: prizes.map((p) => ({ place: p.place, amount: p.amountPoisha })),
      maxSlots: t.maxSlots,
      minParticipants: t.minParticipants,
      entryUnit: t.entryUnit,
      format: t.format,
      registrationOpensAt: t.registrationOpensAt,
      registrationClosesAt: t.registrationClosesAt,
      startsAt: t.startsAt,
      matches: matches.map((m) => ({ startsAt: m.startsAt })),
      placementPoints: t.placementPoints,
    },
    mode,
    new Date()
  );
  // At the minimum fill, prizes beyond fees are a guaranteed subsidy (FR-25): a warning, not a block.
  // An organiser's prizes are pre-funded (M22-FR-05), so Kriraghor never covers a gap there.
  const atMinimum = t.entryFeePoisha * t.minParticipants;
  const gap = isOrganised(t) ? 0 : t.prizePoolPoisha - atMinimum;
  return [
    { key: 'schedule_and_prizes', severity: 'hard', result: block ? 'fail' : 'pass', detail: block },
    { key: 'subsidy_at_minimum', severity: 'soft', result: gap > 0 ? 'warn' : 'pass', detail: gap > 0 ? `Prizes exceed fees at the minimum fill by ৳${gap / 100}` : null },
  ];
}

/** Apply an M05 decision (consumer). Approved → scheduled with the settings snapshot; otherwise back to draft. */
async function applyDecision(submissionId, status, { transaction }) {
  const sub = await moderation.getById(submissionId, { transaction });
  if (!sub) return null;
  const t = await EsportsTournament.findByPk(sub.payload.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
  const ack = () =>
    events.publish(transaction, { name: 'submission.applied', aggregateType: 'submission', aggregateId: sub.id, payload: { submissionId: sub.id, kind: sub.kind, subjectId: sub.subjectId, version: sub.version, submittedBy: sub.submittedBy } });
  if (!t || t.status !== 'review' || t.submissionId !== sub.id) {
    if (status === 'approved') await ack();
    return null;
  }
  if (status !== 'approved') {
    await t.update({ status: 'draft' }, { transaction });
    await audit.record({ action: 'esports_tournament.returned', actor: null, entityType: 'esports_tournament', entityId: t.id, after: { status: 'draft', reasonCode: sub.reasonCode ?? null }, meta: { submissionId: sub.id } }, { transaction });
    return 'draft';
  }
  const snap = snapshot();
  const matches = await EsportsMatch.findAll({ where: { tournamentId: t.id }, order: [['seq', 'ASC']], transaction });
  const w = rules.checkinWindow(matches[0].startsAt, snap['esports.checkin_open_minutes'], snap['esports.checkin_close_minutes']);
  await EsportsStage.update({ checkinOpensAt: w.opensAt, checkinClosesAt: w.closesAt }, { where: { tournamentId: t.id }, transaction });
  await t.update({ status: 'scheduled', settingsSnapshot: snap, publishedAt: new Date() }, { transaction });
  if (isOrganised(t)) await organiser.onPublished(t, { transaction });
  await audit.record({ action: 'esports_tournament.published', actor: null, entityType: 'esports_tournament', entityId: t.id, after: { status: 'scheduled' }, meta: { submissionId: sub.id, decidedBy: sub.decidedBy } }, { transaction });
  await events.publish(transaction, {
    name: 'esports_tournament.published',
    aggregateType: 'esports_tournament',
    aggregateId: t.id,
    payload: { tournamentId: t.id, gameId: t.gameId, entryFee: t.entryFeePoisha, prizePool: t.prizePoolPoisha, startsAt: t.startsAt.toISOString() },
  });
  await ack();
  return 'scheduled';
}

// ---------------------------------------------------------------- cancel (FR-30) and streams (FR-29)

/**
 * POST /admin/esports/tournaments/:id/cancel (manage_esports + step-up esports.money): every paid entry
 * is refunded 100% (§6.6), unpaid holds and the waitlist are cancelled, the matches are cancelled.
 */
async function cancel(actor, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const t = await EsportsTournament.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!t) throw E.notFound('Tournament');
    if (!rules.canTournament(t.status, 'cancelled')) throw fail('ESPORTS_TOURNAMENT_STATE');
    if (t.status === 'review') await moderation.withdrawSubject('esports_tournament', t.id, { transaction });
    const refunded = await cancelInTx(t, { situation: 'cancelled', reason, actor, transaction });
    await audit.record({ action: 'esports_tournament.cancelled', actor, entityType: 'esports_tournament', entityId: t.id, after: { status: 'cancelled', refunded }, reason, req }, { transaction });
    return detailOf(t, { staff: true, transaction });
  });
}

/** Cancel inside a transaction (staff cancel, or min_participants not met at close, FR-12). */
async function cancelInTx(t, { situation, reason, actor = null, transaction }) {
  const refunded = await require('./registrations.service').closeAllInTx(t, { situation, actor, transaction });
  if (isOrganised(t)) await organiser.onCancelled(t, { actor, transaction });
  await EsportsMatch.update({ status: 'cancelled', cancelledAt: new Date(), cancelReason: reason }, { where: { tournamentId: t.id, status: { [Op.notIn]: ['final', 'cancelled'] } }, transaction });
  await t.update({ status: 'cancelled', cancelReason: reason, cancelledAt: new Date() }, { transaction });
  await events.publish(transaction, {
    name: 'esports_tournament.cancelled',
    aggregateType: 'esports_tournament',
    aggregateId: t.id,
    payload: { tournamentId: t.id, reasonCode: situation, refunded },
  });
  realtime.toRoom(rooms.tournament(t.id), 'esports.status_changed', { tournamentId: t.id, status: 'cancelled' });
  return refunded;
}

/** PUT /admin/esports/tournaments/:id/streams: replace the stream list (https on known hosts). */
async function setStreams(actor, id, { streams }, req) {
  return sequelize.transaction(async (transaction) => {
    const t = await EsportsTournament.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!t) throw E.notFound('Tournament');
    for (const s of streams) {
      const block = rules.streamBlock(s.platform, s.url);
      if (block) throw fail(block);
    }
    const matchIds = new Set((await EsportsMatch.findAll({ where: { tournamentId: t.id }, attributes: ['id'], transaction })).map((m) => m.id));
    if (streams.some((s) => s.matchId && !matchIds.has(s.matchId))) throw E.notFound('Match');
    await EsportsStream.update({ status: 'removed' }, { where: { tournamentId: t.id, status: 'active' }, transaction });
    for (const [i, s] of streams.entries()) {
      await EsportsStream.create({ tournamentId: t.id, matchId: s.matchId ?? null, platform: s.platform, url: s.url, title: s.title, isLive: Boolean(s.isLive), startsAt: s.startsAt ?? null, sort: i }, { transaction });
    }
    await audit.record({ action: 'esports_tournament.streams_set', actor, entityType: 'esports_tournament', entityId: t.id, after: { streams: streams.length, live: streams.filter((s) => s.isLive).length }, req }, { transaction });
    if (streams.some((s) => s.isLive)) realtime.toRoom(rooms.tournament(t.id), 'esports.stream_live', { tournamentId: t.id });
    return detailOf(t, { staff: true, transaction });
  });
}

/** Move a tournament (lifecycle job and results); publishes the change to its room. */
async function moveInTx(t, to, { transaction }) {
  if (!rules.canTournament(t.status, to)) return false;
  await t.update({ status: to }, { transaction });
  realtime.toRoom(rooms.tournament(t.id), 'esports.status_changed', { tournamentId: t.id, status: to });
  return true;
}

module.exports = { list, publicDetail, adminDetail, detailOf, createDraft, update, submit, checksFor, applyDecision, cancel, cancelInTx, setStreams, moveInTx, setting, slotCounts };
