'use strict';

/**
 * Builds postman/kriraghor-gym-sms.postman_collection.json ("M24 · SMS add-on", prompt 3b, M24-FR-96 to
 * FR-100): off by default; with the platform switch on (the runner, as a master would after four-eyes):
 * switching on with the month's allowance, the kinds chosen for SMS, a receipt held and settled for a
 * phone-only member, a payment link by SMS with the short link, bundles paid at once, the jobs, the
 * master's adjustment. node postman/build-collection-m24-sms.js
 *
 * Variables (set by the runner, postman/run-m24-sms.js): ownerToken (a Basic gym), freeOwnerToken (a Free
 * gym), adminAccessToken (a master), gymId, ownerId, dueA (a phone-only member's due), dueB (another
 * member's due), phoneB (that member's phone, for the runner only), controlUrl (the runner: /switch,
 * /drain, /last-sms, /pay, /daily, /allowance, /stepup). Unattended: `node postman/run-m24-sms.js`.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-gym-sms.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('ownerToken');
const freeOwner = as('freeOwnerToken');
const master = as('adminAccessToken');
const pub = (name, method, p, opts = {}) => req(name, method, p, { ...opts, as: false });
const idem = (item, value = 'sms-{{$guid}}') => {
  item.request.header.push({ key: 'Idempotency-Key', value });
  return item;
};
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  const [p, qs] = step.split('?');
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [p], ...(qs ? { query: qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};
const G = '/manage/gyms/{{gymId}}';
const withStepUp = (item) => {
  item.request.header.push({ key: 'X-Step-Up', value: '{{stepUpToken}}' });
  return item;
};

const collection = {
  info: {
    name: 'Kriraghor API: M24 · SMS add-on (prompt 3b)',
    description: [
      'The gym SMS add-on (M24-FR-96 to FR-100, §6.7, §18). Built against the test SMS driver and switched off on the platform (gym_saas.sms_addon_enabled = false, prices 0) until the SMS gateway is signed (G9). While off, no gym ever sends an SMS (M24-FR-57).',
      'With the switch on, a gym owner on a paid plan switches the add-on on and gets the month’s allowance; chooses which reminders go by SMS; each SMS holds gym_saas.sms_reserve_units before its event is published and M08 settles the hold (notification.sms_settled) with the segments used. Bundles are invoices paid at once; their units arrive with the payment. The owner hears once when the balance runs low or empty. A master can add or take units (step-up).',
      'Requests named "Runner" go to the local test runner (switching the platform setting, delivering events, reading the test SMS outbox, paying through the simulator, the jobs, a step-up token).',
      'Unattended: `node postman/run-m24-sms.js`. Rebuild this file with: node postman/build-collection-m24-sms.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'controlUrl', 'ownerToken', 'freeOwnerToken', 'adminAccessToken', 'stepUpToken', 'gymId', 'ownerId', 'dueA', 'dueB', 'phoneB', 'linkId', 'shortCode', 'bundlePaymentId', 'bundleInvoiceId'].map((key) => ({
    key,
    value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '',
  })),
  item: [
    {
      name: '1. Off on the platform (M24-FR-57, G9)',
      item: [
        owner('The billing page: not available', 'GET', '/manage/billing', { expect: { status: 200 }, checks: [['off', 'j.smsAddon.available === false && j.smsAddon.enabled === false && j.smsAddon.balance === 0']] }),
        owner('Switch on (expect 409)', 'PUT', '/manage/billing/sms-addon', { body: { enabled: true }, expect: { status: 409, code: 'GYM_SMS_ADDON_UNAVAILABLE' } }),
        owner('Choose SMS kinds (expect 409)', 'PATCH', `${G}/settings`, { body: { smsKinds: ['receipt'] }, expect: { status: 409, code: 'GYM_SMS_ADDON_OFF' } }),
        control('The platform switch on, with prices', 'switch?on=1'),
      ],
    },
    {
      name: '2. Switching on (M24-FR-96, FR-97)',
      item: [
        freeOwner('A Free plan (expect 409)', 'PUT', '/manage/billing/sms-addon', { body: { enabled: true }, expect: { status: 409, code: 'GYM_SMS_ADDON_UNAVAILABLE' } }),
        owner('Switch on: the month’s allowance', 'PUT', '/manage/billing/sms-addon', { body: { enabled: true }, expect: { status: 200 }, checks: [['active, 10 units', "j.status === 'active' && j.balance === 10 && j.allowanceLeft === 10 && j.included === 10"]] }),
        owner('Again: no second allowance', 'PUT', '/manage/billing/sms-addon', { body: { enabled: true }, expect: { status: 200 }, checks: [['still 10', 'j.balance === 10']] }),
        owner('Receipts go by SMS', 'PATCH', `${G}/settings`, { body: { smsKinds: ['receipt'] }, expect: { status: 200 }, checks: [['chosen', "j.smsKinds.includes('receipt')"]] }),
        owner('The reminders page', 'GET', `${G}/reminders`, { expect: { status: 200 }, checks: [['active, the kinds', "j.sms.active === true && j.sms.balance === 10 && j.sms.kinds.join() === 'receipt' && j.sms.choosable.length === 5"]] }),
      ],
    },
    {
      name: '3. Held and settled (M24-FR-99)',
      item: [
        idem(owner('A cash payment of a phone-only member', 'POST', `${G}/dues/{{dueA}}/payments`, { body: { amountPoisha: 100000, method: 'cash' }, expect: { status: 201 } })),
        owner('Two units held', 'GET', '/manage/billing/sms-entries', { expect: { status: 200 }, checks: [['a reserve', "j.balance === 8 && j.items.some((e) => e.kind === 'reserve' && e.units === -2)"]] }),
        control('Deliver: M08 sends it and settles', 'drain'),
        owner('Settled: two segments used (the taka sign makes it Unicode)', 'GET', '/manage/billing/sms-entries', { expect: { status: 200 }, checks: [['a settle', "j.balance === 8 && j.items.some((e) => e.kind === 'settle')"]] }),
        idem(owner('A payment link by SMS', 'POST', `${G}/dues/{{dueB}}/payment-links`, { body: { channels: ['sms'] }, expect: { status: 201 }, save: { linkId: 'id' } })),
        control('Deliver', 'drain'),
        control('The SMS the member got', 'last-sms?phone={{phoneB}}', {
          checks: [['the short link', "/\\/p\\/[0-9A-HJKMNP-TV-Z]{10}/.test(j.text) && (pm.collectionVariables.set('shortCode', /\\/p\\/([0-9A-HJKMNP-TV-Z]{10})/.exec(j.text)[1]), true)"]],
        }),
        pub('The pay page by the short code', 'GET', '/gym-pay/{{shortCode}}', { expect: { status: 200 }, checks: [['the link', "j.link.id === pm.variables.get('linkId')"]] }),
        pub('A made-up code (expect 404)', 'GET', '/gym-pay/ABCDEFGHJK', { expect: { status: 404 } }),
      ],
    },
    {
      name: '4. Bundles (M24-FR-98)',
      item: [
        idem(owner('Buy two bundles', 'POST', '/manage/billing/sms-bundles', { body: { bundles: 2 }, expect: { status: 201 }, save: { bundlePaymentId: 'payment.id', bundleInvoiceId: 'invoice.id' }, checks: [['a bundle invoice', "j.invoice.kind === 'sms_bundle' && j.units === 200 && j.invoice.totalPoisha === 100000"]] })),
        idem(owner('Too many bundles (expect 422)', 'POST', '/manage/billing/sms-bundles', { body: { bundles: 21 }, expect: { status: 422 } })),
        control('Pay it through the simulator', 'pay?paymentId={{bundlePaymentId}}'),
        owner('The units arrived', 'GET', '/manage/billing', { expect: { status: 200 }, checks: [['200 more', 'j.smsAddon.balance >= 200 && j.smsAddon.bundles.length === 1']] }),
        owner('The invoice is paid', 'GET', '/manage/billing/invoices/{{bundleInvoiceId}}', { expect: { status: 200 }, checks: [['paid, one bundle line', "j.status === 'paid' && j.lines[0].kind === 'sms_bundle'"]] }),
      ],
    },
    {
      name: '5. Jobs and the master',
      item: [
        control('The daily job (nothing stale)', 'daily'),
        control('The allowance job on the 1st', 'allowance', { checks: [['expired and granted', 'j.granted === 10']] }),
        master('Adjust without step-up (expect 403)', 'POST', '/admin/gym-manage/owners/{{ownerId}}/sms-adjust', { body: { units: 25, note: 'Goodwill for a gateway outage' }, expect: { status: 403 } }),
        control('A step-up token', 'stepup?scope=settings.write', { save: { stepUpToken: 'token' } }),
        withStepUp(master('Adjust below 0 (expect 409)', 'POST', '/admin/gym-manage/owners/{{ownerId}}/sms-adjust', { body: { units: -100000, note: 'Too much' }, expect: { status: 409, code: 'GYM_SMS_BALANCE_SHORT' } })),
        control('Another step-up token', 'stepup?scope=settings.write', { save: { stepUpToken: 'token' } }),
        withStepUp(master('Add 25 units', 'POST', '/admin/gym-manage/owners/{{ownerId}}/sms-adjust', { body: { units: 25, note: 'Goodwill for a gateway outage' }, expect: { status: 200 }, checks: [['an adjust entry', "j.entry.kind === 'adjust' && j.entry.units === 25"]] })),
        master('The owner in the admin desk', 'GET', '/admin/gym-manage/owners/{{ownerId}}', { expect: { status: 200 }, checks: [['the add-on', "j.smsAddon.status === 'active' && j.smsAddon.balance > 0"]] }),
        owner('Switch off', 'PUT', '/manage/billing/sms-addon', { body: { enabled: false }, expect: { status: 200 }, checks: [['ended', "j.status === null"]] }),
        owner('Choosing kinds now (expect 409)', 'PATCH', `${G}/settings`, { body: { smsKinds: ['receipt', 'overdue'] }, expect: { status: 409, code: 'GYM_SMS_ADDON_OFF' } }),
        control('The platform switch off again', 'switch?on=0'),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
