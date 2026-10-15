'use strict';

const FULL = { branches: 100, functions: 100, lines: 100, statements: 100 };

module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/env.js'],
  globalSetup: '<rootDir>/tests/global-setup.js',
  testTimeout: 30000,
  collectCoverageFrom: ['src/**/*.js', '!src/server.js', '!src/worker.js', '!src/realtime.js', '!src/db/migrations/**'],
  coverageReporters: ['text-summary', 'lcov'],
  // CLAUDE.md: money and points calculations need 100% branch coverage.
  coverageThreshold: {
    './src/modules/settings/settings.validate.js': FULL,
    './src/modules/catalog/catalog.validate.js': FULL,
    // M04 redactor, retry backoff and event registry rules.
    './src/modules/audit/audit.redact.js': FULL,
    './src/modules/events/events.backoff.js': FULL,
    './src/modules/events/catalog.js': { branches: 100 },
    // M08 SMS encoding, quiet hours, channel resolution, templates, dedupe and masking.
    './src/modules/notifications/notify.rules.js': FULL,
    // M06 money: helpers, ledger postings, escrow holds and refund authority.
    './src/common/money.js': FULL,
    './src/modules/payments/ledger.rules.js': FULL,
    './src/modules/payments/escrow.rules.js': FULL,
    './src/modules/payments/refunds.rules.js': FULL,
  },
};
