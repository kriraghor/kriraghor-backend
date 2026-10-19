'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { Session, sequelize } = require('../../models');
const { sha256, randomToken } = require('../../common/crypto');
const { E } = require('../../common/errors');
const audit = require('../audit').audit;
const events = require('../events').events;

// Admin sessions (ADR-004) live auth.admin_refresh_ttl_hours; customer sessions auth.refresh_ttl_days.
const { refreshTtlMs } = require('./limits');

function deviceLabel(ua = '') {
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad/i.test(ua)) return 'iOS';
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac os/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Unknown device';
}

/** Create a new session (new token family). Returns the plain refresh token once. */
async function create(user, req, { twoFactorAt = null, audience = 'api', transaction } = {}) {
  const refreshToken = randomToken();
  const ua = req?.get?.('user-agent') ?? '';
  const session = await Session.create(
    {
      userId: user.id,
      familyId: crypto.randomUUID(),
      refreshTokenHash: sha256(refreshToken),
      userAgent: ua.slice(0, 512),
      ip: req?.ip ?? null,
      deviceLabel: deviceLabel(ua),
      twoFactorAt,
      audience,
      expiresAt: new Date(Date.now() + refreshTtlMs(audience)),
    },
    { transaction }
  );
  return { session, refreshToken };
}

/**
 * Rotate a refresh token (M01-FR-07). Presenting an already-rotated token is treated
 * as theft: the whole family is revoked. A token from the other audience (ADR-004: an admin
 * cookie sent to the customer refresh, or the reverse) is rejected without touching the session.
 */
async function rotate(refreshToken, req, { audience = 'api' } = {}) {
  if (!refreshToken) throw E.unauthorized('SESSION_REVOKED', 'Your session has ended. Sign in again.');
  const hash = sha256(refreshToken);

  // Revocations must COMMIT before we reject the request: throwing inside the
  // transaction would roll back the family revocation on reuse detection.
  const result = await sequelize.transaction(async (transaction) => {
    const current = await Session.findOne({ where: { refreshTokenHash: hash }, transaction, lock: transaction.LOCK.UPDATE });
    if (!current || current.audience !== audience) return null;

    if (current.revokedAt) {
      if (current.revokeCause === 'rotation') {
        // Reuse detected → kill every live session in this family.
        await Session.update(
          { revokedAt: new Date(), revokeCause: 'rotation_reuse' },
          { where: { familyId: current.familyId, revokedAt: null }, transaction }
        );
        await audit.record(
          { action: 'session.reuse_detected', actor: { id: current.userId }, entityType: 'session', entityId: current.familyId, req },
          { transaction }
        );
      }
      return null;
    }
    if (current.expiresAt < new Date()) {
      await current.update({ revokedAt: new Date(), revokeCause: 'expired' }, { transaction });
      return null;
    }

    const nextToken = randomToken();
    await current.update({ revokedAt: new Date(), revokeCause: 'rotation' }, { transaction });
    const next = await Session.create(
      {
        userId: current.userId,
        familyId: current.familyId,
        refreshTokenHash: sha256(nextToken),
        rotatedFrom: current.id,
        userAgent: (req?.get?.('user-agent') ?? current.userAgent ?? '').slice(0, 512),
        ip: req?.ip ?? current.ip,
        deviceLabel: current.deviceLabel,
        twoFactorAt: current.twoFactorAt,
        audience: current.audience,
        expiresAt: new Date(Date.now() + refreshTtlMs(current.audience)),
      },
      { transaction }
    );
    return { session: next, refreshToken: nextToken };
  });

  if (!result) throw E.unauthorized('SESSION_REVOKED', 'Your session has ended. Sign in again.');
  return result;
}

/**
 * Read-only lookup of a live session by refresh token, used to check the CSRF token binding
 * (ADR-004) before rotating. Returns null for unknown, revoked or expired tokens.
 */
async function peek(refreshToken) {
  if (!refreshToken) return null;
  const s = await Session.findOne({ where: { refreshTokenHash: sha256(refreshToken) } });
  if (!s || s.revokedAt || s.expiresAt < new Date()) return null;
  return { sessionId: s.id, familyId: s.familyId, audience: s.audience, userId: s.userId };
}

/** Revoke one session and every later rotation of it (the whole family). */
async function revokeFamilyOf(sessionId, cause, { transaction } = {}) {
  const s = await Session.findByPk(sessionId, { transaction });
  if (!s) return 0;
  const [n] = await Session.update(
    { revokedAt: new Date(), revokeCause: cause },
    { where: { familyId: s.familyId, revokedAt: null }, transaction }
  );
  return n;
}

async function revokeAllForUser(userId, cause, { exceptFamilyId, transaction } = {}) {
  const where = { userId, revokedAt: null };
  if (exceptFamilyId) where.familyId = { [Op.ne]: exceptFamilyId };
  const [n] = await Session.update({ revokedAt: new Date(), revokeCause: cause }, { where, transaction });
  // M04 §6.3 session.revoked → M08 ("you were signed out"). Token rotation never comes through here.
  if (n > 0) await events.publish(transaction ?? null, { name: 'session.revoked', aggregateType: 'user', aggregateId: userId, payload: { userId, cause, count: n } });
  return n;
}

async function listActive(userId) {
  return Session.findAll({
    where: { userId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
    order: [['lastSeenAt', 'DESC']],
  });
}

module.exports = { create, rotate, peek, revokeFamilyOf, revokeAllForUser, listActive };
