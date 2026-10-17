'use strict';

/**
 * M21 results, disputes, standings and fair play (FR-18 to FR-22, §6.4, §8.3).
 *
 *   match: … ─enter (draft)─▶ ─post─▶ results_pending (dispute window esports.result_dispute_minutes)
 *          results_pending ─player disputes─▶ disputed ─staff resolves─▶ results_pending | final
 *          results_pending ─window closes, no open dispute─▶ final (job esports.tick)
 *
 * Disputes: an entrant disputes within the window with evidence (at most esports.dispute_max_per_entry
 * per match). Since M17 (17 Oct 2026) each dispute is also an M17 case (source esports_result, this
 * row's id) on the unified staff desk; the decision comes back through resolveInTx (rejected or
 * corrected), and M21 keeps its own row for the match machine and the finalise guard.
 * Standings are a projection rebuilt from posted and final results of entries still in the stage.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const realtime = require('../../common/realtime');
const models = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const { fail, setting, rooms } = require('./esports.common');
const rules = require('./esports.rules');

const {
  sequelize,
  EsportsTournament,
  EsportsStage,
  EsportsMatch,
  EsportsRegistration,
  EsportsRegistrationPlayer,
  EsportsResult,
  EsportsResultPlayer,
  EsportsResultEvidence,
  EsportsResultDispute,
  EsportsDisqualification,
  EsportsStanding,
  EsportsRoomCredential,
  EsportsSquad,
} = models;

// A match without a room can still be played (and scored) once it has started.
const PLAYABLE = ['scheduled', 'room_ready', 'room_revealed', 'live'];

// ---------------------------------------------------------------- helpers

async function lockMatch(id, transaction) {
  const m = await EsportsMatch.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!m) throw E.notFound('Match');
  return m;
}

/** Entries that play a match: checked in for its stage (no-shows and DQs are out). regId → Set(userIds). */
async function matchEntries(m, { transaction } = {}) {
  const regs = await EsportsRegistration.findAll({ where: { tournamentId: m.tournamentId, status: 'checked_in' }, attributes: ['id'], transaction });
  const players = await EsportsRegistrationPlayer.findAll({ where: { registrationId: regs.map((r) => r.id), status: 'active' }, attributes: ['registrationId', 'userId'], transaction });
  const map = new Map(regs.map((r) => [r.id, new Set()]));
  for (const p of players) map.get(p.registrationId).add(p.userId);
  return map;
}

/** A display name per entry: the squad name, or the player's IGN (never a real name, FR-32). */
async function entryNames(regIds, { transaction } = {}) {
  const regs = await EsportsRegistration.findAll({ where: { id: regIds }, transaction });
  const squads = new Map((await EsportsSquad.findAll({ where: { id: regs.map((r) => r.squadId).filter(Boolean) }, transaction })).map((s) => [s.id, s]));
  const players = await require('./registrations.service').playersOf(regIds, { transaction });
  return new Map(
    regs.map((r) => {
      const squad = r.squadId ? squads.get(r.squadId) : null;
      const list = players.get(r.id) ?? [];
      return [r.id, { name: squad ? squad.name : list[0]?.ign ?? '—', tag: squad?.tag ?? null, slotNo: r.slotNo ?? null, players: list.filter((p) => !p.isSubstitute).map((p) => ({ userId: p.userId, ign: p.ign, username: p.username })) }];
    })
  );
}

const resultRow = (r, players, names) => ({
  registrationId: r.registrationId,
  entry: names.get(r.registrationId) ?? null,
  placement: r.placement ?? null,
  kills: r.kills,
  placementPoints: r.placementPoints,
  killPoints: r.killPointsTotal,
  totalPoints: r.totalPoints,
  status: r.status,
  players: players.filter((p) => p.resultId === r.id).map((p) => ({ userId: p.userId, kills: p.kills })),
});

async function resultsOf(m, { statuses, transaction } = {}) {
  const rows = await EsportsResult.findAll({ where: { matchId: m.id, ...(statuses ? { status: statuses } : {}) }, order: [['placement', 'ASC NULLS LAST']], transaction });
  const players = await EsportsResultPlayer.findAll({ where: { resultId: rows.map((r) => r.id) }, transaction });
  const names = await entryNames(rows.map((r) => r.registrationId), { transaction });
  return rows.map((r) => resultRow(r, players, names));
}

