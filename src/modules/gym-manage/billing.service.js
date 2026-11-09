'use strict';

/**
 * M24 the owner's plan (§5.11, §6.6): one subscription per owner across their gyms (G3), the tier the
 * owner chooses (features unlock or lock at once, FR-82), today's active members and this month's peak
 * against the plan's limit (FR-83, G7), and the public pricing from settings (never hard-coded, §4.1).
 * Prompt 2 adds to the billing page the open invoices, the founding partner status and the fees that
 * apply to this owner (FR-88, FR-90; invoices.service), and the SMS add-on card (prompt 3b, sms.service).
 */
const { QueryTypes } = require('sequelize');
const { AppError } = require('../../common/errors');
const { sequelize, GymOwnerSubscription } = require('../../models');
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');

/** The plans with their limits, prices and features, from settings (§3.5, §6.12). */
function tiers() {
  const t = c.tierCfg();
  const price = { free: 0, basic: t.basicPrice, standard: t.standardPrice, pro: t.proPrice };
  return rules.TIERS.map((key) => ({
    key,
    maxMembers: rules.tierLimit(key, t),
    pricePoisha: price[key],
    features: rules.FEATURES.filter((f) => rules.hasFeature(key, f, t.featureMinTiers)),
    ...(key === 'pro' ? { minGyms: t.proMinGyms } : {}),
  }));
}

/** GET /gym-manage/pricing (public). */
async function pricing() {
  const t = c.tierCfg();
  // Prompt 3 (the landing page, §4.1): the founding partner offer shows while places are left (M24-FR-88).
  const s = c.saasCfg();
  const taken = await GymOwnerSubscription.count({ where: { foundingPartner: true } });
  return {
    currency: 'BDT',
    tiers: tiers(),
    featureMinTiers: t.featureMinTiers,
    activeWindowDays: c.cfg().activeWindowDays,
    noticePct: t.noticePct,
    foundingPlacesLeft: Math.max(0, s.foundingLimit - taken),
    founding: { limit: s.foundingLimit, freeMonths: s.foundingFreeMonths, discountPct: s.foundingDiscountPct, discountMonths: s.foundingDiscountMonths },
  };
}

/**
 * Active members of an owner on a Dhaka day (§6.6, FR-83): non-removed members of all their gyms with a
 * counted check-in or a positive, non-reversed payment dated in (day − active_window_days, day].
 */
async function activeCount(ownerId, day) {
  const since = rules.addDays(day, -c.cfg().activeWindowDays);
  const [row] = await sequelize.query(
    `SELECT COUNT(*)::int AS active
       FROM gym_members m
      WHERE m.owner_id = :ownerId AND m.status <> 'removed' AND (
        EXISTS (SELECT 1 FROM gym_attendance a WHERE a.member_id = m.id AND a.counted AND a.local_date > :since AND a.local_date <= :day)
        OR EXISTS (SELECT 1 FROM gym_fee_payments p WHERE p.member_id = m.id AND p.amount_poisha > 0 AND p.paid_on > :since AND p.paid_on <= :day
                     AND NOT EXISTS (SELECT 1 FROM gym_fee_payments r WHERE r.reverses_id = p.id)))`,
    { replacements: { ownerId, since, day }, type: QueryTypes.SELECT }
  );
  const [{ withMembers }] = await sequelize.query("SELECT COUNT(DISTINCT gym_id)::int AS \"withMembers\" FROM gym_members WHERE owner_id = :ownerId AND status <> 'removed'", { replacements: { ownerId }, type: QueryTypes.SELECT });
  return { active: row.active, gymsWithMembers: withMembers };
}

/** The caller must own at least one gym (gate run_gym is checked by the route). */
async function ownerGyms(principal) {
  const gyms = await gymFacade.ofOwner(principal.id);
  if (!gyms.length) throw new AppError(403, 'PERMISSION_REQUIRED', 'Only a gym owner has a gym plan', { meta: { permission: 'owner.only' } });
  return gyms;
}

async function billingView(principal, gyms) {
  const sub = await c.ensureSubscription(principal.id);
  const t = c.tierCfg();
  const today = c.today();
  const counts = await activeCount(principal.id, today);
  const extras = await require('./invoices.service').billingExtras(principal.id, sub);
  const peak = Math.max(extras.monthPeak ?? 0, counts.active);
  return {
    subscription: {
      id: sub.id,
      chosenTier: sub.chosenTier,
      monthMaxTier: sub.monthOf === rules.firstOfMonth(today) ? sub.monthMaxTier : sub.chosenTier,
      monthOf: rules.firstOfMonth(today),
      status: sub.status,
      startedOn: sub.startedOn,
      foundingPartner: sub.foundingPartner,
      foundingNo: sub.foundingNo ?? null,
      freeUntil: extras.founding.freeUntil,
      discountUntil: extras.founding.discountUntil,
      restrictOn: extras.restrictOn,
    },
    activeMembers: {
      today: counts.active,
      monthPeak: peak,
      limit: rules.tierLimit(sub.chosenTier, t),
      fitTier: counts.gymsWithMembers >= t.proMinGyms ? 'pro' : rules.fitTier(peak, t),
      gymsWithMembers: counts.gymsWithMembers,
      windowDays: c.cfg().activeWindowDays,
      noticePct: t.noticePct,
    },
    features: rules.featuresOf(sub.chosenTier, t.featureMinTiers),
    tiers: tiers(),
    gyms: gyms.map((g) => ({ id: g.id, name: g.name, listingStatus: g.status })),
    fees: extras.fees,
    founding: extras.founding,
    smsAddon: await require('./sms.service').view(principal.id, sub),
    openInvoices: extras.openInvoices,
  };
}

/** GET /manage/billing (gate run_gym, owner of at least one gym). */
async function get(principal) {
  return billingView(principal, await ownerGyms(principal));
}

/** PUT /manage/billing/tier { tier }: features change at once; the month bills the highest tier chosen (FR-82). */
async function setTier(principal, { tier }, req) {
  const gyms = await ownerGyms(principal);
  await c.ensureSubscription(principal.id);
  await sequelize.transaction(async (transaction) => {
    const sub = await GymOwnerSubscription.findOne({ where: { ownerId: principal.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (sub.status === 'closed') throw c.fail('GYM_ACCOUNT_RESTRICTED');
    if (sub.chosenTier === tier) return;
    const from = sub.chosenTier;
    const next = rules.chooseTier({ monthOf: sub.monthOf, monthMaxTier: sub.monthMaxTier, today: c.today(), tier });
    await sub.update({ ...next, ...(tier !== 'free' && !sub.paidTierSince ? { paidTierSince: next.monthOf } : {}) }, { transaction });
    await c.publish(transaction, 'gym_subscription.tier_changed', 'gym_owner_subscription', sub.id, { subscriptionId: sub.id, ownerId: principal.id, from, to: tier }, principal);
    await c.record({ action: 'gym_subscription.tier_changed', actor: principal, entityType: 'gym_owner_subscription', entityId: sub.id, before: { tier: from }, after: { tier, monthMaxTier: next.monthMaxTier }, req }, transaction);
  });
  return billingView(principal, gyms);
}

module.exports = { tiers, pricing, activeCount, get, setTier };
