'use strict';

/**
 * M15 lite (built with M14 step 1): final results entered by the organiser and the standings
 * projection (M15-FR-09/10/11/16). Live scoring, player stats and stat disputes come with M15.
 *  - enter: organisation staff record the final score of a published match with both teams;
 *  - amend: organisation admins correct it with a reason, unless a match that depends on it already
 *    has a result; the history stays (one current row per match);
 *  - standings: rebuilt per league or group from current results with the tournament's tiebreakers
 *    and recorded lots; M14 reads positions through standingsFor / rankedTeam.
 * After every change M14's afterResultInTx resolves placeholders, money and completion.
 */
const { Op } = require('sequelize');
const { AppError } = require('../../common/errors');
const audit = require('../audit/audit.service');
const realtime = require('../../common/realtime');
const sportRules = require('../catalog/sport-rules.service');
const teamsSvc = require('../teams/teams.service');
const { sequelize, Match, MatchResult, Standing, Stage, Group, GroupTeam } = require('../../models');
const S = require('./standings.rules');
const tc = require('../tournaments/tournaments.common');

const ERR = {
  RESULT_INVALID: [422, 'Check the score: it does not fit the rules'],
  KNOCKOUT_NEEDS_WINNER: [422, 'A knockout match needs a winner (penalties, a super over or a decider)'],
  RESULT_EXISTS: [409, 'This match already has a result. Amend it instead'],
  NO_RESULT_YET: [409, 'This match has no result to amend'],
  AMEND_BLOCKED: [409, 'A later match already used this result, so it can no longer change'],
};
const fail = (code, meta) => new AppError(ERR[code][0], code, ERR[code][1], meta ? { meta } : undefined);
const fixtures = () => require('../tournaments/fixtures.service');

const resultView = (r) => ({ outcome: r.outcome, winnerTeamId: r.winnerTeamId, margin: r.margin, score: r.score, version: r.version, reason: r.reason, at: r.createdAt?.toISOString?.() ?? null });

/** Current results of a tournament by match id. */
async function resultsOf(tournamentId, { transaction } = {}) {
  const rows = await MatchResult.findAll({ where: { tournamentId, isCurrent: true }, transaction });
  return new Map(rows.map((r) => [r.matchId, r]));
}

const hasResults = async (tournamentId, { transaction } = {}) => (await MatchResult.count({ where: { tournamentId, isCurrent: true }, transaction })) > 0;

/** Rule shape of a stored result (for standings). */
const toRule = (m, r) => ({ teamA: m.teamAId, teamB: m.teamBId, outcome: r.outcome, winner: r.winnerTeamId ? (r.winnerTeamId === m.teamAId ? 'a' : 'b') : null, margin: r.margin, score: r.score });

/**
 * Records a result inside the caller's transaction (enter, amend, and M14 walkovers and forfeits).
 * `input` is the engine's score or {outcome:'no_result'|'walkover', walkoverTo}.
 */
async function recordInTx(t, m, input, { transaction, actor, reason = null, amend = false }) {
  const r = await tc.rulesOf(t.id, transaction);
  const schema = await sportRules.schemaFor(t.sportId, { version: r.schemaVersion, transaction });
  const stage = await Stage.findByPk(m.stageId, { transaction });
  const d = S.decide(schema.sport.engine, input, { knockout: stage.kind === 'knockout', values: r.values });
  if (d.error) throw fail(d.error);
  const prior = await MatchResult.findOne({ where: { matchId: m.id, isCurrent: true }, transaction, lock: transaction.LOCK.UPDATE });
  if (prior && !amend) throw fail('RESULT_EXISTS');
  if (prior) await prior.update({ isCurrent: false, supersededAt: new Date() }, { transaction });
  const winnerTeamId = d.winner ? (d.winner === 'a' ? m.teamAId : m.teamBId) : null;
  const score = Object.fromEntries(Object.entries(input).filter(([k]) => !['outcome', 'walkoverTo'].includes(k)));
  const row = await MatchResult.create(
    { matchId: m.id, tournamentId: t.id, version: (prior?.version ?? 0) + 1, outcome: d.outcome, winnerTeamId, margin: d.margin, score, reason, enteredBy: actor?.id ?? t.createdBy },
    { transaction }
  );
  const status = d.outcome === 'walkover' ? 'walkover' : d.outcome === 'no_result' ? 'no_result' : 'completed';
  await m.update({ status, walkoverTeamId: d.outcome === 'walkover' ? winnerTeamId : null, version: m.version + 1 }, { transaction });
  await tc.publish(transaction, prior ? 'match.result_corrected' : 'match.result_saved', 'match', m.id, { matchId: m.id, tournamentId: t.id, matchNo: m.matchNo, outcome: d.outcome, winnerTeamId }, actor);
  if (d.outcome === 'walkover' && !prior) await tc.publish(transaction, 'match.walkover_awarded', 'match', m.id, { matchId: m.id, tournamentId: t.id, winnerTeamId }, actor);
  await rebuildInTx(t, m.stageId, m.groupId, { transaction });
  await fixtures().afterResultInTx(t, { transaction });
  return row;
}