async function matchView(m, { staff = false, transaction } = {}) {
  const posted = ['results_pending', 'disputed', 'final'].includes(m.status);
  const disputes = staff ? await EsportsResultDispute.findAll({ where: { matchId: m.id }, order: [['createdAt', 'ASC']], transaction }) : [];
  return {
    id: m.id,
    tournamentId: m.tournamentId,
    seq: m.seq,
    startsAt: m.startsAt,
    status: m.status,
    resultsPostedAt: m.resultsPostedAt ?? null,
    disputeClosesAt: m.disputeClosesAt ?? null,
    finalisedAt: m.finalisedAt ?? null,
    results: staff || posted ? await resultsOf(m, { statuses: staff ? undefined : ['posted', 'final'], transaction }) : [],
    ...(staff ? { disputes: disputes.map(serializeDispute) } : {}),
  };
}

const serializeDispute = (d) => ({ id: d.id, matchId: d.matchId, registrationId: d.registrationId, raisedBy: d.raisedBy, reason: d.reason, evidenceIds: d.evidenceIds, status: d.status, resolutionNote: d.resolutionNote ?? null, resolvedAt: d.resolvedAt ?? null, createdAt: d.createdAt });

/** GET /esports/matches/:id (public: status and posted results). */
async function publicMatch(id) {
  const m = await EsportsMatch.findByPk(id);
  if (!m) throw E.notFound('Match');
  const t = await EsportsTournament.findByPk(m.tournamentId);
  if (!rules.PUBLIC.includes(t.status)) throw E.notFound('Match');
  return matchView(m);
}

async function adminMatch(id) {
  const m = await EsportsMatch.findByPk(id);
  if (!m) throw E.notFound('Match');
  const entries = await matchEntries(m);
  const names = await entryNames([...entries.keys()]);
  return { ...(await matchView(m, { staff: true })), entries: [...entries.keys()].map((id) => ({ registrationId: id, ...names.get(id) })) };
}

// ---------------------------------------------------------------- standings (FR-19, §6.4)

/** Rebuild the stage projection from posted and final results of entries still in it. */
async function recomputeStandings(stageId, { transaction }) {
  const stage = await EsportsStage.findByPk(stageId, { transaction });
  const regs = await EsportsRegistration.findAll({ where: { tournamentId: stage.tournamentId, status: 'checked_in' }, transaction });
  const matches = await EsportsMatch.findAll({ where: { stageId, status: { [Op.ne]: 'cancelled' } }, transaction });
  const seq = new Map(matches.map((m) => [m.id, m.seq]));
  const results = await EsportsResult.findAll({ where: { matchId: [...seq.keys()], registrationId: regs.map((r) => r.id), status: ['posted', 'final'] }, transaction });
  const table = rules.standings(
    regs.map((r) => ({ registrationId: r.id, registeredAt: r.createdAt })),
    results.map((r) => ({ registrationId: r.registrationId, matchSeq: seq.get(r.matchId), placement: r.placement ?? null, kills: r.kills, total: r.totalPoints }))
  );
  await EsportsStanding.destroy({ where: { stageId, registrationId: { [Op.notIn]: table.map((r) => r.registrationId).concat(['00000000-0000-0000-0000-000000000000']) } }, transaction });
  for (const r of table) {
    await EsportsStanding.upsert({ stageId, registrationId: r.registrationId, rank: r.rank, totalPoints: r.totalPoints, wins: r.wins, kills: r.kills, lastPlacement: r.lastPlacement, matchesPlayed: r.matchesPlayed, updatedAt: new Date() }, { transaction });
  }
  transaction.afterCommit(() => realtime.toRoom(rooms.tournament(stage.tournamentId), 'esports.standings_updated', { tournamentId: stage.tournamentId, stageId }));
  return table;
}

