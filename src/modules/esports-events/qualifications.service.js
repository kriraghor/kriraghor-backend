'use strict';

/**
 * M23 qualifications: who may enter an invite-only final.
 *
 *   qualifier finalised ─top N─▶ qualified ─captain registers─▶ entered ─entry withdrawn/cancelled─▶ qualified
 *   staff invite ─▶ invited ─registers─▶ entered
 *   qualified | invited ─final registration closed─▶ missed (tick)
 *   qualified | invited | missed ─staff revoke, source disqualified, final cancelled─▶ revoked
 *
 * M21 calls entryBlock and onEntered inside register()'s locked transaction (registerEntryPolicy), so
 * one qualification is used once and a staff revoke cannot race a registration. M23 reacts to M21's
 * outbox events; it never writes M21's tables.
 */
const { UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const models = require('../../models');
const audit = require('../audit').audit;
const reads = require('../esports').reads;
const rules = require('./events.rules');
const c = require('./events.common');
const feed = require('./feed.service');

const { sequelize, EsportsEvent, EsportsEventStage, EsportsEventQualification } = models;

const OPEN = ['qualified', 'invited'];
const LIVE = ['qualified', 'invited', 'entered', 'missed'];
const REG_OPEN = ['draft', 'review', 'scheduled', 'registration_open'];

const keyWhere = ({ squadId, userId }) => (squadId ? { squadId } : { userId });

function view(q, labels) {
  const squad = q.squadId ? labels.squads.get(q.squadId) : null;
  const user = q.userId ? labels.users.get(q.userId) : null;
  return {
    id: q.id,
    finalTournamentId: q.finalTournamentId,
    sourceTournamentId: q.sourceTournamentId ?? null,
    rank: q.rank ?? null,
    status: q.status,
    entry: squad ? { kind: 'squad', id: squad.id, name: squad.name, tag: squad.tag } : { kind: 'player', id: q.userId, name: user?.username ?? user?.displayName ?? '—', tag: null },
    createdAt: q.createdAt,
  };
}

async function viewsOf(rows, { transaction } = {}) {
  const labels = await reads.entryLabels({ squadIds: rows.map((q) => q.squadId).filter(Boolean), userIds: rows.map((q) => q.userId).filter(Boolean) }, { transaction });
  return rows.map((q) => view(q, labels));
}

/** Public: the live qualifications of an event (revoked ones hidden), best rank first. */
async function publicList(eventId, { transaction } = {}) {
  const rows = await EsportsEventQualification.findAll({ where: { eventId, status: LIVE }, order: [['finalTournamentId', 'ASC'], ['rank', 'ASC NULLS LAST'], ['createdAt', 'ASC']], transaction });
  return viewsOf(rows, { transaction });
}

/** Staff: every qualification of the event with its reason. */
async function staffList(eventId) {
  const rows = await EsportsEventQualification.findAll({ where: { eventId }, order: [['finalTournamentId', 'ASC'], ['rank', 'ASC NULLS LAST'], ['createdAt', 'ASC']] });
  const views = await viewsOf(rows);
  return { items: views.map((v, i) => ({ ...v, reason: rows[i].reason ?? null, players: rows[i].players.length, finalRegistrationId: rows[i].finalRegistrationId ?? null })) };
}

const grantEvent = (transaction, q) => c.publish(transaction, 'esports_event_qualification.granted', 'esports_event_qualification', q.id, { qualificationId: q.id, eventId: q.eventId, finalTournamentId: q.finalTournamentId, status: q.status });
const revokeEvent = (transaction, q, reasonCode) =>
  c.publish(transaction, 'esports_event_qualification.revoked', 'esports_event_qualification', q.id, { qualificationId: q.id, eventId: q.eventId, finalTournamentId: q.finalTournamentId, reasonCode });

// ---------------------------------------------------------------- the M21 entry hooks

/** The open qualification of this entry for final t, locked; throws when there is none. */
async function lockedFor(t, { squadId, registrantUserId }, transaction) {
  return EsportsEventQualification.findOne({ where: { finalTournamentId: t.id, status: OPEN, ...keyWhere({ squadId, userId: squadId ? null : registrantUserId }) }, transaction, lock: transaction.LOCK.UPDATE });
}

async function entryBlock(t, { registrantUserId, squadId, playerUserIds, transaction }) {
  const q = await lockedFor(t, { squadId, registrantUserId }, transaction);
  if (!q) throw c.fail('EVENT_NOT_QUALIFIED');
  const block = rules.coreBlock(q.players, playerUserIds, c.config().minCore);
  if (block) throw c.fail(block, { need: Math.min(c.config().minCore, q.players.length) });
}

async function onEntered(t, r, { transaction }) {
  const q = await lockedFor(t, { squadId: r.squadId, registrantUserId: r.registrantUserId }, transaction);
  if (q) await q.update({ status: 'entered', finalRegistrationId: r.id }, { transaction });
}

// ---------------------------------------------------------------- M21 events

/** The active stage a tournament holds, with its event (or null). */
async function stageOf(tournamentId, { transaction } = {}) {
  const stage = await EsportsEventStage.findOne({ where: { tournamentId, status: 'active' }, transaction });
  if (!stage) return null;
  const event = await EsportsEvent.findByPk(stage.eventId, { transaction });
  return event ? { stage, event } : null;
}

/** esports_tournament.finalised: a qualifier's top N go through (once; a replay finds them written). */
async function onFinalised(tournamentId, { transaction }) {
  const s = await stageOf(tournamentId, { transaction });
  if (!s) return null;
  const { stage, event } = s;
  await feed.add(transaction, event.id, { kind: 'tournament_finalised', tournamentId });
  if (stage.role !== 'qualifier' || event.status === 'cancelled') return null;
  if (await EsportsEventQualification.count({ where: { sourceTournamentId: tournamentId }, transaction })) return null;
  const final = (await reads.tournamentSummary([stage.finalTournamentId], { transaction })).get(stage.finalTournamentId);
  if (!final || final.status === 'cancelled') return null;
  const late = !REG_OPEN.includes(final.status) || new Date() >= new Date(final.registrationClosesAt);
  const taken = new Set(
    (await EsportsEventQualification.findAll({ where: { finalTournamentId: final.id, status: LIVE }, attributes: ['squadId', 'userId'], transaction })).map((q) => rules.entryKey(q))
  );
  const cut = rules.qualifyCut(await reads.standingsWithEntries(tournamentId, { transaction }), stage.qualifyCount, taken);
  for (const e of cut) {
    const q = await EsportsEventQualification.create(
      {
        eventId: event.id,
        finalTournamentId: final.id,
        sourceTournamentId: tournamentId,
        sourceRegistrationId: e.registrationId,
        squadId: e.squadId ?? null,
        userId: e.squadId ? null : e.registrantUserId,
        players: e.playerUserIds,
        rank: e.rank,
        status: late ? 'missed' : 'qualified',
        reason: late ? 'final_registration_closed' : null,
      },
      { transaction }
    );
    if (late) await c.publish(transaction, 'esports_event_qualification.missed', 'esports_event_qualification', q.id, { qualificationId: q.id, eventId: event.id, finalTournamentId: final.id });
    else await grantEvent(transaction, q);
  }
  if (cut.length) await feed.add(transaction, event.id, { kind: 'qualified', tournamentId, data: { count: cut.length, finalTournamentId: final.id, late } });
  return cut.length;
}

/** esports_registration.disqualified: only that registration's qualification is revoked (no pass-down, Q147). */
async function onDisqualified(registrationId, { transaction }) {
  const q = await EsportsEventQualification.findOne({ where: { sourceRegistrationId: registrationId, status: ['qualified', 'invited', 'missed', 'entered'] }, transaction, lock: transaction.LOCK.UPDATE });
  if (!q) return null;
  await q.update({ status: 'revoked', reason: 'disqualified' }, { transaction });
  await revokeEvent(transaction, q, 'disqualified');
  c.ping(transaction, q.eventId, 'esports_event.feed_added');
  return q.id;
}

/** A final's entry withdrew, was cancelled or refunded: its place is open to it again. */
async function onEntryClosed(registrationId, { transaction }) {
  const q = await EsportsEventQualification.findOne({ where: { finalRegistrationId: registrationId, status: 'entered' }, transaction, lock: transaction.LOCK.UPDATE });
  if (!q) return null;
  await q.update({ status: q.sourceRegistrationId ? 'qualified' : 'invited', finalRegistrationId: null }, { transaction });
  return q.id;
}

/** esports_tournament.cancelled: a final takes its open qualifications with it; the feed says so. */
async function onCancelled(tournamentId, { transaction }) {
  const s = await stageOf(tournamentId, { transaction });
  if (!s) return null;
  await feed.add(transaction, s.event.id, { kind: 'tournament_cancelled', tournamentId });
  if (s.stage.role !== 'final') return null;
  const rows = await EsportsEventQualification.findAll({ where: { finalTournamentId: tournamentId, status: ['qualified', 'invited', 'missed'] }, transaction, lock: transaction.LOCK.UPDATE });
  for (const q of rows) {
    await q.update({ status: 'revoked', reason: 'final_cancelled' }, { transaction });
    await revokeEvent(transaction, q, 'final_cancelled');
  }
  return rows.length;
}

/** Tick: a final's registration has closed, so places nobody took are missed. */
async function sweepMissed(now = new Date()) {
  const open = await EsportsEventQualification.findAll({ where: { status: OPEN }, attributes: ['finalTournamentId'], group: ['finalTournamentId'] });
  if (!open.length) return 0;
  const finals = await reads.tournamentSummary(open.map((r) => r.finalTournamentId));
  let n = 0;
  for (const f of finals.values()) {
    if (REG_OPEN.includes(f.status) && now < new Date(f.registrationClosesAt)) continue;
    n += await sequelize.transaction(async (transaction) => {
      const rows = await EsportsEventQualification.findAll({ where: { finalTournamentId: f.id, status: OPEN }, transaction, lock: transaction.LOCK.UPDATE });
      for (const q of rows) {
        await q.update({ status: 'missed', reason: 'not_entered' }, { transaction });
        await c.publish(transaction, 'esports_event_qualification.missed', 'esports_event_qualification', q.id, { qualificationId: q.id, eventId: q.eventId, finalTournamentId: q.finalTournamentId });
      }
      return rows.length;
    });
  }
  return n;
}

// ---------------------------------------------------------------- staff

async function finalStage(eventId, finalTournamentId, transaction) {
  const stage = await EsportsEventStage.findOne({ where: { eventId, tournamentId: finalTournamentId, role: 'final', status: 'active' }, transaction });
  if (!stage) throw E.notFound('Final');
  return stage;
}

/** POST /admin/esports/events/:id/qualifications: invite a squad or a player into a final (wildcard, pro team). */
async function invite(actor, eventId, { finalTournamentId, squadId = null, userId = null, reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const event = await EsportsEvent.findByPk(eventId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!event) throw E.notFound('Event');
    if (event.status === 'cancelled') throw c.fail('EVENT_STATE');
    await finalStage(eventId, finalTournamentId, transaction);
    const final = (await reads.tournamentSummary([finalTournamentId], { transaction })).get(finalTournamentId);
    if (!REG_OPEN.includes(final.status)) throw c.fail('EVENT_QUALIFICATION_STATE');
    if (final.entryUnit === 'squad') {
      const s = squadId ? await reads.squadFacts(squadId, { transaction }) : null;
      if (!s || userId || s.status !== 'active' || s.gameId !== final.gameId) throw c.fail('EVENT_INVITE_INVALID');
    } else if (!userId || squadId || !(await reads.hasVerifiedProfile(userId, final.gameId, { transaction }))) throw c.fail('EVENT_INVITE_INVALID');
    let q;
    try {
      q = await sequelize.transaction({ transaction }, (sp) => EsportsEventQualification.create({ eventId, finalTournamentId, squadId, userId, players: [], status: 'invited', reason, actorId: actor.id }, { transaction: sp }));
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw c.fail('EVENT_ALREADY_QUALIFIED');
      throw err;
    }
    await grantEvent(transaction, q);
    await audit.record({ action: 'esports_event_qualification.invited', actor, entityType: 'esports_event', entityId: eventId, after: { qualificationId: q.id, finalTournamentId, squadId, userId }, reason, req }, { transaction });
    return (await viewsOf([q], { transaction }))[0];
  });
}

