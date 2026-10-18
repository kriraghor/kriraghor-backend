'use strict';

/**
 * M16 teams and members (step 1).
 *
 *   team: active ─captain archives / staff archive / last member leaves / last member banned─▶ archived
 *   member: active ─leaves─▶ left · ─removed (captain or vice; banned account)─▶ removed
 *
 * One captain and at most one vice-captain per team (partial unique indexes). A hand-over demotes the
 * old captain before it promotes the new one. Members are user ids, never free-text names (M16-FR-03).
 * Captains see each member's name and an "NID verified" boolean only (never DOB, gender or phone).
 * Rosters, RSVPs, lineups, suspensions and transfers come with M14 and M15.
 */
const crypto = require('crypto');
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const storage = require('../../common/storage');
const { sniffMime } = require('../../common/filetype');
const { uuid7 } = require('../../common/uuid7');
const models = require('../../models');
const audit = require('../audit/audit.service');
const gates = require('../auth/gate.service');
const directory = require('../users/directory.service');
const rules = require('./teams.rules');
const c = require('./teams.common');

const { sequelize, Team, TeamMember, TeamInvite, Sport, Area } = models;

const LOGO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_LOGO = 2 * 1024 * 1024;

// ---------------------------------------------------------------- views

async function sportsById(ids, transaction) {
  const rows = ids.length ? await Sport.findAll({ where: { id: [...new Set(ids)] }, transaction }) : [];
  return new Map(rows.map((s) => [s.id, { id: s.id, key: s.key, nameEn: s.nameEn, nameBn: s.nameBn }]));
}
async function areasById(ids, transaction) {
  const list = ids.filter(Boolean);
  const rows = list.length ? await Area.findAll({ where: { id: [...new Set(list)] }, transaction }) : [];
  return new Map(rows.map((a) => [a.id, { id: a.id, key: a.key, nameEn: a.nameEn, nameBn: a.nameBn }]));
}

function teamCard(t, sports, areas, extra = {}) {
  return {
    id: t.id,
    name: t.name,
    shortCode: t.shortCode ?? null,
    sport: sports.get(t.sportId) ?? null,
    homeArea: t.homeAreaId ? (areas.get(t.homeAreaId) ?? null) : null,
    logoUrl: t.logoKey ? storage.publicUrl(t.logoKey) : null,
    status: t.status,
    createdAt: t.createdAt,
    ...extra,
  };
}

const activeMembersOf = (teamId, transaction) => TeamMember.findAll({ where: { teamId, status: 'active' }, order: [['joinedAt', 'ASC']], transaction });

/** Members as a captain sees them: names, roles, jersey numbers and the NID-verified boolean only. */
async function memberViews(members, transaction) {
  const ids = members.map((m) => m.userId);
  const [names, identity] = await Promise.all([directory.publicNames(ids, { transaction }), directory.eligibilityIdentity(ids, { transaction })]);
  return members.map((m) => {
    const who = identity.get(m.userId);
    return {
      userId: m.userId,
      displayName: names.get(m.userId)?.displayName ?? '—',
      username: names.get(m.userId)?.username ?? null,
      role: m.role,
      jerseyNo: m.jerseyNo ?? null,
      joinedAt: m.joinedAt,
      nidVerified: Boolean(who && who.kycStatus === 'verified' && who.memberActive),
    };
  });
}

/** The caller's active membership of a team, or a 404 (no probing of other teams). */
async function membershipOf(principal, teamId, { transaction, lock = false } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(teamId))) throw E.notFound('Team');
  const team = await Team.findByPk(teamId, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  const m = team ? await TeamMember.findOne({ where: { teamId, userId: principal.user.id, status: 'active' }, transaction }) : null;
  if (!team || !m) throw E.notFound('Team');
  return { team, me: m };
}

