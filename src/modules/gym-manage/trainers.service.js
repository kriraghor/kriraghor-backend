'use strict';

/**
 * M24 trainer assignment (§5.2 FR-21, FR-23; feature `trainers`, Standard and up). A trainer is a staff
 * member of the gym (M01 Round B3 business_members) holding members.trainer or plans.manage (§3.1); an
 * M11 trainer profile is unrelated (G12).
 *  - GET …/trainers: who can be picked (members.view or members.trainer), with how many members each has.
 *  - PUT …/members/:memberId/trainer { businessMemberId | null } (members.edit, refused while restricted):
 *    422 GYM_TRAINER_INVALID unless an active staff member of this gym holds one of the two permissions.
 *  - Consumers (§2.3): business_member.removed clears the staff member's assignments;
 *    business_member.permissions_changed clears them once neither permission is left. Plans and logs
 *    stay with the gym (§12.19).
 * Each change publishes gym_member.trainer_assigned (ids only) and is audited.
 */
const { QueryTypes } = require('sequelize');
const { sequelize, GymMember } = require('../../models');
const c = require('./gym-manage.common');
const members = require('./members.service');
const memberships = require('./memberships.service');

const { fail } = c;

const assignedPayload = (m, { businessMemberId, previous, reason, by }) => ({ memberId: m.id, gymId: m.gymId, ownerId: m.ownerId, by, businessMemberId, previousBusinessMemberId: previous, reason });

/** GET /manage/gyms/:gymId/trainers (members.view or members.trainer; feature trainers). */
async function list(principal, gymId) {
  await c.gymAccess(principal, gymId, null, { anyOf: members.SEE, feature: 'trainers' });
  const rows = await c.trainersOf(gymId);
  const counts = await sequelize.query(
    `SELECT trainer_business_member_id AS id, COUNT(*)::int AS n FROM gym_members
      WHERE gym_id = :gymId AND status <> 'removed' AND trainer_business_member_id IS NOT NULL GROUP BY trainer_business_member_id`,
    { replacements: { gymId }, type: QueryTypes.SELECT }
  );
  const n = new Map(counts.map((r) => [r.id, r.n]));
  return { items: rows.map((r) => ({ businessMemberId: r.businessMemberId, displayName: r.displayName, permissions: r.permissions, assignedMembers: n.get(r.businessMemberId) ?? 0 })) };
}

/** PUT /manage/gyms/:gymId/members/:memberId/trainer { businessMemberId | null } (members.edit; M24-FR-21). */
async function assign(principal, gymId, memberId, { businessMemberId }, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true, feature: 'trainers' });
  if (businessMemberId && !(await c.trainersOf(gymId)).some((t) => t.businessMemberId === businessMemberId)) throw fail('GYM_TRAINER_INVALID', { businessMemberId });
  await sequelize.transaction(async (transaction) => {
    const m = await memberships.lockedMember(gymId, memberId, transaction);
    if (m.status === 'removed') throw fail('GYM_MEMBER_STATE', { reason: 'removed' });
    const previous = m.trainerBusinessMemberId ?? null;
    if (previous === (businessMemberId ?? null)) return;
    await m.update({ trainerBusinessMemberId: businessMemberId ?? null, version: m.version + 1, updatedBy: principal.id }, { transaction });
    const reason = businessMemberId ? 'assigned' : 'cleared';
    await c.publish(transaction, 'gym_member.trainer_assigned', 'gym_member', m.id, assignedPayload(m, { businessMemberId: businessMemberId ?? null, previous, reason, by: principal.id }), a.actor);
    await c.record(
      { action: businessMemberId ? 'gym_member.trainer_assigned' : 'gym_member.trainer_cleared', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, before: { businessMemberId: previous }, after: { businessMemberId: businessMemberId ?? null }, meta: { gymId }, req },
      transaction
    );
  });
  return members.get(principal, gymId, memberId);
}

/** Clear every assignment to one staff member of a gym (the consumers), inside the inbox transaction. */
async function clearIn(transaction, { gymId, businessMemberId, reason }) {
  const rows = await GymMember.findAll({ where: { gymId, trainerBusinessMemberId: businessMemberId }, transaction, lock: transaction.LOCK.UPDATE });
  for (const m of rows) {
    await m.update({ trainerBusinessMemberId: null, version: m.version + 1 }, { transaction });
    await c.publish(transaction, 'gym_member.trainer_assigned', 'gym_member', m.id, assignedPayload(m, { businessMemberId: null, previous: businessMemberId, reason, by: null }));
    await c.record({ action: 'gym_member.trainer_cleared', actor: null, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, before: { businessMemberId }, after: { businessMemberId: null }, reason, meta: { gymId } }, transaction);
  }
  return rows.length;
}

/** business_member.removed (M01): the staff member's members lose their trainer (M24-FR-21, §12.19). */
async function onStaffRemoved(p, { transaction }) {
  if (p.businessType !== 'gym') return 0;
  return clearIn(transaction, { gymId: p.businessId, businessMemberId: p.businessMemberId, reason: 'staff_removed' });
}

/** business_member.permissions_changed (M01): cleared once neither members.trainer nor plans.manage is left. */
async function onPermissionsChanged(p, { transaction }) {
  if (p.businessType !== 'gym' || !(p.removed ?? []).some((x) => c.TRAINER_PERMISSIONS.includes(x))) return 0;
  if ((await c.trainersOf(p.businessId)).some((t) => t.businessMemberId === p.businessMemberId)) return 0;
  return clearIn(transaction, { gymId: p.businessId, businessMemberId: p.businessMemberId, reason: 'permissions_removed' });
}

module.exports = { list, assign, clearIn, onStaffRemoved, onPermissionsChanged };
