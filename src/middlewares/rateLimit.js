'use strict';

const { rateLimit } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const config = require('../config');
const { E } = require('../common/errors');
const { getRedis } = require('../common/redis');
const settings = require('../modules/settings/settings.service');

/**
 * Limits are shared by every API pod through Redis (CLAUDE.md: no in-memory rate limits).
 * Tests use the default memory store so they need no Redis and stay isolated.
 * Behind the ingress, TRUST_PROXY must equal the number of proxy hops so req.ip is the client.
 */
function store(name) {
  if (config.isTest) return undefined;
  return new RedisStore({
    prefix: `${config.redis.prefix}:rl:${name}:`,
    sendCommand: (command, ...args) => getRedis().call(command, ...args),
  });
}

/** `settingKey` holds the limit per window (M03 ratelimit.*); read per request so a change applies at once. */
function limiter(name, { windowMs, settingKey, code = 'RATE_LIMITED' }) {
  return rateLimit({
    windowMs,
    limit: () => settings.get(settingKey) * (config.isTest ? 100 : 1),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: store(name),
    // Fail open if Redis is down: the DB-backed OTP and lockout limits still apply.
    passOnStoreError: true,
    handler: (req, _res, next, options) =>
      next(E.tooMany(code, 'Too many requests', 'Slow down and try again shortly.', { retryAfter: Math.ceil(options.windowMs / 1000) })),
  });
}

module.exports = {
  authGeneral: limiter('auth', { windowMs: 15 * 60 * 1000, settingKey: 'ratelimit.global_per_15min' }),
  otpSend: limiter('otp', { windowMs: 60 * 60 * 1000, settingKey: 'ratelimit.otp_per_hour', code: 'OTP_RATE_LIMITED' }),
  credential: limiter('cred', { windowMs: 15 * 60 * 1000, settingKey: 'ratelimit.credential_per_15min' }), // login, OTP verify, TOTP, reset
};
