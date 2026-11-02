'use strict';

/**
 * M24 join requests (§5.2 FR-16, FR-17; §8.2; §5.12 FR-91, FR-92): a person asks to join a live gym
 * from its page; the gym accepts (the member is created or linked, optionally with a membership and the
 * first payment) or declines. No new table: gym_link_requests rows with direction `join_request`.
 *  - Ask (gate join_gym): a live gym that uses the panel and has join requests switched on
 *    (gym_manage_settings.join_requests_open), else 409 GYM_JOIN_NOT_OPEN { reason }; one pending request
 *    per gym and person (partial unique index, 409 GYM_LINK_REQUEST_PENDING); it expires after
 *    gym_manage.request_expiry_days (job gym-manage.requests-expire). The request keeps the keyed hash of
 *    the person's verified phone, so the same person added at the desk later is still a referral (FR-92).
 *  - The person cancels a pending request from /me/gym-requests.
 *  - Accept (members.edit, refused while restricted, Idempotency-Key): a new member with source
 *    `platform`, linked to the person (name and phone from the account), or an existing unlinked member
 *    with the same phone hash is linked instead; the request keeps member_id, so the referral fee charges
 *    on the first positive payment (fees.chargeReferralIn) and "Past" links keep working (me.service).
 *  - Decline (members.edit): the person is told (GYM_JOIN_DECLINED); a reason stays with the gym.
 * Consent messages go on every tier (§3.5): GYM_JOIN_REQUEST_NEW, GYM_JOIN_ACCEPTED, GYM_JOIN_DECLINED.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymMember, GymLinkRequest, GymDue } = require('../../models');
const directory = require('../users').directory;
const gymFacade = require('../gym').gyms;
const packagesFacade = require('../gym').packages;
const c = require('./gym-manage.common');
const view = require('./gym-manage.serializer');
const members = require('./members.service');
const memberships = require('./memberships.service');
const links = require('./links.service');

const { fail } = c;
const payload = (r) => ({ requestId: r.id, gymId: r.gymId, direction: r.direction, memberId: r.memberId ?? null, userId: r.userId ?? null });

/** Why a gym takes no join requests now, or null (M24-FR-16, §12.15): live, set up for the panel, switched on. */
async function closedReason(gym, { transaction } = {}) {
  if (!gym || gym.status !== 'live') return 'not_live';
  const s = await c.settingsOf(gym.id, { transaction });
  if (!s) return 'not_set_up';
  return s.joinRequestsOpen ? null : 'closed';
}

/** M20's gym page: whether "Join this gym" shows (facade joins.openFor). */
async function openFor(gymId) {
  return !(await closedReason(await gymFacade.get(gymId)));
}

/** A package a person may ask for: active, of this gym and sold online (what the public page lists). */
async function askablePackage(gymId, packageId) {
  if (!packageId) return null;
  const pkg = await packagesFacade.get(packageId);
  if (!pkg || pkg.gymId !== gymId || pkg.status !== 'active' || pkg.channel === 'desk') throw fail('GYM_PACKAGE_UNAVAILABLE');
  return pkg;
}

/** A pending row past its expiry that the job has not reached yet is expired here, so a new one can be made. */
async function expireStale(r, now, transaction) {
  await r.update({ status: 'expired', decidedAt: now }, { transaction });
  await c.publish(transaction, 'gym_link.expired', 'gym_link_request', r.id, payload(r));
}

