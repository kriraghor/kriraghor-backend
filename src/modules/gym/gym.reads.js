'use strict';

/**
 * M20 reads for other modules: M19 "Needs your action" (members: renewals to pay; gym owners: gyms
 * with changes requested), M08 notification facts and M19 gym facts (passKpiFact and the reconcile's
 * exportPassKpiFacts). Codes, names and amounts only.
 */
const { Op } = require('sequelize');
const { Gym, GymPass, PassRedemption, TrainerSubscription, TrainerSubscriptionPeriod } = require('../../models');

const earliest = (rows, key) => rows.reduce((m, r) => (r[key] && (!m || r[key] < m) ? r[key] : m), null);

async function pendingActions(principal, role) {
  const items = [];
  if (role === 'gym_owner') {
    const changes = await Gym.findAll({ where: { ownerId: principal.id, [Op.or]: [{ status: 'changes_requested' }, { editStatus: 'changes_requested' }] }, attributes: ['id'] });
    if (changes.length) items.push({ key: 'gym_changes_requested', count: changes.length, severity: 'normal', dueAt: null, href: '/vendor/gyms' });
    return items;
  }
  const subs = await TrainerSubscription.findAll({ where: { memberId: principal.id, status: 'active' }, attributes: ['id'] });
  const due = subs.length ? await TrainerSubscriptionPeriod.findAll({ where: { subscriptionId: subs.map((s) => s.id), status: 'pending_payment', seq: { [Op.gt]: 1 } }, attributes: ['payBy'] }) : [];
  if (due.length) items.push({ key: 'trainer_renewals_due', count: due.length, severity: 'high', dueAt: earliest(due, 'payBy')?.toISOString() ?? null, href: '/me/subscriptions' });
  return items;
}

/** What a notification needs about a pass (the gym's public name). */
async function passFacts(passId) {
  const p = await GymPass.findByPk(passId, { attributes: ['gymId', 'title', 'validFrom', 'validTo'] });
  if (!p) return null;
  const g = await Gym.findByPk(p.gymId, { attributes: ['name', 'liveSnapshot'] });
  return { gym: g?.liveSnapshot?.name ?? g?.name ?? '', title: p.title, validFrom: p.validFrom, validTo: p.validTo };
}

// ---------------------------------------------------------------- M19 facts (Round B2)

const kpiFact = (p, admissions) => ({
  passId: p.id,
  sourceVersion: p.updatedAt.getTime(),
  code: p.code,
  gymId: p.gymId,
  ownerId: p.ownerId,
  packageId: p.packageId,
  kind: p.kind,
  title: p.title,
  status: p.status,
  price: p.pricePoisha,
  fee: p.feePoisha,
  refunded: p.refundedPoisha,
  released: p.releasedPoisha,
  paidAt: p.paidAt,
  validFrom: p.validFrom,
  validTo: p.validTo,
  firstRedeemedAt: p.firstRedeemedAt,
  admissions: admissions.map((r) => ({ id: r.id, redeemedAt: r.redeemedAt, method: r.method })),
});

/**
 * M19 gym facts (§6.3 gym, FR-08): a pass with its front-desk admissions, amounts in poisha. No holder
 * id, name or phone leaves M20.
 */
async function passKpiFact(passId) {
  const p = await GymPass.findByPk(passId);
  if (!p) return null;
  return kpiFact(p, await PassRedemption.findAll({ where: { passId: p.id }, order: [['redeemedAt', 'ASC']] }));
}

/** FactsExporter (M19-FR-09): passes changed in [since, until] (an admission touches its pass; since null: all). */
async function exportPassKpiFacts({ since = null, until = new Date() } = {}) {
  const rows = await GymPass.findAll({ where: { updatedAt: since ? { [Op.gte]: since, [Op.lte]: until } : { [Op.lte]: until } }, order: [['updatedAt', 'ASC']] });
  if (!rows.length) return [];
  const all = await PassRedemption.findAll({ where: { passId: { [Op.in]: rows.map((p) => p.id) } }, order: [['redeemedAt', 'ASC']] });
  return rows.map((p) => kpiFact(p, all.filter((r) => r.passId === p.id)));
}

module.exports = { pendingActions, passFacts, passKpiFact, exportPassKpiFacts };
