'use strict';

const { rateLimit } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const config = require('../config');
const { E } = require('../common/errors');
const { getRedis } = require('../common/redis');

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

function limiter(name, { windowMs, limit, code = 'RATE_LIMITED' }) {
  return rateLimit({
    windowMs,
    limit: config.isTest ? limit * 100 : limit,
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
  authGeneral: limiter('auth', { windowMs: 15 * 60 * 1000, limit: 300 }),
  otpSend: limiter('otp', { windowMs: 60 * 60 * 1000, limit: 20, code: 'OTP_RATE_LIMITED' }),
  credential: limiter('cred', { windowMs: 15 * 60 * 1000, limit: 30 }), // login, OTP verify, TOTP, reset
};