/** POST /me/gym-join-requests { gymId, packageId?, note? } (gate join_gym; M24-FR-16). */
async function create(principal, { gymId, packageId = null, note = null }, req) {
  const gym = await gymFacade.get(gymId);
  if (!gym) throw E.notFound('Gym');
  if (gym.ownerId === principal.id) throw fail('GYM_JOIN_NOT_OPEN', { reason: 'own_gym' });
  const reason = await closedReason(gym);
  if (reason) throw fail('GYM_JOIN_NOT_OPEN', { reason });
  const pkg = await askablePackage(gymId, packageId);
  const phone = await directory.verifiedPhoneOf(principal.id);
  const now = new Date();
  const row = await sequelize.transaction(async (transaction) => {
    if (await GymMember.findOne({ where: { gymId, userId: principal.id, status: { [Op.ne]: 'removed' } }, attributes: ['id'], transaction })) throw fail('GYM_ALREADY_LINKED', { reason: 'account_linked' });
    // One pending request either way: a pending invite from the gym to me is accepted instead.
    const pending = await GymLinkRequest.findAll({ where: { gymId, userId: principal.id, status: 'pending' }, transaction, lock: transaction.LOCK.UPDATE });
    for (const p of pending) {
      if (p.expiresAt <= now) await expireStale(p, now, transaction);
      else throw fail('GYM_LINK_REQUEST_PENDING', { requestId: p.id, direction: p.direction });
    }
    let r;
    try {
      r = await sequelize.transaction({ transaction }, (t) =>
        GymLinkRequest.create(
          {
            gymId,
            ownerId: gym.ownerId,
            direction: 'join_request',
            userId: principal.id,
            phoneHash: phone ? c.phoneHash(phone) : null,
            packageId: pkg?.id ?? null,
            note: note ?? null,
            status: 'pending',
            expiresAt: new Date(now.getTime() + c.cfg().requestExpiryDays * 86400000),
            createdBy: principal.id,
          },
          { transaction: t }
        )
      );
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw fail('GYM_LINK_REQUEST_PENDING');
      throw err;
    }
    await c.publish(transaction, 'gym_link.requested', 'gym_link_request', r.id, { ...payload(r), ownerId: gym.ownerId, expiresAt: c.iso(r.expiresAt) }, principal);
    await c.record({ action: 'gym_link.join_requested', actor: principal, entityType: 'gym_link_request', entityId: r.id, after: { packageId: r.packageId, note: r.note ? 'set' : null }, meta: { gymId }, req }, transaction);
    return r;
  });
  return { request: links.myView(row, { gym, pkg }) };
}

