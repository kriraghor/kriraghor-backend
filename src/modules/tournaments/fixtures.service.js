'use strict';

/**
 * M14 fixtures (FR-15 to FR-19, FR-24) and what follows a result:
 *  - the draw (§6.3): registration order, a manual order, or a random draw whose seed is published;
 *    confirming it stores the seeds, the stages and the groups;
 *  - generate (dry run or for real) with the optional automatic schedule (§6.6, no M10 courts yet);
 *    regenerating cancels earlier drafts (status_reason `regenerated`) and is refused once a result
 *    is in; publish notifies the captains;
 *  - per match: move (clash check, version check), postpone, walkover, cancel;
 *  - after every result (M15 lite calls afterResultInTx): placeholders resolve (§6.7), the first
 *    result locks the rules, freezes the squads and releases tranche 1; when every match is done the
 *    tournament completes and the rest is released (§6.8).
 */
const crypto = require('crypto');
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const audit = require('../audit').audit;
const sportRules = require('../catalog').sportRules;
const teamsSvc = require('../teams').teams;
const rosters = require('../teams').rosters;
const { sequelize, Tournament, TournamentVenue, Stage, Group, GroupTeam, Registration, Match } = require('../../models');
const F = require('./fixtures.rules');
const S = require('./schedule.rules');
const rules = require('./tournaments.rules');
const c = require('./tournaments.common');

/** Match length by sport (§6.6) when the organiser does not set one. */
const DURATION = { cricket: 210, football: 120, futsal: 60, basketball: 90, kabaddi: 60, volleyball: 90, badminton: 60, table_tennis: 45 };

const scoring = () => require('../scoring').results;
const registrations = () => require('./registrations.service');

/** The draw must happen after registration closes with every decision made and enough teams (FR-14). */
async function drawReady(t, transaction) {
  if (t.status !== 'registration_closed') throw c.fail(t.status === 'registration_open' ? 'REGISTRATION_STILL_OPEN' : 'TOURNAMENT_STATE');
  if (await Registration.count({ where: { tournamentId: t.id, status: 'pending_approval' }, transaction })) throw c.fail('PENDING_DECISIONS');
  const teams = await registrations().approvedTeams(t, { transaction });
  if (teams.length < Math.max(2, t.minTeams)) throw c.fail('NOT_ENOUGH_TEAMS', { approved: teams.length, needed: Math.max(2, t.minTeams) });
  if (await scoring().hasResults(t.id, { transaction })) throw c.fail('RESULTS_EXIST');
  return teams;
}

/** The format settings checked against the real number of teams. */
function formatFor(t, r, n) {
  const block = F.formatBlock(t.format, { ...r.formatConfig, minTeams: n, maxTeams: n });
  if (block) throw c.fail(block);
  return r.formatConfig;
}

/** The seeded order of a draw method. Random draws are made at confirm, never previewed. */
function seeded(teams, { seeding, manualOrder }, seed) {
  if (seeding === 'manual') {
    if (!manualOrder || manualOrder.length !== teams.length || new Set(manualOrder).size !== teams.length || manualOrder.some((id) => !teams.includes(id))) throw c.fail('DRAW_INVALID');
    return manualOrder;
  }
  if (seeding === 'random') return F.shuffle(teams, seed);
  return teams;
}

async function teamNames(ids, transaction) {
  const rows = await Promise.all([...new Set(ids)].map((id) => teamsSvc.getTeam(id, { transaction })));
  return new Map(rows.filter(Boolean).map((x) => [x.id, { id: x.id, name: x.name, shortCode: x.shortCode }]));
}

/** POST …/draw {seeding, manualOrder}: a preview of the seeds and groups (random: at confirm). */
async function drawPreview(org, id, body) {
  return sequelize.transaction(async (transaction) => {
    const t = await c.ownTournament(org, id, { transaction });
    const teams = await drawReady(t, transaction);
    const r = await c.rulesOf(t.id, transaction);
    const cfg = formatFor(t, r, teams.length);
    const names = await teamNames(teams, transaction);
    if (body.seeding === 'random') return { seeding: 'random', teams: teams.length, groups: null, order: null, matchCount: F.matchCount(t.format, teams.length, cfg) };
    const order = seeded(teams, body);
    const { stages } = F.generate(t.format, order, cfg);
    const groups = stages.find((s) => s.kind === 'group')?.groups ?? null;
    return { seeding: body.seeding, teams: teams.length, order: order.map((x) => names.get(x)), groups: groups && groups.map((g) => ({ name: g.name, teams: g.teamIds.map((x) => names.get(x)) })), matchCount: F.matchCount(t.format, teams.length, cfg) };
  });
}

