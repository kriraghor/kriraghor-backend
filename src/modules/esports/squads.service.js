'use strict';

/**
 * M21 squads (FR-05). A squad belongs to one game; every member needs a verified UID for that game and
 * a player is in at most one active squad per game (service lock + partial unique index). The captain
 * invites by username (the invitee accepts) or shares the invite code (joining with it is immediate).
 * Size: the largest team size + substitutes among the game's modes (Q127). A captain who leaves hands
 * over to the longest-standing member; the last member leaving disbands the squad. Registrations
 * already made keep their roster (edge case 14).
 */
const { UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, EsportsSquad, EsportsSquadMember, EsportsGameProfile } = require('../../models');
const audit = require('../audit').audit;
const events = require('../events').events;
const directory = require('../users').directory;
const { fail, game: gameRow, maxSquadSize } = require('./esports.common');
const { shortCode } = require('./profiles.service');

const OPEN = ['invited', 'active'];

async function serialize(squad, { transaction } = {}) {
  const members = await EsportsSquadMember.findAll({ where: { squadId: squad.id, status: OPEN }, order: [['createdAt', 'ASC']], transaction });
  const names = await directory.publicNames(members.map((m) => m.userId), { transaction });
  const profiles = await EsportsGameProfile.findAll({ where: { userId: members.map((m) => m.userId), gameId: squad.gameId, status: 'verified' }, transaction });
  const ign = new Map(profiles.map((p) => [p.userId, { profileId: p.id, ign: p.ign }]));
  return {
    id: squad.id,
    gameId: squad.gameId,
    name: squad.name,
    tag: squad.tag,
    captainUserId: squad.captainUserId,
    status: squad.status,
    inviteCode: squad.inviteCode,
    maxMembers: await maxSquadSize(squad.gameId, { transaction }),
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      status: m.status,
      username: names.get(m.userId)?.username ?? null,
      displayName: names.get(m.userId)?.displayName ?? null,
      profileId: ign.get(m.userId)?.profileId ?? null,
      ign: ign.get(m.userId)?.ign ?? null,
    })),
  };
}

/** GET /me/esports/squads: squads I am in, and invites waiting for me. */
async function listMine(userId) {
  const mine = await EsportsSquadMember.findAll({ where: { userId, status: OPEN } });
  const squads = await EsportsSquad.findAll({ where: { id: mine.map((m) => m.squadId), status: 'active' } });
  const items = [];
  for (const s of squads) {
    const me = mine.find((m) => m.squadId === s.id);
    items.push({ ...(await serialize(s)), myStatus: me.status, myMemberId: me.id, inviteCode: me.status === 'active' ? s.inviteCode : null });
  }
  return { items };
}

async function lockSquad(id, transaction) {
  const s = await EsportsSquad.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!s || s.status !== 'active') throw E.notFound('Squad');
  return s;
}

async function requireVerified(userId, gameId, transaction) {
  const p = await EsportsGameProfile.findOne({ where: { userId, gameId, status: 'verified' }, transaction });
  if (!p) throw fail('ESPORTS_GAME_PROFILE_REQUIRED');
  return p;
}

async function requireFree(userId, gameId, transaction) {
  const other = await EsportsSquadMember.findOne({ where: { userId, gameId, status: 'active' }, transaction });
  if (other) throw fail('ESPORTS_ALREADY_IN_SQUAD');
}

async function requireRoom(squad, transaction, { counting = OPEN } = {}) {
  const n = await EsportsSquadMember.count({ where: { squadId: squad.id, status: counting }, transaction });
  if (n >= (await maxSquadSize(squad.gameId, { transaction }))) throw fail('ESPORTS_SQUAD_FULL');
}

const captainOnly = (squad, userId) => {
  if (squad.captainUserId !== userId) throw fail('ESPORTS_SQUAD_CAPTAIN_ONLY');
};

const translate = (err) => {
  if (err instanceof UniqueConstraintError) {
    const name = err.parent?.constraint ?? '';
    if (name.includes('squads_name')) return fail('ESPORTS_SQUAD_NAME_TAKEN');
    return fail('ESPORTS_ALREADY_IN_SQUAD');
  }
  return err;
};

