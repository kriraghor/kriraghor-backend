'use strict';

/**
 * Builds postman/kriraghor-business-members.postman_collection.json (Round B3: staff accounts for
 * businesses; Q69, Q168, Q169, Q170).
 * node postman/build-collection-b3.js
 *
 * Variables (set by the runner, postman/run-b3.js): adminAccessToken (master A) and masterPhone;
 * ownerToken / ownerId / groundId / courtId / court2Id (a venue owner with a two-court fixture ground,
 * ৳2,000/h flat, 25% advance) and owner2Token / ground2Id (another owner); memberToken (books);
 * deskPhone, nonePhone, otherPhone, packerPhone, frontdeskPhone (members with verified phones who
 * become staff) and unverifiedPhone; shopOwnerToken, shopId, subOrderId, subOrder2Id, variantId (a
 * live shop with two placed orders); gymOwnerToken, gymId, passToken (a live gym and a paid monthly package);
 * s1, s2 (tomorrow's slots). Staff tokens come from the runner's /refresh step (their access changed).
 * controlUrl (the runner): /refresh?who=, /pay?paymentId=, /shift?bookingId=, /drain, /fill-team-adds?who=.
 * Unattended: `node postman/run-b3.js`.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-business-members.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('ownerToken');
const owner2 = as('owner2Token');
const member = as('memberToken');
const desk = as('deskToken');
const none = as('noneToken');
const other = as('otherToken');
const shopOwner = as('shopOwnerToken');
const packer = as('packerToken');
const gymOwner = as('gymOwnerToken');
const frontdesk = as('frontdeskToken');
const admin = (name, method, p, opts = {}) => req(name, method, p, { ...opts, as: 'A' });

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
// Saved as collection variables; tokens the runner passes as environment values get a new name (environment wins).
const refresh = (who, saveAs = `${who}Token`) => control(`refresh ${who}'s session`, `refresh?who=${who}`, { save: { [saveAs]: 'accessToken' } });
const ownerFresh = as('ownerFreshToken');
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
/** Staff answers never carry money keys or full phone numbers. */
const MONEY = /"(fee|feeBps|commission|commissionBps|net|released|retained|stockValuePoisha|settlement|payoutsHref)"\s*:/.source;
const noMoney = ['no fee, net, released or retained amounts', `!new RegExp(${JSON.stringify(MONEY)}).test(pm.response.text())`];
const noPhone = ['no full phone numbers', '!/(\\+?880|"0)1[3-9]\\d{8}/.test(pm.response.text())'];
const code = (status, c) => ({ status, code: c });
const VENUE_DEFAULTS = ['bookings.check_in', 'bookings.collect_balance', 'bookings.extend', 'bookings.no_show', 'bookings.view', 'bookings.walk_in'];

