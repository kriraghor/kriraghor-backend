'use strict';

/**
 * M07 on-demand withdrawal (M21-FR-26, v3). Esports prizes (pool credits in payable:user, schedule
 * 'withdraw') are never swept by the scheduled runs; the winner withdraws them here:
 *   - gate withdraw_winnings (NID KYC, M02) and a verified bKash / Nagad payout account;
 *   - at least esports.min_withdraw_poisha, at most esports.withdraw_daily_limit_poisha per Dhaka day;
 *   - whole ledger entries, oldest first (each entry is paid once: uq_payout_items_entry_once); any
 *     unconsumed reversal (a prize taken back, M21 §6.7) is netted first;
 *   - one open withdrawal per payee (uq_payouts_one_open_withdrawal).
 * The payout is kind 'withdrawal' and goes through the normal release → manual send → paid flow, holds
 * and the four-eyes threshold included.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { AppError } = require('../../common/errors');
const { nextCode } = require('../../common/sequences');
const logger = require('../../common/logger');
const { sequelize, Payout, PayoutItem } = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const settings = require('../settings/settings.service');
const ledger = require('../payments').ledger;
const accounts = require('./payout-accounts.service');
const holds = require('./holds.service');
const rules = require('./payouts.rules');

const ERRORS = {
  WITHDRAW_BELOW_MINIMUM: [422, 'That is below the minimum withdrawal'],
  WITHDRAW_DAILY_LIMIT: [422, 'That would pass today’s withdrawal limit'],
  WITHDRAW_NOTHING: [409, 'You have no winnings to withdraw'],
  WITHDRAW_OPEN: [409, 'You already have a withdrawal in progress'],
  PAYOUT_ACCOUNT_REQUIRED: [409, 'Add and verify a bKash or Nagad payout account first'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

const DHAKA_MS = 6 * 3600000;
const startOfDhakaDay = (now) => new Date(Math.floor((now.getTime() + DHAKA_MS) / 86400000) * 86400000 - DHAKA_MS);
const POOL_PURPOSE = 'esports_entry';

/** Unconsumed esports pool entries of a payee (credits and reversals), oldest first. */
async function poolEntries(userId, transaction) {
  // A pool with no holds (a free tournament: prizes are all subsidy) has no purpose to look up; only
  // esports pools exist, so a pool posting without one is esports too.
  const entries = (await ledger.payableEntries({ upTo: new Date(), payeeIds: [userId], transaction })).filter((e) => e.source === 'pool' && (e.purpose === POOL_PURPOSE || (e.purpose === null && e.kind.startsWith('escrow.pool'))));
  if (!entries.length) return [];
  const used = new Set(
    (await PayoutItem.findAll({ where: { status: 'included', ledgerEntryId: { [Op.in]: entries.map((e) => e.entryId) } }, attributes: ['ledgerEntryId'], transaction })).map((i) => Number(i.ledgerEntryId))
  );
  return entries.filter((e) => !used.has(e.entryId));
}

async function withdrawnToday(userId, now, transaction) {
  return (await Payout.sum('amountPoisha', { where: { payeeId: userId, kind: 'withdrawal', status: { [Op.notIn]: ['cancelled', 'failed'] }, createdAt: { [Op.gte]: startOfDhakaDay(now) } }, transaction })) ?? 0;
}

/**
 * The plan for a withdrawal now: reversals first, then credits oldest first while the total stays
 * within today's limit. Returns { amount, items, dailyLeft, minimum, available }.
 */
async function plan(userId, { transaction, now = new Date() } = {}) {
  const entries = await poolEntries(userId, transaction);
  const debits = entries.filter((e) => e.debit > 0);
  const credits = entries.filter((e) => e.credit > 0);
  const available = Math.max(0, credits.reduce((s, e) => s + e.credit, 0) - debits.reduce((s, e) => s + e.debit, 0));
  const dailyLeft = Math.max(0, settings.get('esports.withdraw_daily_limit_poisha') - Number(await withdrawnToday(userId, now, transaction)));
  let amount = -debits.reduce((s, e) => s + e.debit, 0);
  const items = [...debits];
  for (const e of credits) {
    if (amount + e.credit > dailyLeft) break;
    amount += e.credit;
    items.push(e);
  }
  if (amount <= 0) return { amount: 0, items: [], dailyLeft, minimum: settings.get('esports.min_withdraw_poisha'), available };
  return { amount, items, dailyLeft, minimum: settings.get('esports.min_withdraw_poisha'), available };
}