async function detail(team, me, transaction) {
  const members = await activeMembersOf(team.id, transaction);
  const sports = await sportsById([team.sportId], transaction);
  const areas = await areasById([team.homeAreaId], transaction);
  const manager = rules.canManage(me.role);
  const invites = manager ? await require('./invites.service').teamInviteViews(team.id, { transaction }) : [];
  return {
    ...teamCard(team, sports, areas),
    myRole: me.role,
    members: await memberViews(members, transaction),
    invites,
    can: { invite: manager && team.status === 'active', manage: rules.isCaptain(me.role) && team.status === 'active', leave: team.status === 'active' },
  };
}

// ---------------------------------------------------------------- the member

function gate(principal, action) {
  const g = gates.evaluateAction(principal, action);
  if (!g.allowed) throw E.forbidden(g.code, 'You cannot do this yet', undefined, { next: g.next });
}

async function sportByKey(key, transaction) {
  const s = await Sport.findOne({ where: { key, isActive: true }, transaction });
  if (!s || !(s.positions ?? []).length) throw c.fail('TEAM_SPORT_UNKNOWN');
  return s;
}

/** POST /teams (verified phone): a team for one sport; the creator is its captain (M16-FR-01). */
async function create(principal, { sportKey, name, shortCode, homeAreaId }, req) {
  gate(principal, 'create_team');
  const nameBlock = rules.nameBlock(name);
  if (nameBlock) throw c.fail(nameBlock);
  const code = rules.shortCode(shortCode);
  if (code.error) throw c.fail(code.error);
  return sequelize.transaction(async (transaction) => {
    const sport = await sportByKey(sportKey, transaction);
    if (homeAreaId && !(await Area.findOne({ where: { id: homeAreaId, isActive: true }, transaction }))) throw E.notFound('Area');
    const memberships = await TeamMember.count({ where: { userId: principal.user.id, status: 'active' }, transaction });
    if (memberships >= c.config().maxMemberships) throw c.fail('TOO_MANY_TEAMS');
    const team = await Team.create({ id: uuid7(), sportId: sport.id, name: name.trim(), shortCode: code.value, homeAreaId: homeAreaId ?? null, createdBy: principal.user.id }, { transaction });
    await TeamMember.create({ teamId: team.id, userId: principal.user.id, role: 'captain', joinedAt: new Date(), addedBy: principal.user.id }, { transaction });
    await audit.record({ action: 'team.created', actor: principal, entityType: 'team', entityId: team.id, after: { sport: sport.key }, req }, { transaction });
    await c.publish(transaction, 'team.created', 'team', team.id, { teamId: team.id, sportId: sport.id, captainId: principal.user.id }, principal);
    await c.publish(transaction, 'team_member.added', 'team', team.id, { teamId: team.id, userId: principal.user.id, role: 'captain' }, principal);
    const me = await TeamMember.findOne({ where: { teamId: team.id, userId: principal.user.id, status: 'active' }, transaction });
    return detail(team, me, transaction);
  });
}

/** GET /me/teams: my active teams with my role. */
async function mine(principal) {
  const ms = await TeamMember.findAll({ where: { userId: principal.user.id, status: 'active' } });
  const teams = ms.length ? await Team.findAll({ where: { id: ms.map((m) => m.teamId) }, order: [['name', 'ASC']] }) : [];
  const counts = new Map(
    (await TeamMember.findAll({ where: { teamId: teams.map((t) => t.id), status: 'active' }, attributes: ['teamId', [sequelize.fn('COUNT', sequelize.col('id')), 'n']], group: ['teamId'], raw: true })).map((r) => [r.teamId, Number(r.n)])
  );
  const sports = await sportsById(teams.map((t) => t.sportId));
  const areas = await areasById(teams.map((t) => t.homeAreaId));
  const roleOf = new Map(ms.map((m) => [m.teamId, m.role]));
  return { items: teams.map((t) => teamCard(t, sports, areas, { myRole: roleOf.get(t.id), members: counts.get(t.id) ?? 0 })) };
}

/** GET /teams/:id (members only). */
async function get(principal, id) {
  const { team, me } = await membershipOf(principal, id);
  return detail(team, me);
}

async function captainTx(principal, id, transaction) {
  const { team, me } = await membershipOf(principal, id, { transaction, lock: true });
  if (!rules.isCaptain(me.role)) throw c.fail('CAPTAIN_ONLY');
  if (team.status !== 'active') throw c.fail('TEAM_ARCHIVED');
  return { team, me };
}