/** PUT /org/:orgId/sports/matches/:id/result: the final score (organisation staff). */
async function enter(principal, org, matchId, input, req) {
  await sequelize.transaction(async (transaction) => {
    const { m, t } = await tc.ownMatch(org, matchId, { transaction, lock: true });
    if (!['scheduled', 'postponed'].includes(m.status) || !m.published) throw tc.fail('MATCH_STATE');
    if (!m.teamAId || !m.teamBId) throw tc.fail('MATCH_TEAMS_UNKNOWN');
    await recordInTx(t, m, input, { transaction, actor: principal });
    await audit.record({ action: 'match.result_saved', actor: principal, entityType: 'match', entityId: m.id, after: input, req }, { transaction });
  });
  return matchResult(matchId);
}

/**
 * POST …/matches/:id/result/amend {…score, reason} (organisation admins, M15-FR-16): blocked once a
 * match that depends on it has a result. Dependants still to play are re-resolved.
 */
async function amend(principal, org, matchId, { reason, ...input }, req) {
  await sequelize.transaction(async (transaction) => {
    const { m, t } = await tc.ownMatch(org, matchId, { transaction, lock: true });
    const prior = await MatchResult.findOne({ where: { matchId: m.id, isCurrent: true }, transaction });
    if (!prior) throw fail('NO_RESULT_YET');
    const all = await Match.findAll({ where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' } }, transaction });
    const stage = await Stage.findByPk(m.stageId, { transaction });
    const dependants = all.filter((x) => [x.teamARef, x.teamBRef].some((ref) => ((ref.type === 'winner' || ref.type === 'loser') && ref.matchNo === m.matchNo) || (stage.kind !== 'knockout' && ['group_pos', 'league_pos', 'ranked'].includes(ref.type) && x.stageId !== m.stageId)));
    const results = await resultsOf(t.id, { transaction });
    if (dependants.some((x) => results.has(x.id))) throw fail('AMEND_BLOCKED');
    for (const x of dependants) await x.update({ teamAId: x.teamARef.type === 'team' ? x.teamAId : null, teamBId: x.teamBRef.type === 'team' ? x.teamBId : null }, { transaction });
    await recordInTx(t, m, input, { transaction, actor: principal, reason, amend: true });
    await audit.record({ action: 'match.result_corrected', actor: principal, entityType: 'match', entityId: m.id, before: resultView(prior), after: input, meta: { reason }, req }, { transaction });
  });
  return matchResult(matchId);
}

async function matchResult(matchId) {
  const m = await Match.findByPk(matchId);
  const r = await MatchResult.findOne({ where: { matchId, isCurrent: true } });
  return { matchId, status: m.status, result: r ? resultView(r) : null };
}

// ---------------------------------------------------------------- standings

/** Rebuilds one table (a league, or a group). Knockout stages have no table. */
async function rebuildInTx(t, stageId, groupId, { transaction }) {
  const stage = await Stage.findByPk(stageId, { transaction });
  if (stage.kind === 'knockout') return null;
  const group = groupId ? await Group.findByPk(groupId, { transaction }) : null;
  const matches = await Match.findAll({ where: { stageId, ...(groupId ? { groupId } : {}), status: { [Op.ne]: 'cancelled' } }, transaction });
  const teamIds = group
    ? (await GroupTeam.findAll({ where: { groupId }, order: [['seedNo', 'ASC']], transaction })).map((x) => x.teamId)
    : [...new Set(matches.flatMap((m) => [m.teamAId, m.teamBId]).filter(Boolean))];
  const results = await resultsOf(t.id, { transaction });
  const r = await tc.rulesOf(t.id, transaction);
  const schema = await sportRules.schemaFor(t.sportId, { version: r.schemaVersion, transaction });
  const rows = S.table(
    teamIds,
    matches.filter((m) => results.has(m.id)).map((m) => toRule(m, results.get(m.id))),
    { engine: schema.sport.engine, values: r.values, tiebreakers: r.tiebreakers, lots: stage.lots?.[group?.name ?? 'L'] ?? [] }
  );
  for (const row of rows) {
    const values = {
      tournamentId: t.id,
      played: row.played,
      won: row.won,
      drawn: row.drawn,
      lost: row.lost,
      noResult: row.noResult,
      points: row.points,
      scoreFor: row.for,
      scoreAgainst: row.against,
      setsFor: row.setsFor,
      setsAgainst: row.setsAgainst,
      runsFor: row.runsFor,
      runsAgainst: row.runsAgainst,
      ballsFaced: row.ballsFaced,
      ballsBowled: row.ballsBowled,
      nrr: Number.isFinite(row.nrr) ? row.nrr : 0,
      position: row.position,
      needsLots: row.needsLots,
      updatedAt: new Date(),
    };
    const existing = await Standing.findOne({ where: { stageId, groupId: groupId ?? null, teamId: row.teamId }, transaction });
    if (existing) await existing.update(values, { transaction });
    else await Standing.create({ stageId, groupId: groupId ?? null, teamId: row.teamId, ...values }, { transaction });
  }
  await tc.publish(transaction, 'standings.updated', 'tournament', t.id, { tournamentId: t.id, stageId, groupId: groupId ?? null });
  // A finished table with a tie nothing breaks: the organiser records lots (§6.5).
  const finished = matches.every((m) => ['completed', 'no_result', 'walkover', 'cancelled'].includes(m.status));
  if (finished && rows.some((x) => x.needsLots)) await tc.publish(transaction, 'tournament.lots_needed', 'tournament', t.id, { tournamentId: t.id, stageId, groupId: groupId ?? null });
  transaction.afterCommit(() => realtime.toRoom(`tournament:${t.id}`, 'tournament.standings_updated', { tournamentId: t.id }));
  return rows;
}

/** A table in position order (M14 reads positions from here). */
async function standingsFor(stageId, groupId, { transaction } = {}) {
  const rows = await Standing.findAll({ where: { stageId, groupId: groupId ?? null }, order: [['position', 'ASC']], transaction });
  return rows.map((x) => ({ teamId: x.teamId, played: x.played, won: x.won, drawn: x.drawn, lost: x.lost, noResult: x.noResult, points: x.points, for: x.scoreFor, against: x.scoreAgainst, setsFor: x.setsFor, setsAgainst: x.setsAgainst, nrr: x.nrr, position: x.position, needsLots: x.needsLots }));
}

/** The rank-th team among rows from different groups (best thirds), or null while tied. */
function rankedTeam(rows, tiebreakers, rank) {
  const ranked = S.rankAcrossGroups(rows, tiebreakers);
  const hit = ranked.filter((x) => x.rank === rank);
  return hit.length === 1 && !hit[0].needsLots ? hit[0].teamId : null;
}

/** The hub's tables: every league or group with team names. */
async function publicStandings(t) {
  const stages = await Stage.findAll({ where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' }, kind: { [Op.ne]: 'knockout' } }, order: [['seq', 'ASC']] });
  const out = [];
  for (const stage of stages) {
    const groups = stage.kind === 'group' ? await Group.findAll({ where: { stageId: stage.id }, order: [['seq', 'ASC']] }) : [null];
    for (const g of groups) {
      const rows = await standingsFor(stage.id, g?.id ?? null);
      const teams = await Promise.all(rows.map((x) => teamsSvc.getTeam(x.teamId)));
      out.push({ stageId: stage.id, kind: stage.kind, group: g?.name ?? null, rows: rows.map((x, i) => ({ ...x, team: teams[i] ? { id: teams[i].id, name: teams[i].name, shortCode: teams[i].shortCode } : null })) });
    }
  }
  return out;
}

module.exports = { ERR, resultView, resultsOf, hasResults, recordInTx, enter, amend, rebuildInTx, standingsFor, rankedTeam, publicStandings };
