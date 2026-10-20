'use strict';

const FULL = { branches: 100, functions: 100, lines: 100, statements: 100 };

module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/env.js'],
  // ADR-007 Q163: LEDGER_SNAPSHOT=<file> records each test's ledger postings (tests/ledger-snapshot.js).
  setupFilesAfterEnv: process.env.LEDGER_SNAPSHOT ? ['<rootDir>/tests/ledger-snapshot.js'] : [],
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
    // M07 payout amounts, holds, approvals and schedules.
    './src/modules/payouts/payouts.rules.js': FULL,
    // M02 NID format, age, file types, checks, decisions and the member role.
    './src/modules/kyc/kyc.rules.js': FULL,
    // M05 SLA, claim lock, rubric, checks and decisions.
    './src/modules/moderation/moderation.rules.js': FULL,
    './src/modules/esports/esports.rules.js': FULL,
    './src/modules/esports/streams.rules.js': FULL,
    // M09 price formula and limits (shared with M10), listing rules.
    './src/modules/grounds/pricing.rules.js': FULL,
    './src/modules/grounds/grounds.rules.js': FULL,
    // M10 state machine, time guards and the v3 money plans.
    './src/modules/bookings/bookings.rules.js': FULL,
    // M19 periods, deltas and KPI formulas.
    './src/modules/analytics/analytics.rules.js': FULL,
    // M17 dispute machine, outcome maths, authority, reporter eligibility and reviews.
    './src/modules/trust/trust.rules.js': FULL,
    // M18 flag machine, authority, undo and the reliability formula.
    './src/modules/risk/risk.rules.js': FULL,
    // M12 state machine, spec and variant checks, stock arithmetic, shelf life and prices.
    './src/modules/market/market.rules.js': FULL,
    // M13 quote, commission, the sub-order state machine and deadlines.
    './src/modules/orders/orders.rules.js': FULL,
    // M11 quote, rate limits, checks, the request and job machines, windows and cancellation.
    './src/modules/hire/hire.rules.js': FULL,
    // M20 gym money, validity, redemption, cancellation, tokens and subscription periods.
    './src/modules/gym/gym.rules.js': FULL,
    // M22 fees, prize fund, contracts, invoices, subdomains and contrast.
    './src/modules/organiser-saas/saas.rules.js': FULL,
    // M23 event phase, stage links, the qualifying cut, core players, alerts and polls.
    './src/modules/esports-events/events.rules.js': FULL,
    // M16 names, invites, succession, age and the eligibility evaluator.
    './src/modules/teams/teams.rules.js': FULL,
    // M14 tournaments and M15 lite results: fixtures, scheduling, money and refunds, rule schemas, standings.
    './src/modules/tournaments/fixtures.rules.js': FULL,
    './src/modules/tournaments/schedule.rules.js': FULL,
    './src/modules/tournaments/tournaments.rules.js': FULL,
    './src/modules/catalog/sport-rules.rules.js': FULL,
    './src/modules/scoring/standings.rules.js': FULL,
  },
};