/** GET /esports/tournaments/:id/standings */
async function standings(tournamentId) {
  const t = await EsportsTournament.findByPk(tournamentId);
  if (!t || !rules.PUBLIC.includes(t.status)) throw E.notFound('Tournament');
  const stage = await EsportsStage.findOne({ where: { tournamentId }, order: [['seq', 'ASC']] });
  const rows = stage ? await EsportsStanding.findAll({ where: { stageId: stage.id }, order: [['rank', 'ASC']] }) : [];
  const names = await entryNames(rows.map((r) => r.registrationId));
  return {
    tournamentId,
    stageId: stage?.id ?? null,
    tieBreakers: ['points', 'wins', 'kills', 'latest_placement', 'registered_at'],
    items: rows.map((r) => ({ rank: r.rank, registrationId: r.registrationId, entry: names.get(r.registrationId) ?? null, totalPoints: r.totalPoints, wins: r.wins, kills: r.kills, lastPlacement: r.lastPlacement ?? null, matchesPlayed: r.matchesPlayed })),
  };
}

// ---------------------------------------------------------------- results entry and posting (FR-18, FR-20)

/** Store one entry's result (draft or correction), with its per-player kills. */
async function writeResult(m, t, row, { actor, status, transaction }) {
  const kills = row.kills.reduce((a, k) => a + k.kills, 0);
  const p = rules.points({ placement: row.placement, kills }, { placementPoints: t.placementPoints, killPoints: t.killPoints });
  const existing = await EsportsResult.findOne({ where: { matchId: m.id, registrationId: row.registrationId }, transaction, lock: transaction.LOCK.UPDATE });
  const values = { placement: row.placement, kills, placementPoints: p.placementPoints, killPointsTotal: p.killPointsTotal, totalPoints: p.total, status, enteredBy: actor.id };
  const r = existing ? await existing.update({ ...values, version: existing.version + 1 }, { transaction }) : await EsportsResult.create({ matchId: m.id, registrationId: row.registrationId, ...values }, { transaction });
  await EsportsResultPlayer.destroy({ where: { resultId: r.id }, transaction });
  const perPlayer = row.kills.filter((k) => k.kills > 0);
  if (perPlayer.length) await EsportsResultPlayer.bulkCreate(perPlayer.map((k) => ({ resultId: r.id, userId: k.userId, kills: k.kills })), { transaction });
  return r;
}

/** PUT /admin/esports/matches/:id/results (enter_results): a draft for some or all entries. */
async function enter(actor, matchId, { rows }, req) {
  return sequelize.transaction(async (transaction) => {
    const m = await lockMatch(matchId, transaction);
    if (!PLAYABLE.includes(m.status)) throw fail('ESPORTS_MATCH_STATE');
    const t = await EsportsTournament.findByPk(m.tournamentId, { transaction });
    const entries = await matchEntries(m, { transaction });
    const drafts = await EsportsResult.findAll({ where: { matchId: m.id }, transaction });
    // Placements must be unique across the whole draft, not only this batch.
    const merged = new Map(drafts.map((d) => [d.registrationId, { registrationId: d.registrationId, placement: d.placement ?? null, kills: [] }]));
    for (const r of rows) merged.set(r.registrationId, r);
    const block = rules.resultsBlock(rows, entries) ?? rules.resultsBlock([...merged.values()].map((r) => ({ ...r, kills: [] })), entries);
    if (block) throw fail(block);
    for (const row of rows) await writeResult(m, t, row, { actor, status: 'draft', transaction });
    await audit.record({ action: 'esports_results.entered', actor, entityType: 'esports_match', entityId: m.id, after: { rows: rows.length }, req }, { transaction });
    return matchView(m, { staff: true, transaction });
  });
}

