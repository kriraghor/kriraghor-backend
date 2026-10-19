'use strict';

/**
 * M22 prize funds (FR-05, FR-10, §6.3). An organiser pre-funds the guaranteed pool (every place plus
 * kill reward × max paid kills) into escrow:esports_prize_fund before the tournament goes to review
 * (no netting against entry fees, Q130). Deposits are M06 payments (purpose esports_prize_fund) grouped
 * by the fund row; a top-up is allowed while the tournament is a draft, a deposit beyond the pool is
 * refused at capture (refunded). At finalise the prizes leave the fund and the rest returns to the
 * organisation owner; a cancelled tournament returns the whole fund. Kriraghor never subsidises.
 */
const { E } = require('../../common/errors');
const { sequelize, EsportsTournament, EsportsPrizePlace, OrganiserPrizeFund } = require('../../models');
const audit = require('../audit/audit.service');
const payments = require('../payments/payments.service');
const purposes = require('../payments/payments.purposes');
const escrow = require('../payments/escrow.service');
const { payUrl } = require('../payments').intents;
const organisations = require('../organisations/organisations.service');
const rules = require('./saas.rules');
const c = require('./saas.common');

const { fail } = c;

function view(f) {
  if (!f) return null;
  return { id: f.id, tournamentId: f.tournamentId, required: f.requiredPoisha, deposited: f.depositedPoisha, paid: f.paidPoisha, returned: f.returnedPoisha, status: f.status, fundedAt: c.iso(f.fundedAt), settledAt: c.iso(f.settledAt) };
}

/** The pool a tournament must fund now, from its prize table and kill cap. */
async function requiredFor(t, { transaction } = {}) {
  const prizes = await EsportsPrizePlace.findAll({ where: { tournamentId: t.id }, attributes: ['amountPoisha'], transaction });
  return rules.requiredFund({ prizes: prizes.map((p) => ({ amount: p.amountPoisha })), killReward: t.killRewardPoisha, maxPaidKills: t.maxPaidKills });
}

