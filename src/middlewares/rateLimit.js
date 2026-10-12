'use strict';

const { rateLimit } = require('express-rate-limit');
const config = require('../config');
const { E } = require('../common/errors');

// In-memory store for a single instance. Swap for a Redis store when running more than one API instance.
function limiter({ windowMs, limit, code = 'RATE_LIMITED' }) {
  return rateLimit({
    windowMs,
    limit: config.isTest ? limit * 100 : limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, _res, next, options) =>
      next(E.tooMany(code, 'Too many requests', 'Slow down and try again shortly.', { retryAfter: Math.ceil(options.windowMs / 1000) })),
  });
}

module.exports = {
  authGeneral: limiter({ windowMs: 15 * 60 * 1000, limit: 300 }),
  otpSend: limiter({ windowMs: 60 * 60 * 1000, limit: 20, code: 'OTP_RATE_LIMITED' }),
  credential: limiter({ windowMs: 15 * 60 * 1000, limit: 30 }), // login, OTP verify, TOTP, reset
};
