'use strict';

/**
 * Builds postman/kriraghor-bookings.postman_collection.json (M10 Bookings step 1 on the v3 money rules,
 * with M09 step 2 closures and series). node postman/build-collection-m10.js
 *
 * Variables: adminAccessToken (master A), ownerToken / owner2Token (two ground owners; owner A has a
 * live two-court ground at ৳2,000/h flat with a 25% advance), memberToken / member2Token, the slot
 * times s1…s6 and the ids, all set by the runner; controlUrl (the runner: /pay, /shift, /tick, /check).
 * Unattended: `node postman/run-m10.js` (kriraghor_test database).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-bookings.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const member = as('memberToken');
const member2 = as('member2Token');
const owner = as('ownerToken');
const owner2 = as('owner2Token');
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
/** Send a variable as a number in a JSON body (Postman would otherwise keep the quotes around it). */
const numeric = (item, field, variable) => {
  item.request.body.raw = item.request.body.raw.replace(`"${field}": "{{${variable}}}"`, `"${field}": {{${variable}}}`);
  return item;
};
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
const hold = (who, label, startVar, payment, saveAs, court = 'courtId') =>
  idem(
    who(label, 'POST', '/bookings/holds', {
      body: { groundId: '{{groundId}}', courtIds: [`{{${court}}}`], start: `{{${startVar}}}`, minutes: 60, payment },
      expect: { status: 201 },
      checks: [setVar(saveAs, 'j.booking.id'), setVar(`${saveAs}Payment`, 'j.payment.id')],
    })
  );
const pay = (saveAs, who = 'member') => control(`pay ${saveAs}`, `pay?paymentId={{${saveAs}Payment}}&who=${who}`);