/** POST /me/esports/squads */
async function create(principal, { gameId, name, tag }, req) {
  await gameRow(gameId);
  const userId = principal.user.id;
  try {
    return await sequelize.transaction(async (transaction) => {
      await requireVerified(userId, gameId, transaction);
      await requireFree(userId, gameId, transaction);
      const squad = await EsportsSquad.create({ gameId, name: name.trim(), tag: tag.trim().toUpperCase(), captainUserId: userId, inviteCode: shortCode(10) }, { transaction });
      await EsportsSquadMember.create({ squadId: squad.id, gameId, userId, role: 'captain', status: 'active', joinedAt: new Date() }, { transaction });
      await audit.record({ action: 'esports_squad.created', actor: principal, entityType: 'esports_squad', entityId: squad.id, after: { gameId, name: squad.name }, req }, { transaction });
      return serialize(squad, { transaction });
    });
  } catch (err) {
    throw translate(err);
  }
}

/** POST /me/esports/squads/:id/invites { username } (captain). */
async function invite(principal, squadId, { username }) {
  return sequelize.transaction(async (transaction) => {
    const squad = await lockSquad(squadId, transaction);
    captainOnly(squad, principal.user.id);
    const target = await directory.byUsername(username, { transaction });
    if (!target || target.status !== 'active') throw E.notFound('Player');
    const existing = await EsportsSquadMember.findOne({ where: { squadId, userId: target.id, status: OPEN }, transaction });
    if (existing) return serialize(squad, { transaction });
    await requireRoom(squad, transaction);
    const m = await EsportsSquadMember.create({ squadId, gameId: squad.gameId, userId: target.id, role: 'member', status: 'invited', invitedBy: principal.user.id }, { transaction });
    await events.publish(transaction, { name: 'esports_squad.invited', aggregateType: 'esports_squad', aggregateId: squad.id, payload: { squadId, memberId: m.id, userId: target.id, invitedBy: principal.user.id } });
    return serialize(squad, { transaction });
  });
}

/** POST /me/esports/squad-invites/:memberId/accept | decline */
async function respond(principal, memberId, accept) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const m = await EsportsSquadMember.findOne({ where: { id: memberId, userId: principal.user.id, status: 'invited' }, transaction, lock: transaction.LOCK.UPDATE });
      if (!m) throw fail('ESPORTS_SQUAD_INVITE_UNKNOWN');
      const squad = await lockSquad(m.squadId, transaction);
      if (!accept) {
        await m.update({ status: 'declined', leftAt: new Date() }, { transaction });
        return serialize(squad, { transaction });
      }
      await requireVerified(m.userId, squad.gameId, transaction);
      await requireFree(m.userId, squad.gameId, transaction);
      await requireRoom(squad, transaction, { counting: ['active'] });
      await m.update({ status: 'active', joinedAt: new Date() }, { transaction });
      await events.publish(transaction, { name: 'esports_squad.joined', aggregateType: 'esports_squad', aggregateId: squad.id, payload: { squadId: squad.id, userId: m.userId } });
      return serialize(squad, { transaction });
    });
  } catch (err) {
    throw translate(err);
  }
}

/** POST /me/esports/squads/join { code }: the invite code joins at once. */
async function joinByCode(principal, { code }) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const found = await EsportsSquad.findOne({ where: { inviteCode: String(code).trim().toUpperCase(), status: 'active' }, transaction });
      if (!found) throw fail('ESPORTS_SQUAD_INVITE_UNKNOWN');
      const squad = await lockSquad(found.id, transaction);
      const userId = principal.user.id;
      const existing = await EsportsSquadMember.findOne({ where: { squadId: squad.id, userId, status: OPEN }, transaction, lock: transaction.LOCK.UPDATE });
      if (existing?.status === 'active') return serialize(squad, { transaction });
      await requireVerified(userId, squad.gameId, transaction);
      await requireFree(userId, squad.gameId, transaction);
      await requireRoom(squad, transaction, { counting: ['active'] });
      if (existing) await existing.update({ status: 'active', joinedAt: new Date() }, { transaction });
      else await EsportsSquadMember.create({ squadId: squad.id, gameId: squad.gameId, userId, role: 'member', status: 'active', joinedAt: new Date() }, { transaction });
      await events.publish(transaction, { name: 'esports_squad.joined', aggregateType: 'esports_squad', aggregateId: squad.id, payload: { squadId: squad.id, userId } });
      return serialize(squad, { transaction });
    });
  } catch (err) {
    throw translate(err);
  }
}

