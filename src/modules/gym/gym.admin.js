'use strict';

/**
 * M20 staff desk (admin.kriraghor.com/admin/gym): a pass or a subscription by its code with its
 * escrow, and a master's platform cancel with a full refund of what is still held (step-up
 * escrow.manage). Gyms are listed, suspended and restored through gyms.service.
 */
const { E } = require('../../common/errors');
const { sequelize, GymPass, TrainerSubscription } = require('../../models');
const audit = require('../audit/audit.service');
const escrow = require('../payments/escrow.service');
const subscriptions = require('./subscriptions.service');
const passes = require('./passes.service');
const c = require('./gym.common');

const { fail } = c;
const holdView = async (paymentId) => {
  const id = paymentId ? await escrow.holdIdForPayment(paymentId) : null;
  return id ? escrow.getOne(id) : null;
};

/** GET /admin/gym/passes/:code. */
async function getPass(code) {
  const p = await GymPass.findOne({ where: { code: code.trim().toUpperCase() } });
  if (!p) throw E.notFound('Pass');
  return { ...c.passView(p, { gym: await passes.gymRef(p.gymId) }), holderId: p.holderId, ownerId: p.ownerId, money: { price: p.pricePoisha, fee: p.feePoisha, net: p.netPoisha, released: p.releasedPoisha, refunded: p.refundedPoisha }, escrow: await holdView(p.paymentId) };
}

/** GET /admin/gym/subscriptions/:code: the subscription and every month with its escrow. */
async function getSubscription(code) {
  const s = await TrainerSubscription.findOne({ where: { code: code.trim().toUpperCase() } });
  if (!s) throw E.notFound('Subscription');
  const periods = await subscriptions.periodsOf(s.id);
  return {
    id: s.id,
    code: s.code,
    status: s.status,
    title: s.title,
    price: s.pricePoisha,
    memberId: s.memberId,
    trainerId: s.trainerId,
    startedOn: s.startedOn,
    paidThrough: s.paidThrough ?? null,
    renew: s.renew,
    periods: await Promise.all(periods.map(async (p) => ({ seq: p.seq, periodStart: p.periodStart, periodEnd: p.periodEnd, status: p.status, price: p.pricePoisha, released: p.releasedPoisha, refunded: p.refundedPoisha, releaseAt: c.iso(p.releaseAt), escrow: await holdView(p.paymentId) }))),
  };
}

/** POST /admin/gym/passes/:code/cancel (master, step-up): refund what is held; the pass ends. */
async function cancelPass(actor, code, { reason }, req) {
  const passCode = await sequelize.transaction(async (transaction) => {
    const found = await GymPass.findOne({ where: { code: code.trim().toUpperCase() }, attributes: ['id'], transaction });
    if (!found) throw E.notFound('Pass');
    const p = await c.lockPass(found.id, transaction);
    if (p.status !== 'active') throw fail('PASS_NOT_ACTIVE');
    const refunded = await c.refund(p, c.heldOf(p), { reasonCode: 'platform_cancelled', key: `gym_pass:${p.id}:platform`, actor, transaction });
    await p.update({ status: 'refunded', closedAt: new Date(), closeReason: 'platform' }, { transaction });
    await audit.record({ action: 'gym_pass.platform_cancelled', actor, entityType: 'gym_pass', entityId: p.id, entityCode: p.code, after: { refunded }, reason, req }, { transaction });
    await c.publishPass(transaction, 'gym_pass.cancelled', p, { refund: refunded, by: 'staff' }, actor);
    return p.code;
  });
  return getPass(passCode);
}

module.exports = { getPass, getSubscription, cancelPass };
