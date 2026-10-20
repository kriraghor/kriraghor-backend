'use strict';

/**
 * M20 passes (FR-03 to FR-07, v3 packages).
 *  - Buy (gate buy_gym_pass, Idempotency-Key): a package of a live gym for a start date; the price is
 *    the live package's, the fee snapshot M06's (fees.gym_pct). A day pass needs a date the gym opens
 *    within gym.pass_advance_days; the gym's daily capacity (if set) counts day passes per date under
 *    the gym row lock. One M06 payment and one escrow hold per pass (purpose gym_package).
 *  - Captured → active, with a signed QR token and a 6-character backup code (unique per gym among
 *    active passes). Not paid in time → void.
 *  - Cancel (holder): a day pass before its date, a month or quarter pass before its first use, in
 *    full; nothing after. Unpaid → void.
 *  - Expiry (gym.tick, Q110): a day pass when the gym closes on its date, month and quarter passes
 *    after their last day; money not yet released goes to the gym minus the fee.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const crypto = require('crypto');
const { E } = require('../../common/errors');
const { randomToken } = require('../../common/crypto');
const { nextCode } = require('../../common/sequences');
const { sequelize, Gym, GymPackage, GymPass } = require('../../models');
const audit = require('../audit').audit;
const payments = require('../payments').intents;
const purposes = require('../payments').purposes;
const settings = require('../settings').settings;
const { payUrl } = require('../payments').intents;
const rules = require('./gym.rules');
const c = require('./gym.common');

const { fail } = c;
const SOLD = ['pending_payment', 'active', 'redeemed', 'expired'];

async function gymRef(gymId) {
  const g = await Gym.findByPk(gymId, { attributes: ['id', 'slug', 'name', 'liveSnapshot'] });
  return g ? { id: g.id, slug: g.slug, name: g.liveSnapshot?.name ?? g.name, addressLine: g.liveSnapshot?.addressLine ?? null } : null;
}

async function result(pass, viewer) {
  const holder = viewer === pass.holderId;
  return {
    pass: c.passView(pass, { gym: await gymRef(pass.gymId), withSecrets: holder }),
    payment: holder && pass.status === 'pending_payment' && pass.paymentId ? { id: pass.paymentId, payUrl: payUrl(pass.paymentId) } : null,
  };
}

/** POST /gym/passes { packageId, validFrom } [Idempotency-Key]. */
async function buy(principal, { packageId, validFrom }, idempotencyKey, req) {
  const again = () => GymPass.findOne({ where: { holderId: principal.id, idempotencyKey } });
  const prior = await again();
  if (prior) return result(prior, principal.id);
  const now = new Date();
  const cfg = c.config();
  try {
    const pass = await sequelize.transaction(async (transaction) => {
      const pkgRow = await GymPackage.findByPk(packageId, { transaction });
      if (!pkgRow) throw fail('PACKAGE_UNKNOWN');
      const g = await c.lockGym(pkgRow.gymId, transaction);
      if (!g || g.status !== 'live') throw fail('GYM_NOT_AVAILABLE');
      const pkg = g.liveSnapshot.packages.find((p) => p.id === packageId);
      if (!pkg) throw fail('PACKAGE_UNKNOWN');
      const v = rules.validity({ kind: pkg.kind, days: pkg.days, from: validFrom, today: c.today(now), now, advanceDays: cfg.advanceDays, hours: g.liveSnapshot.hours });
      if (v.block) throw fail(v.block);
      if (pkg.kind === 'day' && g.liveSnapshot.dailyCapacity) {
        const sold = await GymPass.count({ where: { gymId: g.id, kind: 'day', validFrom: v.validFrom, status: SOLD }, transaction });
        if (sold >= g.liveSnapshot.dailyCapacity) throw fail('PASS_CAPACITY_FULL');
      }
      const payBy = new Date(now.getTime() + cfg.payMinutes * 60000);
      const row = await GymPass.create(
        {
          code: await nextCode('GP', transaction),
          gymId: g.id,
          packageId: pkg.id,
          holderId: principal.id,
          ownerId: g.ownerId,
          kind: pkg.kind,
          title: pkg.title,
          validFrom: v.validFrom,
          validTo: v.validTo,
          pricePoisha: pkg.price,
          feeBps: 0,
          feePoisha: 0,
          netPoisha: pkg.price,
          qrNonce: randomToken(12),
          status: 'pending_payment',
          payBy,
          idempotencyKey,
        },
        { transaction }
      );
      const p = await payments.createIntent(
        { purpose: 'gym_package', purposeId: row.id, payerId: principal.id, payeeId: g.ownerId, amount: pkg.price, title: `${pkg.title} · ${g.liveSnapshot.name}`, expiresAt: payBy, idempotencyKey: `gym_pass:${row.id}` },
        { transaction }
      );
      // The fee rate is the one M06 snapshotted on the payment, so the release matches it.
      const m = rules.money(pkg.price, p.escrow.fee.feeBps);
      await row.update({ paymentId: p.id, feeBps: p.escrow.fee.feeBps, feePoisha: m.fee, netPoisha: m.net }, { transaction });
      await audit.record({ action: 'gym_pass.created', actor: principal, entityType: 'gym_pass', entityId: row.id, entityCode: row.code, after: { kind: row.kind, validFrom: row.validFrom, price: row.pricePoisha }, req }, { transaction });
      return row;
    });
    return result(pass, principal.id);
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const row = await again();
      if (row) return result(row, principal.id);
    }
    throw err;
  }
}

