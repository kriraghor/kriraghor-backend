'use strict';

/**
 * Builds postman/kriraghor-gym-special-days.postman_collection.json ("M20 · Holidays and special hours, M27 ·
 * Conversion report", product owner, 11 Nov 2026; M20-FR-16..22, M27-FR-87..91): the owner's list and its
 * limits, the checks, the preview of what a holiday would cancel, a holiday that closes the gym (the public
 * page, trial-visit slots and bookings, the class session and the booked visit it cancels), special hours
 * that replace the week's windows, removing one (its class session comes back empty), and the month's
 * conversion report with its permission and the owner's CSV.
 * node postman/build-collection-m20-special-days.js
 *
 * Variables (set by the runner, postman/run-m20-special-days.js): ownerToken (a Standard gym, live, open 06:00
 * to 22:00 every day, trial visits on, a class tomorrow with one member booked), gymId, slug, sessionId (that
 * class session), deskToken (attendance.mark, classes.manage), accountToken (reports.view), anaToken (a guest
 * with a visit booked tomorrow 18:00), boToken (a guest), otherOwnerToken (another gym's owner), today,
 * tomorrow, in2, in5, in7, in61, yesterday, month, controlUrl (the runner: /drain, /visits-today).
 * Unattended: `node postman/run-m20-special-days.js`.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-gym-special-days.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('ownerToken');
const desk = as('deskToken');
const account = as('accountToken');
const ana = as('anaToken');
const bo = as('boToken');
const other = as('otherOwnerToken');
const pub = (name, method, p, opts = {}) => req(name, method, p, { ...opts, as: false });
const idem = (item, value = 'sd-{{$guid}}') => {
  item.request.header.push({ key: 'Idempotency-Key', value });
  return item;
};
const control = (name, step) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 } });
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [step] };
  return r;
};
const S = '/me/gyms/{{gymId}}/special-days';
const G = '/manage/gyms/{{gymId}}';
const eid = { fromOn: '{{tomorrow}}', toOn: '{{in2}}', kind: 'closed', title: 'Eid-ul-Fitr' };
const ramadan = { fromOn: '{{in5}}', toOn: '{{in5}}', kind: 'hours', windows: [{ openTime: '10:00', closeTime: '14:00' }], title: 'Ramadan hours' };
const day = (name) => `j.days.find((x) => x.date === pm.variables.get('${name}'))`;

const collection = {
  info: {
    name: 'Kriraghor API: M20 · Holidays and special hours, M27 · Conversion report',
    description: [
      'Holidays and special hours (product owner, 11 Nov 2026): the owner closes the gym for a range of dates or gives those dates their own hours. It applies at once, without review: open now and the public page follow it, trial-visit slots follow it, and class sessions and booked visits it leaves shut are cancelled with the title as the reason. Removing one brings its class sessions back empty; bookings and visits are not restored. Memberships are not extended.',
      'The conversion report: for the enquiries, free trial visits and join requests that came in during a month, what became of them by today, and the month’s new members by source. Counts only. Read by the owner and staff with reports.view; the CSV is the owner’s.',
      'Requests named "Runner" go to the local test runner (delivering events as the worker would, moving the visits to today).',
      'Unattended: `node postman/run-m20-special-days.js`. Rebuild this file with: node postman/build-collection-m20-special-days.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'ownerToken', 'deskToken', 'accountToken', 'anaToken', 'boToken', 'otherOwnerToken', 'gymId', 'slug', 'sessionId',
    'today', 'tomorrow', 'in2', 'in5', 'in7', 'in61', 'yesterday', 'month', 'eidId', 'ramadanId',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. The list, the checks and the preview (M20-FR-16, FR-17)',
      item: [
        owner('Nothing yet, with the limits', 'GET', S, {
          expect: { status: 200 },
          checks: [
            ['empty', 'j.items.length === 0'],
            ['limits from the settings', 'j.limits.maxDays === 60 && j.limits.aheadDays === 365 && j.limits.maxActive === 30 && j.limits.publicDays === 30'],
          ],
        }),
        owner('A past day (expect 422)', 'POST', S, { body: { ...eid, fromOn: '{{yesterday}}' }, expect: { status: 422, code: 'GYM_SPECIAL_DAY_DATES' }, checks: [['reason past', "j.reason === 'past'"]] }),
        owner('Dates out of order (expect 422)', 'POST', S, { body: { ...eid, fromOn: '{{in2}}', toOn: '{{tomorrow}}' }, expect: { status: 422, code: 'GYM_SPECIAL_DAY_DATES' }, checks: [['reason order', "j.reason === 'order'"]] }),
        owner('Longer than 60 days (expect 422)', 'POST', S, { body: { ...eid, toOn: '{{in61}}' }, expect: { status: 422, code: 'GYM_SPECIAL_DAY_DATES' }, checks: [['reason too_long', "j.reason === 'too_long'"]] }),
        owner('Hours on a closed day (expect 422)', 'POST', S, { body: { ...eid, windows: [{ openTime: '10:00', closeTime: '12:00' }] }, expect: { status: 422, code: 'GYM_SPECIAL_DAY_HOURS' } }),
        owner('Changed hours without hours (expect 422)', 'POST', S, { body: { ...eid, kind: 'hours' }, expect: { status: 422, code: 'GYM_SPECIAL_DAY_HOURS' } }),
        owner('A one-letter title (expect 422)', 'POST', S, { body: { ...eid, title: 'x' }, expect: { status: 422, code: 'VALIDATION_FAILED' } }),
        desk('Staff cannot add one (expect 403)', 'POST', S, { body: eid, expect: { status: 403 } }),
        desk('Staff cannot list them (expect 403)', 'GET', S, { expect: { status: 403 } }),
        other('Another gym’s owner (expect 403)', 'POST', S, { body: eid, expect: { status: 403, code: 'NOT_OWNER' } }),
        owner('The preview: one class session and one visit', 'POST', `${S}/preview`, {
          body: eid,
          expect: { status: 200 },
          checks: [['counts what it would cancel', 'j.ok === true && j.affected.classSessions === 1 && j.affected.visits === 1']],
        }),
        owner('The preview saved nothing', 'GET', S, { expect: { status: 200 }, checks: [['still empty', 'j.items.length === 0']] }),
      ],
    },
    {
      name: '2. A holiday closes the gym (M20-FR-18, FR-19, FR-20, FR-22)',
      item: [
        owner('Eid-ul-Fitr, tomorrow and the day after', 'POST', S, {
          body: eid,
          expect: { status: 201 },
          save: { eidId: 'id' },
          checks: [['active and upcoming, without hours', "j.status === 'active' && j.phase === 'upcoming' && j.kind === 'closed' && j.windows.length === 0 && j.title === 'Eid-ul-Fitr'"]],
        }),
        owner('It is in the list', 'GET', S, { expect: { status: 200 }, checks: [['one item', "j.items.length === 1 && j.items[0].id === pm.variables.get('eidId')"]] }),
        owner('An overlapping one (expect 409)', 'POST', S, { body: { ...eid, fromOn: '{{in2}}', toOn: '{{in5}}', title: 'Repairs' }, expect: { status: 409, code: 'GYM_SPECIAL_DAY_OVERLAP' } }),
        pub('The gym page lists it', 'GET', '/gym/gyms/{{slug}}', {
          expect: { status: 200 },
          checks: [
            ['one special day, public fields only', "j.specialDays.length === 1 && j.specialDays[0].title === 'Eid-ul-Fitr' && j.specialDays[0].kind === 'closed' && !('createdBy' in j.specialDays[0])"],
            ['today is an ordinary day', 'j.specialToday === null'],
          ],
        }),
        pub('Trial-visit slots skip both days', 'GET', '/gym/gyms/{{slug}}/visit-slots', {
          expect: { status: 200 },
          checks: [['13 of 15 days', `j.days.length === 13 && !${day('tomorrow')} && !${day('in2')}`]],
        }),
        idem(bo('Booking a visit on the holiday (expect 422)', 'POST', '/me/gym-visits', { body: { gymId: '{{gymId}}', date: '{{tomorrow}}', arriveAt: '10:00' }, expect: { status: 422, code: 'GYM_VISIT_HOURS' } })),
        control('deliver the events', 'drain'),
        ana('The guest’s visit was cancelled by the gym, with the reason', 'GET', '/me/gym-visits', {
          expect: { status: 200 },
          checks: [['cancelled: the gym is closed', "j.items[0].status === 'cancelled' && j.items[0].cancelledBy === 'gym' && j.items[0].cancelReason === 'The gym is closed: Eid-ul-Fitr'"]],
        }),
        owner('The class session was cancelled, with the reason', 'GET', `${G}/class-sessions?from={{today}}&to={{in7}}`, {
          expect: { status: 200 },
          checks: [['cancelled: the gym is closed', "(() => { const s = j.items.find((x) => x.id === pm.variables.get('sessionId')); return s.status === 'cancelled' && s.cancelReason === 'The gym is closed: Eid-ul-Fitr'; })()"]],
        }),
      ],
    },
    {
      name: '3. Special hours replace the week’s (M20-FR-18, FR-20)',
      item: [
        owner('Ramadan hours in five days, 10:00 to 14:00', 'POST', S, {
          body: ramadan,
          expect: { status: 201 },
          save: { ramadanId: 'id' },
          checks: [['with its hours', "j.kind === 'hours' && j.windows.length === 1 && j.windows[0].openTime === '10:00' && j.windows[0].closeTime === '14:00'"]],
        }),
        pub('That day’s slots follow them', 'GET', '/gym/gyms/{{slug}}/visit-slots', {
          expect: { status: 200 },
          checks: [['10:00 to 14:00 only', `(() => { const d = ${day('in5')}; return d.windows.length === 1 && d.windows[0].openTime === '10:00' && d.windows[0].closeTime === '14:00'; })()`]],
        }),
        idem(bo('A visit at 18:00 that day (expect 422)', 'POST', '/me/gym-visits', { body: { gymId: '{{gymId}}', date: '{{in5}}', arriveAt: '18:00' }, expect: { status: 422, code: 'GYM_VISIT_HOURS' } })),
        idem(bo('A visit at 11:00 that day', 'POST', '/me/gym-visits', { body: { gymId: '{{gymId}}', date: '{{in5}}', arriveAt: '11:00' }, expect: { status: 201 } })),
        pub('The gym page lists both, the nearest first', 'GET', '/gym/gyms/{{slug}}', {
          expect: { status: 200 },
          checks: [['two special days in date order', "j.specialDays.length === 2 && j.specialDays[0].title === 'Eid-ul-Fitr' && j.specialDays[1].title === 'Ramadan hours' && j.specialDays[1].windows[0].openTime === '10:00'"]],
        }),
      ],
    },
    {
      name: '4. Removing a holiday (M20-FR-21)',
      item: [
        desk('Staff cannot remove it (expect 403)', 'POST', `${S}/{{eidId}}/remove`, { expect: { status: 403 } }),
        owner('The owner removes Eid-ul-Fitr', 'POST', `${S}/{{eidId}}/remove`, { expect: { status: 200 }, checks: [['removed', "j.status === 'removed'"]] }),
        owner('Removing it again (expect 409)', 'POST', `${S}/{{eidId}}/remove`, { expect: { status: 409, code: 'GYM_SPECIAL_DAY_STATE' } }),
        control('deliver the events', 'drain'),
        owner('The class session is back, empty', 'GET', `${G}/class-sessions?from={{today}}&to={{in7}}`, {
          expect: { status: 200 },
          checks: [['scheduled again with no one booked', "(() => { const s = j.items.find((x) => x.id === pm.variables.get('sessionId')); return s.status === 'scheduled' && s.cancelReason === null && s.booked === 0; })()"]],
        }),
        ana('The guest’s visit stays cancelled', 'GET', '/me/gym-visits', { expect: { status: 200 }, checks: [['still cancelled', "j.items[0].status === 'cancelled'"]] }),
        pub('Tomorrow takes visits again', 'GET', '/gym/gyms/{{slug}}/visit-slots', { expect: { status: 200 }, checks: [['tomorrow is back', `Boolean(${day('tomorrow')})`]] }),
        owner('Coming: only the Ramadan hours', 'GET', S, { expect: { status: 200 }, checks: [['one left', "j.items.length === 1 && j.items[0].id === pm.variables.get('ramadanId')"]] }),
        owner('Past and removed: Eid-ul-Fitr is kept', 'GET', `${S}?scope=past`, { expect: { status: 200 }, checks: [['kept as removed', "j.items.length === 1 && j.items[0].id === pm.variables.get('eidId') && j.items[0].status === 'removed'"]] }),
      ],
    },
    {
      name: '5. Where members come from (M27-FR-87 to FR-91)',
      item: [
        pub('An enquiry from the gym page', 'POST', '/gym/gyms/{{slug}}/enquiries', { body: { name: 'Nadia', phone: '01711000111' }, expect: { status: 202 } }),
        pub('A second enquiry', 'POST', '/gym/gyms/{{slug}}/enquiries', { body: { name: 'Omar', phone: '01711000222' }, expect: { status: 202 } }),
        control('date the visits today, so this month holds them', 'visits-today'),
        owner('This month’s report', 'GET', `${G}/reports/conversion`, {
          expect: { status: 200 },
          checks: [
            ['this month', "j.period.month === pm.variables.get('month')"],
            ['two enquiries, both new, none joined', 'j.enquiries.received === 2 && j.enquiries.open === 2 && j.enquiries.joined === 0 && j.enquiries.joinedPct === 0'],
            ['two visits: one cancelled, one to come', 'j.visits.booked === 2 && j.visits.cancelled === 1 && j.visits.waiting === 1 && j.visits.joined === 0'],
            ['no join requests: no share to show', 'j.joinRequests.received === 0 && j.joinRequests.joinedPct === null'],
            ['one new member, added at the desk', 'j.members.total === 1 && j.members.bySource.desk === 1 && j.members.fromVisit === 0'],
            ['counts only', "!/Nadia|Omar|0171/.test(pm.response.text())"],
          ],
        }),
        owner('A month with nothing', 'GET', `${G}/reports/conversion?month=2020-01`, { expect: { status: 200 }, checks: [['January 2020, all zero', "j.period.from === '2020-01-01' && j.period.to === '2020-01-31' && j.enquiries.received === 0 && j.members.total === 0"]] }),
        owner('A month ahead falls back to this one', 'GET', `${G}/reports/conversion?month=2999-01`, { expect: { status: 200 }, checks: [['this month', "j.period.month === pm.variables.get('month')"]] }),
        owner('A malformed month (expect 422)', 'GET', `${G}/reports/conversion?month=11-2026`, { expect: { status: 422, code: 'VALIDATION_FAILED' } }),
        account('Staff with reports.view read it', 'GET', `${G}/reports/conversion`, { expect: { status: 200 }, checks: [['the same numbers', 'j.enquiries.received === 2']] }),
        desk('Desk staff do not (expect 403)', 'GET', `${G}/reports/conversion`, { expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        account('The CSV is the owner’s (expect 403)', 'GET', `${G}/reports/conversion/export`, { expect: { status: 403 } }),
        owner('The owner’s CSV', 'GET', `${G}/reports/conversion/export?month={{month}}`, {
          expect: { status: 200 },
          checks: [
            ['a CSV file named after the month', "pm.response.headers.get('Content-Type').includes('text/csv') && pm.response.headers.get('Content-Disposition').includes('conversion-' + pm.variables.get('month') + '.csv')"],
            ['counts only', "pm.response.text().includes('\"Enquiries\",\"Received\",\"2\"') && !/Nadia|0171/.test(pm.response.text())"],
          ],
        }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
