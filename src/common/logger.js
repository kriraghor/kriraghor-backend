'use strict';

const pino = require('pino');
const config = require('../config');

// PII never goes to logs: phone numbers, OTPs, tokens and passwords are redacted.
const logger = pino({
  level: config.logLevel ?? (config.isTest ? 'silent' : config.isProd ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.newPassword',
      '*.code',
      '*.refreshToken',
      '*.phone',
      '*.target',
      // M02: identity fields never reach the logs.
      '*.fields',
      '*.number',
      '*.dob',
      '*.legalName',
    ],
    censor: '[redacted]',
  },
});

module.exports = logger;
