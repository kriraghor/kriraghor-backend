'use strict';

/**
 * M16 team invites by phone (M16-FR-02), step 1.
 *
 *   pending ─invitee accepts─▶ accepted (member added) · ─declines─▶ declined
 *           ─captain cancels / team archived─▶ cancelled · ─expires_at (tick)─▶ expired
 *
 * Phones are stored only as hmac('phone:'+e164) and a mask. The answer to the inviter is the same
 * whether or not the number has an account: always a share link (kriraghor.com/teams/join/{token}).
 * A number that belongs to an account gets TEAM_INVITE in-app and by SMS; an unknown number gets
 * nothing from Kriraghor (the captain shares the link). Invites are matched to a member *on read*,
 * by the hash of their current verified phone, so phone sign-ups, phones added later and OTP sign-ins
 * all find them; whoever verifies the number gets the invite. Linking never accepts.
 */
const { E } = require('../../common/errors');
const config = require('../../config');
const { normalizePhone } = require('../../common/identifiers');
const { randomToken, sha256 } = require('../../common/crypto');
const models = require('../../models');
const audit = require('../audit/audit.service');
const gates = require('../auth/gate.service');
const directory = require('../users/directory.service');
const rules = require('./teams.rules');
const c = require('./teams.common');

const { sequelize, Team, TeamMember, TeamInvite } = models;

const shareUrl = (token) => `${config.apps.web}/teams/join/${token}`;
const tokenHash = (token) => sha256(`team-invite:${token}`);
const inviteView = (i) => ({ id: i.id, phoneMasked: i.phoneMasked, role: i.role, status: i.status, expiresAt: i.expiresAt, resendCount: i.resendCount, createdAt: i.createdAt });

/** The invites a captain or vice-captain sees (masked phones; nothing says whether an account exists). */
async function teamInviteViews(teamId, { transaction } = {}) {
  const rows = await TeamInvite.findAll({ where: { teamId, status: 'pending' }, order: [['createdAt', 'DESC']], transaction });
  return rows.map(inviteView);
}

function gate(principal, action) {
  const g = gates.evaluateAction(principal, action);
  if (!g.allowed) throw E.forbidden(g.code, 'You cannot do this yet', undefined, { next: g.next });
}

const sentEvent = (transaction, i, actor, resent = false) =>
  c.publish(transaction, 'team_invite.sent', 'team_invite', i.id, { inviteId: i.id, teamId: i.teamId, linked: Boolean(i.userId), resent }, actor);

/**
 * POST /teams/:id/invites {phone, role} (captain or vice-captain). A pending invite to the same number
 * is reused (one per team and number); every call returns a fresh share link.
 */
async function invite(principal, teamId, { phone, role = 'player' }, req) {
  const e164 = normalizePhone(phone);
  if (!e164) throw c.fail('PHONE_INVALID');
  const hash = c.phoneHash(e164);
  const token = randomToken(24);
  return sequelize.transaction(async (transaction) => {
    const { team, me } = await require('./teams.service').membershipOf(principal, teamId, { transaction, lock: true });
    if (!rules.canManage(me.role)) throw c.fail('CAPTAIN_ONLY');
    const userId = await directory.byVerifiedPhone(e164, { transaction });
    const selfInvite = userId === principal.user.id || (principal.user.phone && principal.user.phoneVerifiedAt && c.phoneHash(principal.user.phone) === hash);
    const alreadyMember = Boolean(userId && (await TeamMember.count({ where: { teamId: team.id, userId, status: 'active' }, transaction })));
    const activeCount = await TeamMember.count({ where: { teamId: team.id, status: 'active' }, transaction });
    const block = rules.inviteBlock({ teamStatus: team.status, selfInvite, alreadyMember, activeCount, maxMembers: c.config().maxMembers });
    if (block) throw c.fail(block);
    const expiresAt = new Date(Date.now() + c.config().inviteDays * 86400000);
    let i = await TeamInvite.findOne({ where: { teamId: team.id, phoneHash: hash, status: 'pending' }, transaction, lock: transaction.LOCK.UPDATE });
    const fresh = !i;
    if (i) await i.update({ tokenHash: tokenHash(token), role, userId: i.userId ?? userId, expiresAt }, { transaction });
    else i = await TeamInvite.create({ teamId: team.id, phoneHash: hash, phoneMasked: c.phoneMask(e164), userId, role, invitedBy: principal.user.id, tokenHash: tokenHash(token), expiresAt }, { transaction });
    if (fresh) {
      await sentEvent(transaction, i, principal);
      await audit.record({ action: 'team_invite.sent', actor: principal, entityType: 'team', entityId: team.id, after: { inviteId: i.id, phone: i.phoneMasked }, req }, { transaction });
    }
    return { invite: inviteView(i), shareUrl: shareUrl(token) };
  });
}

