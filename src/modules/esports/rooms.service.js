'use strict';

/**
 * M21 room credentials (FR-14 to FR-17). The room ID and password are encrypted at rest (AES-256-GCM,
 * common/crypto) and versioned. They reach players only:
 *   - at reveal_at (starts_at − esports.room_reveal_minutes), over the socket to user:{id} of each
 *     checked-in player (never a shared room), with a push notification that never carries them;
 *   - from GET /me/esports/matches/:id/room, to a checked-in player, from reveal_at (rate-limited).
 * Every read (API, socket delivery, staff view) writes an esports_credential_views row and an audit
 * row. Rotation makes a new version, pushed at once; the old version is never served again.
 * Plaintext is never stored, logged, put in events, notifications or error messages.
 */
const { E } = require('../../common/errors');
const { encrypt, decrypt } = require('../../common/crypto');
const realtime = require('../../common/realtime');
const models = require('../../models');
const audit = require('../audit').audit;
const events = require('../events').events;
const { fail, setting } = require('./esports.common');
const rules = require('./esports.rules');

const { sequelize, EsportsMatch, EsportsTournament, EsportsRoomCredential, EsportsCredentialView, EsportsCheckin, EsportsRegistration, EsportsRegistrationPlayer, EsportsMap } = models;

const CURRENT = ['scheduled', 'revealed'];
const currentOf = (matchId, { transaction, lock = false } = {}) =>
  EsportsRoomCredential.findOne({ where: { matchId, status: CURRENT }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });

async function lockMatch(matchId, transaction) {
  const m = await EsportsMatch.findByPk(matchId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!m) throw E.notFound('Match');
  return m;
}

const staffView = (c) => (c ? { version: c.version, status: c.status, revealAt: c.revealAt, revealedAt: c.revealedAt ?? null, createdAt: c.createdAt } : null);

/** Checked-in players of a match: users checked in for its stage whose entry is checked_in. */
async function checkedInUsers(match, { transaction } = {}) {
  const checkins = await EsportsCheckin.findAll({ where: { stageId: match.stageId }, transaction });
  if (!checkins.length) return [];
  const regs = await EsportsRegistration.findAll({ where: { id: [...new Set(checkins.map((c) => c.registrationId))], status: 'checked_in' }, attributes: ['id'], transaction });
  const ok = new Set(regs.map((r) => r.id));
  const active = await EsportsRegistrationPlayer.findAll({ where: { registrationId: [...ok], status: 'active' }, attributes: ['userId'], transaction });
  const playing = new Set(active.map((a) => a.userId));
  return [...new Set(checkins.filter((c) => ok.has(c.registrationId) && playing.has(c.userId)).map((c) => c.userId))];
}

async function recordView(c, userId, { actorType, channel, req = null, transaction }) {
  await EsportsCredentialView.create({ credentialId: c.id, matchId: c.matchId, userId, actorType, channel, ip: req?.ip ?? null, userAgent: req?.get?.('user-agent')?.slice(0, 255) ?? null }, { transaction });
  await audit.record(
    { action: 'esports_room.viewed', actor: actorType === 'staff' ? req?.user ?? null : null, entityType: 'esports_match', entityId: c.matchId, meta: { version: c.version, userId, channel, actorType }, req },
    { transaction }
  );
}

/** Push the credentials to one player's own room (and log the delivery as a view). */
async function pushToUser(c, userId, name, transaction) {
  const plain = { roomId: decrypt(c.roomIdEnc), password: decrypt(c.passwordEnc) };
  await recordView(c, userId, { actorType: 'player', channel: 'socket', transaction });
  transaction.afterCommit(() => realtime.toUser(userId, name, { matchId: c.matchId, version: c.version, ...plain }));
}

// ---------------------------------------------------------------- staff (FR-14, FR-17)

/**
 * PUT /admin/esports/matches/:id/room { roomId, password, revealAt? }: the room for a match. Before the
 * reveal a new value replaces the old version; after it, use rotate.
 */
