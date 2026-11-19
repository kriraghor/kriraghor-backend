'use strict';

/**
 * Builds postman/kriraghor-gym.postman_collection.json (M20 Gym step 1: a gym reviewed on the
 * Moderation desk, passes into escrow with a QR and backup code, the front desk, cancel and expiry
 * (Q110), a trainer's monthly plan and subscription, the staff desk). node postman/build-collection-m20.js
 *
 * Variables: adminAccessToken (master A), listingsToken (staff, approve_listings), modToken (staff,
 * manage_users), ownerToken (an active gym owner), trainerToken / trainerProfileId (a live fitness
 * trainer), m1Token (a member), areaBanani, today / tomorrow / in2 (Dhaka dates), stepUpA and stepUpB (escrow.manage),
 * controlUrl (the runner: /settle, /pay, /tick, /check).
 * Unattended: `node postman/run-m20.js` (kriraghor_test database; fixtures in postman/fixtures).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-gym.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('ownerToken');
const trainer = as('trainerToken');
const m1 = as('m1Token');
const listings = as('listingsToken');
const mod = as('modToken');
const idem = (item) => {
  item.request.header.push({ key: 'Idempotency-Key', value: 'pm-{{$guid}}' });
  return item;
};
const upload = (name, p, file, mime, opts) => {
  const r = owner(name, 'POST', p, opts);
  r.request.header.push({ key: 'Content-Type', value: mime });
  r.request.body = { mode: 'file', file: { src: file } };
  return r;
};
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  const [p, qs] = step.split('?');
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [p], ...(qs ? { query: qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, openTime: '00:00', closeTime: '24:00', womenOnly: false }));
const HOURS = [...ALL_DAY.filter((x) => x.dow !== 5), { dow: 5, openTime: '00:00', closeTime: '10:00', womenOnly: false }, { dow: 5, openTime: '10:00', closeTime: '24:00', womenOnly: false }];
const IRON_YARD = [
  { kind: 'month', title: 'Monthly', price: 450000 },
  { kind: 'quarter', title: 'Quarterly', price: 1200000 },
];
const GYM_RUBRIC = ['photos_real', 'address_matches', 'hours_sensible', 'packages_clear', 'no_contact_details'];

const collection = {
  info: {
    name: 'Kriraghor API: M20 Gym (step 1)',
    description: [
      'An approved gym owner (gym_owner role, ground-owner documents; set up by the runner) lists Iron Yard Banani: three photos, the week (open all day; Friday in two windows) and the design packages (day ৳400, month ৳4,500, quarter ৳12,000). Sending it incomplete is refused with the missing parts; the listings desk sees the five automatic checks pass and approves it (M05 kind gym). The public page and list show it.',
      'A member buys a monthly package from today (Idempotency-Key, M06 purpose gym_package) and pays through the simulator: the pass shows its QR token and 6-character backup code to the holder only. The front desk refuses a tampered token, admits the pass by token (৳4,275 to the owner, ৳225 fee) and then says "already used" for the day. A pass not yet used is cancelled for a full refund; a used one cannot be. An unused pass is paid to the gym after its last day (Q110). Day passes sold before 2 Nov 2026 are covered in tests/e2e/gym.test.js.',
      'A fitness trainer adds a monthly plan (a price under the limit is refused) and a member subscribes and pays; cancelling within the first 3 days refunds the month in full.',
      'Staff: the pass with its escrow hold (no token or code), a master\'s platform cancel with step-up escrow.manage, one gym\'s working copy, suspend (manage_users) and restore (master).',
      'Requests named "Runner" go to the local test runner (drain events, pay, run gym.tick at a time, read the ledger).',
      'Unattended: `node postman/run-m20.js` (kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m20.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'controlUrl', 'gymId', 'slug', 'submissionId', 'monthPkg', 'quarterPkg', 'passId', 'passCode', 'passToken', 'backupCode', 'payment1', 'pass2', 'payment2', 'pass3', 'pass3code', 'payment3', 'pass4', 'payment4', 'pass4code', 'planId', 'subId', 'subPayment', 'gymName', 'ownerId'].map((key) => ({
    key,
    value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '',
  })),
  item: [
    {
      name: '1. A gym and its review (FR-01, FR-02)',
      item: [
        m1('A member with a verified phone may open gyms (M24 gate run_gym): none yet', 'GET', '/me/gyms', { expect: { status: 200 }, checks: [['none', 'j.items.length === 0']] }),
        owner('A draft in Banani', 'POST', '/me/gyms', { body: { name: 'Iron Yard Banani', areaId: '{{areaBanani}}', addressLine: 'House 9, Road 11, Banani, Dhaka', about: 'Free weights, squat racks and showers.' }, expect: { status: 201 }, save: { gymId: 'id', slug: 'slug' }, checks: [['draft with limits', "j.status === 'draft' && j.limits.minPhotos === 3"]] }),
        owner('Send it incomplete (expect 422)', 'POST', '/me/gyms/{{gymId}}/submit', { expect: { status: 422, code: 'GYM_INCOMPLETE' }, checks: [['photos, hours, packages missing', "j.errors.map((e) => e.field).join() === 'photos,hours,packages'"]] }),
        upload('Photo 1 (JPEG)', '/me/gyms/{{gymId}}/photos', 'nid-front.jpg', 'image/jpeg', { expect: { status: 201 } }),
        upload('Photo 2 (PNG)', '/me/gyms/{{gymId}}/photos', 'nid-back.png', 'image/png', { expect: { status: 201 } }),
        upload('Photo 3 (WebP)', '/me/gyms/{{gymId}}/photos', 'ground.webp', 'image/webp', { expect: { status: 201 } }),
        upload('A GIF is refused (expect 415)', '/me/gyms/{{gymId}}/photos', 'not-allowed.gif', 'image/gif', { expect: { status: 415 } }),
        owner('Hours that close before they open (expect 422)', 'PUT', '/me/gyms/{{gymId}}/hours', { body: { hours: [{ dow: 1, openTime: '06:00', closeTime: '05:00' }] }, expect: { status: 422 } }),
        owner('The week (Friday in two windows)', 'PUT', '/me/gyms/{{gymId}}/hours', { body: { hours: HOURS }, expect: { status: 200 }, checks: [['8 windows', 'j.hours.length === 8']] }),
        owner('A day pass is refused (expect 422)', 'PUT', '/me/gyms/{{gymId}}/packages', { body: { packages: [{ kind: 'day', title: 'Day', price: 40000 }] }, expect: { status: 422 } }),
        owner('Only at the desk: saved', 'PUT', '/me/gyms/{{gymId}}/packages', { body: { packages: [{ kind: 'month', title: 'Monthly', price: 450000, channel: 'desk' }] }, expect: { status: 200 } }),
        owner('Only at the desk: cannot be sent (expect 422)', 'POST', '/me/gyms/{{gymId}}/submit', { expect: { status: 422, code: 'GYM_INCOMPLETE' }, checks: [['a package sold online', "j.errors.some((e) => e.field === 'packages')"]] }),
        owner('The design packages', 'PUT', '/me/gyms/{{gymId}}/packages', { body: { packages: IRON_YARD }, expect: { status: 200 }, checks: [['two, month first', "j.packages.length === 2 && j.packages[0].kind === 'month'"]] }),
        owner('Send for review', 'POST', '/me/gyms/{{gymId}}/submit', { expect: { status: 200 } }),
        control('drain events', 'settle'),
        listings('The gym on the desk', 'GET', '/admin/submissions?status=pending_review&kind=gym', { expect: { status: 200 }, checks: [setVar('submissionId', 'j.items[0].id')] }),
        listings('Claim: the five checks pass', 'POST', '/admin/submissions/{{submissionId}}/claim', { expect: { status: 200 }, checks: [['five, all pass', "j.checks.length === 5 && j.checks.every((c) => c.result === 'pass')"]] }),
        listings('Tick the rubric', 'PUT', '/admin/submissions/{{submissionId}}/ticks', { body: { ticks: GYM_RUBRIC }, expect: { status: 200 } }),
        idem(listings('Approve', 'POST', '/admin/submissions/{{submissionId}}/decide', { body: { decision: 'approve' }, expect: { status: 200 } })),
        control('deliver the decision', 'settle'),
        req('The public page', 'GET', '/gym/gyms/{{slug}}', { as: false, expect: { status: 200 }, save: { monthPkg: 'packages.0.id', quarterPkg: 'packages.1.id' }, checks: [['prices and photos', 'j.monthPrice === 450000 && j.quarterPrice === 1200000 && j.photos.length === 3 && j.taking === true']] }),
        req('The gym list', 'GET', '/gym/gyms?sort=price', { as: false, expect: { status: 200 }, checks: [['listed, open now', "j.items.length === 1 && j.items[0].openNow === true"]] }),
      ],
    },
    {
      name: '2. A monthly package and the front desk (FR-03 to FR-05)',
      item: [
        idem(m1('Too far ahead (expect 422)', 'POST', '/gym/passes', { body: { packageId: '{{monthPkg}}', validFrom: '{{in9}}' }, expect: { status: 422, code: 'DATE_OUT_OF_RANGE' } })),
        idem(m1('Buy a month from today', 'POST', '/gym/passes', { body: { packageId: '{{monthPkg}}', validFrom: '{{today}}' }, expect: { status: 201 }, save: { passId: 'pass.id', passCode: 'pass.code', payment1: 'payment.id' }, checks: [['waiting, no secrets yet', "j.pass.status === 'pending_payment' && j.pass.token === null && j.pass.backupCode === null && j.pass.money.price === 450000"]] })),
        control('pay through the simulator', 'pay?paymentId={{payment1}}'),
        m1('The pass with its QR token and code', 'GET', '/me/passes/{{passCode}}', { expect: { status: 200 }, save: { passToken: 'pass.token', backupCode: 'pass.backupCode' }, checks: [['active', "j.pass.status === 'active' && /^v1\\./.test(j.pass.token) && /^[0-9A-HJKMNP-TV-Z]{6}$/.test(j.pass.backupCode)"]] }),
        owner('A tampered token (expect 422)', 'POST', '/me/gyms/{{gymId}}/redemptions', { body: { token: 'v1.00000000-0000-0000-0000-000000000000.abcdefgh.00000000000000000000000000000000' }, expect: { status: 422, code: 'INVALID_PASS_TOKEN' } }),
        owner('Admit by token', 'POST', '/me/gyms/{{gymId}}/redemptions', { body: { token: '{{passToken}}' }, expect: { status: 201 }, checks: [['admitted, ৳4,275 released', "j.status === 'active' && j.released === 427500 && j.holder.displayName === 'Fahim Rahman'"]] }),
        owner('A second scan today: already used (expect 409)', 'POST', '/me/gyms/{{gymId}}/redemptions', { body: { token: '{{passToken}}' }, expect: { status: 409, code: 'PASS_ALREADY_REDEEMED' } }),
        owner("Today's admissions", 'GET', '/me/gyms/{{gymId}}/redemptions', { expect: { status: 200 }, checks: [['one, by QR', "j.items.length === 1 && j.items[0].method === 'qr'"]] }),
        control('ledger: owner ৳4,275, fee ৳225', 'check', { checks: [['balanced', 'j.invariantsOk === true'], ['payable', 'j.ownerPayable === 427500 && j.feeRevenue === 22500']] }),
        m1('Still active for the rest of the month', 'GET', '/me/passes/{{passCode}}', { expect: { status: 200 }, checks: [['active, used once', "j.pass.status === 'active' && j.pass.firstRedeemedAt !== null && /^v1\\./.test(j.pass.token)"]] }),
      ],
    },
    {
      name: '3. Cancel and expiry (FR-06, FR-07, Q110)',
      item: [
        idem(m1('A month from tomorrow', 'POST', '/gym/passes', { body: { packageId: '{{monthPkg}}', validFrom: '{{tomorrow}}' }, expect: { status: 201 }, save: { pass2: 'pass.id', payment2: 'payment.id' } })),
        control('pay it', 'pay?paymentId={{payment2}}'),
        m1('Cancel before its first use: full refund', 'POST', '/me/passes/{{pass2}}/cancel', { expect: { status: 200 }, checks: [['refunded ৳4,500', "j.pass.status === 'refunded' && j.pass.money.refunded === 450000"]] }),
        m1('Cancel after its first use (expect 409)', 'POST', '/me/passes/{{passId}}/cancel', { expect: { status: 409, code: 'PASS_NOT_REFUNDABLE' } }),
        idem(m1('Another month, never used', 'POST', '/gym/passes', { body: { packageId: '{{monthPkg}}', validFrom: '{{today}}' }, expect: { status: 201 }, save: { pass3: 'pass.id', pass3code: 'pass.code', payment3: 'payment.id' } })),
        control('pay it', 'pay?paymentId={{payment3}}'),
        control('gym.tick after the last day', 'tick?date={{in31}}&minutes=1', { checks: [['both months expired', 'j.tick.expired === 2']] }),
        m1('The unused pass expired', 'GET', '/me/passes/{{pass3code}}', { expect: { status: 200 }, checks: [['expired', "j.pass.status === 'expired' && j.pass.closeReason === 'unused'"]] }),
        control('ledger: the gym kept it minus the fee', 'check', { checks: [['payable ৳8,550', 'j.ownerPayable === 855000 && j.feeRevenue === 45000']] }),
      ],
    },
    {
      name: "4. A trainer's monthly plan (v3)",
      item: [
        trainer('A price under the limit (expect 422)', 'POST', '/pro/trainer-plans', { body: { profileId: '{{trainerProfileId}}', title: 'Strength 12', price: 50000, whereKind: 'online' }, expect: { status: 422 } }),
        trainer('Strength 12, ৳6,000 a month', 'POST', '/pro/trainer-plans', { body: { profileId: '{{trainerProfileId}}', title: 'Strength 12', sessionsPerMonth: 12, price: 600000, whereKind: 'online' }, expect: { status: 201 }, save: { planId: 'id' } }),
        req('The trainers tab', 'GET', '/gym/trainers', { as: false, expect: { status: 200 }, checks: [['from ৳6,000', "j.items[0].planFrom === 600000 && j.items[0].plans === 1"]] }),
        req('The plans with the start window', 'GET', '/gym/trainers/{{trainerProfileId}}/plans', { as: false, expect: { status: 200 }, checks: [['window', 'j.items.length === 1 && j.startDays === 14 && j.cancelDays === 3']] }),
        idem(m1('Subscribe from today', 'POST', '/gym/subscriptions', { body: { planId: '{{planId}}', startDate: '{{today}}' }, expect: { status: 201 }, save: { subId: 'id', subPayment: 'payment.id' } })),
        control('pay the first month', 'pay?paymentId={{subPayment}}'),
        m1('Active; a cancel now refunds', 'GET', '/me/subscriptions/{{subId}}', { expect: { status: 200 }, checks: [['active', "j.status === 'active' && j.current.seq === 1 && j.current.status === 'paid' && j.can.refundOnCancel === true"]] }),
        trainer('The trainer sees the subscriber', 'GET', '/pro/subscriptions', { expect: { status: 200 }, checks: [['one', "j.items.length === 1 && j.items[0].role === 'trainer'"]] }),
        m1('Cancel in the first 3 days', 'POST', '/me/subscriptions/{{subId}}/cancel', { expect: { status: 200 }, checks: [['cancelled; the refunded month is no longer current', "j.status === 'cancelled' && j.renew === false && j.current === null && j.can.pay === false"]] }),
      ],
    },
    {
      name: '5. Staff (FR-10)',
      item: [
        idem(m1('A pass for tomorrow', 'POST', '/gym/passes', { body: { packageId: '{{monthPkg}}', validFrom: '{{tomorrow}}' }, expect: { status: 201 }, save: { pass4: 'pass.id', pass4code: 'pass.code', payment4: 'payment.id' } })),
        control('pay it', 'pay?paymentId={{payment4}}'),
        listings('Staff: the pass with its hold, no secrets', 'GET', '/admin/gym/passes/{{pass4code}}', { expect: { status: 200 }, checks: [['held ৳4,500', "j.escrow.held === 450000 && j.token === null && j.backupCode === null"]] }),
        listings('A reviewer cannot cancel it (expect 403)', 'POST', '/admin/gym/passes/{{pass4code}}/cancel', { body: { reason: 'The gym closed for repairs' }, expect: { status: 403 } }),
        (() => {
          const r = req('Master: platform cancel (step-up)', 'POST', '/admin/gym/passes/{{pass4code}}/cancel', { body: { reason: 'The gym closed for repairs' }, expect: { status: 200 }, checks: [['refunded', "j.status === 'refunded' && j.money.refunded === 450000"]] });
          r.request.header.push({ key: 'X-Step-Up', value: '{{stepUpA}}' });
          return r;
        })(),
        listings('Staff: the gym working copy', 'GET', '/admin/gym/gyms/{{gymId}}', { expect: { status: 200 }, checks: [['live, owner', "j.status === 'live' && typeof j.ownerId === 'string' && j.packages.length === 2"]] }),
        mod('Suspend the gym', 'POST', '/admin/gym/gyms/{{gymId}}/suspend', { body: { reason: 'Fake photos reported' }, expect: { status: 200 }, checks: [['suspended', "j.status === 'suspended'"]] }),
        idem(m1('Buying now (expect 409)', 'POST', '/gym/passes', { body: { packageId: '{{monthPkg}}', validFrom: '{{tomorrow}}' }, expect: { status: 409, code: 'GYM_NOT_AVAILABLE' } })),
        req('The public page is gone (expect 404)', 'GET', '/gym/gyms/{{slug}}', { as: false, expect: { status: 404 } }),
        req('Master: restore', 'POST', '/admin/gym/gyms/{{gymId}}/restore', { body: { reason: 'Photos checked on site' }, expect: { status: 200 }, checks: [['live', "j.status === 'live'"]] }),
        control('ledger still balanced', 'check', { checks: [['balanced', 'j.invariantsOk === true']] }),
      ],
    },
    {
      name: '6. Suspension is a total freeze (M20-FR-10a, FR-10b; tester feedback, 19 Nov 2026)',
      item: [
        listings('The owner of the gym', 'GET', '/admin/gym/gyms/{{gymId}}', { expect: { status: 200 }, save: { ownerId: 'ownerId' } }),
        mod('Suspend this gym only', 'POST', '/admin/gym/gyms/{{gymId}}/suspend', { body: { reason: 'Fees taken in cash off the books' }, expect: { status: 200 }, checks: [['suspended by Kriraghor', "j.status === 'suspended' && j.suspendCause === 'staff'"]] }),
        owner('The owner can still look', 'GET', '/me/gyms/{{gymId}}', { expect: { status: 200 }, checks: [['suspended', "j.status === 'suspended'"]] }),
        owner('Any change is refused (expect 423)', 'PATCH', '/manage/gyms/{{gymId}}/settings', { body: { shortCode: 'IY' }, expect: { status: 423, code: 'GYM_SUSPENDED' } }),
        req('The public page is gone (expect 404)', 'GET', '/gym/gyms/{{slug}}', { as: false, expect: { status: 404 } }),
        req('Master: restore', 'POST', '/admin/gym/gyms/{{gymId}}/restore', { body: { reason: 'Books checked' }, expect: { status: 200 }, checks: [['live again', "j.status === 'live' && j.suspendCause === null"]] }),
        mod("Suspend the owner's account", 'POST', '/admin/users/{{ownerId}}/suspend', { body: { reasonCode: 'policy_breach', note: 'Fees taken in cash off the books again' }, expect: { status: 200 }, checks: [['signed out', "j.status === 'suspended' && j.sessionsRevoked >= 0"]] }),
        control('deliver user.suspended', 'settle'),
        listings('Every gym of the owner is suspended with the account', 'GET', '/admin/gym/gyms/{{gymId}}', { expect: { status: 200 }, checks: [['owner_account', "j.status === 'suspended' && j.suspendCause === 'owner_account'"]] }),
        req('The gym alone cannot be restored (expect 409)', 'POST', '/admin/gym/gyms/{{gymId}}/restore', { body: { reason: 'Too early' }, expect: { status: 409, code: 'GYM_OWNER_SUSPENDED' } }),
        owner('The owner is signed out (expect 401)', 'GET', '/me/gyms', { expect: { status: 401 } }),
        mod("Restore the owner's account", 'POST', '/admin/users/{{ownerId}}/restore', { body: { note: 'Agreed to take fees through Kriraghor' }, expect: { status: 200 } }),
        control('deliver user.restored', 'settle'),
        listings('The gym is back where it was', 'GET', '/admin/gym/gyms/{{gymId}}', { expect: { status: 200 }, checks: [['live', "j.status === 'live' && j.suspendCause === null"]] }),
        control('the owner signs in again', 'signin', { checks: [['token', "(pm.environment.set('ownerToken', j.accessToken), typeof j.accessToken === 'string')"]] }),
        owner('Signed in', 'GET', '/me/gyms', { expect: { status: 200 }, checks: [['one gym', 'j.items.length === 1']] }),
      ],
    },
    {
      name: '7. Removing a gym (tester feedback, 19 Nov 2026)',
      item: [
        owner('The gym, for its name', 'GET', '/me/gyms/{{gymId}}', { expect: { status: 200 }, save: { gymName: 'name' } }),
        mod('Suspend it again', 'POST', '/admin/gym/gyms/{{gymId}}/suspend', { body: { reason: 'Owner asked to close' }, expect: { status: 200 } }),
        owner('The owner cannot remove a suspended gym (expect 409)', 'POST', '/me/gyms/{{gymId}}/remove', { body: { confirmName: '{{gymName}}' }, expect: { status: 409, code: 'GYM_STATE' } }),
        listings('Staff who are not masters cannot (expect 403)', 'POST', '/admin/gym/gyms/{{gymId}}/remove', { body: { reason: 'Closed for good' }, expect: { status: 403 } }),
        req('Master without step-up (expect 403)', 'POST', '/admin/gym/gyms/{{gymId}}/remove', { body: { reason: 'Closed for good' }, expect: { status: 403, code: 'STEP_UP_REQUIRED' } }),
        (() => {
          const r = req('Master: remove (step-up)', 'POST', '/admin/gym/gyms/{{gymId}}/remove', { body: { reason: 'Closed for good' }, expect: { status: 200 }, checks: [['removed, the lists returned', "j.status === 'removed' && Array.isArray(j.refunded) && Array.isArray(j.paidToGym)"]] });
          r.request.header.push({ key: 'X-Step-Up', value: '{{stepUpB}}' });
          return r;
        })(),
        req('The public page is gone (expect 404)', 'GET', '/gym/gyms/{{slug}}', { as: false, expect: { status: 404 } }),
        control('ledger still balanced', 'check', { checks: [['balanced', 'j.invariantsOk === true']] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
