'use strict';

/**
 * M21 leaderboards and the top-player ranking (FR-27, FR-28, §6.8, Q125). Projections, rebuilt per
 * game from finalised tournaments (deterministic, so a rebuild is always safe):
 *   esports_ranking_entries  one row per player per finalised tournament they played (DQs excluded)
 *   esports_rankings         rolling (last 365 days, 90-day half-life, at least
 *                            esports.ranking_min_tournaments) and per season (Dhaka quarter, no decay)
 * Rebuilt on esports_tournament.finalised, nightly (job esports.rankings-recompute), and when a
 * player is suspended, banned or restored (Q161): only active accounts are ranked, so ranks renumber
 * around a sanctioned player. Their entries (tournament history) are kept.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const models = require('../../models');
const settings = require('../settings/settings.service');
const directory = require('../users/directory.service');
const rules = require('./esports.rules');

const {
  sequelize,
  EsportsTournament,
  EsportsStage,
  EsportsStanding,
  EsportsRegistration,
  EsportsCheckin,
  EsportsMatch,
  EsportsResult,
  EsportsResultPlayer,
  EsportsRankingEntry,
  EsportsRanking,
  EsportsGame,
  EsportsGameProfile,
} = models;

const DONE = ['finalised', 'paid_out'];

/** Ranking entries of one finalised tournament. */
async function entriesFor(t, transaction) {
  const stage = await EsportsStage.findOne({ where: { tournamentId: t.id }, order: [['seq', 'ASC']], transaction });
  if (!stage) return [];
  const table = await EsportsStanding.findAll({ where: { stageId: stage.id }, order: [['rank', 'ASC']], transaction });
  const ok = new Set((await EsportsRegistration.findAll({ where: { id: table.map((s) => s.registrationId), status: 'checked_in' }, attributes: ['id'], transaction })).map((r) => r.id));
  const ranked = table.filter((s) => ok.has(s.registrationId));
  const n = ranked.length;
  if (!n) return [];
  const rankOf = new Map(ranked.map((s, i) => [s.registrationId, i + 1]));
  const checkins = await EsportsCheckin.findAll({ where: { stageId: stage.id, registrationId: [...ok] }, transaction });
  const matches = await EsportsMatch.findAll({ where: { tournamentId: t.id, status: 'final' }, attributes: ['id'], transaction });
  const results = await EsportsResult.findAll({ where: { matchId: matches.map((m) => m.id), status: 'final' }, attributes: ['id'], transaction });
  const kills = new Map();
  for (const p of await EsportsResultPlayer.findAll({ where: { resultId: results.map((r) => r.id) }, transaction })) kills.set(p.userId, (kills.get(p.userId) ?? 0) + p.kills);
  const weights = (t.settingsSnapshot && t.settingsSnapshot['esports.tier_weights']) || settings.get('esports.tier_weights');
  const seen = new Set();
  const out = [];
  for (const c of checkins) {
    if (seen.has(c.userId)) continue;
    seen.add(c.userId);
    out.push({ userId: c.userId, tournamentId: t.id, gameId: t.gameId, placementScore: Math.round(rules.placementScore(n, rankOf.get(c.registrationId)) * 1000) / 1000, kills: kills.get(c.userId) ?? 0, tierWeight: weights[t.tier] ?? 1, finalisedAt: t.finalisedAt });
  }
  return out;
}

/** Rebuild one game's entries and rankings (all scopes). Pass a transaction to run inside it. */
async function recompute(gameId, now = new Date(), { transaction: outer } = {}) {
  const run = (fn) => (outer ? fn(outer) : sequelize.transaction(fn));
  return run(async (transaction) => {
    const ts = await EsportsTournament.findAll({ where: { gameId, status: DONE }, transaction });
    await EsportsRankingEntry.destroy({ where: { gameId }, transaction });
    const entries = [];
    for (const t of ts) entries.push(...(await entriesFor(t, transaction)));
    if (entries.length) await EsportsRankingEntry.bulkCreate(entries, { transaction });
    // Q161: suspended, banned or closed accounts keep their history but are not ranked.
    const accounts = await directory.accounts(entries.map((e) => e.userId));
    const all = entries.filter((e) => (accounts.get(e.userId)?.status ?? 'active') === 'active');
    const halfLifeDays = settings.get('esports.ranking_half_life_days');
    const minTournaments = settings.get('esports.ranking_min_tournaments');
    const rows = [];
    for (const r of rules.rankPlayers(all, { now, scope: 'rolling', halfLifeDays, minTournaments })) rows.push({ ...r, scope: 'rolling', seasonKey: 'rolling' });
    for (const key of [...new Set(all.map((e) => rules.seasonOf(e.finalisedAt)))]) {
      const { from, to } = rules.seasonRange(key);
      for (const r of rules.rankPlayers(all, { now, scope: 'season', halfLifeDays, minTournaments: 1, from, to })) rows.push({ ...r, scope: 'season', seasonKey: key });
    }
    await EsportsRanking.destroy({ where: { gameId }, transaction });
    if (rows.length) await EsportsRanking.bulkCreate(rows.map((r) => ({ userId: r.userId, gameId, scope: r.scope, seasonKey: r.seasonKey, points: r.points, rank: r.rank, tournaments: r.tournaments, updatedAt: now })), { transaction });
    return { entries: entries.length, rankings: rows.length };
  });
}