/**
 * POST …/draw/confirm {seeding, manualOrder}: stores the seeds on the registrations and the stages
 * and groups; a random draw's seed is published on the stage. Earlier unplayed draws are replaced.
 */
async function drawConfirm(principal, org, id, body, req) {
  await sequelize.transaction(async (transaction) => {
    const t = await c.ownTournament(org, id, { transaction, lock: true });
    const teams = await drawReady(t, transaction);
    const r = await c.rulesOf(t.id, transaction);
    const cfg = formatFor(t, r, teams.length);
    const seed = body.seeding === 'random' ? crypto.randomBytes(16).toString('hex') : null;
    const order = seeded(teams, body, seed);
    await Match.update({ status: 'cancelled', statusReason: 'regenerated' }, { where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' } }, transaction });
    await Stage.update({ status: 'cancelled' }, { where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' } }, transaction });
    const regs = await Registration.findAll({ where: { tournamentId: t.id, status: 'approved' }, transaction });
    for (const reg of regs) await reg.update({ seedNo: order.indexOf(reg.teamId) + 1 }, { transaction });
    const { stages } = F.generate(t.format, order, cfg);
    for (const s of stages) {
      const stage = await Stage.create({ tournamentId: t.id, key: s.key, kind: s.kind, seq: s.seq, seeding: body.seeding, drawSeed: seed, drawConfirmedAt: new Date(), drawConfirmedBy: principal.id }, { transaction });
      for (const [i, g] of (s.groups ?? []).entries()) {
        const group = await Group.create({ stageId: stage.id, name: g.name, seq: i + 1 }, { transaction });
        for (const [j, teamId] of g.teamIds.entries()) await GroupTeam.create({ groupId: group.id, teamId, seedNo: j + 1 }, { transaction });
      }
    }
    await audit.record({ action: 'tournament.draw_confirmed', actor: principal, entityType: 'tournament', entityId: t.id, after: { seeding: body.seeding, seed, order }, req }, { transaction });
  });
  return { draw: await drawOf(id) };
}

/** The confirmed draw (seeds, groups, the published random seed). */
async function drawOf(tournamentId, { transaction } = {}) {
  const stages = await Stage.findAll({ where: { tournamentId, status: { [Op.ne]: 'cancelled' } }, order: [['seq', 'ASC']], transaction });
  if (!stages.length) return null;
  const groups = await Group.findAll({ where: { stageId: stages.map((s) => s.id) }, order: [['seq', 'ASC']], transaction });
  const members = await GroupTeam.findAll({ where: { groupId: groups.map((g) => g.id) }, order: [['seedNo', 'ASC']], transaction });
  const names = await teamNames(
    members.map((m) => m.teamId),
    transaction
  );
  return {
    seeding: stages[0].seeding,
    seed: stages[0].drawSeed,
    confirmedAt: stages[0].drawConfirmedAt?.toISOString() ?? null,
    stages: stages.map((s) => ({
      id: s.id,
      key: s.key,
      kind: s.kind,
      status: s.status,
      groups: groups.filter((g) => g.stageId === s.id).map((g) => ({ id: g.id, name: g.name, teams: members.filter((m) => m.groupId === g.id).map((m) => names.get(m.teamId)) })),
    })),
  };
}

/** Seeded team ids from the confirmed draw; refuses when the approved teams changed since. */
async function seededTeams(t, transaction) {
  const regs = await Registration.findAll({ where: { tournamentId: t.id, status: 'approved' }, order: [['seedNo', 'ASC']], transaction });
  if (!regs.length || regs.some((x) => !x.seedNo)) throw c.fail('DRAW_NOT_CONFIRMED');
  const stages = await Stage.count({ where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' } }, transaction });
  if (!stages) throw c.fail('DRAW_NOT_CONFIRMED');
  return regs.map((x) => x.teamId);
}

/** The schedule config: the organiser's, with the sport's match length and default slots. */
function scheduleCfg(t, schema, given, venues) {
  return {
    startDate: given.startDate ?? t.startDate,
    endDate: given.endDate ?? t.endDate,
    weekdays: given.weekdays ?? [0, 1, 2, 3, 4, 5, 6],
    slots: given.slots ?? (schema.sport.key === 'cricket' ? ['09:00', '13:30'] : ['16:30', '18:00', '19:30']),
    durationMin: given.durationMin ?? DURATION[schema.sport.key] ?? 90,
    bufferMin: given.bufferMin ?? 15,
    matchesPerDay: given.matchesPerDay ?? null,
    minRestHours: given.minRestHours ?? (schema.sport.key === 'cricket' ? 20 : schema.sport.engine === 'rally' ? 1 : 44),
    maxPerTeamPerDay: given.maxPerTeamPerDay ?? (schema.sport.engine === 'rally' ? 3 : 1),
    restDates: given.restDates ?? [],
    venues: venues.map((v) => ({ venueId: v.id, courts: v.courts ?? [] })),
  };
}

/**
 * POST …/fixtures/generate {dryRun, schedule?}: matches from the confirmed draw, optionally placed
 * by the scheduler. A dry run writes nothing; otherwise earlier unplayed matches are replaced.
 */
async function generate(principal, org, id, { dryRun = false, schedule = null }, req) {
  return sequelize.transaction(async (transaction) => {
    const t = await c.ownTournament(org, id, { transaction, lock: true });
    if (t.status !== 'registration_closed') throw c.fail('TOURNAMENT_STATE');
    if (await scoring().hasResults(t.id, { transaction })) throw c.fail('RESULTS_EXIST');
    const order = await seededTeams(t, transaction);
    const r = await c.rulesOf(t.id, transaction);
    const cfg = formatFor(t, r, order.length);
    const { matches } = F.generate(t.format, order, cfg);
    const schema = await sportRules.schemaFor(t.sportId, { version: r.schemaVersion, transaction });
    const venues = await TournamentVenue.findAll({ where: { tournamentId: t.id, status: 'active' }, order: [['sort', 'ASC']], transaction });
    const plan = schedule ? S.schedule(matches, scheduleCfg(t, schema, schedule, venues)) : { placed: [], unscheduled: [] };
    const placed = new Map(plan.placed.map((p) => [p.matchNo, p]));
    const names = await teamNames(order, transaction);
    const out = matches.map((m) => ({ ...m, scheduledStart: placed.get(m.matchNo)?.start ?? null, scheduledEnd: placed.get(m.matchNo)?.end ?? null, venueId: placed.get(m.matchNo)?.venueId ?? null, court: placed.get(m.matchNo)?.court ?? null }));
    if (!dryRun) {
      const stages = await Stage.findAll({ where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' } }, transaction });
      const groups = await Group.findAll({ where: { stageId: stages.map((s) => s.id) }, transaction });
      const stageOf = (key) => stages.find((s) => s.key === key).id;
      const groupOf = (stageKey, name) => (name ? groups.find((g) => g.stageId === stageOf(stageKey) && g.name === name).id : null);
      await Match.update({ status: 'cancelled', statusReason: 'regenerated' }, { where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' } }, transaction });
      for (const m of out) {
        await Match.create(
          {
            tournamentId: t.id,
            stageId: stageOf(m.stageKey),
            groupId: groupOf(m.stageKey, m.group),
            round: m.round,
            matchNo: m.matchNo,
            roundName: m.roundName,
            teamARef: m.teamA,
            teamBRef: m.teamB,
            teamAId: m.teamA.type === 'team' ? m.teamA.teamId : null,
            teamBId: m.teamB.type === 'team' ? m.teamB.teamId : null,
            scheduledStart: m.scheduledStart,
            scheduledEnd: m.scheduledEnd,
            venueId: m.venueId,
            court: m.court,
            status: 'draft',
          },
          { transaction }
        );
      }
      await audit.record({ action: 'tournament.fixtures_generated', actor: principal, entityType: 'tournament', entityId: t.id, after: { matches: out.length, unscheduled: plan.unscheduled.length }, req }, { transaction });
    }
    const label = (ref) => (ref.type === 'team' ? { ...ref, team: names.get(ref.teamId) } : ref);
    return { dryRun, matchCount: out.length, matches: out.map((m) => ({ matchNo: m.matchNo, stageKey: m.stageKey, group: m.group, round: m.round, roundName: m.roundName, teamA: label(m.teamA), teamB: label(m.teamB), scheduledStart: m.scheduledStart, venueId: m.venueId, court: m.court })), unscheduled: plan.unscheduled };
  });
}

/** POST …/fixtures/publish: captains are told (FR-15, §4.5). Unscheduled matches show "time to be set". */
async function publish(principal, org, id, req) {
  await sequelize.transaction(async (transaction) => {
    const t = await c.ownTournament(org, id, { transaction, lock: true });
    const drafts = await Match.findAll({ where: { tournamentId: t.id, status: 'draft' }, transaction });
    if (!drafts.length) throw c.fail('FIXTURES_MISSING');
    for (const m of drafts) await m.update({ status: 'scheduled', published: true }, { transaction });
    await Stage.update({ status: 'active' }, { where: { tournamentId: t.id, status: 'draft' }, transaction });
    await audit.record({ action: 'tournament.fixtures_published', actor: principal, entityType: 'tournament', entityId: t.id, after: { matches: drafts.length }, req }, { transaction });
    await c.publish(transaction, 'tournament.fixtures_published', 'tournament', t.id, { tournamentId: t.id, organisationId: t.organisationId, matches: drafts.length }, principal);
  });
  return { fixtures: await consoleFixtures(org, id) };
}

// ---------------------------------------------------------------- matches

/** The placed matches of a tournament in the clash checker's shape (for a manual edit). */
async function placedOf(t, transaction) {
  const all = await Match.findAll({ where: { tournamentId: t.id, status: { [Op.notIn]: ['cancelled'] } }, transaction });
  const asRules = all.map((m) => ({ matchNo: m.matchNo, stageKey: null, group: m.groupId, teamA: m.teamARef, teamB: m.teamBRef }));
  return all.map((m, i) => ({
    row: m,
    matchNo: m.matchNo,
    start: m.scheduledStart?.getTime() ?? null,
    end: m.scheduledEnd?.getTime() ?? null,
    venueId: m.venueId,
    court: m.court,
    teams: [m.teamAId, m.teamBId].filter(Boolean),
    refs: asRules[i],
  }));
}

/** Dependencies of a match by its references (winner/loser sources; stage completion for positions). */
function depsFor(m, list) {
  const out = [];
  for (const ref of [m.teamARef, m.teamBRef]) {
    if (ref.type === 'winner' || ref.type === 'loser') out.push(ref.matchNo);
    if (['group_pos', 'league_pos', 'ranked'].includes(ref.type)) for (const x of list) if (x.row.stageId !== m.stageId) out.push(x.matchNo);
  }
  return out;
}

/** PATCH /org/:orgId/sports/matches/:id {scheduledStart, venueId, court, version} (FR-18). */
async function moveMatch(principal, org, matchId, body, req) {
  await sequelize.transaction(async (transaction) => {
    const { m, t } = await c.ownMatch(org, matchId, { transaction, lock: true });
    if (body.version !== undefined && body.version !== m.version) throw c.fail('VERSION_CONFLICT');
    if (!['draft', 'scheduled', 'postponed'].includes(m.status)) throw c.fail('MATCH_STATE');
    if (body.venueId && !(await TournamentVenue.findOne({ where: { id: body.venueId, tournamentId: t.id, status: 'active' }, transaction }))) throw c.fail('VENUE_INVALID');
    const r = await c.rulesOf(t.id, transaction);
    const schema = await sportRules.schemaFor(t.sportId, { version: r.schemaVersion, transaction });
    const cfg = scheduleCfg(t, schema, r.formatConfig.schedule ?? {}, []);
    const start = body.scheduledStart ? new Date(body.scheduledStart) : m.scheduledStart;
    const end = start ? new Date(start.getTime() + cfg.durationMin * 60000) : null;
    const venueId = body.venueId === undefined ? m.venueId : body.venueId;
    const court = body.court === undefined ? m.court : body.court;
    if (start) {
      const all = await placedOf(t, transaction);
      const others = all.filter((x) => x.start !== null && x.matchNo !== m.matchNo).map((x) => ({ ...x, deps: depsFor(x.row, all) }));
      const problems = S.clashes({ matchNo: m.matchNo, start: start.getTime(), end: end.getTime(), venueId, court, teams: [m.teamAId, m.teamBId].filter(Boolean), deps: depsFor(m, all) }, others, cfg);
      if (problems.length) throw c.fail('SCHEDULE_CLASH', { clashes: problems });
    }
    const moved = m.published && (start?.getTime() !== m.scheduledStart?.getTime() || venueId !== m.venueId);
    await m.update({ scheduledStart: start, scheduledEnd: end, venueId, court, status: m.status === 'postponed' && start ? 'scheduled' : m.status, version: m.version + 1 }, { transaction });
    await audit.record({ action: 'match.rescheduled', actor: principal, entityType: 'match', entityId: m.id, after: { start: start?.toISOString() ?? null, venueId, court }, req }, { transaction });
    if (moved) await c.publish(transaction, 'match.rescheduled', 'match', m.id, { matchId: m.id, tournamentId: t.id, matchNo: m.matchNo }, principal);
  });
  return matchView(await Match.findByPk(matchId));
}

/** POST …/matches/:id/postpone {reason, newStart?} (FR-19). */
async function postpone(principal, org, matchId, { reason, newStart }, req) {
  await sequelize.transaction(async (transaction) => {
    const { m, t } = await c.ownMatch(org, matchId, { transaction, lock: true });
    if (!rules.can(rules.MATCH, m.status, 'postponed')) throw c.fail('MATCH_STATE');
    await m.update({ status: 'postponed', statusReason: reason, postponedFrom: m.scheduledStart, scheduledStart: null, scheduledEnd: null, version: m.version + 1 }, { transaction });
    await audit.record({ action: 'match.postponed', actor: principal, entityType: 'match', entityId: m.id, meta: { reason }, req }, { transaction });
    await c.publish(transaction, 'match.postponed', 'match', m.id, { matchId: m.id, tournamentId: t.id, matchNo: m.matchNo }, principal);
  });
  if (newStart) return moveMatch(principal, org, matchId, { scheduledStart: newStart }, req);
  return matchView(await Match.findByPk(matchId));
}

/** POST …/matches/:id/walkover {winnerTeamId, reason}: the winner is given the match (FR-19). */
async function walkover(principal, org, matchId, { winnerTeamId, reason }, req) {
  await sequelize.transaction(async (transaction) => {
    const { m, t } = await c.ownMatch(org, matchId, { transaction, lock: true });
    if (!['scheduled', 'postponed'].includes(m.status)) throw c.fail('MATCH_STATE');
    if (!m.teamAId || !m.teamBId || ![m.teamAId, m.teamBId].includes(winnerTeamId)) throw c.fail('MATCH_TEAMS_UNKNOWN');
    await scoring().recordInTx(t, m, { outcome: 'walkover', walkoverTo: winnerTeamId === m.teamAId ? 'a' : 'b' }, { transaction, actor: principal, reason });
    await audit.record({ action: 'match.walkover_awarded', actor: principal, entityType: 'match', entityId: m.id, meta: { winnerTeamId, reason }, req }, { transaction });
  });
  return matchView(await Match.findByPk(matchId));
}

/** POST …/matches/:id/cancel {reason}: no result; the match no longer counts. */
async function cancelMatch(principal, org, matchId, { reason }, req) {
  await sequelize.transaction(async (transaction) => {
    const { m, t } = await c.ownMatch(org, matchId, { transaction, lock: true });
    if (!rules.can(rules.MATCH, m.status, 'cancelled')) throw c.fail('MATCH_STATE');
    await m.update({ status: 'cancelled', statusReason: reason, version: m.version + 1 }, { transaction });
    await audit.record({ action: 'match.cancelled', actor: principal, entityType: 'match', entityId: m.id, meta: { reason }, req }, { transaction });
    await c.publish(transaction, 'match.cancelled', 'match', m.id, { matchId: m.id, tournamentId: t.id, matchNo: m.matchNo }, principal);
    await afterResultInTx(t, { transaction });
  });
  return matchView(await Match.findByPk(matchId));
}

/** A team that withdrew or was removed: its remaining matches go to the opponents as walkovers. */
async function forfeitTeam(t, teamId, { transaction }) {
  const open = await registrations().openMatchesOf(t, teamId, transaction);
  for (const m of open) {
    if (!m.published || !m.teamAId || !m.teamBId) continue;
    await scoring().recordInTx(t, m, { outcome: 'walkover', walkoverTo: m.teamAId === teamId ? 'b' : 'a' }, { transaction, actor: null, reason: 'team_left' });
  }
}

// ---------------------------------------------------------------- after a result

/** The team a reference points to now, or null while it is not decided (§6.7). */
async function refTeam(ref, ctx) {
  if (ref.type === 'team') return ref.teamId;
  if (ref.type === 'winner' || ref.type === 'loser') {
    const src = ctx.byNo.get(ref.matchNo);
    const res = src && ctx.results.get(src.id);
    if (!res || !res.winnerTeamId) return null;
    if (ref.type === 'winner') return res.winnerTeamId;
    return res.winnerTeamId === src.teamAId ? src.teamBId : src.teamAId;
  }
  const stageDone = (stageId, groupId) => ctx.matches.filter((x) => x.stageId === stageId && (!groupId || x.groupId === groupId)).every((x) => rules.TERMINAL_MATCH.includes(x.status));
  const at = (rows, pos) => {
    const hits = rows.filter((x) => x.position === pos);
    return hits.length === 1 && !hits[0].needsLots ? hits[0].teamId : null;
  };
  if (ref.type === 'group_pos') {
    const stage = ctx.stages.find((s) => s.key === 'G');
    const group = ctx.groups.find((g) => g.stageId === stage.id && g.name === ref.group);
    if (!stageDone(stage.id, group.id)) return null;
    return at(await scoring().standingsFor(stage.id, group.id, { transaction: ctx.transaction }), ref.pos);
  }
  if (ref.type === 'league_pos') {
    const stage = ctx.stages.find((s) => s.key === 'L');
    if (!stageDone(stage.id)) return null;
    return at(await scoring().standingsFor(stage.id, null, { transaction: ctx.transaction }), ref.pos);
  }
  // ranked: the rank-th best of the teams finishing pos-th in their groups
  const stage = ctx.stages.find((s) => s.key === 'G');
  if (!stageDone(stage.id)) return null;
  const rows = [];
  for (const g of ctx.groups.filter((x) => x.stageId === stage.id)) {
    const table = await scoring().standingsFor(stage.id, g.id, { transaction: ctx.transaction });
    const hits = table.filter((x) => x.position === ref.pos);
    if (hits.length !== 1 || hits[0].needsLots) return null;
    rows.push(hits[0]);
  }
  return scoring().rankedTeam(rows, ctx.tiebreakers, ref.rank);
}

/**
 * Runs after every result, walkover or cancelled match (inside the same transaction): resolves
 * placeholders, handles the first result (rules lock, squads freeze, tranche 1, status live) and
 * completion (every match done → completed, the rest released).
 */
async function afterResultInTx(t, { transaction }) {
  const matches = await Match.findAll({ where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' }, published: true }, order: [['matchNo', 'ASC']], transaction });
  const stages = await Stage.findAll({ where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' } }, transaction });
  const groups = await Group.findAll({ where: { stageId: stages.map((s) => s.id) }, transaction });
  const results = await scoring().resultsOf(t.id, { transaction });
  const r = await c.rulesOf(t.id, transaction);
  const ctx = { matches, stages, groups, results, byNo: new Map(matches.map((m) => [m.matchNo, m])), tiebreakers: r.tiebreakers, transaction };
  for (const m of matches) {
    if (results.has(m.id) || (m.teamAId && m.teamBId)) continue;
    const a = m.teamAId ?? (await refTeam(m.teamARef, ctx));
    const b = m.teamBId ?? (await refTeam(m.teamBRef, ctx));
    if (a === m.teamAId && b === m.teamBId) continue;
    await m.update({ teamAId: a, teamBId: b }, { transaction });
    if (a && b) await c.publish(transaction, 'match.teams_resolved', 'match', m.id, { matchId: m.id, tournamentId: t.id, teamAId: a, teamBId: b });
  }
  const played = matches.filter((m) => results.has(m.id));
  if (played.length && !t.firstResultAt) {
    await t.update({ firstResultAt: new Date(), status: t.status === 'registration_closed' ? 'live' : t.status }, { transaction });
    await require('./tournaments.service').lockRulesInTx(t, { transaction });
    await rosters.freeze(t.id, { transaction });
    const moved = await registrations().releaseTranche(t, 'first', { transaction });
    await t.update({ tranche1At: new Date() }, { transaction });
    await c.publish(transaction, 'tournament.first_match_completed', 'tournament', t.id, { tournamentId: t.id, released: moved.gross });
  }
  const done = matches.length > 0 && matches.every((m) => rules.TERMINAL_MATCH.includes(m.status));
  if (done && t.status === 'live') {
    const moved = await registrations().releaseTranche(t, 'final', { transaction });
    await t.update({ status: 'completed', completedAt: new Date() }, { transaction });
    await c.publish(transaction, 'tournament.completed', 'tournament', t.id, { tournamentId: t.id, released: moved.gross });
  }
}

/** POST …/lots {stageId, group, order}: the organiser records a draw of lots for a tie (§6.5). */
async function recordLots(principal, org, id, { stageId, group = null, order }, req) {
  await sequelize.transaction(async (transaction) => {
    const t = await c.ownTournament(org, id, { transaction, lock: true });
    const stage = await Stage.findOne({ where: { id: stageId, tournamentId: t.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!stage) throw E.notFound('Stage');
    const g = group ? await Group.findOne({ where: { stageId: stage.id, name: group }, transaction }) : null;
    if (group && !g) throw E.notFound('Group');
    const tied = (await scoring().standingsFor(stage.id, g?.id ?? null, { transaction })).filter((x) => x.needsLots).map((x) => x.teamId);
    if (!tied.length) throw c.fail('LOTS_NOT_NEEDED');
    if (order.length !== new Set(order).size || !tied.every((x) => order.includes(x))) throw c.fail('LOTS_INVALID');
    await stage.update({ lots: { ...stage.lots, [group ?? 'L']: order } }, { transaction });
    await audit.record({ action: 'tournament.lots_recorded', actor: principal, entityType: 'stage', entityId: stage.id, after: { group, order }, req }, { transaction });
    await scoring().rebuildInTx(t, stage.id, g?.id ?? null, { transaction });
    await afterResultInTx(t, { transaction });
  });
  return { standings: await scoring().publicStandings(await Tournament.findByPk(id)) };
}

// ---------------------------------------------------------------- views

function matchView(m, names = new Map(), result = null) {
  const side = (id, ref) => ({ ref, team: id ? (names.get(id) ?? { id }) : null });
  return {
    id: m.id,
    matchNo: m.matchNo,
    stageId: m.stageId,
    groupId: m.groupId,
    round: m.round,
    roundName: m.roundName,
    teamA: side(m.teamAId, m.teamARef),
    teamB: side(m.teamBId, m.teamBRef),
    scheduledStart: m.scheduledStart?.toISOString() ?? null,
    scheduledEnd: m.scheduledEnd?.toISOString() ?? null,
    venueId: m.venueId,
    court: m.court,
    status: m.status,
    statusReason: m.statusReason,
    published: m.published,
    version: m.version,
    result,
  };
}

async function fixturesOf(t, { publicOnly }) {
  const where = { tournamentId: t.id, status: { [Op.ne]: 'cancelled' }, ...(publicOnly ? { published: true } : {}) };
  const rows = await Match.findAll({ where, order: [['matchNo', 'ASC']] });
  const names = await teamNames(rows.flatMap((m) => [m.teamAId, m.teamBId]).filter(Boolean));
  const results = await scoring().resultsOf(t.id);
  const venues = await TournamentVenue.findAll({ where: { tournamentId: t.id } });
  return {
    matches: rows.map((m) => matchView(m, names, results.get(m.id) ? scoring().resultView(results.get(m.id)) : null)),
    venues: venues.map((v) => ({ id: v.id, groundId: v.groundId, venueText: v.venueText, areaId: v.areaId, courts: v.courts })),
    draw: await drawOf(t.id),
  };
}

const consoleFixtures = async (org, id) => fixturesOf(await c.ownTournament(org, id), { publicOnly: false });
const publicFixtures = (t) => fixturesOf(t, { publicOnly: true });

module.exports = {
  DURATION,
  drawPreview,
  drawConfirm,
  drawOf,
  generate,
  publish,
  moveMatch,
  postpone,
  walkover,
  cancelMatch,
  forfeitTeam,
  afterResultInTx,
  recordLots,
  matchView,
  consoleFixtures,
  publicFixtures,
};
