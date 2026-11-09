'use strict';

/**
 * Builds postman/kriraghor-gym-visits.postman_collection.json ("M24 · Trial visits", product owner, 9 Nov 2026;
 * M24-FR-109..120): the gym's visit settings, the public slots, booking within the gym's rules, my visits with
 * the QR and code, the gym's list, the desk search and check-in, the audited phone, make member (source desk,
 * no referral fee), cancelling from either side, the morning job and the plan tier.
 * node postman/build-collection-m24-visits.js
 *
 * Variables (set by the runner, postman/run-m24-visits.js): ownerToken (a Basic gym, live, open 06:00 to
 * 22:00), gymId, slug, deskToken (attendance.mark), anaToken, boToken, cyToken (guests with a verified phone),
 * freeOwnerToken + freeGymId + freeSlug (a Free-tier gym), tomorrow, in2, in20, yesterday, today, controlUrl
 * (the runner: /today?visitId=, /daily?at=HH:MM, /drain). Unattended: `node postman/run-m24-visits.js`.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-gym-visits.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('ownerToken');
const desk = as('deskToken');
const ana = as('anaToken');
const bo = as('boToken');
const cy = as('cyToken');
const freeOwner = as('freeOwnerToken');
const pub = (name, method, p, opts = {}) => req(name, method, p, { ...opts, as: false });
const idem = (item, value = 'gv-{{$guid}}') => {
  item.request.header.push({ key: 'Idempotency-Key', value });
  return item;
};
const control = (name, step) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 } });
  const [pathname, qs] = step.split('?');
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [pathname], ...(qs ? { query: qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};
const G = '/manage/gyms/{{gymId}}';
const slot = { gymId: '{{gymId}}', date: '{{tomorrow}}', arriveAt: '18:00' };
const book = (who, name, body, expect, extra = {}) => idem(who(name, 'POST', '/me/gym-visits', { body, expect, ...extra }));

const collection = {
  info: {
    name: 'Kriraghor API: M24 · Trial visits',
    description: [
      'Free trial visits (product owner, 9 Nov 2026), replacing the day pass. A signed-in person with a verified phone books a free visit to a gym before joining; it is confirmed at once within the gym’s rules: visits switched on (Basic plans and up), not the gym’s own owner or staff, not already a member with a running membership, from now to 14 days ahead, inside the opening hours, under the gym’s visits per person (default 1) and the daily cap.',
      'The gym is told of each booking and gets a morning “guests today” list; the desk finds a guest by their QR or 6-character code and checks them in; the phone is shown only through an audited reveal; Make member links the guest’s account with source desk, so Kriraghor charges no referral fee. Nothing is paid: no ledger, no books.',
      'Requests named "Runner" go to the local test runner (moving a visit to today, the morning job at a given Dhaka time, delivering events).',
      'Unattended: `node postman/run-m24-visits.js`. Rebuild this file with: node postman/build-collection-m24-visits.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'ownerToken', 'deskToken', 'anaToken', 'boToken', 'cyToken', 'freeOwnerToken', 'gymId', 'slug', 'freeGymId', 'freeSlug',
    'tomorrow', 'in2', 'in20', 'yesterday', 'today', 'anaVisit', 'anaCode', 'anaToken2', 'boVisit', 'cyVisit', 'memberId',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. Off by default, then switched on (M24-FR-109, FR-110)',
      item: [
        pub('The gym page: no visits yet', 'GET', '/gym/gyms/{{slug}}/visit-slots', { expect: { status: 200 }, checks: [['closed', 'j.open === false && j.days.length === 0']] }),
        book(ana, 'Booking while off (expect 409)', slot, { status: 409, code: 'GYM_VISITS_CLOSED' }),
        owner('A cap above the maximum (expect 422)', 'PATCH', `${G}/settings`, { body: { visitDailyCap: 51 }, expect: { status: 422 } }),
        desk('Staff cannot change settings (expect 403)', 'PATCH', `${G}/settings`, { body: { visitsOpen: true }, expect: { status: 403 } }),
        owner('Visits on: 2 a day, 1 per person, a note', 'PATCH', `${G}/settings`, {
          body: { visitsOpen: true, visitDailyCap: 2, visitPerPerson: 1, visitNote: 'Bring a towel; ask for Rumi at the desk.' },
          expect: { status: 200 },
          checks: [['saved with the limits', 'j.visitsOpen === true && j.visitDailyCap === 2 && j.visitPerPerson === 1 && j.visitDailyCapMax === 50 && j.visitPerPersonMax === 3']],
        }),
        pub('The gym page: 15 days with hours and places', 'GET', '/gym/gyms/{{slug}}/visit-slots', {
          expect: { status: 200 },
          checks: [
            ['open with the note', "j.open === true && j.note.startsWith('Bring a towel') && j.perPerson === 1"],
            ['15 days', 'j.days.length === 15'],
            ['tomorrow: 2 places, 06:00 to 22:00', "(() => { const d = j.days.find((x) => x.date === pm.variables.get('tomorrow')); return d.placesLeft === 2 && d.windows[0].openTime === '06:00' && d.windows[0].closeTime === '22:00'; })()"],
          ],
        }),
      ],
    },
    {
      name: '2. Booking within the gym’s rules (M24-FR-111, FR-112)',
      item: [
        book(owner, 'The owner (expect 409)', slot, { status: 409, code: 'GYM_VISIT_OWN_GYM' }),
        book(desk, 'Staff (expect 409)', slot, { status: 409, code: 'GYM_VISIT_OWN_GYM' }),
        book(ana, 'Outside the hours (expect 422)', { ...slot, arriveAt: '23:00' }, { status: 422, code: 'GYM_VISIT_HOURS' }),
        book(ana, 'Beyond 14 days (expect 422)', { ...slot, date: '{{in20}}' }, { status: 422, code: 'GYM_VISIT_DATE' }),
        book(ana, 'A past day (expect 422)', { ...slot, date: '{{yesterday}}' }, { status: 422, code: 'GYM_VISIT_DATE' }),
        ana('No Idempotency-Key (expect 400)', 'POST', '/me/gym-visits', { body: slot, expect: { status: 400 } }),
        book(ana, 'Ana books tomorrow 18:00', slot, { status: 201 }, {
          save: { anaVisit: 'visit.id', anaCode: 'visit.code', anaToken2: 'visit.token' },
          checks: [
            ['booked at once', "j.visit.status === 'booked' && j.visit.arriveAt === '18:00'"],
            ['a 6-character code and a QR token', "/^[0-9A-HJKMNP-TV-Z]{6}$/.test(j.visit.code) && j.visit.token.startsWith('v1.gv.')"],
          ],
        }),
        book(ana, 'A second visit: one per person (expect 409)', { ...slot, date: '{{in2}}' }, { status: 409, code: 'GYM_VISIT_LIMIT' }),
        book(bo, 'Bo books tomorrow 18:00', slot, { status: 201 }, { save: { boVisit: 'visit.id' } }),
        book(cy, 'Cy: the day is full (expect 409)', slot, { status: 409, code: 'GYM_VISIT_FULL' }),
        ana('My visits: the QR while booked', 'GET', '/me/gym-visits', { expect: { status: 200 }, checks: [['booked with code', "j.items[0].status === 'booked' && j.items[0].code === pm.variables.get('anaCode')"], ['no-store', "pm.response.headers.get('Cache-Control').includes('no-store')"]] }),
      ],
    },
    {
      name: '3. The gym’s list and the desk (M24-FR-113, FR-114, FR-120)',
      item: [
        desk('Tomorrow’s guests', 'GET', `${G}/visits?date={{tomorrow}}`, {
          expect: { status: 200 },
          checks: [
            ['two booked, cap 2', 'j.counts.booked === 2 && j.cap === 2 && j.items.length === 2'],
            ['name and last 4 digits only', "j.items.every((x) => x.guest.name && x.guest.phoneLast4.length === 4) && !JSON.stringify(j).includes(pm.variables.get('anaCode'))"],
          ],
        }),
        desk('Check-in on another day (expect 409)', 'POST', `${G}/visits/{{anaVisit}}/check-in`, { expect: { status: 409, code: 'GYM_VISIT_NOT_TODAY' } }),
        control('Ana’s visit is today', 'today?visitId={{anaVisit}}'),
        desk('The desk finds Ana by the typed code', 'GET', `${G}/desk/search?q={{anaCode}}`, { expect: { status: 200 }, checks: [['the visit', "j.visit && j.visit.id === pm.variables.get('anaVisit')"]] }),
        desk('The desk finds Ana by the QR', 'GET', `${G}/desk/search?q={{anaToken2}}`, { expect: { status: 200 }, checks: [['the visit', "j.visit && j.visit.id === pm.variables.get('anaVisit')"]] }),
        owner('The dashboard tile', 'GET', `${G}/overview`, { expect: { status: 200 }, checks: [['one guest today', 'j.tiles.guestsToday === 1']] }),
        desk('Check Ana in', 'POST', `${G}/visits/{{anaVisit}}/check-in`, { expect: { status: 200 }, checks: [['attended', "j.visit.status === 'attended'"]] }),
        desk('Twice (expect 409)', 'POST', `${G}/visits/{{anaVisit}}/check-in`, { expect: { status: 409, code: 'GYM_VISIT_STATE' } }),
        ana('My visit: attended, no QR any more', 'GET', '/me/gym-visits', { expect: { status: 200 }, checks: [['attended', "j.items[0].status === 'attended' && j.items[0].token === null && j.items[0].code === null"]] }),
      ],
    },
    {
      name: '4. The phone and Make member (M24-FR-116, FR-117)',
      item: [
        desk('Without members.view (expect 403)', 'POST', `${G}/visits/{{anaVisit}}/reveal-phone`, { expect: { status: 403 } }),
        owner('The guest’s phone', 'POST', `${G}/visits/{{anaVisit}}/reveal-phone`, { expect: { status: 200 }, checks: [['a phone', "typeof j.phone === 'string' && j.phone.length >= 11"], ['no-store', "pm.response.headers.get('Cache-Control').includes('no-store')"]] }),
        desk('Without members.edit (expect 403)', 'POST', `${G}/visits/{{anaVisit}}/convert`, { expect: { status: 403 } }),
        owner('Make Ana a member', 'POST', `${G}/visits/{{anaVisit}}/convert`, { expect: { status: 201 }, save: { memberId: 'member.id' }, checks: [['a member', "typeof j.member.id === 'string'"]] }),
        owner('Once only (expect 409)', 'POST', `${G}/visits/{{anaVisit}}/convert`, { expect: { status: 409, code: 'GYM_VISIT_STATE' } }),
        owner('The member: linked, added at the desk', 'GET', `${G}/members/{{memberId}}`, { expect: { status: 200 }, checks: [['source desk (no referral fee)', "JSON.stringify(j).includes('\"source\":\"desk\"')"]] }),
      ],
    },
    {
      name: '5. Cancelling (M24-FR-112, FR-115, FR-118)',
      item: [
        bo('Bo cancels', 'POST', '/me/gym-visits/{{boVisit}}/cancel', { expect: { status: 200 }, checks: [['cancelled by the guest', "j.items[0].status === 'cancelled' && j.items[0].cancelledBy === 'guest'"]] }),
        bo('Twice (expect 409)', 'POST', '/me/gym-visits/{{boVisit}}/cancel', { expect: { status: 409, code: 'GYM_VISIT_STATE' } }),
        cy('Someone else’s visit (expect 404)', 'POST', '/me/gym-visits/{{boVisit}}/cancel', { expect: { status: 404 } }),
        book(cy, 'Cy gets the freed place', slot, { status: 201 }, { save: { cyVisit: 'visit.id' } }),
        desk('The gym cancels Cy’s visit with a reason', 'POST', `${G}/visits/{{cyVisit}}/cancel`, { body: { reason: 'Closed for a private event' }, expect: { status: 200 }, checks: [['cancelled by the gym', "j.visit.cancelledBy === 'gym'"]] }),
        cy('Cy sees the reason', 'GET', '/me/gym-visits', { expect: { status: 200 }, checks: [['the reason', "j.items[0].cancelReason === 'Closed for a private event' && j.items[0].token === null"]] }),
        control('Deliver events', 'drain'),
        owner('The owner heard of the bookings and Bo’s cancel', 'GET', '/me/notifications?limit=50', {
          expect: { status: 200 },
          checks: [['visit notices', "(() => { const codes = JSON.stringify(j); return codes.includes('GYM_VISIT_BOOKED') && codes.includes('GYM_VISIT_CANCELLED_BY_GUEST'); })()"]],
        }),
        cy('Cy heard of the gym’s cancel', 'GET', '/me/notifications?limit=50', { expect: { status: 200 }, checks: [['GYM_VISIT_CANCELLED', "JSON.stringify(j).includes('GYM_VISIT_CANCELLED')"]] }),
      ],
    },
    {
      name: '6. The morning job (M24-FR-119)',
      item: [
        book(bo, 'Bo books tomorrow again', { ...slot, arriveAt: '21:00' }, { status: 201 }, { save: { boVisit: 'visit.id' } }),
        control('Bo’s visit is today', 'today?visitId={{boVisit}}'),
        control('The morning job at 08:30', 'daily?at=08:30'),
        control('Again: nothing more', 'daily?at=08:30'),
        control('Deliver events', 'drain'),
        owner('The owner’s guests-today list', 'GET', '/me/notifications?limit=50', { expect: { status: 200 }, checks: [['GYM_GUESTS_TODAY', "JSON.stringify(j).includes('GYM_GUESTS_TODAY')"]] }),
        bo('Bo’s reminder', 'GET', '/me/notifications?limit=50', { expect: { status: 200 }, checks: [['GYM_VISIT_REMINDER', "JSON.stringify(j).includes('GYM_VISIT_REMINDER')"]] }),
      ],
    },
    {
      name: '7. Basic and up (M24-FR-120)',
      item: [
        freeOwner('A Free gym switches visits on', 'PATCH', '/manage/gyms/{{freeGymId}}/settings', { body: { visitsOpen: true }, expect: { status: 200 } }),
        pub('Its page still takes none', 'GET', '/gym/gyms/{{freeSlug}}/visit-slots', { expect: { status: 200 }, checks: [['closed', 'j.open === false']] }),
        freeOwner('The list asks for Basic (expect 403)', 'GET', '/manage/gyms/{{freeGymId}}/visits', { expect: { status: 403, code: 'GYM_TIER_REQUIRED' }, checks: [['visits, basic', "j.feature === 'visits' && j.minTier === 'basic'"]] }),
        book(cy, 'Booking there (expect 409)', { gymId: '{{freeGymId}}', date: '{{tomorrow}}', arriveAt: '10:00' }, { status: 409, code: 'GYM_VISITS_CLOSED' }),
        pub('An unknown gym (expect 404)', 'GET', '/gym/gyms/no-such-gym/visit-slots', { expect: { status: 404 } }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
