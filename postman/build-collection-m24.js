'use strict';

/**
 * Builds postman/kriraghor-gym-manage.postman_collection.json ("M24 prompt 1 · Desk"): a private gym
 * on a verified phone, members with memberships and counter payments, receipts, renew and freeze,
 * staff with permissions at the desk, a member who accepts an invite and checks in with the rotating
 * QR, and a member list import with undo. node postman/build-collection-m24.js
 *
 * Variables (set by the runner, postman/run-m24.js): ownerToken (a member with a verified phone, no
 * NID), personToken / personPhone (the member who accepts the invite), deskToken / deskPhone (who
 * becomes front-desk staff), supportToken (Kriraghor staff with manage_gyms), areaBanani, today,
 * yesterday, in3 (Dhaka dates), ikAdd (a fixed Idempotency-Key for the replay), controlUrl (the runner:
 * /refresh?who=, /drain, /daily). The import file m24-members.csv is written by the runner into the
 * collection's working directory. Unattended: `node postman/run-m24.js`.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-gym-manage.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('ownerToken');
const person = as('personToken');
const desk = as('deskToken');
const support = as('supportToken');
const idem = (item, value = 'pm-{{$guid}}') => {
  item.request.header.push({ key: 'Idempotency-Key', value });
  return item;
};
const upload = (who, name, p, file, mime, opts) => {
  const r = who(name, 'POST', p, opts);
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
const G = '/manage/gyms/{{gymId}}';
const PHONE = /(\+?880|"0)1[3-9]\d{8}/.source;
const noPhone = ['no full phone numbers', `!new RegExp(${JSON.stringify(PHONE)}).test(pm.response.text())`];
const PACKAGES = [
  { kind: 'month', title: 'Monthly', price: 250000, admissionFee: 100000, channel: 'both', sort: 1 },
  { kind: 'quarter', title: 'Quarterly', price: 650000, channel: 'both', sort: 2 },
  { kind: 'custom', title: '45 days', price: 350000, days: 45, channel: 'desk', visitLimit: 3, sort: 3 },
];
const add = { displayName: 'Rafiq Hasan', phone: '{{personPhone}}', gender: 'male', membership: { packageId: '{{monthPkg}}', startsOn: '{{today}}', discountPoisha: 50000, discountReason: 'Opening offer' }, payment: { amountPoisha: 100000, method: 'cash' } };

const collection = {
  info: {
    name: 'Kriraghor API: M24 prompt 1 · Desk',
    description: [
      'M24 Gym management, prompt 1 (Desk MVP). A member with only a verified phone (no NID, no documents) opens a private gym (gate run_gym), saves a month-only package list (a package sold online is needed only to list the gym), picks the short code IY and the Basic plan. They add a member with a membership (৳2,500 + ৳1,000 admission − ৳500 discount = ৳3,000) and a first cash payment in one call (Idempotency-Key replayed), get receipt IY-R26-000001 and its public link, then record the rest, a reversal and a waiver. Counter money never touches the ledger.',
      'A front-desk staff member (attendance.mark, members.view; hired through /me/team) lists members without amounts, checks them in (one counted per Dhaka day) and is refused fees and owner-only settings. The member accepts the gym invite, sees the membership and receipts, and shows the rotating QR that the desk scans. A member list (CSV) is previewed with row errors, applied and undone; Kriraghor staff upload only with the owner’s consent.',
      'Requests named "Runner" go to the local test runner (refreshing a session after its access changed, draining events, running the daily jobs).',
      'Unattended: `node postman/run-m24.js`. Rebuild this file with: node postman/build-collection-m24.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'ownerToken', 'personToken', 'personPhone', 'deskToken', 'deskPhone', 'supportToken', 'areaBanani', 'today', 'yesterday', 'in3', 'ikAdd',
    'gymId', 'monthPkg', 'quarterPkg', 'memberId', 'membershipId', 'dueId', 'paymentId', 'receiptToken', 'member2Id', 'due2Id', 'payment2Id', 'renewalId', 'requestId', 'qrToken', 'importId', 'import2Id',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. A private gym and its setup (FR-01, FR-02, FR-09, FR-24, FR-81, FR-82)',
      item: [
        owner('A private gym on a verified phone (gate run_gym)', 'POST', '/me/gyms', { body: { name: 'Iron Yard Banani', areaId: '{{areaBanani}}', addressLine: 'House 9, Road 11, Banani, Dhaka' }, expect: { status: 201 }, save: { gymId: 'id' }, checks: [['draft, custom limit from settings', "j.status === 'draft' && j.limits.maxCustomPackages === 10 && j.limits.kindDays.year === 365"]] }),
        owner('Packages: month, quarter and a desk-only custom package', 'PUT', '/me/gyms/{{gymId}}/packages', {
          body: { packages: PACKAGES },
          expect: { status: 200 },
          checks: [setVar('monthPkg', "j.packages.find((p) => p.kind === 'month').id"), setVar('quarterPkg', "j.packages.find((p) => p.kind === 'quarter').id"), ['admission fee and channel kept', "j.packages.find((p) => p.kind === 'custom').channel === 'desk' && j.packages.find((p) => p.kind === 'month').admissionFee === 100000"]],
        }),
        owner('Submitting for review still needs the gym_owner role (expect 403)', 'POST', '/me/gyms/{{gymId}}/submit', { expect: { status: 403, code: 'KYC_REQUIRED' } }),
        req('The private gym is not in the directory', 'GET', '/gym/gyms', { as: false, expect: { status: 200 }, checks: [['empty', 'j.items.length === 0']] }),
        owner('Settings before setup', 'GET', `${G}/settings`, { expect: { status: 200 }, checks: [['not set up', "j.setupDone === false && j.shortCode === null && j.entryPolicy === 'warn'"]] }),
        idem(owner('Adding a member before the short code (expect 409)', 'POST', `${G}/members`, { body: { displayName: 'Too Early', phone: '01711999000' }, expect: { status: 409, code: 'GYM_SETUP_REQUIRED' } })),
        owner('The short code IY (creates the settings)', 'PATCH', `${G}/settings`, { body: { shortCode: 'iy', receiptFooter: 'Thank you for training with us' }, expect: { status: 200 }, checks: [['IY', "j.setupDone === true && j.shortCode === 'IY' && j.nextMemberCode === 'IY-0001' && j.tin === null"]] }),
        req('Public pricing from settings', 'GET', '/gym-manage/pricing', { as: false, expect: { status: 200 }, checks: [['four plans', "j.tiers.map((t) => t.key).join() === 'free,basic,standard,pro' && j.tiers[1].pricePoisha === 79900 && j.tiers[0].maxMembers === 30"]] }),
        owner('My plan: Free (one subscription with the first gym)', 'GET', '/manage/billing', { expect: { status: 200 }, checks: [['free, no check-ins', "j.subscription.chosenTier === 'free' && j.features.attendance === false && j.activeMembers.limit === 30"]] }),
        owner('Choose Basic', 'PUT', '/manage/billing/tier', { body: { tier: 'basic' }, expect: { status: 200 }, checks: [['basic', "j.subscription.chosenTier === 'basic' && j.features.attendance === true"]] }),
        owner('My gyms', 'GET', '/manage/gyms', { expect: { status: 200 }, checks: [['one gym, owner', "j.items.length === 1 && j.items[0].role === 'owner' && j.items[0].shortCode === 'IY' && j.owner.tier === 'basic'"]] }),
      ],
    },
    {
      name: '2. Members (FR-10 to FR-13, FR-25, FR-26, FR-32, FR-33)',
      item: [
        idem(owner('Add a member with a membership and the first payment', 'POST', `${G}/members`, {
          body: add,
          expect: { status: 201 },
          save: { memberId: 'member.id', membershipId: 'membership.id', dueId: 'due.id', paymentId: 'payment.id' },
          checks: [['৳3,000 due, ৳1,000 paid, IY-0001', "j.member.memberCode === 'IY-0001' && j.due.amountPoisha === 300000 && j.due.outstandingPoisha === 200000 && j.due.status === 'partial' && /^IY-R\\d{2}-000001$/.test(j.payment.receiptNo)"], setVar('receiptToken', "j.payment.receiptUrl.split('/r/')[1]"), noPhone],
        }), '{{ikAdd}}'),
        idem(owner('The same request again replays the first answer', 'POST', `${G}/members`, { body: add, expect: { status: 201 }, checks: [['replayed', "pm.response.headers.get('Idempotent-Replayed') === 'true' && j.member.memberCode === 'IY-0001'"]] }), '{{ikAdd}}'),
        idem(owner('The same phone again (expect 409)', 'POST', `${G}/members`, { body: { displayName: 'Copy', phone: '{{personPhone}}' }, expect: { status: 409, code: 'GYM_MEMBER_PHONE_TAKEN' }, checks: [['names the member', "j.memberId === pm.collectionVariables.get('memberId')"]] })),
        idem(owner('A second member with a membership, nothing paid', 'POST', `${G}/members`, { body: { displayName: 'Nadia Islam', phone: '01811000444', membership: { packageId: '{{monthPkg}}', startsOn: '{{today}}', admissionFee: false } }, expect: { status: 201 }, save: { member2Id: 'member.id', due2Id: 'due.id' }, checks: [['IY-0002, ৳2,500', "j.member.memberCode === 'IY-0002' && j.due.amountPoisha === 250000"]] })),
        owner('Search by member code', 'GET', `${G}/members?q=iy-0001`, { expect: { status: 200 }, checks: [['one', "j.items.length === 1 && j.items[0].outstandingPoisha === 200000 && j.items[0].phoneLast4.length === 4"], noPhone] }),
        owner('The profile', 'GET', `${G}/members/{{memberId}}`, { expect: { status: 200 }, checks: [['memberships and dues', "j.memberships.length === 1 && j.dues[0].payments.length === 1 && j.member.version === 1 && j.can.remove === true"]] }),
        owner('Edit with the version', 'PATCH', `${G}/members/{{memberId}}`, { body: { version: 1, displayName: 'Rafiq Hasan Khan' }, expect: { status: 200 }, checks: [['version 2', "j.member.version === 2 && j.member.displayName === 'Rafiq Hasan Khan'"]] }),
        owner('A stale version (expect 409)', 'PATCH', `${G}/members/{{memberId}}`, { body: { version: 1, displayName: 'Old Name' }, expect: { status: 409, code: 'VERSION_CONFLICT' } }),
        owner('Reveal the phone (audited, no-store)', 'POST', `${G}/members/{{memberId}}/reveal-phone`, { expect: { status: 200 }, checks: [['full number, not cached', "j.phone.startsWith('+8801') && pm.response.headers.get('Cache-Control') === 'no-store'"]] }),
      ],
    },
    {
      name: '3. Dues, payments, receipts, renew and freeze (FR-27, FR-28, FR-30, FR-33 to FR-38)',
      item: [
        idem(owner('More than is due (expect 422)', 'POST', `${G}/dues/{{dueId}}/payments`, { body: { amountPoisha: 200001, method: 'cash' }, expect: { status: 422, code: 'GYM_PAYMENT_EXCEEDS_DUE' } })),
        idem(owner('Pay the rest by bKash to the owner', 'POST', `${G}/dues/{{dueId}}/payments`, { body: { amountPoisha: 200000, method: 'owner_bkash' }, expect: { status: 201 }, checks: [['paid, receipt 2', "j.due.status === 'paid' && j.due.outstandingPoisha === 0 && j.receipt.receiptNo.endsWith('000002')"]] })),
        idem(owner('Member 2 pays ৳1,000', 'POST', `${G}/dues/{{due2Id}}/payments`, { body: { amountPoisha: 100000, method: 'cash' }, expect: { status: 201 }, save: { payment2Id: 'payment.id' }, checks: [['partial', "j.due.status === 'partial' && j.due.outstandingPoisha === 150000"]] })),
        idem(owner('Reverse it (recorded by mistake)', 'POST', `${G}/fee-payments/{{payment2Id}}/reverse`, { body: { reason: 'Recorded twice' }, expect: { status: 201 }, checks: [['negative row', "j.reversal.amountPoisha === -100000 && j.due.status === 'unpaid'"]] })),
        idem(owner('Reverse it again (expect 409)', 'POST', `${G}/fee-payments/{{payment2Id}}/reverse`, { body: { reason: 'Again' }, expect: { status: 409, code: 'GYM_PAYMENT_NOT_REVERSIBLE' } })),
        owner('Waive ৳500 of member 2’s due', 'POST', `${G}/dues/{{due2Id}}/waive`, { body: { amountPoisha: 50000, reason: 'Student discount' }, expect: { status: 200 }, checks: [['outstanding ৳2,000', "j.due.outstandingPoisha === 200000 && j.due.waivedPoisha === 50000"]] }),
        owner('The receipt (no TIN line without a TIN)', 'GET', `${G}/fee-payments/{{paymentId}}/receipt`, { expect: { status: 200 }, checks: [['receipt', "j.receiptNo.endsWith('000001') && j.gym.tin === null && j.member.memberCode === 'IY-0001' && j.amountPoisha === 100000 && j.outstandingAfterPoisha === 200000 && j.reversed === null"]] }),
        req('The public receipt behind its signed link', 'GET', '/gym-receipts/{{receiptToken}}', { as: false, expect: { status: 200 }, checks: [['same receipt, noindex', "j.receiptNo.endsWith('000001') && pm.response.headers.get('X-Robots-Tag') === 'noindex'"]] }),
        req('A tampered link (expect 404)', 'GET', '/gym-receipts/v1.{{paymentId}}.00000000000000000000000000000000', { as: false, expect: { status: 404 } }),
        idem(owner('Renew within the grace: continuous, upcoming', 'POST', `${G}/memberships/{{membershipId}}/renew`, { body: {}, expect: { status: 201 }, save: { renewalId: 'membership.id' }, checks: [['upcoming, no admission fee', "j.membership.status === 'upcoming' && j.membership.origin === 'renewal' && j.membership.admissionFeePoisha === 0"]] })),
        owner('Freeze from today for 3 days', 'POST', `${G}/memberships/{{membershipId}}/freeze`, { body: { fromOn: '{{today}}', toOn: '{{in3}}', reason: 'Fever' }, expect: { status: 200 }, checks: [['frozen, end moved', "j.membership.status === 'frozen' && j.membership.frozenDays === 4"]] }),
        owner('An overlapping freeze (expect 409)', 'POST', `${G}/memberships/{{membershipId}}/freeze`, { body: { fromOn: '{{in3}}', toOn: '{{in3}}', reason: 'Overlap' }, expect: { status: 409, code: 'GYM_MEMBERSHIP_STATE' } }),
        owner('Unfreeze today: the days come back', 'POST', `${G}/memberships/{{membershipId}}/unfreeze`, { expect: { status: 200 }, checks: [['active again', "j.membership.status === 'active' && j.membership.frozenDays === 0"]] }),
        owner('Cancel the upcoming renewal (its due voids)', 'POST', `${G}/memberships/{{renewalId}}/cancel`, { body: { reason: 'Changed their mind' }, expect: { status: 200 }, checks: [['cancelled, void', "j.membership.status === 'cancelled' && j.due.status === 'void'"]] }),
        owner('Today’s cash closing', 'GET', `${G}/cash-closing`, { expect: { status: 200 }, checks: [['all staff, counter money', "j.scope === 'all' && j.totals.receivedPoisha === 400000 && j.totals.reversedPoisha === 100000"]] }),
        owner('The dashboard', 'GET', `${G}/overview`, { expect: { status: 200 }, checks: [['tiles with money for the owner', "j.tiles.members === 2 && typeof j.tiles.collectedTodayPoisha === 'number'"]] }),
      ],
    },
    {
      name: '4. Staff at the desk (FR-03 to FR-06, FR-47, FR-48)',
      item: [
        owner('Hire the front desk (check-ins and the member list)', 'POST', '/me/team', { body: { businessType: 'gym', businessId: '{{gymId}}', phone: '{{deskPhone}}', permissions: ['attendance.mark', 'members.view'] }, expect: { status: 201 } }),
        owner('fees.adjust without fees.collect (expect 422)', 'POST', '/me/team', { body: { businessType: 'gym', businessId: '{{gymId}}', phone: '{{personPhone}}', permissions: ['members.view', 'fees.adjust'] }, expect: { status: 422, code: 'PERMISSIONS_INVALID' } }),
        control('refresh the desk session', 'refresh?who=desk', { save: { deskToken: 'accessToken' } }),
        desk('Desk: my workplace', 'GET', '/manage/gyms', { expect: { status: 200 }, checks: [['staff, basic plan', "j.items[0].role === 'staff' && j.items[0].tier === 'basic' && j.owner === null"]] }),
        desk('Desk: members without amounts', 'GET', `${G}/members`, { expect: { status: 200 }, checks: [['no outstandingPoisha', "j.items.length === 2 && j.items.every((i) => i.outstandingPoisha === undefined)"], noPhone] }),
        desk('Desk: search by name', 'GET', `${G}/desk/search?q=nadia`, { expect: { status: 200 }, checks: [['a card, no amounts', "j.items.length === 1 && j.items[0].outstandingPoisha === undefined && j.items[0].decision === 'allow'"]] }),
        desk('Desk: check member 1 in', 'POST', `${G}/checkins`, { body: { memberId: '{{memberId}}' }, expect: { status: 201 }, checks: [['counted', "j.counted === true && j.decision === 'allow'"]] }),
        desk('Desk: again the same day', 'POST', `${G}/checkins`, { body: { memberId: '{{memberId}}' }, expect: { status: 200 }, checks: [['not counted, first time shown', "j.counted === false && typeof j.firstCheckInToday === 'string'"]] }),
        idem(desk('Desk: recording a payment (expect 403)', 'POST', `${G}/dues/{{due2Id}}/payments`, { body: { amountPoisha: 100000, method: 'cash' }, expect: { status: 403, code: 'PERMISSION_REQUIRED' }, checks: [['names fees.collect', "j.permission === 'fees.collect'"]] })),
        desk('Desk: the gym settings (expect 403 owner.only)', 'GET', `${G}/settings`, { expect: { status: 403, code: 'PERMISSION_REQUIRED' }, checks: [['owner.only', "j.permission === 'owner.only'"]] }),
        desk('Desk: the dashboard without money', 'GET', `${G}/overview`, { expect: { status: 200 }, checks: [['no money tiles', 'j.tiles.collectedTodayPoisha === undefined && j.tiles.checkInsToday === 1']] }),
        owner('The day’s check-ins', 'GET', `${G}/checkins`, { expect: { status: 200 }, checks: [['one counted, two rows', 'j.counted === 1 && j.items.length === 2']] }),
      ],
    },
    {
      name: '5. Account link and the member area (FR-14, FR-15, FR-18, FR-50)',
      item: [
        owner('Invite member 1 to link their account', 'POST', `${G}/members/{{memberId}}/invite`, { body: {}, expect: { status: 201 }, save: { requestId: 'request.id' }, checks: [['pending, account known', "j.request.status === 'pending' && j.request.accountKnown === true"]] }),
        owner('A second invite (expect 409)', 'POST', `${G}/members/{{memberId}}/invite`, { body: {}, expect: { status: 409, code: 'GYM_LINK_REQUEST_PENDING' } }),
        control('deliver events', 'drain'),
        person('Member: my gym requests', 'GET', '/me/gym-requests', { expect: { status: 200 }, checks: [['the invite with what the gym sees', "j.items.length === 1 && j.items[0].memberCode === 'IY-0001' && j.items[0].shares.includes('payments')"]] }),
        person('Member: accept (gate join_gym)', 'POST', '/me/gym-requests/{{requestId}}/accept', { expect: { status: 200 }, checks: [['accepted', "j.request.status === 'accepted' && j.memberId === pm.collectionVariables.get('memberId')"]] }),
        person('Member: my gyms', 'GET', '/me/gym-memberships', { expect: { status: 200 }, checks: [['linked, monthly', "j.items.length === 1 && j.items[0].linked === true && j.items[0].current.title === 'Monthly'"]] }),
        person('Member: the membership with receipts', 'GET', '/me/gym-memberships/{{memberId}}', { expect: { status: 200 }, checks: [['two receipts', 'j.receipts.length === 2 && j.memberships.length === 2']] }),
        person('Member: my receipts', 'GET', '/me/gym-receipts', { expect: { status: 200 }, checks: [['two', 'j.items.length === 2']] }),
        person('Member: my check-in QR (no-store)', 'GET', '/me/gym-memberships/{{memberId}}/checkin-token', { expect: { status: 200 }, save: { qrToken: 'token' }, checks: [['rotating token', "j.token.startsWith('v1.gm.') && pm.response.headers.get('Cache-Control') === 'no-store'"]] }),
        desk('Desk: scan the member QR', 'POST', `${G}/checkins`, { body: { token: '{{qrToken}}' }, expect: { status: 200 }, checks: [['by QR (already counted today)', "j.method === 'member_qr' && j.counted === false && j.member.linked === true"]] }),
        desk('Desk: a forged QR (expect 422)', 'POST', `${G}/checkins`, { body: { token: 'v1.gm.00000000-0000-4000-8000-000000000000.1.00000000000000000000000000000000' }, expect: { status: 422, code: 'GYM_CHECKIN_TOKEN_INVALID' } }),
        person('Member: unlink', 'POST', '/me/gym-memberships/{{memberId}}/unlink', { expect: { status: 200 }, checks: [['unlinked', 'j.linked === false']] }),
        person('Member: the gym under Past', 'GET', '/me/gym-memberships', { expect: { status: 200 }, checks: [['past', 'j.items.length === 1 && j.items[0].linked === false']] }),
      ],
    },
    {
      name: '6. Import a member list (FR-75 to FR-79)',
      item: [
        upload(owner, 'Upload the CSV: a preview with row errors', `${G}/imports?fileName=members.csv`, 'm24-members.csv', 'text/csv', { expect: { status: 201 }, save: { importId: 'id' }, checks: [['3 ok, 1 duplicate', "j.status === 'previewed' && j.rowsOk === 3 && j.rowsFailed === 1 && j.report[3].errors[0].code === 'duplicate_phone_in_gym'"], noPhone] }),
        idem(owner('Apply the ok rows', 'POST', `${G}/imports/{{importId}}/apply`, { expect: { status: 200 }, checks: [['applied, undo open', "j.status === 'applied' && j.can.undo === true"]] })),
        owner('Members now', 'GET', `${G}/members`, { expect: { status: 200 }, checks: [['5 members', 'j.items.length === 5']] }),
        owner('Undo the import', 'POST', `${G}/imports/{{importId}}/undo`, { expect: { status: 200 }, checks: [['undone', "j.status === 'undone'"]] }),
        owner('Members after the undo', 'GET', `${G}/members`, { expect: { status: 200 }, checks: [['2 members again', 'j.items.length === 2']] }),
        upload(support, 'Kriraghor staff upload without consent (expect 403)', `/admin/gym-manage/gyms/{{gymId}}/imports`, 'm24-members.csv', 'text/csv', { expect: { status: 403, code: 'GYM_IMPORT_CONSENT_REQUIRED' } }),
        owner('The owner allows a Kriraghor upload', 'PUT', `${G}/import-consent`, { body: { grant: true }, expect: { status: 200 }, checks: [['consent until', "typeof j.importConsentUntil === 'string'"]] }),
        upload(support, 'Kriraghor staff upload (preview only)', `/admin/gym-manage/gyms/{{gymId}}/imports`, 'm24-members.csv', 'text/csv', { expect: { status: 201 }, save: { import2Id: 'id' }, checks: [['by staff', "j.uploadedAs === 'staff' && j.status === 'previewed'"]] }),
        owner('Discard that preview', 'POST', `${G}/imports/{{import2Id}}/discard`, { expect: { status: 200 }, checks: [['discarded, file gone', "j.status === 'discarded' && j.filePurged === true"]] }),
      ],
    },
    {
      name: '7. Jobs and member status (FR-31, FR-39)',
      item: [
        control('run the daily jobs twice', 'daily', { checks: [['second run changes nothing', 'j.second.expired === 0 && j.second.started === 0 && j.secondOverdue.marked === 0']] }),
        owner('Member 2 is still active', 'GET', `${G}/members/{{member2Id}}`, { expect: { status: 200 }, checks: [['active', "j.member.status === 'active'"]] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
