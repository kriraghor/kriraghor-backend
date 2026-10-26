'use strict';

const { OpenAPIRegistry, OpenApiGeneratorV31 } = require('@asteasolutions/zod-to-openapi');
const config = require('../config');
const pkg = require('../../package.json');
const { register } = require('./paths');

/** Build the OpenAPI 3.1 document from the zod schemas (ADR-002). Pure: no I/O, stable output. */
function buildOpenApi() {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Customer access token (aud "api") for kriraghor.com, esports, vendor and mobile',
  });
  registry.registerComponent('securitySchemes', 'adminBearer', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Staff access token (aud "admin") from the admin portal sign-in (ADR-004)',
  });
  register(registry);

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Kriraghor API',
      version: pkg.version,
      description:
        'REST API for kriraghor.com, esports.kriraghor.com, the admin and vendor portals and the mobile app. ' +
        'Errors are RFC 7807 problem details with a stable `code`. Generated from the zod schemas; do not edit openapi.json by hand.',
    },
    servers: [{ url: config.apiPrefix }],
    tags: [
      { name: 'auth', description: 'Customer sign-in and sessions' },
      { name: 'auth-admin', description: 'Admin portal sign-in, two-factor and step-up (ADR-004)' },
      { name: 'me', description: "The signed-in user's account" },
      { name: 'gym-manage', description: 'Gym management (M24, gym.kriraghor.com): the owner and staff panel, members, memberships, counter fees and receipts, check-ins, imports, the plan, and the member area' },
      { name: 'business-members', description: 'Staff accounts for businesses: an owner’s team at each venue, gym or shop, and where a member works (Round B3)' },
      { name: 'admin', description: 'Staff desks' },
      { name: 'settings', description: 'Platform settings, history and four-eyes change requests (M03)' },
      { name: 'catalog', description: 'Reference catalogues: sports, places, facilities, surfaces, esports games, modes, maps and points presets (M03)' },
      { name: 'audit', description: 'Audit log search, entity history and exports (M04)' },
      { name: 'events', description: 'Outbox health, dead letters and replay (M04)' },
      { name: 'notifications', description: 'The bell, notification preferences and delivery logs (M08)' },
      { name: 'payments', description: 'Payments, refunds, escrow, ledger and reconciliation (M06)' },
      { name: 'payouts', description: 'Payout accounts, payout runs, approvals and manual disbursement (M07)' },
      { name: 'kyc', description: 'Identity and business documents: NID and ground-owner uploads, the document panel and the checklists (M02)' },
      { name: 'moderation', description: 'Submissions, the Moderation desk: claim, rubric, decisions, SLA (M05)' },
      { name: 'grounds', description: 'Grounds: listings, courts, hours, photos, pricing, closures, series and the public browse (M09)' },
      { name: 'analytics', description: 'Dashboards: member, venue owner, shop owner, gym owner, sports organiser and platform numbers, actions, CSV (M19)' },
      { name: 'bookings', description: 'Bookings: availability, holds and payment, my bookings, the owner\'s day (M10)' },
      { name: 'esports', description: 'Esports tournaments: UIDs, squads, registration, check-in, rooms, results, prizes, leaderboards (M21)' },
    ],
  });
}

module.exports = { buildOpenApi };