const collection = {
  info: {
    name: 'Kriraghor API: Business members (Round B3)',
    description: [
      'Staff accounts for businesses (Q69, Q169, Q170). A venue owner adds counter staff by their verified phone (no NID), with the default permissions; every refusal (unknown number, the owner, Kriraghor staff, an unverified phone, someone already on the team, bad permissions, another owner’s venue) answers with a stable code and never echoes the person’s name or number; adds are limited per owner per hour (business.team_adds_per_hour, 429 RATE_LIMITED; Q180). Staff work the venue desk (bookings, check-in, walk-ins) without ever seeing the fee, released or retained amounts; optional permissions (cancel, move, reply to reviews) are off until the owner turns them on, and the staff member’s token goes stale at once. Staff of another venue get 404; staff without a permission get 403 PERMISSION_REQUIRED.',
      'A shop packer accepts and ships orders and adjusts stock; the buyer’s phone and address show on the order page only with the shipping permission once accepted, and every view is audited (Q168); the settlement stays the owner’s. A gym front-desk member admits a pass without seeing the money. When the owner’s role is suspended, staff lose access on their next request; removed staff lose it at once.',
      'Requests named "Runner" go to the local test runner (refreshing a staff session after their access changed, paying through the simulator, moving a booking in time, draining events, using up an owner’s staff adds for the hour).',
      'Unattended: `node postman/run-b3.js`. Rebuild this file with: node postman/build-collection-b3.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'adminAccessToken', 'masterPhone', 'ownerToken', 'ownerId', 'ownerPhone', 'owner2Token', 'memberToken', 'groundId', 'ground2Id', 'courtId', 'court2Id', 's1', 's2',
    'deskPhone', 'nonePhone', 'otherPhone', 'packerPhone', 'frontdeskPhone', 'unverifiedPhone', 'deskToken', 'noneToken', 'otherToken', 'packerToken', 'frontdeskToken',
    'shopOwnerToken', 'shopId', 'subOrderId', 'subOrder2Id', 'variantId', 'gymOwnerToken', 'gymId', 'passToken', 'deskMemberId', 'ownerFreshToken', 'b1', 'b1Payment', 'b2', 'b2Payment', 'reviewId',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. The owner’s team (add, refuse, list)',
      item: [
        owner('My team (empty), the permission catalogue and the cap', 'GET', '/me/team', {
          expect: { status: 200 },
          checks: [
            ['no members yet, my venue listed', "j.items.length === 0 && j.businesses.some((b) => b.businessType === 'venue' && b.id === pm.variables.get('groundId'))"],
            ['cancel, move and reply are optional (off by default, Q170)', "['bookings.cancel', 'bookings.move', 'reviews.reply'].every((k) => j.permissionCatalogue.venue.find((p) => p.key === k).default === false)"],
            ['the cap is business.team_max_members (10)', 'j.maxMembers === 10'],
          ],
        }),
        owner('Unknown number (expect 404)', 'POST', '/me/team', { body: { businessType: 'venue', businessId: '{{groundId}}', phone: '01799999998' }, expect: code(404, 'MEMBER_NOT_FOUND'), checks: [['never echoes the number (Q180)', "!pm.response.text().includes('1799999998')"]] }),
        owner('Myself (expect 422)', 'POST', '/me/team', { body: { businessType: 'venue', businessId: '{{groundId}}', phone: '{{ownerPhone}}' }, expect: code(422, 'MEMBER_IS_OWNER') }),
        owner('A Kriraghor staff account (expect 422)', 'POST', '/me/team', { body: { businessType: 'venue', businessId: '{{groundId}}', phone: '{{masterPhone}}' }, expect: code(422, 'MEMBER_IS_STAFF') }),
        owner('A phone that is not verified (expect 422)', 'POST', '/me/team', {
          body: { businessType: 'venue', businessId: '{{groundId}}', phone: '{{unverifiedPhone}}' },
          expect: code(422, 'PHONE_NOT_VERIFIED'),
          checks: [['never echoes the person’s name or number (Q180)', "!pm.response.text().includes('Unverified Phone') && !pm.response.text().includes(pm.variables.get('unverifiedPhone').slice(1))"]],
        }),
        owner('A permission staff never get: pricing (expect 422)', 'POST', '/me/team', {
          body: { businessType: 'venue', businessId: '{{groundId}}', phone: '{{deskPhone}}', permissions: ['bookings.view', 'pricing.publish'] },
          expect: code(422, 'PERMISSIONS_INVALID'),
          checks: [['names it', "j.unknown[0] === 'pricing.publish'"]],
        }),
        owner('Check-in without the bookings list (expect 422)', 'POST', '/me/team', { body: { businessType: 'venue', businessId: '{{groundId}}', phone: '{{deskPhone}}', permissions: ['bookings.check_in'] }, expect: code(422, 'PERMISSIONS_INVALID') }),
        owner('Another owner’s venue (expect 404)', 'POST', '/me/team', { body: { businessType: 'venue', businessId: '{{ground2Id}}', phone: '{{deskPhone}}' }, expect: code(404, 'NOT_FOUND') }),
        owner('Add the counter staff by phone (defaults)', 'POST', '/me/team', {
          body: { businessType: 'venue', businessId: '{{groundId}}', phone: '{{deskPhone}}' },
          expect: { status: 201 },
          save: { deskMemberId: 'member.id' },
          checks: [
            ['the six default permissions', `JSON.stringify(j.member.permissions) === ${JSON.stringify(JSON.stringify(VENUE_DEFAULTS))}`],
            ['last 4 digits only', "j.member.member.phoneLast4.length === 4 && !pm.response.text().includes(pm.variables.get('deskPhone').slice(1))"],
          ],
        }),
        owner('The same person again (expect 409)', 'POST', '/me/team', { body: { businessType: 'venue', businessId: '{{groundId}}', phone: '{{deskPhone}}' }, expect: code(409, 'ALREADY_MEMBER') }),
        owner('Add a member with no permissions', 'POST', '/me/team', { body: { businessType: 'venue', businessId: '{{groundId}}', phone: '{{nonePhone}}', permissions: [] }, expect: { status: 201 } }),
        owner2('Another owner adds staff at their venue', 'POST', '/me/team', { body: { businessType: 'venue', businessId: '{{ground2Id}}', phone: '{{otherPhone}}', permissions: VENUE_DEFAULTS }, expect: { status: 201 } }),
        owner('My team now', 'GET', '/me/team?businessType=venue&businessId={{groundId}}', { expect: { status: 200 }, checks: [['two members', 'j.items.length === 2'], noPhone] }),
        refresh('desk'),
        refresh('none'),
        refresh('other'),
        desk('Where I work', 'GET', '/me/workplaces', {
          expect: { status: 200 },
          checks: [['the venue, its owner, my permissions', "j.items.length === 1 && j.items[0].businessId === pm.variables.get('groundId') && j.items[0].owner.displayName === 'Kamal Hossain' && j.items[0].permissions.includes('bookings.check_in')"]],
        }),
        desk('Me: workplaces in the principal', 'GET', '/me', { expect: { status: 200 }, checks: [['one workplace', "j.workplaces.length === 1 && j.workplaces[0].businessType === 'venue'"]] }),
        // Q180: adds are limited per owner per hour (business.team_adds_per_hour), refusals included.
        control('use up all but one of owner 2’s staff adds this hour', 'fill-team-adds?who=owner2'),
        owner2('The last add this hour: an unknown number still counts (expect 404)', 'POST', '/me/team', { body: { businessType: 'venue', businessId: '{{ground2Id}}', phone: '01799999997' }, expect: code(404, 'MEMBER_NOT_FOUND') }),
        owner2('Over business.team_adds_per_hour (expect 429)', 'POST', '/me/team', {
          body: { businessType: 'venue', businessId: '{{ground2Id}}', phone: '{{nonePhone}}' },
          expect: code(429, 'RATE_LIMITED'),
          checks: [
            ['says when to try again', 'j.retryAfter > 0'],
            ['nothing about the person', "!pm.response.text().includes('Mitu Akter') && !pm.response.text().includes(pm.variables.get('nonePhone').slice(1))"],
          ],
        }),
        // Per owner: the shop and gym owners below still add their staff (201).
        owner2('Reading my team is not limited', 'GET', '/me/team', { expect: { status: 200 }, checks: [['still one member (the other venue’s staff)', 'j.items.length === 1']] }),
      ],
    },
    {
      name: '2. The venue desk (route by route)',
      item: [
        idem(member('A member holds a booking', 'POST', '/bookings/holds', { body: { groundId: '{{groundId}}', courtIds: ['{{courtId}}'], start: '{{s1}}', minutes: 60, payment: 'advance' }, expect: { status: 201 }, checks: [setVar('b1', 'j.booking.id'), setVar('b1Payment', 'j.payment.id')] })),
        control('pay b1', 'pay?paymentId={{b1Payment}}'),
        control('b1 starts now', 'shift?bookingId={{b1}}'),
        desk('Staff: the day at the venue', 'GET', '/me/ground-bookings?groundId={{groundId}}', { expect: { status: 200 }, checks: [['the booking', 'j.bookings.length === 1'], ['due at the venue shows', 'j.bookings[0].money.dueAtVenue === 150000'], noMoney, noPhone] }),
        owner('Owner: the same day, with the fee', 'GET', '/me/ground-bookings?groundId={{groundId}}', { expect: { status: 200 }, checks: [['the fee shows for the owner', 'j.bookings[0].money.fee === 10000']] }),
        none('No permission: the day (expect 403)', 'GET', '/me/ground-bookings?groundId={{groundId}}', { expect: code(403, 'PERMISSION_REQUIRED'), checks: [['names it', "j.permission === 'bookings.view'"]] }),
        other('Another venue’s staff: this booking (expect 404)', 'GET', '/me/ground-bookings/{{b1}}', { expect: code(404, 'NOT_FOUND') }),
        desk('Staff: the booking', 'GET', '/me/ground-bookings/{{b1}}', { expect: { status: 200 }, checks: [noMoney, noPhone] }),
        none('No permission: check in (expect 403)', 'POST', '/me/ground-bookings/{{b1}}/check-in', { expect: code(403, 'PERMISSION_REQUIRED') }),
        desk('Staff: check in (the money goes to the owner, unseen)', 'POST', '/me/ground-bookings/{{b1}}/check-in', { expect: { status: 200 }, checks: [['checked in', "j.booking.status === 'checked_in'"], ['no released block', 'j.released === undefined'], noMoney] }),
        desk('Staff: collect the balance at the venue', 'POST', '/me/ground-bookings/{{b1}}/collect-balance', { body: { method: 'cash', amount: 150000 }, expect: { status: 200 }, checks: [noMoney] }),
        idem(member('A second booking tomorrow', 'POST', '/bookings/holds', { body: { groundId: '{{groundId}}', courtIds: ['{{courtId}}'], start: '{{s2}}', minutes: 60, payment: 'advance' }, expect: { status: 201 }, checks: [setVar('b2', 'j.booking.id'), setVar('b2Payment', 'j.payment.id')] })),
        control('pay b2', 'pay?paymentId={{b2Payment}}'),
        desk('Staff: cancel is optional and off (expect 403)', 'POST', '/me/ground-bookings/{{b2}}/cancel', { body: { reason: 'weather' }, expect: code(403, 'PERMISSION_REQUIRED') }),
        desk('Staff: move is optional and off (expect 403)', 'POST', '/me/ground-bookings/{{b2}}/move', { body: { courtId: '{{court2Id}}' }, expect: code(403, 'PERMISSION_REQUIRED') }),
        owner('The owner turns move on', 'PATCH', '/me/team/{{deskMemberId}}', { body: { permissions: [...VENUE_DEFAULTS, 'bookings.move'] }, expect: { status: 200 }, checks: [['move is on', "j.member.permissions.includes('bookings.move')"]] }),
        desk('Staff: the old token is stale (expect 401)', 'GET', '/me/ground-bookings/{{b2}}', { expect: code(401, 'AUTHZ_STALE') }),
        refresh('desk'),
        desk('Staff: move to court 2 (same venue)', 'POST', '/me/ground-bookings/{{b2}}/move', { body: { courtId: '{{court2Id}}' }, expect: { status: 200 }, checks: [['moved', "j.booking.courtIds[0] === pm.variables.get('court2Id')"], noMoney] }),
        idem(desk('Staff: a walk-in at the counter', 'POST', '/me/grounds/{{groundId}}/walk-ins', { body: { courtIds: ['{{courtId}}'], start: '{{s2}}', minutes: 60, name: 'Walk-in Team', phone: '01711222333' }, expect: { status: 201 }, checks: [['last 4 digits', "j.booking.phoneLast4 === '2333'"], noMoney, noPhone] })),
        idem(other('Another venue’s staff: a walk-in here (expect 404)', 'POST', '/me/grounds/{{groundId}}/walk-ins', { body: { courtIds: ['{{courtId}}'], start: '{{s2}}', minutes: 60, name: 'Team' }, expect: code(404, 'NOT_FOUND') })),
        desk('Owner-only: pricing (expect 403)', 'GET', '/me/grounds/{{groundId}}/pricing', { expect: { status: 403 } }),
        desk('Owner-only: the owner’s dashboard (expect 403)', 'GET', '/me/dashboard?role=ground_owner', { expect: code(403, 'ROLE_REQUIRED') }),
        desk('Staff to-do', 'GET', '/me/dashboard/actions?role=business_staff', { expect: { status: 200 }, checks: [noMoney] }),
      ],
    },
    {
      name: '3. The shop desk (orders, contact view, stock)',
      item: [
        shopOwner('Add a packer (defaults: orders and stock, no reject)', 'POST', '/me/team', { body: { businessType: 'shop', businessId: '{{shopId}}', phone: '{{packerPhone}}' }, expect: { status: 201 }, checks: [['no reject by default', "!j.member.permissions.includes('orders.reject')"]] }),
        refresh('packer'),
        packer('Staff: orders to accept', 'GET', '/shop/sub-orders?tab=to_accept', { expect: { status: 200 }, checks: [['two orders', 'j.items.length === 2'], noMoney, noPhone] }),
        packer('Staff: accept (no contact in the answer)', 'POST', '/shop/sub-orders/{{subOrderId}}/accept', { expect: { status: 200 }, checks: [['accepted, contact hidden', "j.status === 'accepted' && j.shipTo === null && j.contactHidden === true"], noMoney] }),
        packer('Staff with shipping: the order page shows the contact (audited, Q168)', 'GET', '/shop/sub-orders/{{subOrderId}}', { expect: { status: 200 }, checks: [['the buyer’s phone and address', "j.shipTo && j.shipTo.phone === '+8801711000111'"], noMoney] }),
        admin('The view is in the audit log', 'GET', '/admin/audit-logs?action=sub_order.contact_viewed', { expect: { status: 200 }, checks: [['one view by the packer', 'j.items.length === 1']] }),
        packer('Staff: reject is optional and off (expect 403)', 'POST', '/shop/sub-orders/{{subOrder2Id}}/reject', { body: { reason: 'out_of_stock' }, expect: code(403, 'PERMISSION_REQUIRED') }),
        packer('Staff: ship', 'POST', '/shop/sub-orders/{{subOrderId}}/ship', { body: { courierName: 'Pathao', trackingNo: 'PTH-123456' }, expect: { status: 200 }, checks: [noMoney] }),
        packer('Staff: received stock', 'POST', '/shop/variants/{{variantId}}/adjust', { body: { delta: 2, reasonCode: 'received' }, expect: { status: 200 } }),
        packer('Staff: the inventory, without the stock value', 'GET', '/shop/inventory', { expect: { status: 200 }, checks: [['no stock value', 'j.kpis.stockValuePoisha === undefined'], noMoney] }),
        packer('Owner-only: the settlement (expect 403)', 'GET', '/shop/settlement', { expect: { status: 403 } }),
        packer('Owner-only: products and prices (expect 403)', 'GET', '/shop/products', { expect: { status: 403 } }),
        desk('A venue’s staff at the shop desk (expect 403)', 'GET', '/shop/sub-orders', { expect: { status: 403 } }),
      ],
    },
    {
      name: '4. The gym front desk',
      item: [
        gymOwner('Add a front-desk member (defaults)', 'POST', '/me/team', { body: { businessType: 'gym', businessId: '{{gymId}}', phone: '{{frontdeskPhone}}' }, expect: { status: 201 } }),
        refresh('frontdesk'),
        frontdesk('Staff: admit a pass (no money in the answer)', 'POST', '/me/gyms/{{gymId}}/redemptions', { body: { token: '{{passToken}}' }, expect: { status: 201 }, checks: [['admitted', "j.status === 'active'"], noMoney] }),
        frontdesk('Staff: today’s admissions', 'GET', '/me/gyms/{{gymId}}/redemptions', { expect: { status: 200 }, checks: [['one', 'j.items.length === 1']] }),
        frontdesk('Staff: passes sold is optional and off (expect 403)', 'GET', '/me/gyms/{{gymId}}/passes', { expect: code(403, 'PERMISSION_REQUIRED') }),
        frontdesk('Owner-only: the gym’s hours (expect 403)', 'PUT', '/me/gyms/{{gymId}}/hours', { body: { hours: [] }, expect: { status: 403 } }),
        desk('A venue’s staff at this gym (expect 403)', 'GET', '/me/gyms/{{gymId}}/redemptions', { expect: { status: 403 } }),
      ],
    },
    {
      name: '5. Access follows the owner; removal',
      item: [
        admin('Suspend the venue owner’s role', 'POST', '/admin/users/{{ownerId}}/roles/ground_owner/status', { body: { status: 'suspended', reasonCode: 'other' }, expect: { status: 200 } }),
        desk('Staff of a suspended owner: no access at once (expect 403)', 'GET', '/me/ground-bookings?groundId={{groundId}}', { expect: { status: 403 } }),
        desk('No workplaces while the owner is suspended', 'GET', '/me/workplaces', { expect: { status: 200 }, checks: [['empty', 'j.items.length === 0']] }),
        admin('Reinstate the role', 'POST', '/admin/users/{{ownerId}}/roles/ground_owner/status', { body: { status: 'active' }, expect: { status: 200 } }),
        control('drain events', 'drain'),
        refresh('desk'),
        desk('Access is back', 'GET', '/me/ground-bookings?groundId={{groundId}}', { expect: { status: 200 } }),
        refresh('owner', 'ownerFreshToken'),
        ownerFresh('Remove the counter staff', 'POST', '/me/team/{{deskMemberId}}/remove', { expect: { status: 200 }, checks: [['removed', "j.member.status === 'removed'"]] }),
        ownerFresh('Remove again (expect 404)', 'POST', '/me/team/{{deskMemberId}}/remove', { expect: code(404, 'NOT_FOUND') }),
        control('drain events', 'drain'),
        refresh('desk'),
        desk('Removed staff: no access (expect 403)', 'GET', '/me/ground-bookings?groundId={{groundId}}', { expect: { status: 403 } }),
        desk('Removed staff were told (TEAM_ADDED, TEAM_REMOVED)', 'GET', '/me/notifications', { expect: { status: 200 }, checks: [['both notices', "['TEAM_ADDED', 'TEAM_REMOVED'].every((c) => j.items.some((n) => n.code === c))"]] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