async function managedInvite(principal, teamId, inviteId, transaction) {
  const { team, me } = await require('./teams.service').membershipOf(principal, teamId, { transaction, lock: true });
  if (!rules.canManage(me.role)) throw c.fail('CAPTAIN_ONLY');
  const i = await TeamInvite.findOne({ where: { id: inviteId, teamId: team.id }, transaction, lock: transaction.LOCK.UPDATE });
  if (!i) throw E.notFound('Invite');
  return { team, i };
}

/** POST /teams/:id/invites/:inviteId/cancel */
async function cancel(principal, teamId, inviteId, req) {
  return sequelize.transaction(async (transaction) => {
    const { i } = await managedInvite(principal, teamId, inviteId, transaction);
    if (i.status !== 'pending') throw c.fail('INVITE_STATE');
    await i.update({ status: 'cancelled', decidedAt: new Date(), decidedBy: principal.user.id }, { transaction });
    await c.publish(transaction, 'team_invite.cancelled', 'team_invite', i.id, { inviteId: i.id, teamId: i.teamId }, principal);
    await audit.record({ action: 'team_invite.cancelled', actor: principal, entityType: 'team', entityId: i.teamId, after: { inviteId: i.id }, req }, { transaction });
    return inviteView(i);
  });
}

/** POST /teams/:id/invites/:inviteId/resend (after teams.invite_resend_minutes): a new link, the expiry renewed. */
async function resend(principal, teamId, inviteId, req) {
  const token = randomToken(24);
  return sequelize.transaction(async (transaction) => {
    const { i } = await managedInvite(principal, teamId, inviteId, transaction);
    const block = rules.resendBlock(i, new Date(), c.config().resendMinutes);
    if (block) throw c.fail(block);
    await i.update({ tokenHash: tokenHash(token), resentAt: new Date(), resendCount: i.resendCount + 1, expiresAt: new Date(Date.now() + c.config().inviteDays * 86400000) }, { transaction });
    await sentEvent(transaction, i, principal, true);
    await audit.record({ action: 'team_invite.resent', actor: principal, entityType: 'team', entityId: i.teamId, after: { inviteId: i.id }, req }, { transaction });
    return { invite: inviteView(i), shareUrl: shareUrl(token) };
  });
}

/** The caller's pending invites, matched by their verified phone (and linked to them on the way). */
async function pendingFor(principal, { transaction } = {}) {
  const phone = await directory.verifiedPhoneOf(principal.user.id, { transaction });
  if (!phone) return [];
  const rows = await TeamInvite.findAll({ where: { phoneHash: c.phoneHash(phone), status: 'pending' }, order: [['createdAt', 'DESC']], transaction });
  for (const r of rows) {
    if (r.userId === principal.user.id) continue;
    // Linked here first (before the phone-verified consumer ran): the notice still goes out once.
    await r.update({ userId: principal.user.id }, { transaction });
    await c.publish(transaction, 'team_invite.linked', 'team_invite', r.id, { inviteId: r.id, teamId: r.teamId, userId: principal.user.id });
  }
  return rows;
}

async function invitesWithTeams(rows, { transaction } = {}) {
  const teams = rows.length ? await Team.findAll({ where: { id: rows.map((r) => r.teamId) }, transaction }) : [];
  const svc = require('./teams.service');
  const sports = await svc.sportsById(teams.map((t) => t.sportId), transaction);
  const inviters = await directory.publicNames(rows.map((r) => r.invitedBy), { transaction });
  const byId = new Map(teams.map((t) => [t.id, t]));
  return rows.map((r) => {
    const t = byId.get(r.teamId);
    return {
      id: r.id,
      role: r.role,
      status: r.status,
      expiresAt: r.expiresAt,
      expired: new Date() >= r.expiresAt,
      team: t ? { id: t.id, name: t.name, shortCode: t.shortCode ?? null, sport: sports.get(t.sportId) ?? null, status: t.status } : null,
      invitedBy: firstName(inviters.get(r.invitedBy)?.displayName),
    };
  });
}

const firstName = (name) => (name ? String(name).trim().split(/\s+/)[0] : null);

/** GET /me/team-invites */
async function mine(principal) {
  const rows = await sequelize.transaction((transaction) => pendingFor(principal, { transaction }));
  return { items: await invitesWithTeams(rows) };
}

async function ownInvite(principal, inviteId, transaction) {
  const phone = await directory.verifiedPhoneOf(principal.user.id, { transaction });
  const i = phone ? await TeamInvite.findOne({ where: { id: inviteId, phoneHash: c.phoneHash(phone) }, transaction, lock: transaction.LOCK.UPDATE }) : null;
  if (!i) throw c.fail('INVITE_NOT_YOURS');
  return i;
}

