'use strict';

/**
 * M24 account links by consent (§5.2 FR-14, FR-15, FR-18; §8.2). Member records exist without consent
 * (the gym's own books); only the link to a Kriraghor account needs the member's yes (S3).
 *  - Invite (members.edit): by the member's phone (default), another phone or a username. One pending
 *    invite per member. An unknown phone keeps only its keyed hash and is attached when that phone is
 *    verified (user.phone_verified / user.registered consumers), then the invitee is told.
 *  - The invitee accepts (gate join_gym) or declines in /me/gym-requests; the gym may cancel.
 *  - Unlink by the member or the gym: the record stays, user_id is cleared, unlinked_at set.
 *  - Pending requests past expires_at expire (job gym-manage.requests-expire).
 * Join requests from the gym's page (direction join_request, prompt 3) live in joins.service; the gym's
 * requests list and the member's /me/gym-requests here show both directions.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { normalizePhone } = require('../../common/identifiers');
const { sequelize, GymMember, GymLinkRequest } = require('../../models');
const directory = require('../users').directory;
const gymFacade = require('../gym').gyms;
const packagesFacade = require('../gym').packages;
const c = require('./gym-manage.common');
const view = require('./gym-manage.serializer');

const { fail } = c;
/** What a linked gym sees (M24-FR-15), shown to the invitee before they accept. */
const SHARES = ['name', 'phone', 'photo', 'checkins', 'payments'];

const linkPayload = (r) => ({ requestId: r.id, gymId: r.gymId, direction: r.direction, memberId: r.memberId ?? null, userId: r.userId ?? null });

/** Publish gym_link.requested (GYM_LINK_INVITE goes to the account when it is known). */
const publishRequested = (transaction, r, actor, attached = false) =>
  c.publish(transaction, 'gym_link.requested', 'gym_link_request', r.id, { ...linkPayload(r), ownerId: r.ownerId, expiresAt: c.iso(r.expiresAt), ...(attached ? { attached: true } : {}) }, actor);