async function setRoom(actor, matchId, { roomId, password, revealAt }, req) {
  return sequelize.transaction(async (transaction) => {
    const m = await lockMatch(matchId, transaction);
    if (!['scheduled', 'room_ready'].includes(m.status)) throw fail('ESPORTS_MATCH_STATE');
    const t = await EsportsTournament.findByPk(m.tournamentId, { transaction });
    if (['cancelled', 'finalised', 'paid_out'].includes(t.status)) throw fail('ESPORTS_TOURNAMENT_STATE');
    const at = revealAt ? new Date(revealAt) : rules.revealAt(m.startsAt, setting(t, 'esports.room_reveal_minutes'));
    const old = await currentOf(m.id, { transaction, lock: true });
    if (old?.status === 'revealed') throw fail('ESPORTS_MATCH_STATE');
    const last = await EsportsRoomCredential.max('version', { where: { matchId: m.id }, transaction });
    if (old) await old.update({ status: 'superseded' }, { transaction });
    const c = await EsportsRoomCredential.create({ matchId: m.id, version: (last ?? 0) + 1, roomIdEnc: encrypt(String(roomId)), passwordEnc: encrypt(String(password)), status: 'scheduled', revealAt: at, createdBy: actor.id }, { transaction });
    await m.update({ status: 'room_ready' }, { transaction });
    await audit.record({ action: 'esports_room.set', actor, entityType: 'esports_match', entityId: m.id, after: { version: c.version, revealAt: at }, req }, { transaction });
    return { matchId: m.id, current: staffView(c) };
  });
}

/** POST /admin/esports/matches/:id/room/rotate { roomId, password }: a leak (edge case 6). */
async function rotate(actor, matchId, { roomId, password, reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const m = await lockMatch(matchId, transaction);
    const old = await currentOf(m.id, { transaction, lock: true });
    if (!old || ['final', 'cancelled'].includes(m.status)) throw fail('ESPORTS_ROOM_NOT_SET');
    const revealed = old.status === 'revealed';
    await old.update({ status: 'superseded' }, { transaction });
    const c = await EsportsRoomCredential.create(
      { matchId: m.id, version: old.version + 1, roomIdEnc: encrypt(String(roomId)), passwordEnc: encrypt(String(password)), status: revealed ? 'revealed' : 'scheduled', revealAt: old.revealAt, revealedAt: revealed ? new Date() : null, createdBy: actor.id },
      { transaction }
    );
    if (revealed) for (const userId of await checkedInUsers(m, { transaction })) await pushToUser(c, userId, 'esports.room_rotated', transaction);
    await audit.record({ action: 'esports_room.rotated', actor, entityType: 'esports_match', entityId: m.id, after: { version: c.version }, reason: reason ?? null, req }, { transaction });
    await events.publish(transaction, { name: 'esports_match.room_rotated', aggregateType: 'esports_match', aggregateId: m.id, payload: { matchId: m.id, tournamentId: m.tournamentId, version: c.version } });
    return { matchId: m.id, current: staffView(c) };
  });
}

/** Reveal a match's current credentials now (job at reveal_at, or staff "Reveal now"). Idempotent. */
async function revealInTx(m, c, { transaction }) {
  if (c.status === 'revealed') return 0;
  await c.update({ status: 'revealed', revealedAt: new Date() }, { transaction });
  if (rules.canMatch(m.status, 'room_revealed')) await m.update({ status: 'room_revealed' }, { transaction });
  const users = await checkedInUsers(m, { transaction });
  for (const userId of users) await pushToUser(c, userId, 'esports.room_revealed', transaction);
  await events.publish(transaction, { name: 'esports_match.room_revealed', aggregateType: 'esports_match', aggregateId: m.id, payload: { matchId: m.id, tournamentId: m.tournamentId, version: c.version, players: users.length } });
  return users.length;
}

/** POST /admin/esports/matches/:id/room/reveal-now */
async function revealNow(actor, matchId, req) {
  return sequelize.transaction(async (transaction) => {
    const m = await lockMatch(matchId, transaction);
    const c = await currentOf(m.id, { transaction, lock: true });
    if (!c) throw fail('ESPORTS_ROOM_NOT_SET');
    if (c.status === 'scheduled' && c.revealAt > new Date()) await c.update({ revealAt: new Date() }, { transaction });
    const delivered = await revealInTx(m, c, { transaction });
    await audit.record({ action: 'esports_room.revealed_now', actor, entityType: 'esports_match', entityId: m.id, after: { version: c.version, delivered }, req }, { transaction });
    return { matchId: m.id, current: staffView(c), delivered };
  });
}

