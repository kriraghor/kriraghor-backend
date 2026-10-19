'use strict';

/**
 * M21 prizes (FR-23 to FR-25, §6.5, §6.7, §8.4).
 *
 * Finalise (staff with step-up esports.money; every match final, no dispute open): awards from the
 * locked prize table by final rank, plus per-kill rewards per player; place awards split between the
 * players (the captain's declared split, else equal; remainders to the captain). Everything settles in
 * one transaction through M06 escrow.settlePool on the tournament's pool: Dr escrow:esports_entry,
 * Dr prize_subsidy_expense for a shortfall (FR-25), Cr payable:user:{player} per share, Cr
 * fee_revenue:esports for what is left, so the tournament's escrow ends at zero. Prizes wait in the
 * player's payable balance until they withdraw (M07, gate withdraw_winnings).
 *
 * Disqualification after credit (Q123): an unwithdrawn share is reversed to fee_revenue (M06
 * escrow.reversePoolCredit); the next rank is not paid; a share already withdrawn is recorded as
 * blocked (a recoverable debt for M18 later).
 */
const { E } = require('../../common/errors');
const models = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const escrow = require('../payments').escrow;
const { organiser, isOrganised, fail, money } = require('./esports.common');
const rules = require('./esports.rules');

const {
  sequelize,
  EsportsTournament,
  EsportsPrizePlace,
  EsportsStage,
  EsportsMatch,
  EsportsStanding,
  EsportsRegistration,
  EsportsRegistrationPlayer,
  EsportsResult,
  EsportsResultPlayer,
  EsportsResultDispute,
  EsportsCheckin,
  EsportsPrizeAward,
  EsportsPrizeShare,
} = models;

/** What the pool holds now (open esports_entry holds for the tournament). */
async function collectedFor(t, transaction) {
  let total = 0;
  let cursor;
  do {
    const page = await escrow.list({ purpose: 'esports_entry', groupRef: t.id, cursor, limit: 100 });
    for (const h of page.items) if (['holding', 'partially_released'].includes(h.status)) total += h.available;
    cursor = page.nextCursor;
  } while (cursor);
  void transaction;
  return total;
}

/** Why the tournament cannot be finalised yet (null when it can). */
async function finaliseBlock(t, transaction) {
  if (t.status !== 'results_pending') return 'ESPORTS_NOT_FINALISABLE';
  const matches = await EsportsMatch.findAll({ where: { tournamentId: t.id }, transaction });
  if (!matches.some((m) => m.status === 'final') || matches.some((m) => !['final', 'cancelled'].includes(m.status))) return 'ESPORTS_NOT_FINALISABLE';
  const open = await EsportsResultDispute.count({ where: { matchId: matches.map((m) => m.id), status: 'open' }, transaction });
  return open ? 'ESPORTS_NOT_FINALISABLE' : null;
}

/** Awards and shares from the final standings (pure math over the rows). */
async function compute(t, transaction) {
  const stage = await EsportsStage.findOne({ where: { tournamentId: t.id }, order: [['seq', 'ASC']], transaction });
  const table = await EsportsStanding.findAll({ where: { stageId: stage.id }, order: [['rank', 'ASC']], transaction });
  const regs = new Map((await EsportsRegistration.findAll({ where: { id: table.map((s) => s.registrationId) }, transaction })).map((r) => [r.id, r]));
  const ranking = table.filter((s) => regs.get(s.registrationId)?.status === 'checked_in').map((s) => ({ registrationId: s.registrationId, rank: s.rank }));
  const prizes = (await EsportsPrizePlace.findAll({ where: { tournamentId: t.id }, transaction })).map((p) => ({ place: p.place, amount: p.amountPoisha }));
  const matches = await EsportsMatch.findAll({ where: { tournamentId: t.id, status: 'final' }, attributes: ['id'], transaction });
  const results = await EsportsResult.findAll({ where: { matchId: matches.map((m) => m.id), status: 'final' }, transaction });
  const perPlayer = await EsportsResultPlayer.findAll({ where: { resultId: results.map((r) => r.id) }, transaction });
  const regOfResult = new Map(results.map((r) => [r.id, r.registrationId]));
  const killsByEntry = new Map();
  const killsByPlayer = new Map(); // registrationId → Map(userId → kills)
  for (const p of perPlayer) {
    const regId = regOfResult.get(p.resultId);
    killsByEntry.set(regId, (killsByEntry.get(regId) ?? 0) + p.kills);
    if (!killsByPlayer.has(regId)) killsByPlayer.set(regId, new Map());
    const m = killsByPlayer.get(regId);
    m.set(p.userId, (m.get(p.userId) ?? 0) + p.kills);
  }
  // M22: an organiser's capped kills share the capped total (the fund covers reward × cap).
  const totalKills = [...killsByEntry.values()].reduce((s, k) => s + k, 0);
  const killReward = rules.cappedKillReward(t.killRewardPoisha, totalKills, isOrganised(t) ? t.maxPaidKills : null);
  const awards = rules.awards({ ranking, prizes, killReward, killsByEntry });
  // Who played for each entry: its listed players who checked in (substitutes who stepped in included).
  const checkins = await EsportsCheckin.findAll({ where: { stageId: stage.id, registrationId: ranking.map((r) => r.registrationId) }, transaction });
  const players = await EsportsRegistrationPlayer.findAll({ where: { registrationId: ranking.map((r) => r.registrationId), status: 'active' }, transaction });
  for (const a of awards) {
    const r = regs.get(a.registrationId);
    if (a.kind === 'kill_reward') {
      a.shares = rules.killShares([...(killsByPlayer.get(a.registrationId) ?? new Map()).entries()].map(([userId, kills]) => ({ userId, kills })), killReward);
      continue;
    }
    const played = checkins.filter((c) => c.registrationId === a.registrationId).map((c) => c.userId);
    const listed = players.filter((p) => p.registrationId === a.registrationId && !p.isSubstitute).map((p) => p.userId);
    const playerIds = played.length ? played : listed;
    const split = r.prizeSplit && rules.splitBlock(r.prizeSplit, playerIds) === null ? r.prizeSplit : null;
    a.shares = rules.splitAward(a.amount, { playerIds, captainId: r.registrantUserId, split });
  }
  const paid = awards.reduce((s, a) => s + a.amount, 0);
  return { ranking, awards, paid };
}

