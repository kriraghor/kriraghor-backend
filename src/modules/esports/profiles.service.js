'use strict';

/**
 * M21 game profiles and UID bans (FR-02 to FR-04, FR-32).
 *
 *   add (UID, IGN, screenshot) ─▶ pending ─M05 approved─▶ verified
 *                                         ─M05 changes / rejected─▶ rejected (the UID is free again)
 *   verified | pending ─unlink─▶ unlinked          any live profile ─UID ban─▶ banned
 *
 * One live profile per account per game and one account per UID: partial unique indexes on
 * (game, user) and (game, uid) for pending, verified and banned rows (FR-03). Screenshots are private
 * uploads (esports/{userId}/…), shown to reviewers only. Public pages mask the UID (FR-32).
 */
const crypto = require('crypto');
const { Op, UniqueConstraintError } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const storage = require('../../common/storage');
const { sniffMime } = require('../../common/filetype');
const { uuid7 } = require('../../common/uuid7');
const { sequelize, EsportsGameProfile, EsportsUidBan, EsportsGame } = require('../../models');
const audit = require('../audit').audit;
const events = require('../events').events;
const settings = require('../settings').settings;
const moderation = require('../moderation').moderation;
const { fail, game: gameRow } = require('./esports.common');
const rules = require('./esports.rules');

const LIVE = ['pending', 'verified', 'banned'];
const IMAGE_TYPES = ['image/jpeg', 'image/png'];

// ---------------------------------------------------------------- uploads (screenshots, evidence)

/** POST /me/esports/uploads: one JPEG or PNG (checked by its first bytes) in the private bucket. */
async function upload(principal, { contentType, body }) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!buf.length) throw new AppError(422, 'FILE_EMPTY', 'The file is empty');
  if (buf.length > settings.get('kyc.max_file_bytes')) throw new AppError(413, 'FILE_TOO_LARGE', 'The file is too large');
  const sniffed = sniffMime(buf);
  if (!IMAGE_TYPES.includes(declared) || !IMAGE_TYPES.includes(sniffed)) throw new AppError(415, 'FILE_TYPE_NOT_ALLOWED', 'Upload a JPEG or PNG screenshot');
  if (declared !== sniffed) throw new AppError(415, 'FILE_TYPE_MISMATCH', 'The file is not the type it says it is');
  const key = `esports/${principal.user.id}/${uuid7()}`;
  await storage.putPrivate(key, buf, sniffed);
  return { key, mime: sniffed, sizeBytes: buf.length };
}

/** An upload key the user made (never someone else's object), with its stored type. */
async function ownUpload(userId, key) {
  if (typeof key !== 'string' || !key.startsWith(`esports/${userId}/`)) throw fail('ESPORTS_UPLOAD_INVALID');
  try {
    const obj = await storage.getPrivate(key);
    return { key, mime: obj.contentType ?? 'image/jpeg' };
  } catch {
    throw fail('ESPORTS_UPLOAD_INVALID');
  }
}

// ---------------------------------------------------------------- views

const activeBanWhere = (gameId, uid, now = new Date()) => ({
  gameId,
  uid,
  liftedAt: null,
  [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: now } }],
});
const isBanned = async (gameId, uid, { transaction } = {}) => (await EsportsUidBan.count({ where: activeBanWhere(gameId, uid), transaction })) > 0;

function serializeOwn(p, game) {
  return {
    id: p.id,
    gameId: p.gameId,
    gameKey: game?.key ?? null,
    uid: p.uid,
    uidMasked: rules.maskUid(p.uid),
    ign: p.ign,
    status: p.status,
    rejectReason: p.rejectReason ?? null,
    verifiedAt: p.verifiedAt ?? null,
    createdAt: p.createdAt,
  };
}

async function listMine(userId) {
  const rows = await EsportsGameProfile.findAll({ where: { userId, status: { [Op.ne]: 'unlinked' } }, order: [['createdAt', 'DESC']] });
  const games = new Map((await EsportsGame.findAll({ where: { id: rows.map((r) => r.gameId) } })).map((g) => [g.id, g]));
  return { items: rows.map((r) => serializeOwn(r, games.get(r.gameId))) };
}

/** The verified profile of a user for a game, or null. */
const verifiedFor = (userId, gameId, { transaction } = {}) => EsportsGameProfile.findOne({ where: { userId, gameId, status: 'verified' }, transaction });

// ---------------------------------------------------------------- add, unlink (FR-02, FR-03)

