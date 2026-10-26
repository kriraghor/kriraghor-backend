'use strict';

/**
 * M24 master-set fees, per-gym and per-owner overrides and the referral fee (§5.12, §6.4, §6.5).
 *  - effective(key, { gymId, ownerId, at }): gym override ?? owner override ?? platform_settings, with
 *    what to snapshot (setting version or override id) (M24-FR-93, FR-94).
 *  - M20 pass purchase takes fees.gym_pct through the facade (passFee) and snapshots the bps and the
 *    override id on the pass (M24-FR-95). Trainer subscriptions keep the plain setting.
 *  - Overrides (master, step-up settings.write): one active per scope and key, inside the setting's
 *    bounds; ended by a master or by the overrides-end job at valid_to; audited; the owner is told.
 *  - Referral fee (M24-FR-91, FR-92): a member with source `platform` gets one gym_referrals row on their
 *    first positive payment at that gym, with the effective fee snapshotted; a reversal of that payment
 *    before invoicing voids it.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { pctToBps } = require('../../common/money');
const { sequelize, GymFeeOverride, GymReferral, GymLinkRequest } = require('../../models');
const settings = require('../settings').settings;
const directory = require('../users').directory;
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');

const { fail } = c;
const KEYS = Object.freeze(['fees.gym_referral_poisha', 'fees.gym_pct']);

/** §6.5: the value that applies to a gym (or an owner) at `at`. */
async function effective(key, { gymId = null, ownerId, at = new Date(), transaction } = {}) {
  const scopes = [{ scopeType: 'owner', scopeId: ownerId }, ...(gymId ? [{ scopeType: 'gym', scopeId: gymId }] : [])];
  const overrides = await GymFeeOverride.findAll({ where: { key, status: 'active', [Op.or]: scopes }, transaction });
  const snap = settings.snapshot([key])[key];
  return rules.effectiveFee({ key, gymId, ownerId, at, overrides, setting: { value: snap.value, version: snap.version } });
}

/** M24-FR-95: the pass commission for M20 as an M06 fee snapshot { feeBps, settingKey, settingsVersion, overrideId }. */
async function passFee({ gymId, ownerId, at = new Date(), transaction } = {}) {
  const e = await effective('fees.gym_pct', { gymId, ownerId, at, transaction });
  return { feeBps: pctToBps(e.value), settingKey: 'fees.gym_pct', settingsVersion: e.settingVersion ?? 0, overrideId: e.overrideId };
}

/** The fees that apply to an owner, for the billing page (M24-FR-90): standard or a special rate until {date}. */
async function feesFor(ownerId) {
  const [referral, pass] = await Promise.all([effective('fees.gym_referral_poisha', { ownerId }), effective('fees.gym_pct', { ownerId })]);
  return {
    referral: { valuePoisha: referral.value, source: referral.source, validTo: c.iso(referral.validTo) },
    passCommission: { pct: pass.value, source: pass.source, validTo: c.iso(pass.validTo) },
  };
}

// ---------------------------------------------------------------- overrides (admin, M24-FR-94)

const overrideView = (o) => ({
  id: o.id,
  scopeType: o.scopeType,
  scopeId: o.scopeId,
  ownerId: o.ownerId,
  key: o.key,
  value: o.value,
  reason: o.reason,
  validFrom: c.iso(o.validFrom),
  validTo: c.iso(o.validTo),
  status: o.status,
  source: o.scopeType === 'gym' ? 'gym_override' : 'owner_override',
  setBy: o.setBy,
  endedBy: o.endedBy ?? null,
  endedAt: c.iso(o.endedAt),
  endReason: o.endReason ?? null,
  createdAt: c.iso(o.createdAt),
});

const overridePayload = (o) => ({ overrideId: o.id, scopeType: o.scopeType, scopeId: o.scopeId, ownerId: o.ownerId, key: o.key, value: o.value, validFrom: c.iso(o.validFrom), validTo: c.iso(o.validTo) });

