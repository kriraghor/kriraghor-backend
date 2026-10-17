'use strict';

/**
 * VelocityGuard (M18-FR-12): per-account limits on a Redis sliding window shared by every API pod
 * (CLAUDE.md: no in-memory rate limits). Each limit reads its number from platform_settings at call
 * time. A refused request is a 429 RATE_LIMITED (or the limit's own code) with retryAfter, and the
 * breach is counted for the account (M18 rule velocity_breaches) and schedules a risk evaluation.
 * If Redis is down the guard fails open (these are browsing-style limits; OTP limits live in M01).
 */
const crypto = require('crypto');
const config = require('../config');
const logger = require('./logger');
const { getRedis } = require('./redis');
const { E } = require('./errors');

const DAY = 24 * 3600 * 1000;
const key = (...parts) => `${config.redis.prefix}:vel:${parts.join(':')}`;

/** Count one hit; returns { allowed, retryAfter } (seconds). */
async function hit({ name, scope, limit, windowMs, now = Date.now() }) {
  const k = key(name, scope);
  const r = getRedis();
  const [, [, count], [, oldest]] = await r.multi().zremrangebyscore(k, 0, now - windowMs).zcard(k).zrange(k, 0, 0, 'WITHSCORES').exec();
  if (count >= limit) {
    const first = oldest?.length ? Number(oldest[1]) : now;
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((first + windowMs - now) / 1000)) };
  }
  await r.multi().zadd(k, now, `${now}:${crypto.randomUUID()}`).pexpire(k, windowMs).exec();
  return { allowed: true, retryAfter: 0 };
}

/** A breach: counted per account over 24 h (rule velocity_breaches), then an evaluation is scheduled. */
async function recordBreach(userId, name, now = Date.now()) {
  const k = key('breaches', userId);
  await getRedis().multi().zremrangebyscore(k, 0, now - DAY).zadd(k, now, `${now}:${name}:${crypto.randomUUID()}`).pexpire(k, DAY).exec();
  require('../modules/risk/risk.jobs').scheduleEvaluation(userId);
}

/** Breaches of an account in the last 24 h. */
async function breaches(userId, now = Date.now()) {
  try {
    const k = key('breaches', userId);
    await getRedis().zremrangebyscore(k, 0, now - DAY);
    return await getRedis().zcard(k);
  } catch (err) {
    logger.warn({ err: err.message }, 'velocity breaches unavailable');
    return 0;
  }
}

/**
 * Express middleware for a signed-in route: `settingKey` holds the limit per `windowMs`. Tests run
 * with the limits ×100 (like the M01 limiter), so suites do not trip them by accident.
 */
function guard(name, { windowMs, settingKey, code = 'RATE_LIMITED' }) {
  return async (req, _res, next) => {
    const settings = require('../modules/settings/settings.service');
    if (!req.user) return next();
    const limit = settings.get(settingKey) * (config.isTest ? 100 : 1);
    try {
      const r = await hit({ name, scope: req.user.id, limit, windowMs });
      if (r.allowed) return next();
      await recordBreach(req.user.id, name).catch((err) => logger.warn({ err: err.message }, 'velocity breach not recorded'));
      return next(E.tooMany(code, 'Too many requests', 'Slow down and try again shortly.', { retryAfter: r.retryAfter }));
    } catch (err) {
      logger.warn({ err: err.message, limit: name }, 'velocity guard unavailable; allowing');
      return next();
    }
  };
}

module.exports = { hit, recordBreach, breaches, guard };
