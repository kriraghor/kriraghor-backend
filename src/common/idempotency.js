'use strict';

/**
 * Idempotency-Key for POSTs that create a payment, booking, order, registration or payout
 * (CLAUDE.md, M06-FR-01). The first request with a key reserves it; its response (status < 500) is
 * stored for IDEMPOTENCY_TTL_H and replayed for every retry with the same key and the same body. The
 * same key with a different body is refused (IDEMPOTENCY_KEY_REUSED); a retry while the first is
 * still running gets IDEMPOTENCY_IN_PROGRESS. A 5xx releases the key so the client can retry.
 *
 * Keys are scoped per route and per user, so two users can never collide.
 */
const crypto = require('crypto');
const { UniqueConstraintError } = require('sequelize');
const { AppError } = require('./errors');
const logger = require('./logger');
const { IdempotencyKey } = require('../models');

const IDEMPOTENCY_TTL_H = 24;
const KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;

/** Stable JSON so {a,b} and {b,a} hash the same. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const hashRequest = (req) => crypto.createHash('sha256').update(`${req.method} ${req.baseUrl}${req.path}\n${stable(req.body)}`).digest('hex');

/** Middleware: requires an Idempotency-Key and replays stored responses. Mount after authentication. */
function requireIdempotencyKey(scope) {
  return async (req, res, next) => {
    try {
      const key = req.get('idempotency-key');
      if (!key) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header with this request');
      if (!KEY_RE.test(key)) throw new AppError(400, 'IDEMPOTENCY_KEY_INVALID', 'The Idempotency-Key must be 8 to 80 letters, digits, - or _');
      const userId = req.user.id;
      const requestHash = hashRequest(req);
      const where = { scope, userId, key };

      let row = await IdempotencyKey.findOne({ where });
      if (row && new Date(row.expiresAt).getTime() <= Date.now()) {
        await IdempotencyKey.destroy({ where });
        row = null;
      }
      if (row) return replay(row, requestHash, res);
      try {
        await IdempotencyKey.create({ ...where, requestHash, expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_H * 3600 * 1000) });
      } catch (err) {
        if (!(err instanceof UniqueConstraintError)) throw err;
        // Another request with the same key won the race.
        return replay(await IdempotencyKey.findOne({ where }), requestHash, res);
      }

      req.idempotencyKey = key;
      const json = res.json.bind(res);
      res.json = (body) => {
        const status = res.statusCode;
        const done = status >= 500 ? IdempotencyKey.destroy({ where }) : IdempotencyKey.update({ statusCode: status, response: body ?? null }, { where });
        done.catch((err) => logger.warn({ err: err.message, scope }, 'could not store the idempotent response'));
        return json(body);
      };
      // Errors are rendered by the error handler through res.json too; nothing else to do.
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function replay(row, requestHash, res) {
  if (row.requestHash !== requestHash) {
    throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
  }
  if (row.statusCode === null || row.statusCode === undefined) {
    throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The first request with this Idempotency-Key is still running');
  }
  res.set('Idempotent-Replayed', 'true');
  return res.status(row.statusCode).json(row.response);
}

/** Job: drop expired keys (they are request bookkeeping, not business records). */
async function purgeExpired() {
  const { Op } = require('sequelize');
  return IdempotencyKey.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
}

module.exports = { requireIdempotencyKey, purgeExpired, hashRequest, IDEMPOTENCY_TTL_H };