/** GET /admin/gym-manage/fee-overrides?ownerId&status (manage_gyms). */
async function listOverrides({ ownerId, status } = {}) {
  const rows = await GymFeeOverride.findAll({ where: { ...(ownerId ? { ownerId } : {}), ...(status ? { status } : {}) }, order: [['createdAt', 'DESC']], limit: 500 });
  return { items: rows.map(overrideView) };
}

/** POST /admin/gym-manage/fee-overrides (master, step-up settings.write). */
async function createOverride(actor, { scopeType, scopeId, key, value, reason, validFrom, validTo = null }, req) {
  let ownerId = scopeId;
  if (scopeType === 'gym') {
    const gym = await gymFacade.get(scopeId);
    if (!gym) throw E.notFound('Gym');
    ownerId = gym.ownerId;
  } else if (!(await directory.accounts([scopeId])).get(scopeId)) throw E.notFound('Owner');
  const def = settings.definition(key);
  const block = rules.overrideBlock({ value, min: Number(def.minValue), max: Number(def.maxValue) });
  if (block) throw fail(block, { min: Number(def.minValue), max: Number(def.maxValue) });
  const from = validFrom ? new Date(validFrom) : new Date();
  const to = validTo ? new Date(validTo) : null;
  if (to && to <= from) throw E.validation([{ field: 'validTo', message: 'Must be after validFrom' }]);
  try {
    const row = await sequelize.transaction(async (transaction) => {
      const active = await GymFeeOverride.findOne({ where: { scopeType, scopeId, key, status: 'active' }, transaction });
      if (active) throw fail('GYM_OVERRIDE_ACTIVE', { overrideId: active.id });
      const o = await GymFeeOverride.create({ scopeType, scopeId, ownerId, key, value, reason, validFrom: from, validTo: to, setBy: actor.id }, { transaction });
      await c.publish(transaction, 'gym_fee_override.set', 'gym_fee_override', o.id, overridePayload(o), actor);
      await c.record({ action: 'gym_fee_override.set', actor, entityType: 'gym_fee_override', entityId: o.id, after: { scopeType, scopeId, key, value, validFrom: c.iso(from), validTo: c.iso(to) }, reason, meta: { ownerId }, req }, transaction);
      return o;
    });
    return overrideView(row);
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw fail('GYM_OVERRIDE_ACTIVE');
    throw err;
  }
}

/** End an override inside the caller's transaction (a master, or the job at valid_to). */
async function endOverrideIn(transaction, o, { actor = null, reason, now = new Date() }) {
  await o.update({ status: 'ended', endedAt: now, endedBy: actor?.id ?? null, endReason: reason }, { transaction });
  await c.publish(transaction, 'gym_fee_override.ended', 'gym_fee_override', o.id, { ...overridePayload(o), reason: actor ? 'ended_by_master' : 'valid_to_reached' }, actor);
}

/** POST /admin/gym-manage/fee-overrides/:overrideId/end { reason } (master, step-up settings.write). */
async function endOverride(actor, overrideId, { reason }, req) {
  const row = await sequelize.transaction(async (transaction) => {
    const o = await GymFeeOverride.findByPk(overrideId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!o) throw E.notFound('Override');
    if (o.status !== 'active') throw E.conflict('GYM_OVERRIDE_ENDED', 'This override has already ended');
    await endOverrideIn(transaction, o, { actor, reason });
    await c.record({ action: 'gym_fee_override.ended', actor, entityType: 'gym_fee_override', entityId: o.id, before: { status: 'active' }, after: { status: 'ended' }, reason, meta: { ownerId: o.ownerId }, req }, transaction);
    return o;
  });
  return overrideView(row);
}

/** Job gym-manage.overrides-end: active overrides past valid_to → ended (status guard). */
async function overridesEnd(now = new Date()) {
  const due = await GymFeeOverride.findAll({ where: { status: 'active', validTo: { [Op.lte]: now } }, attributes: ['id'] });
  let ended = 0;
  for (const { id } of due) {
    const done = await sequelize.transaction(async (transaction) => {
      const o = await GymFeeOverride.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (o.status !== 'active' || !o.validTo || new Date(o.validTo) > now) return false;
      await endOverrideIn(transaction, o, { reason: 'valid_to reached', now });
      return true;
    });
    if (done) ended += 1;
  }
  return { ended };
}

