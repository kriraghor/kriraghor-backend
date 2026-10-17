'use strict';

/**
 * Builds postman/kriraghor-settings.postman_collection.json (M03 settings engine + esports catalogue).
 *   node postman/build-collection-m03.js
 *
 * Two masters are needed (four-eyes): master A uses {{adminAccessToken}}, master B {{adminAccessToken2}}.
 * Every write needs a fresh step-up token:
 *  - by hand: run "Step-up A" (or "Step-up B") with a fresh authenticator code in {{totp}} / {{totpB}} just before the write;
 *  - unattended: `node postman/run-m03.js` signs in two test masters, pre-mints the tokens into
 *    stepUpQueueA / stepUpQueueB (comma-separated), and each write takes the next one in its pre-request script.
 */
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'kriraghor-settings.postman_collection.json');
const { req } = require('./lib');

const stepUpReq = (who) =>
  req(`Step-up ${who} (manual runs only)`, 'POST', '/auth/step-up', {
    as: who,
    body: { scope: 'settings.write', code: who === 'A' ? '{{totp}}' : '{{totpB}}' },
    save: { [who === 'A' ? 'stepUpToken' : 'stepUpTokenB']: 'stepUpToken' },
    desc: 'Put a fresh authenticator code in the totp (A) or totpB (B) variable first. Unattended runs skip this folder.',
  });

const propose = (name, changes, opts = {}) =>
  req(name, 'POST', '/admin/settings/change-requests', { stepUp: true, body: { changes, reason: 'Postman acceptance run', ...(opts.body || {}) }, ...opts });

