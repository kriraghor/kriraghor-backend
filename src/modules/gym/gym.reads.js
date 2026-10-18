'use strict';

/**
 * M20 reads for other modules: M19 "Needs your action" (members: renewals to pay; gym owners: gyms
 * with changes requested) and M08 notification facts. Codes, names and amounts only.
 */
const { Op } = require('sequelize');
const { Gym, GymPass, TrainerSubscription, TrainerSubscriptionPeriod } = require('../../models');

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

module.exports = { pendingActions, passFacts };