/** GET /admin/esports/tournaments/:id/finalise-preview: the awards and the ledger outcome. */
async function preview(tournamentId) {
  const t = await EsportsTournament.findByPk(tournamentId);
  if (!t) throw E.notFound('Tournament');
  const block = await finaliseBlock(t);
  const { awards, paid } = await compute(t);
  const collected = await collectedFor(t);
  const names = await require('./results.service').entryNames(awards.map((a) => a.registrationId));
  return {
    tournamentId: t.id,
    finalisable: !block,
    awards: awards.map((a) => ({ registrationId: a.registrationId, entry: names.get(a.registrationId) ?? null, kind: a.kind, place: a.place, amount: money(a.amount), shares: a.shares.map((s) => ({ userId: s.userId, amount: money(s.amount) })) })),
    totals: Object.fromEntries(Object.entries(rules.settlementPreview(collected, paid)).map(([k, v]) => [k, money(v)])),
  };
}

/** POST /admin/esports/tournaments/:id/finalise (manage_esports + step-up esports.money). Idempotent. */
async function finalise(actor, tournamentId, req) {
  const result = await sequelize.transaction(async (transaction) => {
    const t = await EsportsTournament.findByPk(tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!t) throw E.notFound('Tournament');
    if (['finalised', 'paid_out'].includes(t.status)) return { t, created: false };
    const block = await finaliseBlock(t, transaction);
    if (block) throw fail(block);
    const { awards } = await compute(t, transaction);
    const shareRows = [];
    for (const a of awards) {
      const award = await EsportsPrizeAward.create(
        { tournamentId: t.id, registrationId: a.registrationId, kind: a.kind, place: a.place, amountPoisha: a.amount, idempotencyKey: `esports:award:${t.id}:${a.registrationId}:${a.kind}` },
        { transaction }
      );
      for (const s of a.shares) shareRows.push(await EsportsPrizeShare.create({ awardId: award.id, tournamentId: t.id, userId: s.userId, amountPoisha: s.amount }, { transaction }));
    }
    // One posting for the whole pool (M06): payable per player, subsidy or revenue for the difference.
    const byPayee = new Map();
    for (const s of shareRows) byPayee.set(s.userId, (byPayee.get(s.userId) ?? 0) + s.amountPoisha);
    const prizeLines = [...byPayee.entries()].map(([payeeId, amount]) => ({ payeeId, amount }));
    // M22: an organiser tournament settles from its entries and its prize fund, never with a subsidy.
    const settled = isOrganised(t)
      ? await organiser.settle(t, { prizes: prizeLines, actor, transaction })
      : await escrow.settlePool({ purpose: 'esports_entry', groupRef: t.id, prizes: prizeLines, actor }, { transaction });
    const now = new Date();
    await EsportsPrizeAward.update({ status: 'credited', ledgerTxnId: settled.transactionId }, { where: { tournamentId: t.id, status: 'pending' }, transaction });
    await EsportsPrizeShare.update({ status: 'credited', ledgerTxnId: settled.transactionId }, { where: { tournamentId: t.id, status: 'pending' }, transaction });
    await t.update({ status: 'finalised', finalisedAt: now, settlement: settled }, { transaction });
    await t.update({ status: 'paid_out', paidOutAt: now }, { transaction });
    await audit.record(
      { action: 'esports_tournament.finalised', actor, entityType: 'esports_tournament', entityId: t.id, after: { awards: awards.length, paid: settled.paid, subsidy: settled.subsidy, revenue: settled.fee }, req },
      { transaction }
    );
    await events.publish(transaction, {
      name: 'esports_tournament.finalised',
      aggregateType: 'esports_tournament',
      aggregateId: t.id,
      payload: { tournamentId: t.id, gameId: t.gameId, awards: awards.length, paid: settled.paid, subsidy: settled.subsidy, revenue: settled.fee },
    });
    for (const s of shareRows) {
      await events.publish(transaction, { name: 'esports_prize.credited', aggregateType: 'esports_prize_share', aggregateId: s.id, payload: { shareId: s.id, tournamentId: t.id, userId: s.userId, amount: s.amountPoisha } });
    }
    return { t, created: true };
  });
  if (result.created) await require('./rankings.service').recompute(result.t.gameId);
  return require('./tournaments.service').adminDetail(result.t.id);
}