const collection = {
  info: {
    name: 'Kriraghor API: M03 Settings & esports catalogue',
    description: [
      'Fees and rules (platform_settings), history, four-eyes change requests and the esports catalogue.',
      'Unattended: `node postman/run-m03.js` (uses the kriraghor_test database, two test masters and pre-minted step-up tokens).',
      'By hand: sign in two masters with the M01 collection (folder 3), copy their admin access tokens into adminAccessToken and adminAccessToken2, then run each "Step-up" request before a write.',
      'Rebuild this file with: node postman/build-collection-m03.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    ['baseUrl', 'http://localhost:4000/api/v1'],
    ['adminAccessToken', ''],
    ['adminAccessToken2', ''],
    ['totp', ''],
    ['totpB', ''],
    ['stepUpToken', ''],
    ['stepUpTokenB', ''],
    ['singleRequestId', ''],
    ['feeRequestId', ''],
    ['pubgGameId', ''],
    ['mapId', ''],
  ].map(([key, value]) => ({ key, value })),
  item: [
    {
      name: '0. Public (no sign-in)',
      item: [
        req('Public settings', 'GET', '/settings/public', {
          as: false,
          expect: { status: 200 },
          checks: [
            ['ground fee is public, shop commission is not', "j.fees.groundBookingPct === 5 && j.fees.shopCommissionPct === undefined"],
            ['money as amount + currency', "j.market.deliveryFeeDhaka.amount === 8000 && j.market.deliveryFeeDhaka.currency === 'BDT'"],
            ['cache header', "pm.response.headers.get('Cache-Control') === 'public, max-age=300'"],
          ],
        }),
        req('Esports games catalogue', 'GET', '/catalog/esports/games', {
          as: false,
          expect: { status: 200 },
          save: { pubgGameId: 'items.0.id' },
          checks: [
            ['PUBG Mobile then Free Fire', "j.items.map((g) => g.key).join() === 'pubg_mobile,free_fire'"],
            ['PUBG squad is 25 × 4', "j.items[0].modes.some((m) => m.key === 'squad' && m.maxTeams === 25 && m.teamSize === 4)"],
          ],
        }),
      ],
    },
    {
      name: '1. Admin reads (master A)',
      item: [
        req('All settings', 'GET', '/admin/settings', { expect: { status: 200 }, checks: [['181 settings', 'j.items.length === 181']] }),
        req('Fees only', 'GET', '/admin/settings?category=fees', {
          expect: { status: 200 },
          checks: [['fees are four-eyes', "j.items.every((s) => s.approval === 'four_eyes')"]],
        }),
        req('History of the shop commission', 'GET', '/admin/settings/fees.shop_commission_pct/history', { expect: { status: 200 }, checks: [['seeded as v1', 'j.items[0].version >= 1']] }),
        req('Unknown key history (expect 422)', 'GET', '/admin/settings/fees.nope_pct/history', { expect: { status: 422, code: 'SETTING_UNKNOWN' } }),
      ],
    },
    {
      name: '2. Guards',
      item: [
        req('Propose WITHOUT step-up (expect 403)', 'POST', '/admin/settings/change-requests', {
          body: { changes: [{ key: 'esports.room_reveal_minutes', to: 10 }], reason: 'No step-up' },
          expect: { status: 403, code: 'STEP_UP_REQUIRED' },
        }),
        req('Empty change list (expect 422, step-up not spent)', 'POST', '/admin/settings/change-requests', {
          body: { changes: [], reason: 'x' },
          expect: { status: 422, code: 'VALIDATION_FAILED' },
        }),
      ],
    },
    { name: '3a. Manual step-up (skip when unattended)', item: [stepUpReq('A'), stepUpReq('B')] },
    {
      name: '3. Single-approval change (applies at once)',
      item: [
        propose('Room reveal 15 → 10 min', [{ key: 'esports.room_reveal_minutes', to: 10 }], {
          expect: { status: 201 },
          save: { singleRequestId: 'id' },
          checks: [["applied", "j.status === 'applied' && j.needsFourEyes === false"]],
        }),
        propose('Cross-key rule: check-in close below room reveal (expect 422)', [{ key: 'esports.checkin_close_minutes', to: 5 }], {
          expect: { status: 422, code: 'SETTING_CROSS_RULE' },
        }),
        req('History shows v2', 'GET', '/admin/settings/esports.room_reveal_minutes/history', {
          expect: { status: 200 },
          checks: [['v2 is 10', 'j.items[0].newValue === 10 && j.items[0].oldValue === 15']],
        }),
      ],
    },
    {
      name: '4. Four-eyes fee change (A proposes, B approves)',
      item: [
        propose('A proposes shop commission 5 → 6%', [{ key: 'fees.shop_commission_pct', to: 6 }], {
          expect: { status: 201 },
          save: { feeRequestId: 'id' },
          checks: [['waiting for a second master', "j.status === 'proposed' && j.needsSecondApprover === true"]],
        }),
        req('A approves own proposal (expect 403)', 'POST', '/admin/settings/change-requests/{{feeRequestId}}/approve', { stepUp: true, body: {}, expect: { status: 403, code: 'FOUR_EYES_REQUIRED' } }),
        req('B approves', 'POST', '/admin/settings/change-requests/{{feeRequestId}}/approve', {
          as: 'B',
          stepUp: true,
          body: { note: 'Agreed in the Postman run' },
          expect: { status: 200 },
          checks: [['applied by B', "j.status === 'applied' && j.approvedBy !== null"]],
        }),
        req('B approves again (expect 409)', 'POST', '/admin/settings/change-requests/{{feeRequestId}}/approve', { as: 'B', stepUp: true, body: {}, expect: { status: 409, code: 'CHANGE_REQUEST_CLOSED' } }),
        req('Shop commission is now 6% (v2)', 'GET', '/admin/settings?category=fees', {
          expect: { status: 200 },
          checks: [['6% v2', "j.items.some((s) => s.key === 'fees.shop_commission_pct' && s.value === 6 && s.version === 2)"]],
        }),
        req('Change requests list', 'GET', '/admin/settings/change-requests', { expect: { status: 200 } }),
      ],
    },
    {
      name: '5. Esports catalogue (master A)',
      item: [
        req('All modes (admin)', 'GET', '/admin/catalog/esports-modes', { expect: { status: 200 } }),
        req('Add a map', 'POST', '/admin/catalog/esports-maps', {
          body: { gameId: '{{pubgGameId}}', key: 'karakin', nameEn: 'Karakin', nameBn: 'কারাকিন', sort: 6 },
          expect: { status: 201 },
          save: { mapId: 'id' },
        }),
        req('Change its key (expect 422)', 'PATCH', '/admin/catalog/esports-maps/{{mapId}}', { body: { key: 'karakin_2' }, expect: { status: 422, code: 'CATALOG_KEY_IMMUTABLE' } }),
        req('Deactivate it', 'POST', '/admin/catalog/esports-maps/{{mapId}}/deactivate', { expect: { status: 200 }, checks: [['inactive', 'j.isActive === false']] }),
        req('Reactivate it', 'POST', '/admin/catalog/esports-maps/{{mapId}}/reactivate', { expect: { status: 200 }, checks: [['active', 'j.isActive === true']] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
const count = collection.item.reduce((n, f) => n + f.item.length, 0);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${count} requests)`);