/** POST /admin/esports/events/:id/qualifications/:qid/revoke: a place that was not used yet. */
async function revoke(actor, eventId, qid, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const q = await EsportsEventQualification.findOne({ where: { id: qid, eventId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!q) throw E.notFound('Qualification');
    if (!['qualified', 'invited', 'missed'].includes(q.status)) throw c.fail('EVENT_QUALIFICATION_STATE');
    const before = q.status;
    await q.update({ status: 'revoked', reason, actorId: actor.id }, { transaction });
    await revokeEvent(transaction, q, 'staff');
    await audit.record({ action: 'esports_event_qualification.revoked', actor, entityType: 'esports_event', entityId: eventId, before: { status: before }, after: { qualificationId: q.id, status: 'revoked' }, reason, req }, { transaction });
    return (await viewsOf([q], { transaction }))[0];
  });
}

/** M08 recipients: the players who qualified (or, for an invited squad, its captain). */
async function recipientsOf(qualificationId) {
  const q = await EsportsEventQualification.findByPk(qualificationId);
  if (!q) return [];
  if (q.players.length) return q.players;
  if (q.userId) return [q.userId];
  const s = await reads.squadFacts(q.squadId);
  return s ? [s.captainUserId] : [];
}

module.exports = { publicList, staffList, entryBlock, onEntered, stageOf, onFinalised, onDisqualified, onEntryClosed, onCancelled, sweepMissed, invite, revoke, recipientsOf };