// ---------------------------------------------------------------- referrals (M24-FR-91, FR-92)

/**
 * After a positive payment is recorded (any method): a platform member's first one at the gym writes a
 * referral with the effective fee snapshotted. One per (gym, member) (partial unique index); a fee of 0
 * switches it off. Inside the caller's transaction. Returns the referral or null.
 */
async function chargeReferralIn(transaction, { gym, member, payment, actor = null, now = new Date() }) {
  if (member.source !== 'platform' || payment.amountPoisha <= 0) return null;
  if (await GymReferral.findOne({ where: { memberId: member.id, status: { [Op.ne]: 'void' } }, attributes: ['id'], transaction })) return null;
  const fee = await effective('fees.gym_referral_poisha', { gymId: gym.id, ownerId: gym.ownerId, at: now, transaction });
  if (!(fee.value > 0)) return null;
  const request = await GymLinkRequest.findOne({
    where: { gymId: gym.id, direction: 'join_request', [Op.or]: [{ memberId: member.id }, { phoneHash: member.phoneHash }] },
    order: [['createdAt', 'DESC']],
    attributes: ['id'],
    transaction,
  });
  let row;
  try {
    row = await sequelize.transaction({ transaction }, (t) =>
      GymReferral.create(
        { gymId: gym.id, ownerId: gym.ownerId, memberId: member.id, linkRequestId: request?.id ?? null, firstFeePaymentId: payment.id, amountPoisha: Math.round(fee.value), source: fee.source, overrideId: fee.overrideId, settingVersion: fee.settingVersion },
        { transaction: t }
      )
    );
  } catch (err) {
    if (err instanceof UniqueConstraintError) return null;
    throw err;
  }
  await c.publish(transaction, 'gym_referral.charged', 'gym_referral', row.id, { referralId: row.id, gymId: gym.id, ownerId: gym.ownerId, memberId: member.id, amount: row.amountPoisha, source: row.source }, actor);
  return row;
}

/** A reversal of the referral's first payment before invoicing voids it (M24-FR-91). Inside the caller's transaction. */
async function voidReferralForPaymentIn(transaction, { feePaymentId, reason = 'payment_reversed', actor = null, now = new Date() }) {
  const r = await GymReferral.findOne({ where: { firstFeePaymentId: feePaymentId, status: 'pending' }, transaction, lock: transaction.LOCK.UPDATE });
  if (!r) return null;
  await r.update({ status: 'void', voidedAt: now, voidReason: reason }, { transaction });
  await c.publish(transaction, 'gym_referral.voided', 'gym_referral', r.id, { referralId: r.id, gymId: r.gymId, ownerId: r.ownerId, memberId: r.memberId, amount: r.amountPoisha, source: r.source, reason }, actor);
  return r;
}

/**
 * M24-FR-92: a member added at the desk whose phone matches a join request to the same gym from the last
 * gym_manage.referral_match_days (declined, expired or cancelled) came through Kriraghor: source platform.
 */
async function matchesJoinRequest({ gymId, phoneHash, now = new Date(), transaction }) {
  const days = c.cfg().referralMatchDays;
  if (days <= 0) return false;
  const since = new Date(now.getTime() - days * 86400000);
  const r = await GymLinkRequest.findOne({ where: { gymId, phoneHash, direction: 'join_request', status: ['declined', 'expired', 'cancelled'], createdAt: { [Op.gte]: since } }, attributes: ['id'], transaction });
  return Boolean(r);
}

const referralView = (r) => ({ id: r.id, gymId: r.gymId, memberId: r.memberId, amountPoisha: r.amountPoisha, source: r.source, status: r.status, invoiceId: r.invoiceId ?? null, createdAt: c.iso(r.createdAt), voidedAt: c.iso(r.voidedAt) });

module.exports = { KEYS, effective, passFee, feesFor, overrideView, listOverrides, createOverride, endOverride, endOverrideIn, overridesEnd, chargeReferralIn, voidReferralForPaymentIn, matchesJoinRequest, referralView };
