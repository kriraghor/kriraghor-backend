'use strict';

/**
 * Builds postman/kriraghor-analytics.postman_collection.json (M19 Dashboards and Analytics step 1).
 * node postman/build-collection-m19.js
 *
 * Variables: adminAccessToken (master A), ownerToken (a ground owner with a fixture ground at ৳2,000/h
 * flat and a 25% advance), memberToken, groundId, courtId, s1, s2 (tomorrow's slots), set by the runner;
 * controlUrl (the runner: /pay, /shift, /settle, /forget, /reconcile).
 * Unattended: `node postman/run-m19.js` (kriraghor_test database).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-analytics.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const member = as('memberToken');
const owner = as('ownerToken');
const idem = (item) => {
  item.request.header.push({ key: 'Idempotency-Key', value: 'pm-{{$guid}}' });
  return item;
};
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  const [p, qs] = step.split('?');
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [p], ...(qs ? { query: qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
const hold = (label, startVar, saveAs) =>
  idem(
    member(label, 'POST', '/bookings/holds', {
      body: { groundId: '{{groundId}}', courtIds: ['{{courtId}}'], start: `{{${startVar}}}`, minutes: 60, payment: 'advance' },
      expect: { status: 201 },
      checks: [setVar(saveAs, 'j.booking.id'), setVar(`${saveAs}Payment`, 'j.payment.id')],
    })
  );

const collection = {
  info: {
    name: 'Kriraghor API: M19 Dashboards',
    description: [
      'v3 money on a ৳2,000/h ground with a 25% advance. A member books and pays the ৳500 advance; it is played (checked in) today, earning the owner ৳2,000 gross. A second booking is cancelled by the member, earning the kept ৳500. The facts are written from the real events; the views refresh; the owner, member and platform dashboards show the numbers, the charts add up to their tiles, and the ledger fee revenue is ৳125 (৳100 + ৳25). A deleted fact comes back with the nightly reconcile. CSV exports are scoped and audited.',
      'Requests named "Runner" go to the local test runner (paying through the simulator, moving a booking in time, settling events and views, the reconcile).',
      'Unattended: `node postman/run-m19.js` (kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m19.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'controlUrl', 'adminAccessToken', 'ownerToken', 'memberToken', 'groundId', 'courtId', 's1', 's2', 'b1', 'b1Payment', 'b2', 'b2Payment'].map((key) => ({
    key,
    value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '',
  })),
  item: [
    {
      name: '1. Bookings that feed the facts',
      item: [
        owner('Owner dashboard before anything (empty)', 'GET', '/me/dashboard?role=ground_owner&period=7w', { expect: { status: 200 }, checks: [['seven buckets, nothing yet', 'j.buckets.length === 7 && j.tiles.bookings.value === 0']] }),
        hold('Hold the advance', 's1', 'b1'),
        control('pay b1', 'pay?paymentId={{b1Payment}}'),
        control('it is time', 'shift?bookingId={{b1}}'),
        owner('Check in (played)', 'POST', '/me/ground-bookings/{{b1}}/check-in', { expect: { status: 200 } }),
        hold('Hold another', 's2', 'b2'),
        control('pay b2', 'pay?paymentId={{b2Payment}}'),
        member('Cancel it (the advance is kept)', 'POST', '/me/bookings/{{b2}}/cancel', { body: { expectedRefund: 0 }, expect: { status: 200 } }),
        control('settle events and views', 'settle', { checks: [['refreshed', 'j.refreshed === 4']] }),
      ],
    },
    {
      name: '2. Dashboards (FR-01 to FR-07, §6)',
      item: [
        owner('Owner overview: revenue gross, bookings, occupancy', 'GET', '/me/dashboard?role=ground_owner&period=7w', {
          expect: { status: 200 },
          checks: [
            ['played booking earns ৳2,000', 'j.tiles.revenue.value >= 200000'],
            ['one counted booking (the cancelled one is not)', 'j.tiles.bookings.value === 1 && j.tiles.bookings.note.app === 1'],
            ['occupancy is a rate', 'j.tiles.occupancy.value > 0 && j.tiles.occupancy.value < 1'],
            ['bookings by day add up to the tile', 'j.charts.bookingsByDay.reduce((n, x) => n + x.value, 0) === j.tiles.bookings.value'],
            ['revenue by ground adds up to the tile', 'j.charts.revenueByGround.reduce((n, x) => n + x.value, 0) === j.tiles.revenue.value'],
            ['asOf and definitions', "!!j.asOf && j.definitions.revenue.includes('before the Kriraghor fee')"],
          ],
        }),
        owner('A quarter and a year', 'GET', '/me/dashboard?role=ground_owner&period=yr', { expect: { status: 200 }, checks: [['12 months', 'j.buckets.length === 12']] }),
        owner('Wrong period (expect 422)', 'GET', '/me/dashboard?role=ground_owner&period=week', { expect: { status: 422, code: 'VALIDATION_FAILED' } }),
        member('Member asks for the owner view (expect 403)', 'GET', '/me/dashboard?role=ground_owner', { expect: { status: 403, code: 'ROLE_REQUIRED' } }),
        member('Member overview: spent online', 'GET', '/me/dashboard?period=7w', {
          expect: { status: 200 },
          checks: [['two ৳500 advances', "j.tiles.spent.value === 100000 && j.charts.whereItWent[0].vertical === 'grounds'"]],
        }),
        req('Platform overview (master)', 'GET', '/admin/analytics/overview?period=7w', {
          expect: { status: 200 },
          checks: [
            ['fee revenue ৳125 (৳100 at check-in, ৳25 on the kept advance)', 'j.tiles.feeRevenue.value === 12500'],
            ['online ৳1,000', 'j.tiles.gtv.note.online === 100000'],
            ['take rate 12.5%', 'j.tiles.takeRate.value === 0.125'],
            ['verified members counted', 'j.tiles.verifiedMembers.value >= 1'],
          ],
        }),
        req('What take rate means (Bangla)', 'GET', '/kpis/take_rate/definition?locale=bn', { as: false, expect: { status: 200 }, checks: [['text', "j.text.includes('÷')"]] }),
      ],
    },
    {
      name: '3. Actions, exports, reconcile',
      item: [
        owner('Needs your action (owner)', 'GET', '/me/dashboard/actions?role=ground_owner', { expect: { status: 200 }, checks: [['a list', 'Array.isArray(j.items)']] }),
        req('Needs your action (staff)', 'GET', '/admin/analytics/actions', { expect: { status: 200 }, checks: [['a list', 'Array.isArray(j.items)']] }),
        owner('CSV of my bookings', 'GET', '/me/dashboard/export?dataset=owner_bookings&period=7w', {
          expect: { status: 200 },
          checks: [['a CSV with the booking', "pm.response.headers.get('Content-Type').includes('text/csv') && pm.response.text().includes('2000.00')"]],
        }),
        member('Owner CSV as a member (expect 403)', 'GET', '/me/dashboard/export?dataset=owner_bookings', { expect: { status: 403, code: 'ROLE_REQUIRED' } }),
        req('Platform CSV (master)', 'GET', '/admin/analytics/export?dataset=platform_daily&period=7w', { expect: { status: 200 }, checks: [['headers', "pm.response.text().includes('online_gmv_taka')"]] }),
        control('forget one fact', 'forget?bookingId={{b1}}', { checks: [['deleted', 'j.deleted === 1']] }),
        control('nightly reconcile', 'reconcile', { checks: [['repaired', 'j.repaired >= 1']] }),
        owner('The dashboard is whole again', 'GET', '/me/dashboard?role=ground_owner&period=7w', { expect: { status: 200 }, checks: [['the played booking is back', 'j.tiles.bookings.value === 1']] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