/** PATCH /teams/:id (captain): name, short code, home area. */
async function update(principal, id, body, req) {
  return sequelize.transaction(async (transaction) => {
    const { team, me } = await captainTx(principal, id, transaction);
    const patch = {};
    if (body.name !== undefined) {
      const block = rules.nameBlock(body.name);
      if (block) throw c.fail(block);
      patch.name = body.name.trim();
    }
    if (body.shortCode !== undefined) {
      const code = rules.shortCode(body.shortCode);
      if (code.error) throw c.fail(code.error);
      patch.shortCode = code.value;
    }
    if (body.homeAreaId !== undefined) {
      if (body.homeAreaId && !(await Area.findOne({ where: { id: body.homeAreaId, isActive: true }, transaction }))) throw E.notFound('Area');
      patch.homeAreaId = body.homeAreaId;
    }
    await team.update({ ...patch, updatedBy: principal.user.id }, { transaction });
    await audit.record({ action: 'team.updated', actor: principal, entityType: 'team', entityId: team.id, after: { fields: Object.keys(patch) }, req }, { transaction });
    return detail(team, me, transaction);
  });
}

/** POST /teams/:id/logo (captain; raw JPEG, PNG or WebP; public bucket). */
async function uploadLogo(principal, id, { contentType, body }, req) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!buf.length) throw c.fail('FILE_EMPTY');
  if (buf.length > MAX_LOGO) throw c.fail('FILE_TOO_LARGE');
  if (!LOGO_TYPES[declared]) throw c.fail('FILE_TYPE_NOT_ALLOWED');
  if (sniffMime(buf) !== declared) throw c.fail('FILE_TYPE_MISMATCH');
  await membershipOf(principal, id);
  const key = `teams/${id}/logo-${crypto.randomBytes(6).toString('hex')}.${LOGO_TYPES[declared]}`;
  await storage.putPublic(key, buf, declared);
  return sequelize.transaction(async (transaction) => {
    const { team, me } = await captainTx(principal, id, transaction);
    await team.update({ logoKey: key, updatedBy: principal.user.id }, { transaction });
    await audit.record({ action: 'team.logo_uploaded', actor: principal, entityType: 'team', entityId: team.id, meta: { sizeBytes: buf.length }, req }, { transaction });
    return detail(team, me, transaction);
  });
}

async function archiveInTx(team, { actor, reason, transaction }) {
  await team.update({ status: 'archived', archivedAt: new Date(), archiveReason: reason ?? null }, { transaction });
  const pending = await TeamInvite.findAll({ where: { teamId: team.id, status: 'pending' }, transaction });
  for (const i of pending) await i.update({ status: 'cancelled', decidedAt: new Date() }, { transaction });
  await c.publish(transaction, 'team.archived', 'team', team.id, { teamId: team.id }, actor);
}

/** POST /teams/:id/archive (captain). */
async function archive(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const { team, me } = await captainTx(principal, id, transaction);
    await archiveInTx(team, { actor: principal, reason: 'captain', transaction });
    await audit.record({ action: 'team.archived', actor: principal, entityType: 'team', entityId: team.id, req }, { transaction });
    return detail(team, me, transaction);
  });
}

async function endMembership(m, status, reason, { actor, transaction }) {
  await m.update({ status, leftReason: reason, leftAt: new Date() }, { transaction });
  await c.publish(transaction, 'team_member.removed', 'team', m.teamId, { teamId: m.teamId, userId: m.userId, reasonCode: reason }, actor);
}

/** POST /teams/:id/leave. A captain hands over first; the last member leaving archives the team. */
async function leave(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const { team, me } = await membershipOf(principal, id, { transaction, lock: true });
    const members = await activeMembersOf(team.id, transaction);
    if (rules.isCaptain(me.role) && members.length > 1) throw c.fail('CAPTAIN_MUST_HAND_OVER');
    await endMembership(me, 'left', 'left', { actor: principal, transaction });
    if (members.length === 1 && team.status === 'active') await archiveInTx(team, { actor: principal, reason: 'last_member_left', transaction });
    await audit.record({ action: 'team_member.left', actor: principal, entityType: 'team', entityId: team.id, req }, { transaction });
    return { left: true, teamStatus: team.status };
  });
}