/** POST /me/esports/profiles: a UID for one game, sent to M05 review (kind game_profile). */
async function add(principal, { gameId, uid, ign, screenshotKey }, req) {
  const { user } = principal;
  const game = await gameRow(gameId);
  const cleanUid = String(uid).trim();
  const cleanIgn = String(ign).trim().replace(/\s+/g, ' ');
  if (!new RegExp(game.uidRegex).test(cleanUid)) throw fail('ESPORTS_UID_FORMAT');
  if (!cleanIgn || cleanIgn.length > game.ignMaxLen) throw fail('ESPORTS_IGN_INVALID');
  if (await isBanned(game.id, cleanUid)) throw fail('ESPORTS_UID_BANNED');
  const shot = await ownUpload(user.id, screenshotKey);
  try {
    return await sequelize.transaction(async (transaction) => {
      const taken = await EsportsGameProfile.findOne({ where: { gameId: game.id, uid: cleanUid, status: LIVE }, transaction });
      if (taken) throw fail(taken.userId === user.id ? 'ESPORTS_PROFILE_EXISTS' : 'ESPORTS_UID_TAKEN');
      const mine = await EsportsGameProfile.findOne({ where: { gameId: game.id, userId: user.id, status: LIVE }, transaction });
      if (mine) throw fail('ESPORTS_PROFILE_EXISTS');
      const p = await EsportsGameProfile.create({ userId: user.id, gameId: game.id, uid: cleanUid, ign: cleanIgn, status: 'pending', screenshotKey: shot.key, screenshotMime: shot.mime }, { transaction });
      const sub = await moderation.submit(
        {
          kind: 'game_profile',
          subjectId: p.id,
          payload: { profileId: p.id, gameId: game.id, gameKey: game.key, uid: cleanUid, ign: cleanIgn },
          title: `${game.nameEn} UID · ${cleanIgn}`,
          submittedBy: user.id,
        },
        { transaction }
      );
      await p.update({ submissionId: sub.id }, { transaction });
      await audit.record({ action: 'esports_game_profile.submitted', actor: principal, entityType: 'esports_game_profile', entityId: p.id, after: { gameId: game.id, status: 'pending' }, req }, { transaction });
      await events.publish(transaction, { name: 'esports_game_profile.submitted', aggregateType: 'esports_game_profile', aggregateId: p.id, payload: { profileId: p.id, userId: user.id, gameId: game.id } });
      return serializeOwn(p, game);
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw fail('ESPORTS_UID_TAKEN');
    throw err;
  }
}

/** POST /me/esports/profiles/:id/unlink: not while the UID is in an active entry. */
async function unlink(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await EsportsGameProfile.findOne({ where: { id, userId: principal.user.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!p) throw E.notFound('Game profile');
    if (!['pending', 'verified'].includes(p.status)) throw fail('ESPORTS_PROFILE_IN_USE');
    if (await require('./registrations.service').profileInActiveEntry(p.id, { transaction })) throw fail('ESPORTS_PROFILE_IN_USE');
    if (p.status === 'pending') await moderation.withdrawSubject('game_profile', p.id, { transaction });
    const before = { status: p.status };
    await p.update({ status: 'unlinked', unlinkedAt: new Date() }, { transaction });
    await require('./squads.service').leaveAllForGame(p.userId, p.gameId, { transaction });
    await audit.record({ action: 'esports_game_profile.unlinked', actor: principal, entityType: 'esports_game_profile', entityId: p.id, before, after: { status: 'unlinked' }, req }, { transaction });
    return serializeOwn(p);
  });
}

// ---------------------------------------------------------------- M05 adapter (checks and decisions)

/** Checks re-run on every claim: UID format (hard), not banned (hard, locked), not taken (hard, locked). */
async function checksFor(profileId, { transaction }) {
  const p = await EsportsGameProfile.findByPk(profileId, { transaction });
  if (!p) return [];
  const game = await EsportsGame.findByPk(p.gameId, { transaction });
  const banned = await isBanned(p.gameId, p.uid, { transaction });
  const others = await EsportsGameProfile.count({ where: { gameId: p.gameId, uid: p.uid, status: LIVE, id: { [Op.ne]: p.id } }, transaction });
  const ok = (key, pass, severity, detail = null) => ({ key, severity, result: pass ? 'pass' : 'fail', detail: pass ? null : detail });
  return [
    ok('uid_format', new RegExp(game.uidRegex).test(p.uid), 'hard', `Does not match ${game.uidLabelEn}`),
    ok('uid_not_banned', !banned, 'hard', 'The UID is on the ban list'),
    ok('uid_unique', others === 0, 'hard', 'Linked to another account'),
  ];
}

const DECIDED = { approved: 'verified', changes_requested: 'rejected', rejected: 'rejected' };

/** Apply an M05 decision (consumer, inside the inbox transaction). Idempotent. */
async function applyDecision(submissionId, status, { transaction }) {
  const sub = await moderation.getById(submissionId, { transaction });
  if (!sub) return null;
  const p = await EsportsGameProfile.findByPk(sub.payload.profileId, { transaction, lock: transaction.LOCK.UPDATE });
  const ack = () =>
    events.publish(transaction, { name: 'submission.applied', aggregateType: 'submission', aggregateId: sub.id, payload: { submissionId: sub.id, kind: sub.kind, subjectId: sub.subjectId, version: sub.version, submittedBy: sub.submittedBy } });
  if (!p || p.status !== 'pending' || p.submissionId !== sub.id) {
    if (status === 'approved') await ack();
    return null;
  }
  if (status === 'withdrawn') {
    await p.update({ status: 'unlinked', unlinkedAt: new Date() }, { transaction });
    return 'unlinked';
  }
  const next = DECIDED[status];
  await p.update(
    next === 'verified' ? { status: next, verifiedAt: sub.decidedAt ?? new Date(), verifiedBy: sub.decidedBy } : { status: next, rejectReason: sub.reasonCode },
    { transaction }
  );
  await audit.record({ action: `esports_game_profile.${next}`, actor: null, entityType: 'esports_game_profile', entityId: p.id, before: { status: 'pending' }, after: { status: next, reasonCode: sub.reasonCode ?? null }, meta: { submissionId: sub.id, decidedBy: sub.decidedBy } }, { transaction });
  await events.publish(transaction, {
    name: `esports_game_profile.${next}`,
    aggregateType: 'esports_game_profile',
    aggregateId: p.id,
    payload: { profileId: p.id, userId: p.userId, gameId: p.gameId, ...(next === 'rejected' ? { reasonCode: sub.reasonCode } : {}) },
  });
  if (status === 'approved') await ack();
  return next;
}

/** The screenshot for a reviewer (audited view). */
async function screenshot(actor, profileId, req) {
  const p = await EsportsGameProfile.findByPk(profileId);
  if (!p) throw E.notFound('Game profile');
  const obj = await storage.getPrivate(p.screenshotKey);
  await audit.record({ action: 'esports_game_profile.screenshot_viewed', actor, entityType: 'esports_game_profile', entityId: p.id, req });
  return { body: obj.body, mime: p.screenshotMime };
}

// ---------------------------------------------------------------- UID bans (FR-04)

function serializeBan(b) {
  return { id: b.id, gameId: b.gameId, uid: b.uid, reasonCode: b.reasonCode, note: b.note, expiresAt: b.expiresAt ?? null, liftedAt: b.liftedAt ?? null, bannedBy: b.bannedBy, createdAt: b.createdAt };
}

async function listBans({ gameId, active = true } = {}) {
  const where = { ...(gameId ? { gameId } : {}), ...(active ? { liftedAt: null } : {}) };
  const rows = await EsportsUidBan.findAll({ where, order: [['createdAt', 'DESC']], limit: 200 });
  return { items: rows.map(serializeBan) };
}

/**
 * POST /admin/esports/uid-bans: the UID can no longer be added or registered; its live profile becomes
 * banned and its open entries are disqualified with no refund (§6.6).
 */
async function ban(actor, { gameId, uid, reasonCode, note, expiresAt }, req) {
  await gameRow(gameId);
  return sequelize.transaction(async (transaction) => {
    const b = await EsportsUidBan.create({ gameId, uid: String(uid).trim(), reasonCode, note, expiresAt: expiresAt ?? null, bannedBy: actor.id }, { transaction });
    const profiles = await EsportsGameProfile.findAll({ where: { gameId, uid: b.uid, status: ['pending', 'verified'] }, transaction, lock: transaction.LOCK.UPDATE });
    for (const p of profiles) {
      if (p.status === 'pending') await moderation.withdrawSubject('game_profile', p.id, { transaction });
      await p.update({ status: 'banned' }, { transaction });
      await events.publish(transaction, { name: 'esports_game_profile.banned', aggregateType: 'esports_game_profile', aggregateId: p.id, payload: { profileId: p.id, userId: p.userId, gameId, reasonCode } });
      await require('./registrations.service').forfeitForBan(actor, p.id, { reasonCode, transaction });
    }
    await audit.record({ action: 'esports_uid.banned', actor, entityType: 'esports_uid_ban', entityId: b.id, after: { gameId, reasonCode, expiresAt: b.expiresAt ?? null }, reason: note, req }, { transaction });
    return serializeBan(b);
  });
}

/** DELETE /admin/esports/uid-bans/:id: lift a ban; a banned profile is unlinked so the player can add it again. */
async function lift(actor, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const b = await EsportsUidBan.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!b) throw E.notFound('UID ban');
    if (b.liftedAt) return serializeBan(b);
    await b.update({ liftedAt: new Date(), liftedBy: actor.id, liftReason: reason }, { transaction });
    if (!(await isBanned(b.gameId, b.uid, { transaction }))) {
      await EsportsGameProfile.update({ status: 'unlinked', unlinkedAt: new Date() }, { where: { gameId: b.gameId, uid: b.uid, status: 'banned' }, transaction });
    }
    await audit.record({ action: 'esports_uid.unbanned', actor, entityType: 'esports_uid_ban', entityId: b.id, reason, req }, { transaction });
    return serializeBan(b);
  });
}

/** Stable short code (squad invites). */
const shortCode = (n = 10) => crypto.randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, n).toUpperCase().padEnd(n, 'X');

module.exports = { upload, ownUpload, listMine, verifiedFor, add, unlink, checksFor, applyDecision, screenshot, listBans, ban, lift, isBanned, shortCode, LIVE };
