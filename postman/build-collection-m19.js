'use strict';

/**
 * Builds postman/kriraghor-analytics.postman_collection.json (M19 Dashboards and Analytics step 1).
 * node postman/build-collection-m19.js
 *
 * Variables: adminAccessToken (master A), ownerToken (a ground owner with a fixture ground at ৳2,000/h
 * flat and a 25% advance), memberToken, groundId, courtId, s1, s2 (tomorrow's slots), set by the runner;
 * controlUrl (the runner: /pay, /shift, /settle, /forget, /reconcile, and for Round B2
 * /forget-sub-order, /backfill). Round B2: shopOwnerToken (a live shop with four orders, one rejected),
 * shopSales (the counted items in poisha), subOrderId, gymOwnerToken (a live gym with three passes, two
 * admitted), orgOwnerToken, orgStaffToken and orgId (a sports organisation with a busy event).
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
// Round B2 businesses.
const shop = as('shopOwnerToken');
const gym = as('gymOwnerToken');
const org = as('orgOwnerToken');
const orgStaff = as('orgStaffToken');
// Postman strips the byte-order mark from the body; jest checks it (tests/e2e/analytics-business.test.js).
const isCsv = ['a CSV download', "pm.response.headers.get('Content-Type').includes('text/csv') && pm.response.headers.get('Content-Disposition').includes('.csv')"];
const noPersonal = ['no buyer or holder data (names, phones, address, ids)', "!/Tanvir Hasan|Nadia Islam|Fahim Rahman|Rina Begum|01711000111|Road 5|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(pm.response.text())"];
const lines = (n) => [`${n} lines with the header`, `pm.response.text().trim().split('\\r\\n').length === ${n}`];
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
      'Round B2, numbers for businesses: a shop with four orders from two buyers (one rejected) shows Sales, Orders, Average order (= Sales / Orders) and Repeat buyers with charts that add up, and CSVs without any buyer data; a lost fact comes back with the reconcile and an empty fact table is backfilled once. A gym with a day, a month and a day pass (two admitted) shows pass sales, passes by kind, admissions, busiest hours and sales by package. A sports organisation with two approved teams, one waiting and one unpaid shows teams of places and ৳54,000 of entry fees held in escrow (M06), to its members only, and its to-do list.',
      'Requests named "Runner" go to the local test runner (paying through the simulator, moving a booking in time, settling events and views, the reconcile and the backfill).',
      'Unattended: `node postman/run-m19.js` (kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m19.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'controlUrl', 'adminAccessToken', 'ownerToken', 'memberToken', 'groundId', 'courtId', 's1', 's2', 'b1', 'b1Payment', 'b2', 'b2Payment', 'shopOwnerToken', 'gymOwnerToken', 'orgOwnerToken', 'orgStaffToken', 'orgId', 'subOrderId', 'shopSales'].map((key) => ({
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
        control('settle events and views', 'settle', { checks: [['refreshed', 'j.refreshed === 8']] }),
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
        control('fill three staff queues (FR-29)', 'queues'),
        req('Needs your action (staff, FR-29)', 'GET', '/admin/analytics/actions', {
          expect: { status: 200 },
          checks: [
            ['a failed payout, urgent', "j.items.some((i) => i.key === 'payouts_failed' && i.count === 1 && i.severity === 'high' && i.href === '/admin/finance?tab=payouts&status=failed')"],
            ['a reported venue', "j.items.some((i) => i.key === 'reports_open' && i.count === 1 && i.href === '/admin/reports')"],
            ["the other master's fee change", "j.items.some((i) => i.key === 'settings_to_approve' && i.count === 1 && i.href === '/admin/fees')"],
            ['every queue, no cap', 'j.total === j.items.length'],
          ],
        }),
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
    {
      name: '4. Shops (Round B2, §6.3 "Shop", FR-22/23)',
      item: [
        control('a shop, a gym and a sports organisation with real orders, passes and registrations', 'businesses', {
          checks: ['shopOwnerToken', 'shopSales', 'subOrderId', 'gymOwnerToken', 'orgOwnerToken', 'orgStaffToken', 'orgId'].map((k) => setVar(k, `j.${k}`)),
        }),
        control('settle the businesses', 'settle', { checks: [['eight views', 'j.refreshed === 8']] }),
        shop('Shop dashboard: sales, orders, average order, repeat buyers', 'GET', '/me/dashboard?role=shop_owner&period=7w', {
          expect: { status: 200 },
          checks: [
            ['sales = the counted items (the rejected order is out)', "j.tiles.sales.value === Number(pm.collectionVariables.get('shopSales')) && j.tiles.sales.note.items === 4"],
            ['three orders, average = sales / orders', 'j.tiles.orders.value === 3 && j.tiles.averageOrder.value === Math.round(j.tiles.sales.value / 3)'],
            ['repeat buyers: one of two', 'j.tiles.repeatBuyers.value === 0.5'],
            ['orders by day add up', 'j.charts.ordersByDay.reduce((n, x) => n + x.value, 0) === j.tiles.orders.value'],
            ['sales by category add up', 'j.charts.salesByCategory.reduce((n, x) => n + x.value, 0) === j.tiles.sales.value'],
            ['best seller: 4 pairs', 'j.charts.bestSellers[0].units === 4'],
            ['conversion comes later', "j.comingLater.includes('conversion')"],
          ],
        }),
        member('A member asks for the shop view (expect 403)', 'GET', '/me/dashboard?role=shop_owner', { expect: { status: 403, code: 'ROLE_REQUIRED' } }),
        shop('Shop orders CSV', 'GET', '/me/dashboard/export?dataset=shop_orders&period=7w', { expect: { status: 200 }, checks: [isCsv, lines(5), ['the rejected order is listed with its status', "pm.response.text().includes('\"rejected\"')"], noPersonal] }),
        shop('Sales by product CSV', 'GET', '/me/dashboard/export?dataset=shop_sales_by_product&period=7w', { expect: { status: 200 }, checks: [isCsv, lines(2), ['four pairs', "pm.response.text().includes('\"4\",\"' + (Number(pm.collectionVariables.get('shopSales')) / 100).toFixed(2) + '\"')"], noPersonal] }),
        member('Shop CSV as a member (expect 403)', 'GET', '/me/dashboard/export?dataset=shop_orders', { expect: { status: 403, code: 'ROLE_REQUIRED' } }),
        control('forget a sub-order fact', 'forget-sub-order?subOrderId={{subOrderId}}', { checks: [['deleted', 'j.deleted === 1']] }),
        control('nightly reconcile', 'reconcile', { checks: [['repaired', 'j.repaired >= 1']] }),
        shop('The shop dashboard is whole again', 'GET', '/me/dashboard?role=shop_owner&period=7w', { expect: { status: 200 }, checks: [['three orders', 'j.tiles.orders.value === 3']] }),
        control('backfill from empty facts (as on the day of the migration)', 'backfill', { checks: [['every sub-order and pass, once', 'j.backfilled.subOrders === 4 && j.backfilled.passes === 3 && j.repaired === 0']] }),
      ],
    },
    {
      name: '5. Gyms (Round B2)',
      item: [
        gym('Gym dashboard: pass sales, passes by kind, admissions, unused share', 'GET', '/me/dashboard?role=gym_owner&period=7w', {
          expect: { status: 200 },
          checks: [
            ['৳400 + ৳4,500 + ৳400', 'j.tiles.passSales.value === 530000'],
            ['three passes: two day, one month', 'j.tiles.passesSold.value === 3 && j.tiles.passesSold.note.day === 2 && j.tiles.passesSold.note.month === 1'],
            ['two admissions', 'j.tiles.admissions.value === 2 && j.charts.admissionsByDay.reduce((n, x) => n + x.value, 0) === 2'],
            ['sales by package add up', 'j.charts.salesByPackage.reduce((n, x) => n + x.value, 0) === j.tiles.passSales.value'],
            ['busiest hours', 'j.charts.busiestHours.reduce((n, x) => n + x.admissions, 0) === 2'],
          ],
        }),
        member('A member asks for the gym view (expect 403)', 'GET', '/me/dashboard?role=gym_owner', { expect: { status: 403, code: 'ROLE_REQUIRED' } }),
        gym('Gym passes CSV', 'GET', '/me/dashboard/export?dataset=gym_passes&period=7w', { expect: { status: 200 }, checks: [isCsv, lines(4), ['the month pass in taka', "pm.response.text().includes('\"4500.00\"')"], noPersonal] }),
        gym('Admissions CSV', 'GET', '/me/dashboard/export?dataset=gym_admissions&period=7w', { expect: { status: 200 }, checks: [isCsv, lines(3), noPersonal] }),
        gym('A shop dataset as a gym owner (expect 403)', 'GET', '/me/dashboard/export?dataset=shop_orders', { expect: { status: 403, code: 'ROLE_REQUIRED' } }),
      ],
    },
    {
      name: '6. Sports organisers (Round B2, §6.3 "Organiser", M14 §4.1)',
      item: [
        org('Organiser dashboard: teams of places, entry fees from escrow', 'GET', '/me/dashboard?role=organiser&orgId={{orgId}}&period=7w', {
          expect: { status: 200 },
          checks: [
            ['two approved of four, one waiting, one unpaid', 'j.tiles.teams.value === 2 && j.tiles.teams.note.maxTeams === 4 && j.tiles.teams.note.waiting === 1 && j.tiles.teams.note.unpaid === 1'],
            ['three ৳18,000 fees held in escrow', 'j.tiles.entryFees.value === 5400000 && j.tiles.entryFees.note.held === 5400000 && j.tiles.entryFees.note.released === 0'],
            ['registrations this week', 'j.charts.registrationsOverTime[6].registered === 4 && j.charts.registrationsOverTime[6].approved === 2'],
            ['fees by event', 'j.charts.feesByEvent.length === 1 && j.charts.feesByEvent[0].collected === 5400000'],
          ],
        }),
        orgStaff('Organisation staff see it too', 'GET', '/me/dashboard?role=organiser&orgId={{orgId}}', { expect: { status: 200 } }),
        member('Not a member (expect 404)', 'GET', '/me/dashboard?role=organiser&orgId={{orgId}}', { expect: { status: 404, code: 'NOT_FOUND' } }),
        org('No organisation chosen (expect 422)', 'GET', '/me/dashboard?role=organiser', { expect: { status: 422, code: 'VALIDATION_FAILED' } }),
        org('Needs your action (organiser admin)', 'GET', '/me/dashboard/actions?role=organiser', {
          expect: { status: 200 },
          checks: [['waiting and unpaid', "j.items.some((x) => x.key === 'registrations_waiting' && x.count === 1) && j.items.some((x) => x.key === 'registrations_unpaid' && x.count === 1)"]],
        }),
        orgStaff('Needs your action (organiser staff: no approvals)', 'GET', '/me/dashboard/actions?role=organiser', { expect: { status: 200 }, checks: [['unpaid only', "j.items.length === 1 && j.items[0].key === 'registrations_unpaid'"]] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