/** POST /me/team-invites/:id/accept (verified phone): every rule re-checked under the team lock. */
async function accept(principal, inviteId, req) {
  gate(principal, 'join_team');
  return sequelize.transaction(async (transaction) => {
    const i = await ownInvite(principal, inviteId, transaction);
    const team = await Team.findByPk(i.teamId, { transaction, lock: transaction.LOCK.UPDATE });
    const userId = principal.user.id;
    const block = rules.acceptBlock({
      invite: i,
      now: new Date(),
      teamStatus: team.status,
      accountActive: principal.user.status === 'active',
      alreadyMember: (await TeamMember.count({ where: { teamId: team.id, userId, status: 'active' }, transaction })) > 0,
      activeCount: await TeamMember.count({ where: { teamId: team.id, status: 'active' }, transaction }),
      maxMembers: c.config().maxMembers,
      memberships: await TeamMember.count({ where: { userId, status: 'active' }, transaction }),
      maxMemberships: c.config().maxMemberships,
    });
    if (block) throw c.fail(block);
    const viceTaken = i.role === 'vice_captain' && (await TeamMember.count({ where: { teamId: team.id, status: 'active', role: 'vice_captain' }, transaction })) > 0;
    const role = viceTaken ? 'player' : i.role;
    await TeamMember.create({ teamId: team.id, userId, role, joinedAt: new Date(), addedBy: i.invitedBy }, { transaction });
    await i.update({ status: 'accepted', userId, decidedAt: new Date(), decidedBy: userId }, { transaction });
    await c.publish(transaction, 'team_member.added', 'team', team.id, { teamId: team.id, userId, role }, principal);
    await c.publish(transaction, 'team_invite.accepted', 'team_invite', i.id, { inviteId: i.id, teamId: team.id, userId }, principal);
    await audit.record({ action: 'team_invite.accepted', actor: principal, entityType: 'team', entityId: team.id, after: { inviteId: i.id, role }, req }, { transaction });
    return { teamId: team.id, role };
  });
}

/** POST /me/team-invites/:id/decline */
async function decline(principal, inviteId, req) {
  return sequelize.transaction(async (transaction) => {
    const i = await ownInvite(principal, inviteId, transaction);
    if (i.status !== 'pending') throw c.fail('INVITE_STATE');
    await i.update({ status: 'declined', userId: principal.user.id, decidedAt: new Date(), decidedBy: principal.user.id }, { transaction });
    await c.publish(transaction, 'team_invite.declined', 'team_invite', i.id, { inviteId: i.id, teamId: i.teamId }, principal);
    await audit.record({ action: 'team_invite.declined', actor: principal, entityType: 'team', entityId: i.teamId, after: { inviteId: i.id }, req }, { transaction });
    return { id: i.id, status: i.status };
  });
}

/**
 * GET /team-invites/:token (public): what the share link opens. The team, its sport, the inviter's
 * first name and the masked number to sign in with; nothing else.
 */
async function byToken(token) {
  const i = await TeamInvite.findOne({ where: { tokenHash: tokenHash(token) } });
  if (!i) throw E.notFound('Invite');
  const [view] = await invitesWithTeams([i]);
  return { ...view, phoneMasked: i.phoneMasked };
}

/** Tick: pending invites past expires_at expire. */
async function sweep(now = new Date()) {
  const { Op } = require('sequelize');
  const due = await TeamInvite.findAll({ where: { status: 'pending', expiresAt: { [Op.lte]: now } }, attributes: ['id'], limit: 500 });
  let n = 0;
  for (const d of due) {
    n += await sequelize.transaction(async (transaction) => {
      const i = await TeamInvite.findByPk(d.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (i.status !== 'pending' || i.expiresAt > now) return 0;
      await i.update({ status: 'expired', decidedAt: now }, { transaction });
      await c.publish(transaction, 'team_invite.expired', 'team_invite', i.id, { inviteId: i.id, teamId: i.teamId });
      return 1;
    });
  }
  return n;
}

/**
 * M01 user.registered / user.phone_verified: a newly verified number may have invites waiting. Link
 * them and tell the member in-app (team_invite.linked → TEAM_INVITE). Reading /me/team-invites finds
 * them anyway; this only sends the notice.
 */
async function onPhoneVerified(userId, { transaction }) {
  const phone = await directory.verifiedPhoneOf(userId, { transaction });
  if (!phone) return 0;
  const rows = await TeamInvite.findAll({ where: { phoneHash: c.phoneHash(phone), status: 'pending' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const r of rows) {
    if (r.userId === userId) continue;
    await r.update({ userId }, { transaction });
    await c.publish(transaction, 'team_invite.linked', 'team_invite', r.id, { inviteId: r.id, teamId: r.teamId, userId });
  }
  return rows.length;
}

/** M08 helpers: who an invite notice goes to, and what it says. */
async function recipientOf(inviteId) {
  const i = await TeamInvite.findByPk(inviteId);
  return i && i.status === 'pending' && i.userId ? [i.userId] : [];
}
async function noticeValues(inviteId) {
  const i = await TeamInvite.findByPk(inviteId);
  const t = i ? await Team.findByPk(i.teamId) : null;
  const inviter = i ? (await directory.publicNames([i.invitedBy])).get(i.invitedBy) : null;
  return { team: t?.name ?? '', inviter: firstName(inviter?.displayName) ?? '' };
}

module.exports = { teamInviteViews, invite, cancel, resend, mine, accept, decline, byToken, sweep, onPhoneVerified, recipientOf, noticeValues };
