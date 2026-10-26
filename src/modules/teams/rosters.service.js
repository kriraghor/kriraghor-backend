'use strict';

/**
 * M16 rosters for M14 registrations (M16-FR-06/07/08), built with M14 step 1. M14 calls this service,
 * never the tables:
 *  - create / setPlayers: the squad a team takes into a tournament, from its active members, within
 *    the tournament's squad limits; a player is on one active roster per tournament
 *    (PLAYER_IN_OTHER_TEAM, partial unique index);
 *  - readiness: eligible players against the tournament's age, gender and NID rules; captains and
 *    organisers see booleans only (never DOB or gender), each player sees their own checks on
 *    /me/eligibility;
 *  - freeze (first result), release (withdrawn, rejected, removed, cancelled);
 *  - reevaluate: on KYC, gender and membership changes; publishes eligibility.changed.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { AppError } = require('../../common/errors');
const directory = require('../users').directory;
const { Roster, RosterPlayer, EligibilityCheck } = require('../../models');
const teams = require('./teams.service');
const players = require('./players.service');
const c = require('./teams.common');

const ERR = {
  SQUAD_TOO_SMALL: [422, 'Pick more players for the squad'],
  SQUAD_TOO_LARGE: [422, 'Pick fewer players for the squad'],
  PLAYER_NOT_IN_TEAM: [422, 'Pick players from the team'],
  PLAYER_IN_OTHER_TEAM: [409, 'A player is already in another team in this event'],
  ROSTER_FROZEN: [409, 'The squad is fixed now that matches have started'],
};
const fail = (code, meta) => new AppError(ERR[code][0], code, ERR[code][1], meta ? { meta } : undefined);

/** The rules a tournament applies (M14 passes {id, squadMin, squadMax, eligibility, startDate}). */
const configOf = (t) => ({ ageMin: t.eligibility?.ageMin, ageMax: t.eligibility?.ageMax, ageCutoff: t.eligibility?.ageCutoff ?? t.startDate ?? undefined, gender: t.eligibility?.gender });

async function checkSquad(teamId, userIds, t, transaction) {
  const unique = [...new Set(userIds)];
  if (unique.length < t.squadMin) throw fail('SQUAD_TOO_SMALL');
  if (unique.length > t.squadMax) throw fail('SQUAD_TOO_LARGE');
  const members = new Set((await teams.activeMembers(teamId, { transaction })).map((m) => m.userId));
  const outside = unique.filter((id) => !members.has(id));
  if (outside.length) throw fail('PLAYER_NOT_IN_TEAM');
  return unique;
}

/** Stores the latest checks for these players in this tournament. */
async function storeChecks(t, userIds, transaction) {
  const result = await players.checkMany(userIds, configOf(t), { transaction });
  const now = new Date();
  for (const [userId, r] of result) {
    for (const ch of r.checks) {
      const [row, created] = await EligibilityCheck.findOrCreate({ where: { tournamentId: t.id, userId, checkKey: ch.key }, defaults: { status: ch.status, fix: ch.fix ?? null, evaluatedAt: now }, transaction });
      if (!created && row.status !== ch.status) await row.update({ status: ch.status, fix: ch.fix ?? null, evaluatedAt: now }, { transaction });
    }
  }
  return result;
}

async function addPlayers(roster, userIds, actorId, transaction) {
  try {
    for (const userId of userIds) await RosterPlayer.create({ rosterId: roster.id, tournamentId: roster.tournamentId, teamId: roster.teamId, userId, addedBy: actorId }, { transaction });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw fail('PLAYER_IN_OTHER_TEAM');
    throw err;
  }
}

/** A roster for a registration (M14 register). Throws the squad errors above. */
async function create(registration, userIds, t, { transaction, actorId }) {
  const squad = await checkSquad(registration.teamId, userIds, t, transaction);
  const roster = await Roster.create({ registrationId: registration.id, tournamentId: t.id, teamId: registration.teamId }, { transaction });
  await addPlayers(roster, squad, actorId, transaction);
  await storeChecks(t, squad, transaction);
  return roster;
}