/** Q161: rebuild every game a player has ranking entries in (their account was suspended, banned or restored). */
async function recomputeForPlayer(userId, { transaction } = {}) {
  const rows = await EsportsRankingEntry.findAll({ where: { userId }, attributes: [[sequelize.fn('DISTINCT', sequelize.col('game_id')), 'gameId']], raw: true, transaction });
  for (const r of rows) await recompute(r.gameId, new Date(), { transaction });
  return { games: rows.length };
}

/** Job esports.rankings-recompute: every game. */
async function recomputeAll(now = new Date()) {
  const games = await EsportsGame.findAll({ attributes: ['id'] });
  let rankings = 0;
  for (const g of games) rankings += (await recompute(g.id, now)).rankings;
  return { games: games.length, rankings };
}

async function gameByKeyOrId(game) {
  const g = await EsportsGame.findOne({ where: /^[0-9a-f-]{36}$/.test(game) ? { id: game } : { key: game } });
  if (!g) throw E.notFound('Game');
  return g;
}

/** GET /esports/leaderboards?game=&scope=rolling|season&season= */
async function leaderboard({ game, scope = 'rolling', season, limit = 50 }) {
  const g = await gameByKeyOrId(game);
  const seasonKey = scope === 'rolling' ? 'rolling' : season ?? rules.seasonOf(new Date());
  const rows = await EsportsRanking.findAll({ where: { gameId: g.id, scope, seasonKey }, order: [['rank', 'ASC']], limit });
  const names = await directory.publicNames(rows.map((r) => r.userId));
  const profiles = new Map((await EsportsGameProfile.findAll({ where: { userId: rows.map((r) => r.userId), gameId: g.id, status: 'verified' } })).map((p) => [p.userId, p]));
  const seasons = await EsportsRanking.findAll({ where: { gameId: g.id, scope: 'season' }, attributes: [[sequelize.fn('DISTINCT', sequelize.col('season_key')), 'seasonKey']], raw: true });
  return {
    game: { id: g.id, key: g.key, nameEn: g.nameEn, nameBn: g.nameBn },
    scope,
    seasonKey,
    seasons: seasons.map((s) => s.seasonKey).sort().reverse(),
    formula: { placement: '100 × (N − rank + 1) / N', kills: 2, tierWeights: settings.get('esports.tier_weights'), halfLifeDays: settings.get('esports.ranking_half_life_days'), minTournaments: settings.get('esports.ranking_min_tournaments') },
    items: rows.map((r) => ({
      rank: r.rank,
      userId: r.userId,
      username: names.get(r.userId)?.username ?? null,
      displayName: names.get(r.userId)?.displayName ?? null,
      ign: profiles.get(r.userId)?.ign ?? null,
      points: r.points,
      tournaments: r.tournaments,
    })),
  };
}

/** GET /esports/players/:usernameOrId: games and IGNs (UIDs masked), ranks, played, wins, kills. */
async function player(handle) {
  const u = /^[0-9a-f-]{36}$/.test(handle) ? { id: handle } : await directory.byUsername(handle);
  if (!u) throw E.notFound('Player');
  const names = await directory.publicNames([u.id]);
  const who = names.get(u.id);
  if (!who) throw E.notFound('Player');
  const profiles = await EsportsGameProfile.findAll({ where: { userId: u.id, status: 'verified' } });
  const games = new Map((await EsportsGame.findAll({ where: { id: profiles.map((p) => p.gameId) } })).map((g) => [g.id, g]));
  const ranks = await EsportsRanking.findAll({ where: { userId: u.id, scope: 'rolling' } });
  const entries = await EsportsRankingEntry.findAll({ where: { userId: u.id } });
  const wins = entries.filter((e) => Number(e.placementScore) === 100).length;
  return {
    userId: u.id,
    username: who.username,
    displayName: who.displayName,
    games: profiles.map((p) => {
      const g = games.get(p.gameId);
      const r = ranks.find((x) => x.gameId === p.gameId);
      const mine = entries.filter((e) => e.gameId === p.gameId);
      return { game: g ? { key: g.key, nameEn: g.nameEn, nameBn: g.nameBn } : null, ign: p.ign, uidMasked: rules.maskUid(p.uid), rank: r?.rank ?? null, points: r?.points ?? null, tournaments: mine.length, wins: mine.filter((e) => Number(e.placementScore) === 100).length, kills: mine.reduce((a, e) => a + e.kills, 0) };
    }),
    tournaments: entries.length,
    wins,
    kills: entries.reduce((a, e) => a + e.kills, 0),
  };
}

/** Top players across games for the home pages (FR-28): best rolling ranks. */
async function topPlayers({ limit = 6 } = {}) {
  const rows = await EsportsRanking.findAll({ where: { scope: 'rolling', rank: { [Op.lte]: limit } }, order: [['rank', 'ASC'], ['points', 'DESC']], limit: limit * 3 });
  const names = await directory.publicNames(rows.map((r) => r.userId));
  const games = new Map((await EsportsGame.findAll({ where: { id: rows.map((r) => r.gameId) } })).map((g) => [g.id, g]));
  return {
    items: rows.slice(0, limit).map((r) => ({ rank: r.rank, userId: r.userId, username: names.get(r.userId)?.username ?? null, displayName: names.get(r.userId)?.displayName ?? null, game: { key: games.get(r.gameId)?.key ?? null, nameEn: games.get(r.gameId)?.nameEn ?? null }, points: r.points })),
  };
}

module.exports = { recompute, recomputeAll, recomputeForPlayer, leaderboard, player, topPlayers, entriesFor };