/** POST /admin/esports/matches/:id/results/post: visible, dispute window opens; missing entries are DNP. */
async function post(actor, matchId, req) {
  return sequelize.transaction(async (transaction) => {
    const m = await lockMatch(matchId, transaction);
    if (!PLAYABLE.includes(m.status)) throw fail('ESPORTS_MATCH_STATE');
    const now = new Date();
    if (now < m.startsAt) throw fail('ESPORTS_TOO_EARLY');
    const t = await EsportsTournament.findByPk(m.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
    const entries = await matchEntries(m, { transaction });
    const have = new Set((await EsportsResult.findAll({ where: { matchId: m.id }, attributes: ['registrationId'], transaction })).map((r) => r.registrationId));
    for (const regId of entries.keys()) if (!have.has(regId)) await writeResult(m, t, { registrationId: regId, placement: null, kills: [] }, { actor, status: 'draft', transaction });
    await EsportsResult.update({ status: 'posted' }, { where: { matchId: m.id, status: 'draft', registrationId: [...entries.keys()] }, transaction });
    await EsportsResult.update({ status: 'void' }, { where: { matchId: m.id, status: 'draft' }, transaction });
    const minutes = setting(t, 'esports.result_dispute_minutes');
    await m.update({ status: 'results_pending', resultsPostedAt: now, disputeClosesAt: new Date(now.getTime() + minutes * 60000) }, { transaction });
    await EsportsRoomCredential.update({ status: 'superseded' }, { where: { matchId: m.id, status: ['scheduled', 'revealed'] }, transaction });
    await recomputeStandings(m.stageId, { transaction });
    await advanceTournamentInTx(t, { transaction });
    await audit.record({ action: 'esports_results.posted', actor, entityType: 'esports_match', entityId: m.id, after: { entries: entries.size, disputeClosesAt: m.disputeClosesAt }, req }, { transaction });
    await events.publish(transaction, { name: 'esports_match.results_posted', aggregateType: 'esports_match', aggregateId: m.id, payload: { matchId: m.id, tournamentId: t.id, seq: m.seq, disputeClosesAt: m.disputeClosesAt.toISOString() } });
    transaction.afterCommit(() => realtime.toRoom(rooms.match(m.id), 'esports.results_posted', { matchId: m.id }));
    return matchView(m, { staff: true, transaction });
  });
}

/** live → results_pending once every match that counts has posted results. */
async function advanceTournamentInTx(t, { transaction }) {
  const ts = require('./tournaments.service');
  const matches = await EsportsMatch.findAll({ where: { tournamentId: t.id }, transaction });
  if (t.status === 'check_in' && matches.some((m) => !['scheduled', 'room_ready', 'room_revealed', 'cancelled'].includes(m.status))) await ts.moveInTx(t, 'live', { transaction });
  const counting = matches.filter((m) => m.status !== 'cancelled');
  if (t.status === 'live' && counting.length && counting.every((m) => ['results_pending', 'disputed', 'final'].includes(m.status))) await ts.moveInTx(t, 'results_pending', { transaction });
}

/** POST /admin/esports/matches/:id/cancel (manage_esports): a crashed lobby (edge case 8); standings use the rest. */
async function cancelMatch(actor, matchId, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const m = await lockMatch(matchId, transaction);
    if (!rules.canMatch(m.status, 'cancelled')) throw fail('ESPORTS_MATCH_STATE');
    await m.update({ status: 'cancelled', cancelledAt: new Date(), cancelReason: reason }, { transaction });
    await EsportsRoomCredential.update({ status: 'superseded' }, { where: { matchId: m.id, status: ['scheduled', 'revealed'] }, transaction });
    await EsportsResult.update({ status: 'void' }, { where: { matchId: m.id }, transaction });
    await recomputeStandings(m.stageId, { transaction });
    const t = await EsportsTournament.findByPk(m.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
    await advanceTournamentInTx(t, { transaction });
    await audit.record({ action: 'esports_match.cancelled', actor, entityType: 'esports_match', entityId: m.id, reason, req }, { transaction });
    await events.publish(transaction, { name: 'esports_match.cancelled', aggregateType: 'esports_match', aggregateId: m.id, payload: { matchId: m.id, tournamentId: m.tournamentId } });
    return matchView(m, { staff: true, transaction });
  });
}

// ---------------------------------------------------------------- evidence and disputes (FR-20)

/** The caller's entry in a match (a checked-in player), or null. */
async function myEntry(m, userId, transaction) {
  const entries = await matchEntries(m, { transaction });
  for (const [regId, users] of entries) if (users.has(userId)) return regId;
  return null;
}

/** POST /me/esports/matches/:id/evidence { kind, key | url, note } */
async function addEvidence(principal, matchId, { kind, key, url, note }) {
  return sequelize.transaction(async (transaction) => {
    const m = await EsportsMatch.findByPk(matchId, { transaction });
    if (!m) throw E.notFound('Match');
    const regId = await myEntry(m, principal.user.id, transaction);
    if (!regId) throw fail('ESPORTS_NOT_IN_MATCH');
    const file = kind === 'screenshot' ? await require('./profiles.service').ownUpload(principal.user.id, key) : null;
    if (kind === 'video_link' && rules.streamBlock('other', url)) throw fail('STREAM_URL_INVALID');
    const ev = await EsportsResultEvidence.create({ matchId: m.id, registrationId: regId, uploadedBy: principal.user.id, actorType: 'player', kind, fileKey: file?.key ?? null, mime: file?.mime ?? null, url: kind === 'video_link' ? url : null, note: note ?? null }, { transaction });
    return { id: ev.id, matchId: m.id, kind, createdAt: ev.createdAt };
  });
}

