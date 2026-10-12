'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const config = require('../../config');
const { Session, sequelize } = require('../../models');
const { sha256, randomToken } = require('../../common/crypto');
const { E } = require('../../common/errors');
const audit = require('../audit/audit.service');

const refreshTtlMs = () => config.auth.refreshTtlDays * 24 * 3600 * 1000;

function deviceLabel(ua = '') {
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad/i.test(ua)) return 'iOS';
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac os/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Unknown device';
}

/** Create a new session (new token family). Returns the plain refresh token once. */
async function create(user, req, { twoFactorAt = null, transaction } = {}) {
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
      expiresAt: new Date(Date.now() + refreshTtlMs()),
    },
    { transaction }
  );
  return { session, refreshToken };
}

/**
 * Rotate a refresh token (M01-FR-07). Presenting an already-rotated token is treated
 * as theft: the whole family is revoked.
 */
async function rotate(refreshToken, req) {
  if (!refreshToken) throw E.unauthorized('SESSION_REVOKED', 'Your session has ended. Sign in again.');
  const hash = sha256(refreshToken);

  // Revocations must COMMIT before we reject the request: throwing inside the
  // transaction would roll back the family revocation on reuse detection.
  const result = await sequelize.transaction(async (transaction) => {
    const current = await Session.findOne({ where: { refreshTokenHash: hash }, transaction, lock: transaction.LOCK.UPDATE });
    if (!current) return null;

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
        // Sliding expiry is capped by the family start so a stolen token can't live forever.
        expiresAt: new Date(Date.now() + refreshTtlMs()),
      },
      { transaction }
    );
    return { session: next, refreshToken: nextToken };
  });

  if (!result) throw E.unauthorized('SESSION_REVOKED', 'Your session has ended. Sign in again.');
  return result;
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
  return n;
}

async function listActive(userId) {
  return Session.findAll({
    where: { userId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
    order: [['lastSeenAt', 'DESC']],
  });
}

module.exports = { create, rotate, revokeFamilyOf, revokeAllForUser, listActive };