async function memberOf(teamId, userId, transaction) {
  const m = await TeamMember.findOne({ where: { teamId, userId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
  if (!m) throw c.fail('NOT_A_MEMBER');
  return m;
}

/** Give the captaincy to `to` (demote first: partial unique indexes cannot defer). */
async function handOverInTx(team, from, to, { actor, transaction }) {
  if (from) await from.update({ role: 'player' }, { transaction });
  await to.update({ role: 'captain' }, { transaction });
  await c.publish(transaction, 'team.captain_changed', 'team', team.id, { teamId: team.id, fromUserId: from?.userId ?? null, toUserId: to.userId }, actor);
}

/** POST /teams/:id/captain {userId} (captain). */
async function handOver(principal, id, { userId }, req) {
  return sequelize.transaction(async (transaction) => {
    const { team, me } = await captainTx(principal, id, transaction);
    if (userId === me.userId) return detail(team, me, transaction);
    const to = await memberOf(team.id, userId, transaction);
    await handOverInTx(team, me, to, { actor: principal, transaction });
    await audit.record({ action: 'team.captain_changed', actor: principal, entityType: 'team', entityId: team.id, after: { toUserId: userId }, req }, { transaction });
    return detail(team, await TeamMember.findByPk(me.id, { transaction }), transaction);
  });
}

/** POST /teams/:id/members/:userId/remove (captain or vice-captain; never the captain). */
async function removeMember(principal, id, userId, req) {
  return sequelize.transaction(async (transaction) => {
    const { team, me } = await membershipOf(principal, id, { transaction, lock: true });
    if (!rules.canManage(me.role)) throw c.fail('CAPTAIN_ONLY');
    const m = await memberOf(team.id, userId, transaction);
    if (rules.isCaptain(m.role)) throw c.fail('CANNOT_REMOVE_CAPTAIN');
    // A vice-captain "removing" themselves simply leaves (the captain is never removable).
    if (m.userId === me.userId) await endMembership(m, 'left', 'left', { actor: principal, transaction });
    else await endMembership(m, 'removed', 'removed', { actor: principal, transaction });
    await audit.record({ action: 'team_member.removed', actor: principal, entityType: 'team', entityId: team.id, after: { userId }, req }, { transaction });
    return detail(team, me, transaction);
  });
}

/** PUT /teams/:id/members/:userId {role?, jerseyNo?} (captain): one vice-captain at a time. */
async function setMember(principal, id, userId, { role, jerseyNo }, req) {
  return sequelize.transaction(async (transaction) => {
    const { team, me } = await captainTx(principal, id, transaction);
    const m = await memberOf(team.id, userId, transaction);
    if (role !== undefined && !rules.isCaptain(m.role) && role !== m.role) {
      if (role === 'vice_captain') {
        const vice = await TeamMember.findOne({ where: { teamId: team.id, status: 'active', role: 'vice_captain' }, transaction, lock: transaction.LOCK.UPDATE });
        if (vice) await vice.update({ role: 'player' }, { transaction });
      }
      await m.update({ role }, { transaction });
      await c.publish(transaction, 'team_member.role_changed', 'team', team.id, { teamId: team.id, userId, role }, principal);
    }
    if (jerseyNo !== undefined) await m.update({ jerseyNo }, { transaction });
    await audit.record({ action: 'team_member.updated', actor: principal, entityType: 'team', entityId: team.id, after: { userId, role: m.role, jerseyNo: m.jerseyNo ?? null }, req }, { transaction });
    return detail(team, me, transaction);
  });
}

/**
 * M01 user.banned: the account leaves every team. A captain's team passes to the vice-captain, else
 * the longest-serving member, else it is archived (suspensions are temporary and change nothing).
 */
async function onUserBanned(userId, { transaction }) {
  const ms = await TeamMember.findAll({ where: { userId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const m of ms) {
    const team = await Team.findByPk(m.teamId, { transaction, lock: transaction.LOCK.UPDATE });
    const wasCaptain = rules.isCaptain(m.role);
    await m.update({ role: 'player' }, { transaction });
    await endMembership(m, 'removed', 'account_banned', { actor: null, transaction });
    if (!wasCaptain || team.status !== 'active') continue;
    const rest = await activeMembersOf(team.id, transaction);
    const next = rules.successor(rest);
    if (next) await handOverInTx(team, null, rest.find((r) => r.userId === next), { actor: null, transaction });
    else await archiveInTx(team, { actor: null, reason: 'captain_banned', transaction });
  }
  return ms.length;
}

// ---------------------------------------------------------------- staff

/** GET /admin/teams (manage_users): search by name, sport, status. */
async function adminList({ q, status, sport, limit = 50 } = {}) {
  const where = {};
  if (status) where.status = status;
  if (q) where.name = { [Op.iLike]: `%${q.replace(/[%_]/g, '')}%` };
  if (sport) {
    const s = await Sport.findOne({ where: { key: sport } });
    where.sportId = s ? s.id : null;
  }
  const rows = await Team.findAll({ where, order: [['createdAt', 'DESC']], limit });
  const sports = await sportsById(rows.map((t) => t.sportId));
  const areas = await areasById(rows.map((t) => t.homeAreaId));
  return { items: rows.map((t) => teamCard(t, sports, areas)) };
}

/** GET /admin/teams/:id: the team, members (NID booleans) and invites (masked phones). */
async function adminGet(id) {
  const team = await Team.findByPk(id);
  if (!team) throw E.notFound('Team');
  const members = await activeMembersOf(team.id);
  const sports = await sportsById([team.sportId]);
  const areas = await areasById([team.homeAreaId]);
  return { ...teamCard(team, sports, areas), archiveReason: team.archiveReason ?? null, members: await memberViews(members), invites: await require('./invites.service').teamInviteViews(team.id) };
}

/** POST /admin/teams/:id/archive (manage_users, with a reason): e.g. an offensive name. */
async function adminArchive(actor, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const team = await Team.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!team) throw E.notFound('Team');
    if (team.status !== 'active') throw c.fail('TEAM_ARCHIVED');
    await archiveInTx(team, { actor, reason, transaction });
    await audit.record({ action: 'team.archived_by_staff', actor, entityType: 'team', entityId: team.id, reason, req }, { transaction });
    return { id: team.id, status: team.status };
  });
}

// ---------------------------------------------------------------- for M14 (read-only)

async function getTeam(id, { transaction } = {}) {
  const t = await Team.findByPk(id, { transaction });
  return t ? { id: t.id, sportId: t.sportId, name: t.name, shortCode: t.shortCode ?? null, status: t.status } : null;
}
async function activeMembers(teamId, { transaction } = {}) {
  return (await activeMembersOf(teamId, transaction)).map((m) => ({ userId: m.userId, role: m.role, jerseyNo: m.jerseyNo ?? null, joinedAt: m.joinedAt }));
}
async function roleOf(userId, teamId, { transaction } = {}) {
  return (await TeamMember.findOne({ where: { teamId, userId, status: 'active' }, transaction }))?.role ?? null;
}
async function teamsOf(userId, { sportId, transaction } = {}) {
  const ms = await TeamMember.findAll({ where: { userId, status: 'active' }, transaction });
  const teams = ms.length ? await Team.findAll({ where: { id: ms.map((m) => m.teamId), status: 'active', ...(sportId ? { sportId } : {}) }, transaction }) : [];
  return teams.map((t) => ({ id: t.id, sportId: t.sportId, name: t.name, role: ms.find((m) => m.teamId === t.id).role }));
}

module.exports = {
  create,
  mine,
  get,
  update,
  uploadLogo,
  archive,
  leave,
  handOver,
  removeMember,
  setMember,
  onUserBanned,
  adminList,
  adminGet,
  adminArchive,
  getTeam,
  activeMembers,
  roleOf,
  teamsOf,
  membershipOf,
  sportsById,
  areasById,
};