/** POST /manage/gyms/:gymId/members/:memberId/invite { phone? | username? } (members.edit; FR-14). */
async function invite(principal, gymId, memberId, { phone, username } = {}, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true });
  const now = new Date();
  let userId = null;
  let e164 = null;
  if (username) {
    const u = await directory.byUsername(username);
    if (!u || u.status !== 'active') throw E.notFound('Account');
    userId = u.id;
  }
  const row = await sequelize.transaction(async (transaction) => {
    const m = await GymMember.findOne({ where: { id: memberId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!m || m.status === 'removed') throw E.notFound('Member');
    if (m.userId) throw fail('GYM_ALREADY_LINKED', { reason: 'member_linked' });
    if (!username) {
      e164 = phone ? normalizePhone(phone) : c.dec(m.phoneEnc);
      if (!e164) throw E.validation([{ field: 'phone', message: 'Enter a Bangladesh mobile number' }]);
      userId = await directory.byVerifiedPhone(e164, { transaction });
    }
    if (userId && (await GymMember.findOne({ where: { gymId, userId, status: { [Op.ne]: 'removed' } }, attributes: ['id'], transaction }))) throw fail('GYM_ALREADY_LINKED', { reason: 'account_linked' });
    if (await GymLinkRequest.findOne({ where: { memberId: m.id, status: 'pending', direction: 'gym_invite' }, attributes: ['id'], transaction })) throw fail('GYM_LINK_REQUEST_PENDING');
    let r;
    try {
      r = await sequelize.transaction({ transaction }, (t) =>
        GymLinkRequest.create(
          {
            gymId,
            ownerId: a.gym.ownerId,
            direction: 'gym_invite',
            memberId: m.id,
            userId,
            phoneHash: e164 ? c.phoneHash(e164) : null,
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
    await publishRequested(transaction, r, a.actor);
    await c.record({ action: 'gym_link.requested', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: { requestId: r.id, by: username ? 'username' : 'phone', accountKnown: Boolean(userId) }, meta: { gymId }, req }, transaction);
    return { r, m };
  });
  return { request: view.requestView(row.r, { member: row.m }) };
}

/** Packages by id (the join requests' "package asked for"). */
async function packagesById(ids) {
  const out = new Map();
  for (const id of new Set(ids.filter(Boolean))) out.set(id, await packagesFacade.get(id));
  return out;
}

/**
 * The gym's view of requests: invites with the member they name; join requests with who asks (display
 * name, account photo, last 4 digits of the verified phone), the package asked for and the note.
 */
async function gymViews(rows) {
  const members = new Map((await GymMember.findAll({ where: { id: rows.map((r) => r.memberId).filter(Boolean) } })).map((m) => [m.id, m]));
  const joinUsers = rows.filter((r) => r.direction === 'join_request').map((r) => r.userId);
  const [names, contacts, pkgs] = await Promise.all([directory.publicNames(joinUsers), directory.contactFor(joinUsers), packagesById(rows.map((r) => r.packageId))]);
  return rows.map((r) => {
    const phone = contacts.get(r.userId)?.phone ?? null;
    const requester = r.direction === 'join_request' ? { displayName: names.get(r.userId)?.displayName ?? null, avatarUrl: names.get(r.userId)?.avatarUrl ?? null, phoneLast4: phone ? phone.slice(-4) : null } : null;
    return view.requestView(r, { member: members.get(r.memberId) ?? null, requester, pkg: pkgs.get(r.packageId) ?? null });
  });
}

/** GET /manage/gyms/:gymId/requests?status&direction (members.view): join requests and gym invites. */
async function listForGym(principal, gymId, { status, direction } = {}) {
  await c.gymAccess(principal, gymId, 'members.view');
  const rows = await GymLinkRequest.findAll({ where: { gymId, status: status ?? 'pending', ...(direction ? { direction } : {}) }, order: [['createdAt', 'DESC']], limit: 200 });
  return { items: await gymViews(rows) };
}

async function decide(r, status, by, transaction) {
  await r.update({ status, decidedAt: new Date(), decidedBy: by }, { transaction });
}

/** POST /manage/gyms/:gymId/requests/:requestId/cancel: the gym cancels its pending invite (members.edit). */
async function cancel(principal, gymId, requestId, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit');
  const r = await sequelize.transaction(async (transaction) => {
    const row = await GymLinkRequest.findOne({ where: { id: requestId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw E.notFound('Request');
    if (row.status !== 'pending' || row.direction !== 'gym_invite') throw fail('GYM_LINK_REQUEST_STATE', { status: row.status });
    await decide(row, 'cancelled', principal.id, transaction);
    await c.publish(transaction, 'gym_link.cancelled', 'gym_link_request', row.id, linkPayload(row), a.actor);
    await c.record({ action: 'gym_link.cancelled', actor: a.actor, entityType: 'gym_link_request', entityId: row.id, meta: { gymId, memberId: row.memberId }, req }, transaction);
    return row;
  });
  const m = r.memberId ? await GymMember.findByPk(r.memberId) : null;
  return { request: view.requestView(r, { member: m }) };
}

/** Clear a member's account link (the member or the gym; FR-18). Publishes gym_member.unlinked. */
async function unlinkIn(transaction, { m, actor, by }) {
  if (!m.userId) throw fail('GYM_MEMBER_STATE', { reason: 'not_linked' });
  const userId = m.userId;
  await m.update({ userId: null, unlinkedAt: new Date(), version: m.version + 1, updatedBy: by }, { transaction });
  await c.publish(transaction, 'gym_member.unlinked', 'gym_member', m.id, { memberId: m.id, gymId: m.gymId, ownerId: m.ownerId, userId, by }, actor);
  return userId;
}

/** POST /manage/gyms/:gymId/members/:memberId/unlink (members.edit). */
async function unlinkByGym(principal, gymId, memberId, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit');
  await sequelize.transaction(async (transaction) => {
    const m = await GymMember.findOne({ where: { id: memberId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!m || m.status === 'removed') throw E.notFound('Member');
    await unlinkIn(transaction, { m, actor: a.actor, by: principal.id });
    await c.record({ action: 'gym_member.unlinked', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: { linked: false, by: 'gym' }, meta: { gymId }, req }, transaction);
  });
  return { memberId, linked: false };
}

// ---------------------------------------------------------------- the member's side (/me/gym-requests)

/** A request as its account sees it: an invite to me, or my own join request (M24-FR-15, FR-16). */
function myView(r, { gym, member = null, pkg = null }) {
  const join = r.direction === 'join_request';
  return {
    id: r.id,
    direction: r.direction,
    status: r.status,
    gym: gym ? { id: gym.id, name: gym.name, slug: gym.slug } : null,
    // An invite names the gym's record; a join request has none until the gym accepts.
    memberCode: join ? null : (member?.memberCode ?? null),
    displayName: join ? null : (member?.displayName ?? null),
    shares: SHARES,
    package: join && pkg ? { id: pkg.id, title: pkg.title, kind: pkg.kind } : null,
    note: join ? (r.note ?? null) : null,
    memberId: join ? (r.memberId ?? null) : null,
    canCancel: join && r.status === 'pending',
    expiresAt: c.iso(r.expiresAt),
    createdAt: c.iso(r.createdAt),
  };
}

/** GET /me/gym-requests?status&direction: invites to me and my join requests (pending by default). */
async function mine(principal, { status, direction } = {}) {
  const rows = await GymLinkRequest.findAll({ where: { userId: principal.id, status: status ?? 'pending', ...(direction ? { direction } : {}) }, order: [['createdAt', 'DESC']], limit: 100 });
  const members = new Map((await GymMember.findAll({ where: { id: rows.map((r) => r.memberId).filter(Boolean) }, attributes: ['id', 'memberCode', 'displayName'] })).map((m) => [m.id, m]));
  const gyms = new Map();
  for (const r of rows) if (!gyms.has(r.gymId)) gyms.set(r.gymId, await gymFacade.get(r.gymId));
  const pkgs = await packagesById(rows.map((r) => r.packageId));
  return { items: rows.map((r) => myView(r, { gym: gyms.get(r.gymId), member: members.get(r.memberId), pkg: pkgs.get(r.packageId) ?? null })) };
}

/** A pending invite to me (accept and decline answer the gym's invites only; my own join requests are cancelled instead). */
async function myPending(principal, requestId, transaction) {
  const r = await GymLinkRequest.findOne({ where: { id: requestId, userId: principal.id, direction: 'gym_invite' }, transaction, lock: transaction.LOCK.UPDATE });
  if (!r) throw E.notFound('Request');
  if (r.status !== 'pending' || r.expiresAt <= new Date()) throw fail('GYM_LINK_REQUEST_STATE', { status: r.status === 'pending' ? 'expired' : r.status });
  return r;
}

/** POST /me/gym-requests/:requestId/accept (gate join_gym): link the member to my account (FR-15). */
async function accept(principal, requestId, req) {
  return sequelize.transaction(async (transaction) => {
    const r = await myPending(principal, requestId, transaction);
    const m = await GymMember.findByPk(r.memberId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!m || m.status === 'removed') throw fail('GYM_LINK_REQUEST_STATE', { status: 'cancelled' });
    await c.refuseSuspendedId(m.gymId, { transaction });
    if (m.userId && m.userId !== principal.id) throw fail('GYM_ALREADY_LINKED', { reason: 'member_linked' });
    if (await GymMember.findOne({ where: { gymId: m.gymId, userId: principal.id, status: { [Op.ne]: 'removed' }, id: { [Op.ne]: m.id } }, attributes: ['id'], transaction })) throw fail('GYM_ALREADY_LINKED', { reason: 'account_linked' });
    await decide(r, 'accepted', principal.id, transaction);
    await m.update({ userId: principal.id, linkedAt: new Date(), unlinkedAt: null, version: m.version + 1 }, { transaction });
    await c.publish(transaction, 'gym_link.accepted', 'gym_link_request', r.id, linkPayload(r), principal);
    await c.publish(transaction, 'gym_member.linked', 'gym_member', m.id, { memberId: m.id, gymId: m.gymId, ownerId: m.ownerId, userId: principal.id, by: principal.id }, principal);
    await c.record({ action: 'gym_member.linked', actor: principal, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: { linked: true, requestId: r.id }, meta: { gymId: m.gymId }, req }, transaction);
    return { request: { id: r.id, status: 'accepted' }, memberId: m.id, gymId: m.gymId };
  });
}

/** POST /me/gym-requests/:requestId/decline: the record stays unlinked. */
async function decline(principal, requestId, req) {
  return sequelize.transaction(async (transaction) => {
    const r = await myPending(principal, requestId, transaction);
    await decide(r, 'declined', principal.id, transaction);
    await c.publish(transaction, 'gym_link.declined', 'gym_link_request', r.id, linkPayload(r), principal);
    await c.record({ action: 'gym_link.declined', actor: principal, entityType: 'gym_link_request', entityId: r.id, meta: { gymId: r.gymId }, req }, transaction);
    return { request: { id: r.id, status: 'declined' } };
  });
}

/** POST /me/gym-memberships/:memberId/unlink: the member unlinks; receipts stay readable under "Past". */
async function unlinkByMember(principal, memberId, req) {
  await sequelize.transaction(async (transaction) => {
    const m = await GymMember.findOne({ where: { id: memberId, userId: principal.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!m) throw E.notFound('Membership');
    await unlinkIn(transaction, { m, actor: principal, by: principal.id });
    await c.record({ action: 'gym_member.unlinked', actor: principal, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: { linked: false, by: 'member' }, meta: { gymId: m.gymId }, req }, transaction);
  });
  return { memberId, linked: false };
}

// ---------------------------------------------------------------- consumers and jobs

/**
 * user.phone_verified / user.registered (FR-14): pending invites stored by this phone's hash attach to
 * the account and are re-published (GYM_LINK_INVITE reaches the invitee). Idempotent.
 */
async function attachOnPhoneVerified(userId, { transaction }) {
  const phone = await directory.verifiedPhoneOf(userId, { transaction });
  if (!phone) return 0;
  const rows = await GymLinkRequest.findAll({ where: { phoneHash: c.phoneHash(phone), status: 'pending', userId: null, expiresAt: { [Op.gt]: new Date() } }, transaction, lock: transaction.LOCK.UPDATE });
  let n = 0;
  for (const r of rows) {
    if (await GymMember.findOne({ where: { gymId: r.gymId, userId, status: { [Op.ne]: 'removed' } }, attributes: ['id'], transaction })) continue;
    await r.update({ userId }, { transaction });
    await publishRequested(transaction, r, null, true);
    n += 1;
  }
  return n;
}

/** Job gym-manage.requests-expire: pending requests past expires_at → expired (status guard; FR-14). */
async function expireDue(now = new Date(), batch = 500) {
  return sequelize.transaction(async (transaction) => {
    const rows = await GymLinkRequest.findAll({ where: { status: 'pending', expiresAt: { [Op.lte]: now } }, limit: batch, transaction, lock: transaction.LOCK.UPDATE, skipLocked: true });
    for (const r of rows) {
      await r.update({ status: 'expired', decidedAt: now }, { transaction });
      await c.publish(transaction, 'gym_link.expired', 'gym_link_request', r.id, linkPayload(r));
    }
    return rows.length;
  });
}

/** Invite every member of a list that has a phone, is unlinked and has no pending invite (import send-invites). */
async function inviteMany(transaction, { gym, members, actor, by, now = new Date() }) {
  let sent = 0;
  for (const m of members) {
    if (m.userId || m.status === 'removed') continue;
    if (await GymLinkRequest.findOne({ where: { memberId: m.id, status: 'pending', direction: 'gym_invite' }, attributes: ['id'], transaction })) continue;
    const e164 = c.dec(m.phoneEnc);
    const userId = await directory.byVerifiedPhone(e164, { transaction });
    if (userId && (await GymMember.findOne({ where: { gymId: gym.id, userId, status: { [Op.ne]: 'removed' } }, attributes: ['id'], transaction }))) continue;
    const r = await GymLinkRequest.create(
      { gymId: gym.id, ownerId: gym.ownerId, direction: 'gym_invite', memberId: m.id, userId, phoneHash: m.phoneHash, status: 'pending', expiresAt: new Date(now.getTime() + c.cfg().requestExpiryDays * 86400000), createdBy: by },
      { transaction }
    );
    await publishRequested(transaction, r, actor);
    sent += 1;
  }
  return sent;
}

module.exports = { SHARES, packagesById, gymViews, myView, invite, listForGym, cancel, unlinkIn, unlinkByGym, mine, accept, decline, unlinkByMember, attachOnPhoneVerified, expireDue, inviteMany };