/** Job step: reveal every credential whose time has come. */
async function revealDue(now = new Date()) {
  const due = await EsportsRoomCredential.findAll({ where: { status: 'scheduled', revealAt: { [require('sequelize').Op.lte]: now } }, attributes: ['id', 'matchId'] });
  let revealed = 0;
  for (const d of due) {
    await sequelize.transaction(async (transaction) => {
      const m = await lockMatch(d.matchId, transaction);
      if (['cancelled', 'final'].includes(m.status)) return;
      const c = await currentOf(m.id, { transaction, lock: true });
      if (c && c.id === d.id) {
        await revealInTx(m, c, { transaction });
        revealed += 1;
      }
    });
  }
  return { revealed };
}

/** A late (staff) check-in after the reveal gets the credentials of the tournament's revealed matches. */
async function deliverToUserInTx(tournamentId, userId, { transaction }) {
  const matches = await EsportsMatch.findAll({ where: { tournamentId, status: ['room_revealed', 'live'] }, transaction });
  for (const m of matches) {
    const c = await currentOf(m.id, { transaction });
    if (c?.status === 'revealed') await pushToUser(c, userId, 'esports.room_revealed', transaction);
  }
}

/** GET /admin/esports/matches/:id/room: the panel (status, versions) without the secret. */
async function panel(matchId) {
  const m = await EsportsMatch.findByPk(matchId);
  if (!m) throw E.notFound('Match');
  const versions = await EsportsRoomCredential.findAll({ where: { matchId }, order: [['version', 'DESC']] });
  const views = await EsportsCredentialView.count({ where: { matchId } });
  return { matchId, matchStatus: m.status, startsAt: m.startsAt, current: staffView(versions.find((v) => CURRENT.includes(v.status))), versions: versions.map(staffView), views };
}

/** POST /admin/esports/matches/:id/room/view: a staff member reads the secret (audited view). */
async function staffRead(actor, matchId, req) {
  return sequelize.transaction(async (transaction) => {
    const c = await currentOf(matchId, { transaction });
    if (!c) throw fail('ESPORTS_ROOM_NOT_SET');
    await recordView(c, actor.id, { actorType: 'staff', channel: 'api', req, transaction });
    return { matchId, version: c.version, roomId: decrypt(c.roomIdEnc), password: decrypt(c.passwordEnc) };
  });
}

/** GET /admin/esports/matches/:id/room/views: who saw which version, and when. */
async function views(matchId) {
  const rows = await EsportsCredentialView.findAll({ where: { matchId }, order: [['id', 'DESC']], limit: 500 });
  const versions = new Map((await EsportsRoomCredential.findAll({ where: { matchId }, attributes: ['id', 'version'] })).map((c) => [c.id, c.version]));
  const names = await require('../users').directory.publicNames(rows.map((r) => r.userId));
  return {
    items: rows.map((r) => ({ id: Number(r.id), userId: r.userId, username: names.get(r.userId)?.username ?? null, displayName: names.get(r.userId)?.displayName ?? null, version: versions.get(r.credentialId) ?? null, actorType: r.actorType, channel: r.channel, createdAt: r.createdAt })),
  };
}

// ---------------------------------------------------------------- the player (FR-15, FR-16)

/** GET /me/esports/matches/:id/room: a checked-in player, from reveal_at; audited. */
async function playerRead(principal, matchId, req) {
  return sequelize.transaction(async (transaction) => {
    const m = await EsportsMatch.findByPk(matchId, { transaction });
    if (!m) throw E.notFound('Match');
    const users = await checkedInUsers(m, { transaction });
    if (!users.includes(principal.user.id)) throw fail('ESPORTS_NOT_CHECKED_IN');
    const c = await currentOf(m.id, { transaction });
    if (!c) throw fail('ESPORTS_ROOM_NOT_SET');
    if (c.status !== 'revealed' && c.revealAt > new Date()) throw fail('ESPORTS_ROOM_NOT_REVEALED', { revealAt: c.revealAt });
    await recordView(c, principal.user.id, { actorType: 'player', channel: 'api', req, transaction });
    const map = await EsportsMap.findByPk(m.mapId, { transaction });
    return { matchId: m.id, version: c.version, roomId: decrypt(c.roomIdEnc), password: decrypt(c.passwordEnc), map: map ? { key: map.key, nameEn: map.nameEn, nameBn: map.nameBn } : null, startsAt: m.startsAt, revealedAt: c.revealedAt ?? c.revealAt };
  });
}

module.exports = { setRoom, rotate, revealNow, revealDue, revealInTx, deliverToUserInTx, panel, staffRead, views, playerRead, checkedInUsers, currentOf };