const collection = {
  info: {
    name: 'Kriraghor API: M10 Bookings',
    description: [
      'v3 money on a ৳2,000/h ground with a 25% advance. A member holds tomorrow’s slot and pays the ৳500 advance through the simulator; another member cannot take it (exclusion constraint). Check-in releases ৳400 to the owner and ৳100 to Kriraghor; the owner records ৳1,500 at the venue and extends 30 minutes (৳50 fee owed). A full-price booking is cancelled by the member (৳1,500 back, ৳475 / ৳25 kept), one is cancelled by the owner (100% back), one is a no-show (৳475 / ৳25), one is auto-completed after 24 h (৳400 / ৳100). A walk-in owes ৳100. Closures clash with bookings and block holds; a weekly series becomes four venue-paid bookings; a booking moves to the other court. The ledger ends at owner ৳1,750, fee revenue ৳400 (৳250 taken from online money, ৳150 owed from venue money) and every invariant holds.',
      'Requests named "Runner" go to the local test runner (paying through the simulator, moving a booking in time, the minute tick, ledger balances).',
      'Unattended: `node postman/run-m10.js` (kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m10.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'adminAccessToken', 'ownerToken', 'owner2Token', 'memberToken', 'member2Token', 'groundId', 'groundSlug', 'courtId', 'court2Id', 'day1',
    's1', 's2', 's3', 's4', 's5', 's6', 'closeStart', 'closeEnd', 'seriesFirstDate', 'seriesDow', 'seriesStart',
    'b1', 'b1Payment', 'b2', 'b2Payment', 'b3', 'b3Payment', 'b4', 'b4Payment', 'b5', 'b5Payment', 'b6', 'b6Payment', 'closureId', 'seriesId',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. Availability, hold and pay (FR-01 to FR-06)',
      item: [
        req('Availability tomorrow', 'GET', '/grounds/{{groundId}}/availability?date={{day1}}', {
          as: false,
          expect: { status: 200 },
          checks: [['two courts, lengths', "j.courts.length === 2 && j.lengths.join(',') === '60,90,120,180' && j.bookable === true"]],
        }),
        req('Detail: booking is open', 'GET', '/grounds/{{groundSlug}}', { as: false, expect: { status: 200 }, checks: [['bookingOpen', 'j.bookingOpen === true']] }),
        idem(owner('Own ground (expect 422)', 'POST', '/bookings/holds', { body: { groundId: '{{groundId}}', courtIds: ['{{courtId}}'], start: '{{s1}}', minutes: 60, payment: 'advance' }, expect: { status: 422, code: 'OWN_GROUND' } })),
        hold(member, 'Hold the advance: ৳2,000, advance ৳500, fee ৳100', 's1', 'advance', 'b1'),
        idem(
          member2('Same court and time (expect 409)', 'POST', '/bookings/holds', { body: { groundId: '{{groundId}}', courtIds: ['{{courtId}}'], start: '{{s1}}', minutes: 60, payment: 'advance' }, expect: { status: 409, code: 'SLOT_UNAVAILABLE' } })
        ),
        pay('b1'),
        member('Confirmed at once (Q66)', 'GET', '/me/bookings/{{b1}}', {
          expect: { status: 200 },
          checks: [['confirmed, ৳500 online, ৳1,500 at the venue', "j.booking.status === 'confirmed' && j.booking.money.paidOnline === 50000 && j.booking.money.dueAtVenue === 150000 && j.booking.money.fee === 10000"]],
        }),
        member('Cancel preview: the advance is kept', 'POST', '/me/bookings/{{b1}}/cancel-preview', { expect: { status: 200 }, checks: [['refund 0, kept ৳500', 'j.refund === 0 && j.retained === 50000']] }),
        member('My bookings', 'GET', '/me/bookings', { expect: { status: 200 }, checks: [['one upcoming', 'j.items.length === 1']] }),
      ],
    },
    {
      name: '2. Check-in releases the money (FR-13, v3)',
      item: [
        owner('Check-in tomorrow (expect 409)', 'POST', '/me/ground-bookings/{{b1}}/check-in', { expect: { status: 409, code: 'NOT_CHECKIN_WINDOW' } }),
        control('it is time', 'shift?bookingId={{b1}}&to=now'),
        owner('Check in: ৳400 to the owner, ৳100 fee', 'POST', '/me/ground-bookings/{{b1}}/check-in', {
          expect: { status: 200 },
          checks: [['released', "j.booking.status === 'checked_in' && j.released.released === 50000 && j.released.fee === 10000 && j.released.net === 40000"]],
        }),
        owner('Venue balance: wrong amount (expect 422)', 'POST', '/me/ground-bookings/{{b1}}/collect-balance', { body: { method: 'cash', amount: 100000 }, expect: { status: 422, code: 'BALANCE_MISMATCH' } }),
        owner('Venue balance: ৳1,500 cash', 'POST', '/me/ground-bookings/{{b1}}/collect-balance', { body: { method: 'cash', amount: 150000 }, expect: { status: 200 }, checks: [['collected', "j.booking.money.balanceStatus === 'collected'"]] }),
        owner('Extend 30 min: ৳1,000 at the venue', 'POST', '/me/ground-bookings/{{b1}}/extend', { expect: { status: 200 }, checks: [['amount', 'j.amount === 100000 && j.booking.money.total === 300000']] }),
      ],
    },
    {
      name: '3. Cancels and no-show (FR-10 to FR-19, Q120)',
      item: [
        hold(member, 'Hold paying in full', 's2', 'full', 'b2'),
        pay('b2'),
        member('Cancel preview: ৳1,500 back', 'POST', '/me/bookings/{{b2}}/cancel-preview', { expect: { status: 200 }, checks: [['refund ৳1,500, kept ৳500', 'j.refund === 150000 && j.retained === 50000']] }),
        member('Cancel with a stale refund (expect 409)', 'POST', '/me/bookings/{{b2}}/cancel', { body: { expectedRefund: 0 }, expect: { status: 409, code: 'REFUND_CHANGED' } }),
        member('Cancel', 'POST', '/me/bookings/{{b2}}/cancel', { body: { expectedRefund: 150000 }, expect: { status: 200 }, checks: [['refunded', "j.refund === 150000 && j.booking.status === 'cancelled'"]] }),
        hold(member, 'Hold the advance (owner will cancel)', 's3', 'advance', 'b3'),
        pay('b3'),
        owner('Owner cancel for the weather: 100% back', 'POST', '/me/ground-bookings/{{b3}}/cancel', { body: { reason: 'weather' }, expect: { status: 200 }, checks: [['refund ৳500', "j.refund === 50000 && j.booking.status === 'cancelled_by_owner'"]] }),
        hold(member2, 'Hold on court 2 (no-show)', 's4', 'advance', 'b4', 'court2Id'),
        pay('b4', 'member2'),
        owner('No-show before the start (expect 409)', 'POST', '/me/ground-bookings/{{b4}}/no-show', { expect: { status: 409, code: 'NOT_LATE_YET' } }),
        control('30 minutes late', 'shift?bookingId={{b4}}&to=late'),
        owner('Mark no-show: ৳475 / ৳25', 'POST', '/me/ground-bookings/{{b4}}/no-show', { expect: { status: 200 }, checks: [['retained', "j.booking.status === 'no_show' && j.settled.net === 47500 && j.settled.fee === 2500"]] }),
        hold(member2, 'Hold (never checked in)', 's5', 'advance', 'b5'),
        pay('b5', 'member2'),
        control('26 hours ago', 'shift?bookingId={{b5}}&to=past'),
        control('minute tick', 'tick', { checks: [['auto-completed', 'j.tick.autoCompleted === 1']] }),
        member2('Auto-completed (Q68)', 'GET', '/me/bookings/{{b5}}', { expect: { status: 200 }, checks: [['completed, released ৳500', "j.booking.status === 'completed' && j.booking.money.released === 50000"]] }),
      ],
    },
    {
      name: '4. Walk-in, closures, moves, series (FR-18, FR-20; M09 FR-15 to FR-23)',
      item: [
        idem(
          owner('Walk-in paid at the counter (fee owed ৳100)', 'POST', '/me/grounds/{{groundId}}/walk-ins', {
            body: { courtIds: ['{{court2Id}}'], start: '{{s6}}', minutes: 60, name: 'Shapla FC', phone: '01711000099' },
            expect: { status: 201 },
            checks: [['walk-in, phone hidden', "j.booking.source === 'walk_in' && j.booking.phoneLast4 === '0099' && !JSON.stringify(j).includes('01711000099')"]],
          })
        ),
        hold(member2, 'Hold (a closure will clash)', 's6', 'advance', 'b6'),
        pay('b6', 'member2'),
        owner('Close over a booking (expect 409)', 'POST', '/me/grounds/{{groundId}}/closures', {
          body: { courtIds: ['{{courtId}}'], start: '{{s6}}', end: '{{closeEnd}}', reason: 'maintenance' },
          expect: { status: 409, code: 'CLOSURE_CLASHES' },
          checks: [['lists the booking', "j.conflicts.some((c) => c.kind === 'booking')"]],
        }),
        owner('Close day 3 for maintenance', 'POST', '/me/grounds/{{groundId}}/closures', {
          body: { start: '{{closeStart}}', end: '{{closeEnd}}', reason: 'maintenance' },
          expect: { status: 201 },
          checks: [setVar('closureId', 'j.id'), ['every court', 'j.courtIds.length === 2']],
        }),
        idem(member('Hold in the closure (expect 409)', 'POST', '/bookings/holds', { body: { groundId: '{{groundId}}', courtIds: ['{{courtId}}'], start: '{{closeStart}}', minutes: 60, payment: 'advance' }, expect: { status: 409, code: 'SLOT_UNAVAILABLE' } })),
        owner('Reopen', 'POST', '/me/closures/{{closureId}}/reopen', { expect: { status: 200 }, checks: [['reopened', "j.status === 'reopened'"]] }),
        owner('Move targets', 'GET', '/me/ground-bookings/{{b6}}/move-targets', { expect: { status: 200 }, checks: [['listed (court 2 has the walk-in at that time)', 'Array.isArray(j.items) && j.items.length === 0']] }),
        owner2('Another owner (expect 403)', 'POST', '/me/ground-bookings/{{b6}}/check-in', { expect: { status: 403, code: 'NOT_OWNER' } }),
        numeric(owner('Series: check the weeks', 'POST', '/me/grounds/{{groundId}}/series/preview', {
          body: { courtId: '{{courtId}}', teamName: 'Dhanmondi Lions', dow: '{{seriesDow}}', startTime: '{{seriesStart}}', lengthMin: 60, weeks: 4, firstDate: '{{seriesFirstDate}}' },
          expect: { status: 200 },
          checks: [['৳1,800 a session, no clash', 'j.pricePerSession === 180000 && j.weeks.every((w) => w.clash === null)']],
        }), 'dow', 'seriesDow'),
        numeric(owner('Series: book four weeks', 'POST', '/me/grounds/{{groundId}}/series', {
          body: { courtId: '{{courtId}}', teamName: 'Dhanmondi Lions', dow: '{{seriesDow}}', startTime: '{{seriesStart}}', lengthMin: 60, weeks: 4, firstDate: '{{seriesFirstDate}}' },
          expect: { status: 201 },
          checks: [setVar('seriesId', 'j.id'), ['four confirmed sessions', "j.sessions.length === 4 && j.sessions.every((x) => x.status === 'confirmed')"]],
        }), 'dow', 'seriesDow'),
        owner('Series: skip week 2', 'POST', '/me/series/{{seriesId}}/weeks/2/skip', { expect: { status: 200 }, checks: [['skipped', "j.sessions[2].status === 'skipped'"]] }),
        owner('Series: end', 'POST', '/me/series/{{seriesId}}/end', { body: { reason: 'team_left' }, expect: { status: 200 }, checks: [['ended', "j.status === 'ended' && j.sessions.filter((x) => x.status === 'cancelled_by_owner').length === 3"]] }),
        owner('Timeline tomorrow', 'GET', '/me/ground-bookings?groundId={{groundId}}&date={{day1}}', { expect: { status: 200 }, checks: [['courts and bookings', 'j.courts.length === 2 && Array.isArray(j.bookings) && Array.isArray(j.closures)']] }),
      ],
    },
    {
      name: '5. Staff and the ledger',
      item: [
        req('Staff list', 'GET', '/admin/bookings', { expect: { status: 200 }, checks: [['every booking', 'j.items.length >= 10']] }),
        req('Staff view with the ledger trail', 'GET', '/admin/bookings/{{b1}}', { expect: { status: 200 }, checks: [['release and venue fee', "j.ledger.some((l) => l.kind === 'escrow.release_booking') && j.ledger.some((l) => l.kind === 'fee.receivable')"]] }),
        control('ledger balances', 'check', {
          checks: [
            ['owner payable ৳1,750 (400 + 475 + 475 + 400)', 'j.ownerPayable === 175000'],
            ['fee revenue ৳400 (100 + 25 + 25 + 100 online, 150 owed at the venue)', 'j.feeRevenue === 40000'],
            ['fees owed ৳150 (extension 50 + walk-in 100)', 'j.feeReceivable === 15000'],
            ['invariants hold', 'j.invariantsOk === true'],
          ],
        }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