/** POST /me/gym-requests/:requestId/cancel: I withdraw my pending join request. */
async function cancelMine(principal, requestId, req) {
  return sequelize.transaction(async (transaction) => {
    const r = await GymLinkRequest.findOne({ where: { id: requestId, userId: principal.id, direction: 'join_request' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw E.notFound('Request');
    if (r.status !== 'pending' || r.expiresAt <= new Date()) throw fail('GYM_LINK_REQUEST_STATE', { status: r.status === 'pending' ? 'expired' : r.status });
    await r.update({ status: 'cancelled', decidedAt: new Date(), decidedBy: principal.id }, { transaction });
    await c.publish(transaction, 'gym_link.cancelled', 'gym_link_request', r.id, payload(r), principal);
    await c.record({ action: 'gym_link.join_cancelled', actor: principal, entityType: 'gym_link_request', entityId: r.id, meta: { gymId: r.gymId }, req }, transaction);
    return { request: { id: r.id, status: 'cancelled' } };
  });
}

/** The gym's pending join request, locked; 409 GYM_LINK_REQUEST_STATE when it is an invite, decided or expired. */
async function pendingJoin(gymId, requestId, transaction, now) {
  const r = await GymLinkRequest.findOne({ where: { id: requestId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!r) throw E.notFound('Request');
  if (r.direction !== 'join_request') throw fail('GYM_LINK_REQUEST_STATE', { status: r.status, direction: r.direction });
  if (r.status !== 'pending' || r.expiresAt <= now) throw fail('GYM_LINK_REQUEST_STATE', { status: r.status === 'pending' ? 'expired' : r.status });
  return r;
}

/**
 * POST /manage/gyms/:gymId/requests/:requestId/accept { packageId?, startsOn?, admissionFee?,
 * discountPoisha?, discountReason?, payment? } [Idempotency-Key] (members.edit; refused while
 * restricted; M24-FR-17). With packageId the membership (and an optional first payment, fees.collect)
 * is assigned in the same transaction.
 */
async function accept(principal, gymId, requestId, input = {}, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true });
  if (input.payment) c.needs(a, 'fees.collect');
  const now = new Date();
  const today = c.today(now);
  const made = await sequelize.transaction(async (transaction) => {
    const r = await pendingJoin(gymId, requestId, transaction, now);
    const settings = await c.requireSetup(gymId, { transaction, lock: true });
    const account = (await directory.accounts([r.userId])).get(r.userId);
    const phone = await directory.verifiedPhoneOf(r.userId, { transaction });
    if (!account || account.status !== 'active' || account.isStaff || !phone) throw fail('GYM_LINK_REQUEST_STATE', { status: 'requester_unavailable' });
    if (await GymMember.findOne({ where: { gymId, userId: r.userId, status: { [Op.ne]: 'removed' } }, attributes: ['id'], transaction })) throw fail('GYM_ALREADY_LINKED', { reason: 'account_linked' });
    let member = await GymMember.findOne({ where: { gymId, phoneHash: c.phoneHash(phone), status: { [Op.ne]: 'removed' } }, transaction, lock: transaction.LOCK.UPDATE });
    const linkedExisting = Boolean(member);
    if (member) {
      // The gym already had this person on its books: link that record (its source stays; no referral).
      if (member.userId) throw fail('GYM_ALREADY_LINKED', { reason: 'member_linked', memberId: member.id });
      await member.update({ userId: r.userId, linkedAt: now, unlinkedAt: null, version: member.version + 1, updatedBy: principal.id }, { transaction });
      await c.publish(transaction, 'gym_member.linked', 'gym_member', member.id, { memberId: member.id, gymId, ownerId: a.gym.ownerId, userId: r.userId, by: principal.id }, a.actor);
    } else {
      const displayName = String(account.displayName ?? '').trim().slice(0, 80) || 'Member';
      member = await members.createIn(transaction, { gym: a.gym, settings, input: { displayName, phone }, source: 'platform', actor: a.actor, today, userId: r.userId });
      await c.record({ action: 'gym_member.added', actor: a.actor, entityType: 'gym_member', entityId: member.id, entityCode: member.memberCode, after: { displayName: member.displayName, phone: 'set', source: 'platform', requestId: r.id }, meta: { gymId }, req }, transaction);
    }
    await r.update({ status: 'accepted', decidedAt: now, decidedBy: principal.id, memberId: member.id }, { transaction });
    await c.publish(transaction, 'gym_link.accepted', 'gym_link_request', r.id, payload(r), a.actor);
    await c.record({ action: 'gym_link.join_accepted', actor: a.actor, entityType: 'gym_member', entityId: member.id, entityCode: member.memberCode, after: { requestId: r.id, linkedExisting }, meta: { gymId }, req }, transaction);
    const out = { r, member, linkedExisting };
    if (input.packageId) {
      const ms = { packageId: input.packageId, startsOn: input.startsOn ?? today, admissionFee: input.admissionFee, discountPoisha: input.discountPoisha, discountReason: input.discountReason, payment: input.payment };
      Object.assign(out, await memberships.assignIn(transaction, a, member, ms, { now, anyChannel: true }));
    }
    return out;
  });
  const member = await GymMember.findByPk(made.member.id);
  const [request] = await links.gymViews([await GymLinkRequest.findByPk(made.r.id)]);
  return c.shown(a, {
    request,
    member: view.memberSummary(member),
    linkedExisting: made.linkedExisting,
    membership: made.membership ? view.membershipView(made.membership, { today, dueId: made.due.id }) : null,
    due: made.due ? await memberships.dueFor(a, await GymDue.findByPk(made.due.id), today) : null,
    payment: made.payment ? { id: made.payment.id, receiptNo: made.payment.receiptNo, amountPoisha: made.payment.amountPoisha, receiptUrl: c.receiptUrlOf(made.payment.id) } : null,
  });
}

/** POST /manage/gyms/:gymId/requests/:requestId/decline { reason? } (members.edit): the person is told. */
async function decline(principal, gymId, requestId, { reason = null } = {}, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit');
  const now = new Date();
  const r = await sequelize.transaction(async (transaction) => {
    const row = await pendingJoin(gymId, requestId, transaction, now);
    await row.update({ status: 'declined', decidedAt: now, decidedBy: principal.id }, { transaction });
    await c.publish(transaction, 'gym_link.declined', 'gym_link_request', row.id, payload(row), a.actor);
    await c.record({ action: 'gym_link.join_declined', actor: a.actor, entityType: 'gym_link_request', entityId: row.id, reason, meta: { gymId }, req }, transaction);
    return row;
  });
  const [request] = await links.gymViews([r]);
  return { request };
}

module.exports = { closedReason, openFor, create, cancelMine, accept, decline };