/** POST /me/esports/matches/:id/disputes { reason, evidenceIds } */
async function dispute(principal, matchId, { reason, evidenceIds = [] }, req) {
  return sequelize.transaction(async (transaction) => {
    const m = await lockMatch(matchId, transaction);
    const regId = await myEntry(m, principal.user.id, transaction);
    const t = await EsportsTournament.findByPk(m.tournamentId, { transaction });
    const used = regId ? await EsportsResultDispute.count({ where: { matchId: m.id, registrationId: regId }, transaction }) : 0;
    const block = rules.disputeBlock({ matchStatus: m.status, disputeClosesAt: m.disputeClosesAt, now: new Date(), isEntrant: Boolean(regId), openOrUsed: used, max: setting(t, 'esports.dispute_max_per_entry') });
    if (block) throw fail(block);
    const own = evidenceIds.length ? await EsportsResultEvidence.count({ where: { id: evidenceIds, matchId: m.id, registrationId: regId }, transaction }) : 0;
    if (own !== evidenceIds.length) throw E.notFound('Evidence');
    const open = await EsportsResultDispute.findOne({ where: { matchId: m.id, registrationId: regId, status: 'open' }, transaction });
    if (open) throw fail('ESPORTS_DISPUTE_LIMIT');
    const d = await EsportsResultDispute.create({ matchId: m.id, registrationId: regId, raisedBy: principal.user.id, reason, evidenceIds }, { transaction });
    if (m.status === 'results_pending') await m.update({ status: 'disputed' }, { transaction });
    const kase = await require('../trust/disputes.service').openFromSource(
      {
        sourceType: 'esports_result',
        sourceId: d.id,
        ref: `${t.slug.slice(0, 32)}-M${m.seq}`,
        category: 'result_wrong',
        claimantId: principal.user.id,
        respondentId: null,
        money: false,
        policyKey: 'esports.result_dispute',
        policy: { matchId: m.id, tournamentId: t.id, registrationId: regId, seq: m.seq, disputeClosesAt: m.disputeClosesAt.toISOString() },
        statement: reason,
        systemRefs: evidenceIds.map((id) => ({ type: 'esports_evidence', id })),
      },
      { actor: principal, transaction }
    );
    await audit.record({ action: 'esports_result.disputed', actor: principal, entityType: 'esports_match', entityId: m.id, after: { disputeId: d.id }, req }, { transaction });
    await events.publish(transaction, { name: 'esports_result.disputed', aggregateType: 'esports_match', aggregateId: m.id, payload: { matchId: m.id, tournamentId: m.tournamentId, disputeId: d.id, registrationId: regId } });
    return { ...serializeDispute(d), caseCode: kase.code };
  });
}

/** GET /admin/esports/disputes?status=open */
async function listDisputes({ status = 'open', tournamentId } = {}) {
  const where = { status };
  if (tournamentId) where.matchId = (await EsportsMatch.findAll({ where: { tournamentId }, attributes: ['id'] })).map((m) => m.id);
  const rows = await EsportsResultDispute.findAll({ where, order: [['createdAt', 'ASC']], limit: 200 });
  const names = await entryNames(rows.map((r) => r.registrationId));
  return { items: rows.map((d) => ({ ...serializeDispute(d), entry: names.get(d.registrationId) ?? null })) };
}

/**
 * The decision on a result dispute, inside the M17 decision transaction (M17 targets port):
 * corrections replace the posted rows. With no dispute left open the match returns to
 * results_pending, or becomes final at once when its window has already closed.
 */