/** A backup code no active pass of the gym holds (the partial unique index is the last word). */
async function freshCode(gymId, transaction) {
  for (let i = 0; i < 8; i += 1) {
    const code = rules.backupCode(crypto.randomBytes(6));
    if (!(await GymPass.findOne({ where: { gymId, backupCode: code, status: 'active' }, attributes: ['id'], transaction }))) return code;
  }
  throw new Error('No free backup code');
}

/** M06 purpose hook (inside the capture transaction): pending → active with its codes. */
async function onCaptured({ payment, transaction }) {
  const p = await GymPass.findOne({ where: { paymentId: payment.id }, transaction, lock: transaction.LOCK.UPDATE });
  if (!p) return 'reject';
  if (['active', 'redeemed', 'expired'].includes(p.status)) return 'accept';
  if (p.status !== 'pending_payment') return 'reject';
  await p.update({ status: 'active', backupCode: await freshCode(p.gymId, transaction), paidAt: new Date(), payBy: null }, { transaction });
  await c.publishPass(transaction, 'gym_pass.paid', p, { validFrom: p.validFrom, validTo: p.validTo, paymentId: payment.id });
  return 'accept';
}
purposes.register('gym_package', { onCaptured });

async function voidUnpaid(p, reason, { transaction }) {
  if (p.paymentId) {
    try {
      await payments.cancelIntent(p.paymentId, { transaction });
    } catch {
      // A capture that lands later is rejected by onCaptured and refunded in full by M06.
    }
  }
  await p.update({ status: 'void', closedAt: new Date(), closeReason: reason, payBy: null }, { transaction });
}

