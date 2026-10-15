'use strict';

/**
 * Builds postman/kriraghor-audit-events.postman_collection.json (M04 audit log and domain events).
 *   node postman/build-collection-m04.js
 *
 * Master A uses {{adminAccessToken}}. Writes need fresh step-up tokens, in this order:
 * settings.write (folder 2), then audit.export (folder 4).
 *  - unattended: `node postman/run-m04.js` signs in a test master, pre-mints both tokens into
 *    stepUpQueueA and runs a small worker loop (relay, consumers, exports) next to the API;
 *  - by hand: run a worker (`npm run dev:worker`) and paste step-up tokens into stepUpToken.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-audit-events.postman_collection.json');

const collection = {
  info: {
    name: 'Kriraghor API: M04 Audit log & events',
    description: [
      'Audit log search, entity history, the hash chain, exports, outbox health and replay.',
      'Unattended: `node postman/run-m04.js` (uses the kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m04.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    ['baseUrl', 'http://localhost:4000/api/v1'],
    ['adminAccessToken', ''],
    ['stepUpToken', ''],
    ['auditId', ''],
    ['exportId', ''],
    ['eventId', ''],
  ].map(([key, value]) => ({ key, value })),
  item: [
    {
      name: '0. Guards',
      item: [
        req('Audit log without a token (expect 401)', 'GET', '/admin/audit-logs', { as: false, expect: { status: 401, code: 'AUTH_REQUIRED' } }),
        req('Range over a year (expect 422)', 'GET', '/admin/audit-logs?from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z', { expect: { status: 422, code: 'RANGE_TOO_LARGE' } }),
        req('Export without step-up (expect 403)', 'POST', '/admin/audit-logs/exports', { body: { filters: {} }, expect: { status: 403, code: 'STEP_UP_REQUIRED' } }),
      ],
    },
    {
      name: '1. Audit search (master)',
      item: [
        req('Last 7 days', 'GET', '/admin/audit-logs?limit=10', {
          expect: { status: 200 },
          save: { auditId: 'items.0.id' },
          checks: [['has entries with EN and BN summaries', 'j.items.length > 0 && Boolean(j.items[0].summary.en && j.items[0].summary.bn)']],
        }),
        req('Only sign-ins', 'GET', '/admin/audit-logs?action=auth.signed_in', { expect: { status: 200 }, checks: [['all sign-ins', "j.items.every((i) => i.action === 'auth.signed_in')"]] }),
        req('One entry with chain status', 'GET', '/admin/audit-logs/{{auditId}}', { expect: { status: 200 }, checks: [['chain status present', "typeof j.chain.sealed === 'boolean'"]] }),
      ],
    },
    {
      name: '2. A fee-like change is audited as critical',
      item: [
        req('Room reveal 15 → 12 min (step-up settings.write)', 'POST', '/admin/settings/change-requests', {
          stepUp: true,
          body: { changes: [{ key: 'esports.room_reveal_minutes', to: 12 }], reason: 'Postman M04 run' },
          expect: { status: 201 },
          checks: [['applied', "j.status === 'applied'"]],
        }),
        req('setting.changed is critical with step-up', 'GET', '/admin/audit-logs?action=setting.changed', {
          expect: { status: 200 },
          checks: [['critical + step-up + diff', "j.items[0].severity === 'critical' && j.items[0].stepUp === true && j.items[0].before.value === 15 && j.items[0].after.value === 12"]],
        }),
        req('Entity history of the setting', 'GET', '/admin/entities/platform_setting/esports.room_reveal_minutes/history', {
          expect: { status: 200 },
          checks: [['has the change', "j.items.some((i) => i.action === 'setting.changed')"]],
        }),
      ],
    },
    {
      name: '3. Outbox health',
      item: [
        req('Published by the relay', 'GET', '/admin/events?status=pending', {
          waitMs: 2000,
          expect: { status: 200 },
          checks: [['nothing left pending', 'j.health.pending === 0']],
        }),
        req('No dead letters', 'GET', '/admin/events?status=dead', { expect: { status: 200 }, checks: [['empty', 'j.items.length === 0']] }),
      ],
    },
    {
      name: '4. Export',
      item: [
        req('Request a CSV export (step-up audit.export)', 'POST', '/admin/audit-logs/exports', {
          stepUp: true,
          body: { filters: { action: 'setting.changed' } },
          expect: { status: 202 },
          save: { exportId: 'id' },
        }),
        req('Export is ready', 'GET', '/admin/audit-logs/exports/{{exportId}}', {
          waitMs: 2000,
          expect: { status: 200 },
          checks: [['ready with one row', "j.status === 'ready' && j.rowCount === 1 && Boolean(j.downloadPath)"]],
        }),
        req('Download the CSV', 'GET', '/admin/audit-logs/exports/{{exportId}}/download', {
          expect: { status: 200 },
          checks: [['CSV header', "pm.response.text().startsWith('id,occurredAt,actorType')"]],
        }),
        req('The export audited itself', 'GET', '/admin/audit-logs?action=audit_log.exported', {
          waitMs: 500,
          expect: { status: 200 },
          checks: [['critical', "j.items.length === 1 && j.items[0].severity === 'critical'"]],
        }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
const count = collection.item.reduce((n, f) => n + f.item.length, 0);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${count} requests)`);