async function resolveInTx(actor, disputeId, { outcome, rows = [], note }, { transaction }) {
  const d = await EsportsResultDispute.findByPk(disputeId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!d) throw E.notFound('Dispute');
  if (d.status !== 'open') throw fail('ESPORTS_DISPUTE_NOT_OPEN');
  const m = await lockMatch(d.matchId, transaction);
  const t = await EsportsTournament.findByPk(m.tournamentId, { transaction });
  if (outcome === 'corrected') {
    const entries = await matchEntries(m, { transaction });
    const current = await EsportsResult.findAll({ where: { matchId: m.id, status: 'posted' }, transaction });
    const merged = new Map(current.map((c) => [c.registrationId, { registrationId: c.registrationId, placement: c.placement ?? null, kills: [] }]));
    for (const r of rows) merged.set(r.registrationId, r);
    const block = rules.resultsBlock(rows, entries) ?? rules.resultsBlock([...merged.values()].map((r) => ({ ...r, kills: [] })), entries);
    if (block) throw fail(block);
    for (const row of rows) await writeResult(m, t, row, { actor, status: 'posted', transaction });
    await recomputeStandings(m.stageId, { transaction });
    await events.publish(transaction, { name: 'esports_result.corrected', aggregateType: 'esports_match', aggregateId: m.id, payload: { matchId: m.id, tournamentId: m.tournamentId, disputeId: d.id, rows: rows.length } });
  }
  await d.update({ status: outcome, resolvedBy: actor.id, resolvedAt: new Date(), resolutionNote: note }, { transaction });
  const stillOpen = await EsportsResultDispute.count({ where: { matchId: m.id, status: 'open' }, transaction });
  if (!stillOpen && m.status === 'disputed') {
    if (m.disputeClosesAt <= new Date()) await finaliseMatchInTx(m, { transaction });
    else await m.update({ status: 'results_pending' }, { transaction });
  }
  await audit.record({ action: 'esports_result.dispute_resolved', actor, entityType: 'esports_match', entityId: m.id, after: { disputeId: d.id, outcome }, reason: note }, { transaction });
  await events.publish(transaction, { name: 'esports_result.dispute_resolved', aggregateType: 'esports_match', aggregateId: m.id, payload: { matchId: m.id, tournamentId: m.tournamentId, disputeId: d.id, raisedBy: d.raisedBy, outcome } });
  return serializeDispute(d);
}

/**
 * POST /admin/esports/disputes/:id/resolve { outcome: rejected | corrected, rows?, note }: kept for the
 * esports desk; it decides the M17 case, which calls resolveInTx.
 */
async function resolve(actor, disputeId, { outcome, rows = [], note }, req) {
  await require('../trust/disputes.service').decideForSource(actor, 'esports_result', disputeId, { outcome, rows, reason: note }, req);
  return serializeDispute(await EsportsResultDispute.findByPk(disputeId));
}

/** M17 describe: the match a case is about (no player PII; entry names are squad names or IGNs). */
async function disputeSummary(disputeId) {
  const d = await EsportsResultDispute.findByPk(disputeId);
  if (!d) return null;
  const m = await EsportsMatch.findByPk(d.matchId);
  const t = await EsportsTournament.findByPk(m.tournamentId);
  const names = await entryNames([d.registrationId]);
  return { kind: 'esports_result', id: d.id, matchId: m.id, seq: m.seq, matchStatus: m.status, tournamentId: t.id, tournamentSlug: t.slug, tournamentTitle: t.titleEn, registrationId: d.registrationId, entry: names.get(d.registrationId) ?? null, disputeStatus: d.status, disputeClosesAt: m.disputeClosesAt ?? null, evidenceIds: d.evidenceIds };
}

/** results_pending → final: results final, standings rebuilt (FR-21). */
async function finaliseMatchInTx(m, { transaction }) {
  await EsportsResult.update({ status: 'final' }, { where: { matchId: m.id, status: 'posted' }, transaction });
  await m.update({ status: 'final', finalisedAt: new Date() }, { transaction });
  await recomputeStandings(m.stageId, { transaction });
  await events.publish(transaction, { name: 'esports_match.finalised', aggregateType: 'esports_match', aggregateId: m.id, payload: { matchId: m.id, tournamentId: m.tournamentId } });
  transaction.afterCommit(() => realtime.toRoom(rooms.match(m.id), 'esports.match_status', { matchId: m.id, status: 'final' }));
}