/**
 * A disqualified entry forfeits its prizes (FR-22, §6.7): pending awards are forfeited; credited
 * shares are reversed while still in the player's balance. Inside the caller's transaction.
 */
async function forfeitForRegistrationInTx(actor, r, t, { transaction }) {
  const awards = await EsportsPrizeAward.findAll({ where: { registrationId: r.id, status: ['pending', 'credited'] }, transaction, lock: transaction.LOCK.UPDATE });
  for (const a of awards) {
    if (a.status === 'pending') {
      await a.update({ status: 'forfeited' }, { transaction });
      await events.publish(transaction, { name: 'esports_prize.forfeited', aggregateType: 'esports_prize_award', aggregateId: a.id, payload: { awardId: a.id, tournamentId: t.id, registrationId: r.id, amount: a.amountPoisha } });
      continue;
    }
    const shares = await EsportsPrizeShare.findAll({ where: { awardId: a.id, status: 'credited' }, transaction, lock: transaction.LOCK.UPDATE });
    let reversedAll = true;
    for (const s of shares) {
      const posted = await reverseShare(actor, s, t, transaction);
      if (!posted) reversedAll = false;
    }
    if (reversedAll) await a.update({ status: 'reversed' }, { transaction });
  }
}

async function reverseShare(actor, s, t, transaction) {
  const balance = await require('../payments').ledger.balance(`payable:user:${s.userId}`, transaction);
  if (balance < s.amountPoisha) {
    // Already withdrawn: record it for M18 (a recoverable debt against future winnings).
    await audit.record({ action: 'esports_prize.reversal_blocked', actor, entityType: 'esports_prize_share', entityId: s.id, after: { userId: s.userId, amount: s.amountPoisha, balance } }, { transaction });
    return false;
  }
  const posted = isOrganised(t)
    ? await organiser.reverse(t, s, { actor, transaction })
    : await escrow.reversePoolCredit({ purpose: 'esports_entry', groupRef: t.id, payeeId: s.userId, amount: s.amountPoisha, key: s.id, actor }, { transaction });
  await s.update({ status: 'reversed', reversalTxnId: posted.id }, { transaction });
  await audit.record({ action: 'esports_prize.reversed', actor, entityType: 'esports_prize_share', entityId: s.id, after: { userId: s.userId, amount: s.amountPoisha } }, { transaction });
  await events.publish(transaction, { name: 'esports_prize.reversed', aggregateType: 'esports_prize_share', aggregateId: s.id, payload: { shareId: s.id, tournamentId: t.id, userId: s.userId, amount: s.amountPoisha } });
  return true;
}

/** GET /me/esports/winnings: the withdrawable balance (M07) and my prize history. */
async function winnings(userId) {
  const shares = await EsportsPrizeShare.findAll({ where: { userId }, order: [['createdAt', 'DESC']], limit: 200 });
  const awards = new Map((await EsportsPrizeAward.findAll({ where: { id: shares.map((s) => s.awardId) } })).map((a) => [a.id, a]));
  const ts = new Map((await EsportsTournament.findAll({ where: { id: shares.map((s) => s.tournamentId) } })).map((t) => [t.id, t]));
  const withdrawals = require('../payouts/withdrawals.service');
  const available = await withdrawals.available(userId);
  return {
    available: money(available.amount),
    minimum: money(available.minimum),
    dailyLimitLeft: money(available.dailyLeft),
    totalWon: money(shares.filter((s) => s.status === 'credited').reduce((a, s) => a + s.amountPoisha, 0)),
    items: shares.map((s) => {
      const a = awards.get(s.awardId);
      const t = ts.get(s.tournamentId);
      return { id: s.id, tournament: t ? { id: t.id, slug: t.slug, titleEn: t.titleEn, titleBn: t.titleBn } : null, kind: a?.kind ?? null, place: a?.place ?? null, amount: money(s.amountPoisha), status: s.status, createdAt: s.createdAt };
    }),
  };
}

module.exports = { preview, finalise, forfeitForRegistrationInTx, winnings, collectedFor, compute };