/** PUT /me/registrations/:id/roster: replace the squad before it freezes. */
async function setPlayers(registration, userIds, t, { transaction, actorId }) {
  const roster = await Roster.findOne({ where: { registrationId: registration.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
  if (!roster) throw fail('ROSTER_FROZEN');
  if (roster.frozenAt) throw fail('ROSTER_FROZEN');
  const squad = await checkSquad(registration.teamId, userIds, t, transaction);
  const current = await RosterPlayer.findAll({ where: { rosterId: roster.id, status: 'active' }, transaction });
  const now = new Date();
  for (const p of current) if (!squad.includes(p.userId)) await p.update({ status: 'removed', removedAt: now }, { transaction });
  await addPlayers(
    roster,
    squad.filter((id) => !current.some((p) => p.userId === id)),
    actorId,
    transaction
  );
  await storeChecks(t, squad, transaction);
  return roster;
}

/** The active players of a registration's roster. */
async function playerIds(registrationId, { transaction } = {}) {
  const roster = await Roster.findOne({ where: { registrationId }, transaction });
  if (!roster) return [];
  return (await RosterPlayer.findAll({ where: { rosterId: roster.id, status: 'active' }, attributes: ['userId'], transaction })).map((p) => p.userId);
}

/**
 * Readiness of a registration (M16-FR-08, M14-FR-09): {total, eligible, ready, players:[{userId,
 * displayName, nidVerified, eligible}]}. Fresh checks are taken (and stored) on every call.
 */
async function readiness(registrationId, t, { transaction } = {}) {
  const ids = await playerIds(registrationId, { transaction });
  const [result, names] = [await storeChecks(t, ids, transaction), await directory.publicNames(ids, { transaction })];
  const list = ids.map((userId) => {
    const r = result.get(userId);
    return { userId, displayName: names.get(userId)?.displayName ?? '—', nidVerified: r.checks.find((x) => x.key === 'nid_verified').status === 'pass', eligible: r.eligible };
  });
  const eligible = list.filter((p) => p.eligible).length;
  return { total: list.length, eligible, ready: eligible >= t.squadMin, players: list };
}

/** No more changes once the first result is in (M16-FR-10 step 1: no transfers or late adds). */
async function freeze(tournamentId, { transaction }) {
  await Roster.update({ frozenAt: new Date() }, { where: { tournamentId, status: 'active', frozenAt: null }, transaction });
}

/** A registration that ended: its players can join another team in the tournament. */
async function release(registrationId, { transaction }) {
  const roster = await Roster.findOne({ where: { registrationId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
  if (!roster) return;
  await RosterPlayer.update({ status: 'removed', removedAt: new Date() }, { where: { rosterId: roster.id, status: 'active' }, transaction });
  await roster.update({ status: 'released' }, { transaction });
}

/**
 * A player's identity changed (KYC, gender) or they left a team: re-check their active rosters in
 * running tournaments and publish eligibility.changed where the result moved (M14 re-reads readiness).
 * `tournaments(ids)` comes from M14 so this module never reads its tables.
 */
async function reevaluate(userId, { transaction, tournamentsOf }) {
  const rows = await RosterPlayer.findAll({ where: { userId, status: 'active' }, attributes: ['tournamentId'], transaction });
  if (!rows.length) return 0;
  const list = await tournamentsOf(
    rows.map((r) => r.tournamentId),
    { transaction }
  );
  let changed = 0;
  for (const t of list) {
    const before = await EligibilityCheck.findAll({ where: { tournamentId: t.id, userId }, transaction });
    const after = (await storeChecks(t, [userId], transaction)).get(userId);
    const moved = after.checks.some((ch) => before.find((b) => b.checkKey === ch.key)?.status !== ch.status);
    if (moved) {
      changed += 1;
      await c.publish(transaction, 'eligibility.changed', 'tournament', t.id, { tournamentId: t.id, userId, eligible: after.eligible });
    }
  }
  return changed;
}

/** A member left or was removed from a team: they leave its active, unfrozen rosters. */
async function onMemberLeft(teamId, userId, { transaction }) {
  const rows = await RosterPlayer.findAll({ where: { teamId, userId, status: 'active' }, transaction });
  for (const p of rows) {
    const roster = await Roster.findByPk(p.rosterId, { transaction });
    if (!roster.frozenAt) await p.update({ status: 'removed', removedAt: new Date() }, { transaction });
  }
  return rows.length;
}

/** Rosters per registration for the console and the hub (names and NID booleans only). */
async function rostersFor(registrationIds, { transaction } = {}) {
  if (!registrationIds.length) return new Map();
  const rosters = await Roster.findAll({ where: { registrationId: { [Op.in]: registrationIds } }, transaction });
  const playersAll = await RosterPlayer.findAll({ where: { rosterId: { [Op.in]: rosters.map((r) => r.id) }, status: 'active' }, transaction });
  const ids = [...new Set(playersAll.map((p) => p.userId))];
  const [names, identity] = [await directory.publicNames(ids, { transaction }), await directory.eligibilityIdentity(ids, { transaction })];
  return new Map(
    rosters.map((r) => [
      r.registrationId,
      playersAll
        .filter((p) => p.rosterId === r.id)
        .map((p) => {
          const who = identity.get(p.userId);
          return { userId: p.userId, displayName: names.get(p.userId)?.displayName ?? '—', username: names.get(p.userId)?.username ?? null, nidVerified: Boolean(who && who.kycStatus === 'verified' && who.memberActive) };
        }),
    ])
  );
}

module.exports = { ERR, configOf, create, setPlayers, playerIds, readiness, freeze, release, reevaluate, onMemberLeft, rostersFor };
