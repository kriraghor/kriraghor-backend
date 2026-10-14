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
  },
};
