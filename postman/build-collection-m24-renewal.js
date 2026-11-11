'use strict';

/**
 * Builds postman/kriraghor-gym-renewal.postman_collection.json ("M24 · A member renews by themselves, and
 * body progress", product owner, 11 Nov 2026; M24-FR-121..133): the renewal read with its packages, dates
 * and price; renewing for the counter (the gym is told) and taking it back; renewing online through the
 * simulator; the refusals (too early, switched off by the gym, a renewal already waiting, a desk-only
 * package, someone else's membership); body entries by the member and by the gym, the replacement of a
 * day's entry, the progress numbers, who may read and remove, and the plan tier.
 * node postman/build-collection-m24-renewal.js
 *
 * Variables (set by the runner, postman/run-m24-renewal.js): ownerToken (a Standard gym that takes fees
 * online), gymId, deskToken (members.view, fees.collect), coachToken (plans.manage, members.view),
 * rafiToken + rafiMember (linked, Monthly ending in 9 days), limaToken + limaMember (linked, Monthly started
 * today), otherToken (a signed-in stranger), basicOwnerToken + basicGymId + basicToken + basicMember (a Basic
 * gym with a linked member), monthPkg, quarterPkg, deskPkg, today, in10, in39, in15, tomorrow, back60,
 * back400, controlUrl (the runner: /drain, /pay?paymentId=). Unattended: `node postman/run-m24-renewal.js`.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-gym-renewal.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('ownerToken');
const desk = as('deskToken');
const coach = as('coachToken');
const rafi = as('rafiToken');
const lima = as('limaToken');
const other = as('otherToken');
const basicOwner = as('basicOwnerToken');
const basic = as('basicToken');
const idem = (item, value = 'rn-{{$guid}}') => {
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
const R = '/me/gym-memberships/{{rafiMember}}';
const L = '/me/gym-memberships/{{limaMember}}';
const B = '/me/gym-memberships/{{basicMember}}';
const v = (name) => `pm.variables.get('${name}')`;

const collection = {
  info: {
    name: 'Kriraghor API: M24 · A member renews by themselves, and body progress',
    description: [
      'A member renews by themselves (product owner, 11 Nov 2026): a linked member renews their own membership from `gym_manage.self_renew_days_before` (14) days before the end, with their current package or one the gym sells online, at the package price (no admission fee, no discount). They pay online (the M06 payment to open comes back) or at the counter (the fee waits as an unpaid due and the gym is told). Each gym can switch member renewals off. A member can take back a renewal they made while it has not started and nothing is paid on it.',
      'Body progress: weight, body fat and five measurements over time, recorded by the member or by the owner and the plan writers. One live entry per member and date (a second one replaces the first, which is kept as void). Seen only by the member, the owner and staff with plans.manage. Plan feature `progress` (Standard and up).',
      'Requests named "Runner" go to the local test runner (delivering events, paying a payment through the simulator).',
      'Unattended: `node postman/run-m24-renewal.js`. Rebuild this file with: node postman/build-collection-m24-renewal.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'ownerToken', 'deskToken', 'coachToken', 'rafiToken', 'rafiMember', 'limaToken', 'limaMember', 'otherToken', 'basicOwnerToken', 'basicGymId', 'basicToken', 'basicMember',
    'gymId', 'monthPkg', 'quarterPkg', 'deskPkg', 'today', 'tomorrow', 'in10', 'in15', 'in39', 'back60', 'back400', 'renewalId', 'renewalDue', 'paymentId', 'entryMine', 'entryCoach',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. The read and renewing for the counter (M24-FR-121 to FR-124, FR-126)',
      item: [
        rafi('Can I renew: nine days left, so yes', 'GET', `${R}/renewal`, {
          expect: { status: 200 },
          checks: [
            ['open, online fees on', 'j.can === true && j.reason === null && j.daysBefore === 14 && j.renewal === null && j.onlineFees === true'],
            ['Monthly (current) and Quarterly; the desk-only package is not offered', "j.packages.length === 2 && j.packages[0].current === true && j.packages[0].pricePoisha === 250000 && j.packages[1].title === 'Quarterly'"],
            ['the dates continue from the old end', `j.packages[0].startsOn === ${v('in10')} && j.packages[0].endsOn === ${v('in39')}`],
          ],
        }),
        rafi('No Idempotency-Key (expect 400)', 'POST', `${R}/renew`, { body: { pay: 'counter' }, expect: { status: 400 } }),
        idem(rafi('An unknown way to pay (expect 422)', 'POST', `${R}/renew`, { body: { pay: 'cash' }, expect: { status: 422, code: 'VALIDATION_FAILED' } })),
        idem(rafi('The desk-only package (expect 422)', 'POST', `${R}/renew`, { body: { pay: 'counter', packageId: '{{deskPkg}}' }, expect: { status: 422, code: 'GYM_PACKAGE_UNAVAILABLE' } })),
        idem(other('Someone else (expect 404)', 'POST', `${R}/renew`, { body: { pay: 'counter' }, expect: { status: 404 } })),
        idem(
          rafi('Renew, pay at the counter', 'POST', `${R}/renew`, {
            body: { pay: 'counter' },
            expect: { status: 201 },
            save: { renewalId: 'membership.id', renewalDue: 'due.dueId' },
            checks: [
              ['made by the member, upcoming, no admission fee', "j.membership.origin === 'renewal' && j.membership.createdVia === 'member' && j.membership.status === 'upcoming' && j.membership.admissionFeePoisha === 0"],
              ['the fee waits as an unpaid due', "j.due.amountPoisha === 250000 && j.due.status === 'unpaid' && j.payment === null"],
            ],
          }),
          'rn-counter-1'
        ),
        idem(rafi('The same key replays the same answer', 'POST', `${R}/renew`, { body: { pay: 'counter' }, expect: { status: 201 }, checks: [['the same membership', `j.membership.id === ${v('renewalId')}`]] }), 'rn-counter-1'),
        idem(rafi('A second renewal (expect 409)', 'POST', `${R}/renew`, { body: { pay: 'counter' }, expect: { status: 409, code: 'GYM_RENEWAL_EXISTS' } })),
        control('deliver the events', 'drain'),
        owner('The owner is told', 'GET', '/me/notifications?limit=50', { expect: { status: 200 }, checks: [['GYM_RENEWAL_BY_MEMBER', "JSON.stringify(j).includes('GYM_RENEWAL_BY_MEMBER')"]] }),
        desk('Staff who take fees are told', 'GET', '/me/notifications?limit=50', { expect: { status: 200 }, checks: [['GYM_RENEWAL_BY_MEMBER', "JSON.stringify(j).includes('GYM_RENEWAL_BY_MEMBER')"]] }),
        owner('The desk sees who made it', 'GET', `${G}/members/{{rafiMember}}`, { expect: { status: 200 }, checks: [['created by the member', "pm.response.text().includes('\"createdVia\":\"member\"')"]] }),
      ],
    },
    {
      name: '2. Taking a renewal back (M24-FR-125)',
      item: [
        rafi('The read shows the waiting renewal', 'GET', `${R}/renewal`, {
          expect: { status: 200 },
          checks: [['waiting, to pay ৳2,500, can be cancelled', "j.can === false && j.reason === 'GYM_RENEWAL_EXISTS' && j.renewal.outstandingPoisha === 250000 && j.renewal.cancellable === true && j.packages.length === 0"]],
        }),
        other('Someone else cannot cancel it (expect 404)', 'POST', `${R}/renewal/cancel`, { expect: { status: 404 } }),
        rafi('Cancel my renewal', 'POST', `${R}/renewal/cancel`, { expect: { status: 200 }, checks: [['back to renewable', 'j.can === true && j.renewal === null']] }),
        rafi('Nothing left to cancel (expect 409)', 'POST', `${R}/renewal/cancel`, { expect: { status: 409, code: 'GYM_NOTHING_TO_RENEW' } }),
        owner('The cancelled renewal is kept, its fee void', 'GET', `${G}/members/{{rafiMember}}`, { expect: { status: 200 }, checks: [['cancelled and void', "pm.response.text().includes('\"status\":\"cancelled\"') && pm.response.text().includes('\"status\":\"void\"')"]] }),
      ],
    },
    {
      name: '3. Renewing online (M24-FR-123)',
      item: [
        idem(
          rafi('Renew Quarterly, pay online', 'POST', `${R}/renew`, {
            body: { pay: 'online', packageId: '{{quarterPkg}}' },
            expect: { status: 201 },
            save: { renewalId: 'membership.id', renewalDue: 'due.dueId', paymentId: 'payment.paymentId' },
            checks: [['the payment to open comes back', "j.membership.title === 'Quarterly' && j.payment.amountPoisha === 650000 && j.payment.payUrl.includes(j.payment.paymentId)"]],
          })
        ),
        rafi('Until it is paid the fee is with my dues', 'GET', '/me/gym-dues', { expect: { status: 200 }, checks: [['outstanding ৳6,500, payable online', `(() => { const d = j.items.find((x) => x.dueId === ${v('renewalDue')}); return d.outstandingPoisha === 650000 && d.onlineFees === true; })()`]] }),
        control('pay it through the simulator', 'pay?paymentId={{paymentId}}'),
        rafi('Paid: it can no longer be cancelled', 'GET', `${R}/renewal`, { expect: { status: 200 }, checks: [['nothing outstanding', 'j.renewal.outstandingPoisha === 0 && j.renewal.cancellable === false']] }),
        rafi('Cancelling a paid renewal (expect 409)', 'POST', `${R}/renewal/cancel`, { expect: { status: 409, code: 'GYM_MEMBERSHIP_STATE' }, checks: [['because it is paid', "j.reason === 'paid'"]] }),
      ],
    },
    {
      name: '4. Too early, and the gym’s switch (M24-FR-121, FR-122)',
      item: [
        lima('Lima started today: too early', 'GET', `${L}/renewal`, { expect: { status: 200 }, checks: [['opens 14 days before the end', `j.can === false && j.reason === 'GYM_RENEW_TOO_EARLY' && j.opensOn === ${v('in15')}`]] }),
        idem(lima('Renewing now (expect 409)', 'POST', `${L}/renew`, { body: { pay: 'counter' }, expect: { status: 409, code: 'GYM_RENEW_TOO_EARLY' } })),
        owner('Settings: member renewals are on by default', 'GET', `${G}/settings`, { expect: { status: 200 }, checks: [['on, 14 days', 'j.selfRenewOpen === true && j.selfRenewDaysBefore === 14']] }),
        desk('Staff cannot change the switch (expect 403)', 'PATCH', `${G}/settings`, { body: { selfRenewOpen: false }, expect: { status: 403 } }),
        owner('The owner switches member renewals off', 'PATCH', `${G}/settings`, { body: { selfRenewOpen: false }, expect: { status: 200 }, checks: [['off', 'j.selfRenewOpen === false']] }),
        lima('The read says the gym takes renewals at the desk', 'GET', `${L}/renewal`, { expect: { status: 200 }, checks: [['switched off', "j.can === false && j.reason === 'GYM_SELF_RENEW_OFF'"]] }),
        idem(lima('Renewing while off (expect 409)', 'POST', `${L}/renew`, { body: { pay: 'counter' }, expect: { status: 409, code: 'GYM_SELF_RENEW_OFF' } })),
        owner('The owner switches it on again', 'PATCH', `${G}/settings`, { body: { selfRenewOpen: true }, expect: { status: 200 } }),
      ],
    },
    {
      name: '5. Body progress: the member (M24-FR-128 to FR-130)',
      item: [
        lima('Nothing yet, with the limits', 'GET', `${L}/body`, {
          expect: { status: 200 },
          checks: [
            ['on and empty', 'j.on === true && j.entries.length === 0 && j.change.weightKg === null'],
            ['the ranges and 365 days back', 'j.limits.backdateDays === 365 && j.limits.fields.weightKg.min === 10 && j.limits.fields.bodyFatPct.max === 70'],
            ['no-store', "pm.response.headers.get('Cache-Control').includes('no-store')"],
          ],
        }),
        lima('No Idempotency-Key (expect 400)', 'POST', `${L}/body`, { body: { weightKg: 60 }, expect: { status: 400 } }),
        idem(lima('An empty entry (expect 422)', 'POST', `${L}/body`, { body: {}, expect: { status: 422, code: 'GYM_BODY_EMPTY' } })),
        idem(lima('A weight of 5 kg (expect 422)', 'POST', `${L}/body`, { body: { weightKg: 5 }, expect: { status: 422, code: 'VALIDATION_FAILED' } })),
        idem(lima('Dated tomorrow (expect 422)', 'POST', `${L}/body`, { body: { weightKg: 60, measuredOn: '{{tomorrow}}' }, expect: { status: 422, code: 'GYM_DATE_OUT_OF_RANGE' } })),
        idem(lima('Dated 400 days back (expect 422)', 'POST', `${L}/body`, { body: { weightKg: 60, measuredOn: '{{back400}}' }, expect: { status: 422, code: 'GYM_DATE_OUT_OF_RANGE' } })),
        idem(lima('Sixty days ago: 64 kg, waist 78.5', 'POST', `${L}/body`, { body: { measuredOn: '{{back60}}', weightKg: 64, waistCm: 78.5 }, expect: { status: 201 }, checks: [['one entry', 'j.entries.length === 1']] })),
        idem(
          lima('Today: 61.8 kg, waist 75, body fat 24.5', 'POST', `${L}/body`, {
            body: { weightKg: 61.8, waistCm: 75, bodyFatPct: 24.5 },
            expect: { status: 201 },
            save: { entryMine: 'entries.1.id' },
            checks: [
              ['two entries, oldest first', `j.entries.length === 2 && j.entries[0].measuredOn === ${v('back60')} && j.entries[1].measuredOn === ${v('today')}`],
              ['down 2.2 kg and 3.5 cm', 'j.change.weightKg.delta === -2.2 && j.change.waistCm.delta === -3.5 && j.change.bodyFatPct === null'],
            ],
          })
        ),
        idem(
          lima('Today again: 61.5 kg replaces the first', 'POST', `${L}/body`, {
            body: { weightKg: 61.5 },
            expect: { status: 201 },
            save: { entryMine: 'entries.1.id' },
            checks: [['still two entries; today has only the new weight', 'j.entries.length === 2 && j.entries[1].weightKg === 61.5 && j.entries[1].waistCm === null && j.change.weightKg.delta === -2.5']],
          })
        ),
        lima('The newest weight is on my health profile', 'GET', `${L}`, { expect: { status: 200 }, checks: [['61.5 kg', 'Number(j.member.health.weightKg) === 61.5']] }),
        other('Someone else reads nothing (expect 404)', 'GET', `${L}/body`, { expect: { status: 404 } }),
      ],
    },
    {
      name: '6. Body progress: the gym, removing, and the plan (M24-FR-131 to FR-133)',
      item: [
        owner('The owner reads the member’s progress', 'GET', `${G}/members/{{limaMember}}/body`, { expect: { status: 200 }, checks: [['two entries', 'j.entries.length === 2']] }),
        desk('Desk staff cannot (expect 403)', 'GET', `${G}/members/{{limaMember}}/body`, { expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        idem(
          coach('The coach records a measurement', 'POST', `${G}/members/{{limaMember}}/body`, {
            body: { measuredOn: '{{back60}}', weightKg: 64.2, armCm: 28 },
            expect: { status: 201 },
            save: { entryCoach: 'entries.0.id' },
            checks: [['recorded by the gym, replacing that day', "j.entries.length === 2 && j.entries[0].byRole === 'staff' && j.entries[0].armCm === 28"]],
          })
        ),
        lima('The member cannot remove what the gym recorded (expect 409)', 'POST', `${L}/body/{{entryCoach}}/void`, { expect: { status: 409, code: 'GYM_BODY_ENTRY_STATE' }, checks: [['recorded by the gym', "j.reason === 'recorded_by_gym'"]] }),
        lima('The member removes their own entry', 'POST', `${L}/body/{{entryMine}}/void`, { expect: { status: 200 }, checks: [['one entry left', 'j.entries.length === 1']] }),
        lima('Removing it again (expect 409)', 'POST', `${L}/body/{{entryMine}}/void`, { expect: { status: 409, code: 'GYM_BODY_ENTRY_STATE' } }),
        desk('Desk staff cannot remove (expect 403)', 'POST', `${G}/members/{{limaMember}}/body/{{entryCoach}}/void`, { expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        owner('The owner removes the coach’s entry', 'POST', `${G}/members/{{limaMember}}/body/{{entryCoach}}/void`, { expect: { status: 200 }, checks: [['none left', 'j.entries.length === 0']] }),
        basic('On a Basic gym the member sees it switched off', 'GET', `${B}/body`, { expect: { status: 200 }, checks: [['off', 'j.on === false && j.entries.length === 0']] }),
        idem(basic('Recording there (expect 403)', 'POST', `${B}/body`, { body: { weightKg: 70 }, expect: { status: 403, code: 'GYM_TIER_REQUIRED' }, checks: [['progress, standard', "j.feature === 'progress' && j.minTier === 'standard'"]] })),
        basicOwner('The Basic owner is asked for Standard (expect 403)', 'GET', '/manage/gyms/{{basicGymId}}/members/{{basicMember}}/body', { expect: { status: 403, code: 'GYM_TIER_REQUIRED' } }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