async function fundOf(tournamentId, { transaction, lock = false } = {}) {
  return OrganiserPrizeFund.findOne({ where: { tournamentId }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
}

/** The fund's state for the console (required recomputed for a draft). */
async function stateFor(t, { transaction } = {}) {
  const f = await fundOf(t.id, { transaction });
  const required = t.status === 'draft' ? await requiredFor(t, { transaction }) : (f?.requiredPoisha ?? (await requiredFor(t, { transaction })));
  const deposited = f?.depositedPoisha ?? 0;
  return { ...(view(f) ?? { id: null, tournamentId: t.id, paid: 0, returned: 0, status: 'pending', fundedAt: null, settledAt: null }), required, deposited, toDeposit: Math.max(0, required - deposited), block: rules.fundBlock({ required, deposited }) };
}

/** POST /org/:orgId/esports/tournaments/:id/prize-fund [Idempotency-Key] (org admin): pay what is missing. */
async function deposit(principal, org, tournamentId, idempotencyKey) {
  return sequelize.transaction(async (transaction) => {
    const t = await EsportsTournament.findOne({ where: { id: tournamentId, organisationId: org.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!t) throw E.notFound('Tournament');
    if (t.status !== 'draft') throw fail('PRIZE_FUND_LOCKED');
    const required = await requiredFor(t, { transaction });
    let f = await fundOf(t.id, { transaction, lock: true });
    if (!f) f = await OrganiserPrizeFund.create({ tournamentId: t.id, organisationId: org.id, requiredPoisha: required }, { transaction });
    else await f.update({ requiredPoisha: required }, { transaction });
    const amount = required - f.depositedPoisha;
    if (amount <= 0) throw fail('PRIZE_FUND_LOCKED');
    const payment = await payments.createIntent(
      { purpose: 'esports_prize_fund', purposeId: f.id, payerId: principal.id, amount, title: `Prize fund: ${t.titleEn}`.slice(0, 120), groupRef: f.id, idempotencyKey: `prizefund:${f.id}:${idempotencyKey}` },
      { transaction }
    );
    return { fund: view(f), payment: { id: payment.id, amount, payUrl: payUrl(payment.id) } };
  });
}

/** M06 hook: a deposit counts while the tournament is a draft and the pool is not yet covered; otherwise it is refunded. */
async function onCaptured({ payment, transaction }) {
  const f = await OrganiserPrizeFund.findByPk(payment.purposeId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!f) return 'reject';
  const t = await EsportsTournament.findByPk(f.tournamentId, { transaction });
  if (!t || t.status !== 'draft' || f.depositedPoisha + payment.amountPoisha > f.requiredPoisha) return 'reject';
  const deposited = f.depositedPoisha + payment.amountPoisha;
  const funded = deposited === f.requiredPoisha;
  await f.update({ depositedPoisha: deposited, paymentIds: [...f.paymentIds, payment.id], status: funded ? 'funded' : 'pending', fundedAt: funded ? new Date() : f.fundedAt }, { transaction });
  await c.publish(transaction, 'organiser_prize_fund.deposited', 'organiser_prize_fund', f.id, { fundId: f.id, tournamentId: f.tournamentId, organisationId: f.organisationId, amount: payment.amountPoisha, deposited, funded });
  return 'accept';
}
purposes.register('esports_prize_fund', { onCaptured });

// ---------------------------------------------------------------- M21 hooks (saas.hooks)

/** A draft's prize table changed: the fund follows it (a smaller pool than the deposit is refused). */
async function onDraftChanged(t, { transaction }) {
  const f = await fundOf(t.id, { transaction, lock: true });
  if (!f) return;
  const required = await requiredFor(t, { transaction });
  if (required < f.depositedPoisha) throw fail('PRIZE_FUND_SHRINK');
  await f.update({ requiredPoisha: required, status: required === f.depositedPoisha ? 'funded' : 'pending' }, { transaction });
}

/** Why the fund blocks a submit (fresh from the prize table), or null. */
async function blockFor(t, { transaction }) {
  const f = await fundOf(t.id, { transaction, lock: true });
  const required = await requiredFor(t, { transaction });
  if (f && f.requiredPoisha !== required) await f.update({ requiredPoisha: required }, { transaction });
  return rules.fundBlock({ required, deposited: f?.depositedPoisha ?? 0 });
}

/** Finalise: prizes from the fund, entries less the fee and the fund's remainder to the owner (FR-07, FR-10). */
async function settle(t, { prizes, actor, transaction }) {
  const f = await fundOf(t.id, { transaction, lock: true });
  const organiserId = await organisations.ownerOf(t.organisationId, { transaction });
  const result = await escrow.settleOrganiserPool({ tournamentId: t.id, fundId: f.id, prizes, feeBps: t.saasFeeBps ?? 0, organiserId, actor }, { transaction });
  await f.update({ paidPoisha: result.paid, returnedPoisha: result.fundReturn, status: 'consumed', settledAt: new Date() }, { transaction });
  await audit.record({ action: 'organiser_prize_fund.settled', actor, entityType: 'organiser_prize_fund', entityId: f.id, after: { paid: result.paid, returned: result.fundReturn, fee: result.fee, net: result.net } }, { transaction });
  if (result.fundReturn > 0) await c.publish(transaction, 'organiser_prize_fund.returned', 'organiser_prize_fund', f.id, { fundId: f.id, tournamentId: t.id, organisationId: t.organisationId, amount: result.fundReturn }, actor);
  return result;
}

/** Cancel: entries were refunded to the players; the whole fund goes back to the owner. */
async function onCancelled(t, { actor = null, transaction }) {
  const f = await fundOf(t.id, { transaction, lock: true });
  if (!f || f.depositedPoisha === 0 || ['consumed', 'returned'].includes(f.status)) return null;
  const organiserId = await organisations.ownerOf(t.organisationId, { transaction });
  const result = await escrow.settleOrganiserPool({ tournamentId: t.id, fundId: f.id, prizes: [], feeBps: 0, organiserId, actor }, { transaction });
  await f.update({ returnedPoisha: result.fundReturn, status: 'returned', settledAt: new Date() }, { transaction });
  await c.publish(transaction, 'organiser_prize_fund.returned', 'organiser_prize_fund', f.id, { fundId: f.id, tournamentId: t.id, organisationId: t.organisationId, amount: result.fundReturn }, actor);
  return result;
}

/** A disqualified winner's prize goes back to the organiser (FR-10), not to Kriraghor. */
async function reverse(t, share, { actor, transaction }) {
  const organiserId = await organisations.ownerOf(t.organisationId, { transaction });
  return escrow.reverseToOrganiser({ groupRef: t.id, payeeId: share.userId, organiserId, amount: share.amountPoisha, key: share.id, actor }, { transaction });
}

module.exports = { view, requiredFor, stateFor, deposit, onCaptured, onDraftChanged, blockFor, settle, onCancelled, reverse };