/** payment.failed / payment.expired (purpose gym_package): the unpaid pass is void (capacity frees). */
async function onPaymentClosed(paymentId, { transaction }) {
  const p = await GymPass.findOne({ where: { paymentId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!p || p.status !== 'pending_payment') return null;
  await voidUnpaid(p, 'not_paid', { transaction });
  return 'void';
}

async function holderPass(principal, idOrCode, { transaction, lock = false } = {}) {
  const where = /^[0-9a-f-]{36}$/i.test(idOrCode) ? { id: idOrCode } : { code: idOrCode };
  const p = await GymPass.findOne({ where, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!p || p.holderId !== principal.id) throw E.notFound('Pass');
  return p;
}

/** GET /me/passes?status=active|used|expired. */
async function listMine(principal, { status } = {}) {
  const groups = { active: ['pending_payment', 'active'], used: ['redeemed'], expired: ['expired', 'cancelled', 'refunded', 'void'] };
  const rows = await GymPass.findAll({ where: { holderId: principal.id, ...(status ? { status: groups[status] } : { status: { [Op.ne]: 'void' } }) }, order: [['validFrom', 'DESC'], ['createdAt', 'DESC']], limit: 100 });
  const gyms = new Map();
  for (const id of new Set(rows.map((r) => r.gymId))) gyms.set(id, await gymRef(id));
  return { items: rows.map((p) => c.passView(p, { gym: gyms.get(p.gymId) })) };
}

/** GET /me/passes/:code: one pass with its QR token and backup code while it can be used. */
async function getMine(principal, idOrCode) {
  return result(await holderPass(principal, idOrCode), principal.id);
}

/** POST /me/passes/:id/cancel. */
async function cancel(principal, id, req) {
  const p = await sequelize.transaction(async (transaction) => {
    const row = await holderPass(principal, id, { transaction, lock: true });
    if (row.status === 'pending_payment') {
      await voidUnpaid(row, 'holder_cancelled', { transaction });
      return row;
    }
    const plan = rules.cancelPlan({ pass: row, today: c.today() });
    if (plan.block) throw fail(plan.block);
    const refunded = await c.refund(row, plan.refund, { reasonCode: 'pass_cancelled', key: `gym_pass:${row.id}:cancel`, actor: principal, transaction });
    await row.update({ status: 'refunded', closedAt: new Date(), closeReason: 'holder_cancelled' }, { transaction });
    await audit.record({ action: 'gym_pass.cancelled', actor: principal, entityType: 'gym_pass', entityId: row.id, entityCode: row.code, after: { refunded }, req }, { transaction });
    await c.publishPass(transaction, 'gym_pass.cancelled', row, { refund: refunded, by: 'holder' }, principal);
    return row;
  });
  return result(p, principal.id);
}

/** Tick: unpaid passes past their deadline (plus M06's grace) void; used-up or past passes expire (Q110). */
async function sweep(now = new Date()) {
  const out = { voided: 0, expired: 0 };
  const grace = settings.get('payments.unknown_grace_minutes') * 60000;
  const unpaid = await GymPass.findAll({ where: { status: 'pending_payment', payBy: { [Op.lt]: new Date(now.getTime() - grace) } }, attributes: ['id'] });
  for (const { id } of unpaid) {
    await sequelize.transaction(async (transaction) => {
      const p = await c.lockPass(id, transaction);
      if (p.status !== 'pending_payment') return;
      await voidUnpaid(p, 'not_paid', { transaction });
      out.voided += 1;
    });
  }
  const due = await GymPass.findAll({ where: { status: 'active', validTo: { [Op.lte]: c.today(now) } }, attributes: ['id', 'gymId'] });
  const hoursOf = new Map();
  for (const { id, gymId } of due) {
    if (!hoursOf.has(gymId)) hoursOf.set(gymId, (await Gym.findByPk(gymId, { attributes: ['liveSnapshot'] }))?.liveSnapshot?.hours ?? []);
    await sequelize.transaction(async (transaction) => {
      const p = await c.lockPass(id, transaction);
      if (p.status !== 'active' || rules.expiresAt(p, hoursOf.get(gymId)) > now) return;
      const moved = await c.release(p, { transaction });
      await p.update({ status: 'expired', closedAt: now, closeReason: p.firstRedeemedAt ? 'ended' : 'unused' }, { transaction });
      await c.publishPass(transaction, 'gym_pass.expired', p, { used: Boolean(p.firstRedeemedAt), released: moved.gross, net: moved.net });
      out.expired += 1;
    });
  }
  return out;
}

module.exports = { buy, onCaptured, onPaymentClosed, listMine, getMine, cancel, sweep, result, gymRef, holderPass };