/** A member leaves (or is removed); the captaincy passes on; the last one out disbands the squad. */
async function departInTx(squad, member, status, transaction) {
  await member.update({ status, leftAt: new Date(), role: 'member' }, { transaction });
  if (squad.captainUserId !== member.userId) return;
  const next = await EsportsSquadMember.findOne({ where: { squadId: squad.id, status: 'active' }, order: [['joinedAt', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  if (next) {
    await next.update({ role: 'captain' }, { transaction });
    await squad.update({ captainUserId: next.userId }, { transaction });
  } else {
    await EsportsSquadMember.update({ status: 'declined', leftAt: new Date() }, { where: { squadId: squad.id, status: 'invited' }, transaction });
    await squad.update({ status: 'disbanded' }, { transaction });
  }
}

/** POST /me/esports/squads/:id/leave */
async function leave(principal, squadId) {
  return sequelize.transaction(async (transaction) => {
    const squad = await lockSquad(squadId, transaction);
    const m = await EsportsSquadMember.findOne({ where: { squadId, userId: principal.user.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!m) throw fail('ESPORTS_NOT_IN_SQUAD');
    await departInTx(squad, m, 'left', transaction);
    return { left: true, squadStatus: squad.status };
  });
}

/** DELETE /me/esports/squads/:id/members/:userId (captain). */
async function remove(principal, squadId, userId) {
  return sequelize.transaction(async (transaction) => {
    const squad = await lockSquad(squadId, transaction);
    captainOnly(squad, principal.user.id);
    if (userId === principal.user.id) throw fail('ESPORTS_SQUAD_CAPTAIN_ONLY');
    const m = await EsportsSquadMember.findOne({ where: { squadId, userId, status: OPEN }, transaction, lock: transaction.LOCK.UPDATE });
    if (!m) throw fail('ESPORTS_NOT_IN_SQUAD');
    await departInTx(squad, m, 'removed', transaction);
    return serialize(squad, { transaction });
  });
}

/** POST /me/esports/squads/:id/captain { userId } */
async function transferCaptain(principal, squadId, { userId }) {
  return sequelize.transaction(async (transaction) => {
    const squad = await lockSquad(squadId, transaction);
    captainOnly(squad, principal.user.id);
    const next = await EsportsSquadMember.findOne({ where: { squadId, userId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!next) throw fail('ESPORTS_NOT_IN_SQUAD');
    await EsportsSquadMember.update({ role: 'member' }, { where: { squadId, userId: principal.user.id, status: 'active' }, transaction });
    await next.update({ role: 'captain' }, { transaction });
    await squad.update({ captainUserId: userId }, { transaction });
    return serialize(squad, { transaction });
  });
}

/** Unlinking a UID leaves that game's squad (inside the caller's transaction). */
async function leaveAllForGame(userId, gameId, { transaction }) {
  const memberships = await EsportsSquadMember.findAll({ where: { userId, gameId, status: OPEN }, transaction, lock: transaction.LOCK.UPDATE });
  for (const m of memberships) {
    const squad = await EsportsSquad.findByPk(m.squadId, { transaction, lock: transaction.LOCK.UPDATE });
    await departInTx(squad, m, m.status === 'invited' ? 'declined' : 'left', transaction);
  }
}

/** Active members of a squad (registration checks). */
const activeMembers = (squadId, { transaction } = {}) => EsportsSquadMember.findAll({ where: { squadId, status: 'active' }, transaction });

module.exports = { listMine, create, invite, respond, joinByCode, leave, remove, transferCaptain, leaveAllForGame, activeMembers, serialize };