/** GET /me/withdrawals/available (and M21 /me/esports/winnings). */
async function available(userId) {
  const p = await plan(userId);
  return { amount: p.available, withdrawable: p.amount, dailyLeft: p.dailyLeft, minimum: p.minimum };
}

/** POST /me/withdrawals (gate withdraw_winnings, Idempotency-Key): everything withdrawable now. */
async function create(principal, req) {
  const userId = principal.user.id;
  let auto = null;
  try {
    const out = await sequelize.transaction(async (transaction) => {
      const open = await Payout.findOne({ where: { payeeId: userId, kind: 'withdrawal', status: [...rules.OPEN, 'processing'] }, transaction });
      if (open) throw fail('WITHDRAW_OPEN');
      const account = await accounts.activeFor(userId, { transaction });
      if (!account) throw fail('PAYOUT_ACCOUNT_REQUIRED');
      const now = new Date();
      const p = await plan(userId, { transaction, now });
      if (p.available <= 0) throw fail('WITHDRAW_NOTHING');
      if (p.amount <= 0) throw fail('WITHDRAW_DAILY_LIMIT', { dailyLeft: p.dailyLeft });
      if (rules.belowMinimum(p.amount, p.minimum)) throw fail('WITHDRAW_BELOW_MINIMUM', { minimum: p.minimum, amount: p.amount });
      const limits = { threshold: settings.get('payouts.four_eyes_threshold_poisha'), minAmount: p.minimum, autoReleaseMax: settings.get('payouts.auto_release_max_poisha') };
      const active = await holds.activeFor(userId, { transaction, now });
      const { status, autoRelease } = rules.statusFor({ amount: p.amount, threshold: limits.threshold, autoReleaseMax: limits.autoReleaseMax, blocked: rules.blockingHolds(active, now).length > 0 });
      const gross = p.items.filter((e) => e.credit > 0).reduce((s, e) => s + e.credit, 0);
      const payout = await Payout.create(
        {
          code: await nextCode('PO', transaction, now),
          payeeId: userId,
          kind: 'withdrawal',
          grossPoisha: gross,
          deductionsPoisha: gross - p.amount,
          amountPoisha: p.amount,
          status,
          rulesSnapshot: { ...limits, schedule: 'withdraw', dailyLimit: settings.get('esports.withdraw_daily_limit_poisha') },
        },
        { transaction }
      );
      await PayoutItem.bulkCreate(
        p.items.map((e) => ({
          payoutId: payout.id,
          sourceType: e.debit > 0 ? 'reversal' : 'pool',
          sourceId: e.sourceId,
          ledgerEntryId: e.entryId,
          grossPoisha: e.credit,
          feePoisha: 0,
          netPoisha: e.credit - e.debit,
          description: e.debit > 0 ? 'Esports prize taken back' : 'Esports prize',
        })),
        { transaction }
      );
      await audit.record({ action: 'payout.withdrawal_requested', actor: principal, entityType: 'payout', entityId: payout.id, entityCode: payout.code, after: { amount: p.amount, status }, req }, { transaction });
      await events.publish(transaction, { name: 'payout.scheduled', aggregateType: 'payout', aggregateId: payout.id, payload: { payoutId: payout.id, code: payout.code, payeeId: userId, amount: payout.amountPoisha, status, kind: 'withdrawal' } });
      if (status === 'needs_approval') {
        await events.publish(transaction, { name: 'payout.approval_requested', aggregateType: 'payout', aggregateId: payout.id, payload: { payoutId: payout.id, code: payout.code, payeeId: userId, amount: payout.amountPoisha } });
      }
      if (autoRelease) auto = payout.id;
      return payout;
    });
    if (auto) {
      try {
        await require('./payouts.service').releaseAuto(auto);
      } catch (err) {
        logger.info({ payoutId: auto, code: err.code }, 'withdrawal not auto-released');
      }
    }
    return require('./payouts.service').meGet(userId, out.id);
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw fail('WITHDRAW_OPEN');
    throw err;
  }
}

/** GET /me/withdrawals */
async function list(userId) {
  const rows = await Payout.findAll({ where: { payeeId: userId, kind: 'withdrawal' }, order: [['createdAt', 'DESC']], limit: 50 });
  return { items: rows.map((p) => ({ id: p.id, code: p.code, amount: p.amountPoisha, status: p.status, createdAt: p.createdAt, paidAt: p.paidAt ?? null })) };
}

module.exports = { available, create, list, plan };