/** Job step: dispute windows that closed with no open dispute make their match final. */
async function closeWindows(now = new Date()) {
  const due = await EsportsMatch.findAll({ where: { status: 'results_pending', disputeClosesAt: { [Op.lte]: now } }, attributes: ['id'] });
  let finalised = 0;
  for (const d of due) {
    await sequelize.transaction(async (transaction) => {
      const m = await lockMatch(d.id, transaction);
      if (m.status !== 'results_pending') return;
      await finaliseMatchInTx(m, { transaction });
      finalised += 1;
    });
  }
  return { finalised };
}

// ---------------------------------------------------------------- disqualification (FR-22, §6.7)

/** Disqualify an entry (or one player in it) inside a transaction. */
async function disqualifyInTx(actor, r, t, { reasonCode, note, userId = null, effects, evidence = [], transaction }) {
  if (r.status === 'disqualified') throw fail('ESPORTS_ALREADY_DISQUALIFIED');
  const dq = await EsportsDisqualification.create({ tournamentId: t.id, registrationId: r.id, userId, reasonCode, note, evidence, effects, decidedBy: actor.id }, { transaction });
  const before = { status: r.status };
  await r.update({ status: ['pending_payment', 'waitlisted', 'offered'].includes(r.status) ? 'cancelled' : 'disqualified', slotNo: r.status === 'pending_payment' ? null : r.slotNo }, { transaction });
  if (effects.removeFromStandings) {
    const stage = await EsportsStage.findOne({ where: { tournamentId: t.id }, transaction });
    await EsportsResult.update({ status: 'void' }, { where: { registrationId: r.id, status: { [Op.ne]: 'void' } }, transaction });
    if (stage) await recomputeStandings(stage.id, { transaction });
  }
  if (effects.forfeitPrize) await require('./prizes.service').forfeitForRegistrationInTx(actor, r, t, { transaction });
  if (effects.banUid && userId) {
    const player = await EsportsRegistrationPlayer.findOne({ where: { registrationId: r.id, userId }, transaction });
    const profile = player ? await models.EsportsGameProfile.findByPk(player.gameProfileId, { transaction }) : null;
    if (profile && profile.status !== 'banned') {
      const ban = await models.EsportsUidBan.create({ gameId: profile.gameId, uid: profile.uid, reasonCode: ['cheating', 'account_sharing', 'abuse'].includes(reasonCode) ? reasonCode : 'other', note, bannedBy: actor.id }, { transaction });
      await profile.update({ status: 'banned' }, { transaction });
      await audit.record({ action: 'esports_uid.banned', actor, entityType: 'esports_uid_ban', entityId: ban.id, after: { gameId: profile.gameId, reasonCode: ban.reasonCode }, reason: note }, { transaction });
    }
  }
  await audit.record({ action: 'esports_registration.disqualified', actor, entityType: 'esports_registration', entityId: r.id, before, after: { status: r.status, reasonCode, effects }, reason: note }, { transaction });
  await events.publish(transaction, { name: 'esports_registration.disqualified', aggregateType: 'esports_registration', aggregateId: r.id, payload: { registrationId: r.id, tournamentId: t.id, registrantUserId: r.registrantUserId, reasonCode } });
  return dq;
}

/** POST /admin/esports/registrations/:id/disqualify (manage_esports). */
async function disqualify(actor, registrationId, { reasonCode, note, userId, banUid = false, removeFromStandings = true }, req) {
  return sequelize.transaction(async (transaction) => {
    const r = await EsportsRegistration.findByPk(registrationId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw E.notFound('Registration');
    const t = await EsportsTournament.findByPk(r.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (t.status === 'cancelled') throw fail('ESPORTS_TOURNAMENT_STATE');
    const dq = await disqualifyInTx(actor, r, t, { reasonCode, note, userId: userId ?? null, effects: { forfeitPrize: true, removeFromStandings, banUid }, transaction });
    void req;
    return { id: dq.id, registrationId: r.id, status: r.status, reasonCode, createdAt: dq.createdAt };
  });
}

module.exports = {
  matchEntries,
  entryNames,
  publicMatch,
  adminMatch,
  recomputeStandings,
  standings,
  enter,
  post,
  advanceTournamentInTx,
  cancelMatch,
  addEvidence,
  dispute,
  listDisputes,
  resolve,
  resolveInTx,
  disputeSummary,
  finaliseMatchInTx,
  closeWindows,
  disqualifyInTx,
  disqualify,
};
