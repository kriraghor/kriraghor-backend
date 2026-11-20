'use strict';

/**
 * Builds postman/kriraghor-gym-manage-money.postman_collection.json ("M24 prompt 2 · Money and
 * billing"): payment links and online fees with no margin (the §6.3 worked example: ৳1,500 by bKash,
 * ৳30 provider charge, ৳1,470 to the owner), the member's dues, owner refunds from the hold, the
 * reminders page, reports and exports, the owner's invoice (paid through M06), and the admin desk
 * (owners, invoices, founding partners, fee overrides with step-up). node postman/build-collection-m24-money.js
 *
 * Variables (set by the runner, postman/run-m24-money.js): ownerToken (a gym owner with the gym_owner
 * role and a Basic gym), gymId, dueId (a ৳3,500 due of member memberId), payerToken (the member's own
 * account, same phone), cashierToken (staff with members.view and fees.collect), adminAccessToken
 * (master A), supportToken (Kriraghor staff with manage_gyms), ownerId, month (this Dhaka month),
 * controlUrl (the runner: /pay, /drain, /release, /refunds, /reminders, /payout, /cycle, /stepup).
 * Unattended: `node postman/run-m24-money.js`.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-gym-manage-money.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('ownerToken');
const payer = as('payerToken');
const cashier = as('cashierToken');
const support = as('supportToken');
const master = (name, method, p, opts = {}) => req(name, method, p, { ...opts, as: 'A' });
const idem = (item, value = 'pm-{{$guid}}') => {
  item.request.header.push({ key: 'Idempotency-Key', value });
  return item;
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

const collection = {
  info: {
    name: 'Kriraghor API: M24 prompt 2 · Money and billing',
    description: [
      'M24 Gym management, prompt 2. A Basic gym whose owner has the gym_owner role creates a payment link for ৳1,500 of a member’s ৳3,500 due. The member opens the public link page (first name and member code only), pays by bKash through the M06 simulator and links the membership (same phone). The fee row carries the provider charge (200 bps → ৳30), never shown to staff or the member; after the 72-hour hold the owner’s payable gets ৳1,470 and provider_fee_expense ৳30 (no Kriraghor margin); the payout line shows gross, charge and net.',
      'The member pays the rest from the member area; the owner refunds part of it from the hold (the reversal row follows refund.succeeded) and is refused once the window has closed. The owner reads the reminders page, reports and CSV exports, and pays the month’s invoice through M06 (collected to fee_revenue:gym_saas). Masters set a founding partner and fee overrides with step-up; Kriraghor staff with manage_gyms read owners and invoices.',
      'Requests named "Runner" go to the local test runner (paying through the simulator, draining events and payment jobs, the release, reminder and invoice jobs on a fake clock, step-up tokens).',
      'Unattended: `node postman/run-m24-money.js`. Rebuild this file with: node postman/build-collection-m24-money.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'ownerToken', 'payerToken', 'cashierToken', 'adminAccessToken', 'supportToken', 'stepUpToken', 'gymId', 'dueId', 'memberId', 'ownerId', 'month',
    'linkId', 'linkToken', 'paymentId', 'feePaymentId', 'payment2Id', 'feePayment2Id', 'payoutId', 'invoiceId', 'invoicePaymentId', 'overrideId',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. A payment link (FR-40)',
      item: [
        owner('The billing page: Basic, the fees that apply, no invoices yet', 'GET', '/manage/billing', { expect: { status: 200 }, checks: [['basic, standard fees', "j.subscription.chosenTier === 'basic' && j.fees.referral.valuePoisha === 20000 && j.fees.referral.source === 'setting' && j.fees.passCommission.pct === 5 && j.openInvoices.length === 0 && j.smsAddon.available === false"]] }),
        idem(owner('More than is due (expect 422)', 'POST', `${G}/dues/{{dueId}}/payment-links`, { body: { amountPoisha: 350001 }, expect: { status: 422, code: 'GYM_PAYMENT_EXCEEDS_DUE' } })),
        idem(owner('A link for ৳1,500, sent in-app and by email', 'POST', `${G}/dues/{{dueId}}/payment-links`, {
          body: { amountPoisha: 150000, channels: ['in_app', 'email'] },
          expect: { status: 201 },
          save: { linkId: 'id' },
          checks: [['open, the gym app /p/ URL is the QR', "j.status === 'open' && j.amountPoisha === 150000 && j.url.includes('/p/v1.') && j.qr === j.url"], setVar('linkToken', "j.url.split('/p/')[1]")],
        })),
        idem(owner('A second open link (expect 409)', 'POST', `${G}/dues/{{dueId}}/payment-links`, { body: {}, expect: { status: 409, code: 'GYM_PAY_LINK_OPEN' }, checks: [['names the open link', "j.linkId === pm.collectionVariables.get('linkId')"]] })),
        cashier('Staff with fees.collect list the links', 'GET', `${G}/payment-links?dueId={{dueId}}`, { expect: { status: 200 }, checks: [['one open link', "j.items.length === 1 && j.items[0].status === 'open'"]] }),
        req('The public link page (no sign-in)', 'GET', '/gym-pay/{{linkToken}}', { as: false, expect: { status: 200 }, checks: [['first name and code, noindex', "j.member.firstName === 'Rafiq' && /^IY-\\d{4}$/.test(j.member.memberCode) && j.link.amountPoisha === 150000 && j.onlineFees === true && j.viewer === null && pm.response.headers.get('X-Robots-Tag') === 'noindex'"], noPhone] }),
        payer('The same page signed in as the member (same phone)', 'GET', '/gym-pay/{{linkToken}}', { expect: { status: 200 }, checks: [['may link', 'j.viewer.phoneMatches === true && j.viewer.canLink === true']] }),
        req('A tampered token (expect 404)', 'GET', '/gym-pay/v1.{{linkId}}.AAAAAAAAAAAAAAAA.00000000000000000000000000000000', { as: false, expect: { status: 404 } }),
      ],
    },
    {
      name: '2. Paying online, the receipt, the hold and its release (FR-41 to FR-46)',
      item: [
        idem(payer('Pay the link and link my membership (gate join_gym)', 'POST', '/gym-pay/{{linkToken}}/pay', { body: { linkAccount: true }, expect: { status: 201 }, save: { paymentId: 'paymentId' }, checks: [['the gym app pay page, will link', "j.willLink === true && j.amountPoisha === 150000 && j.payUrl.includes('/pay/' + j.paymentId)"]] })),
        control('pay it by bKash through the simulator', 'pay?who=payer&paymentId={{paymentId}}&method=bkash', { checks: [['returns to the gym app result page (M24-FR-104)', "j.returnTo === j.gymApp + '/pay/' + pm.collectionVariables.get('paymentId') + '/result'"]] }),
        req('The link page now shows the receipt', 'GET', '/gym-pay/{{linkToken}}', { as: false, expect: { status: 200 }, checks: [['paid with a receipt', "j.link.status === 'paid' && /^IY-R\\d{2}-\\d{6}$/.test(j.receipt.receiptNo)"]] }),
        idem(payer('Paying a paid link again (expect 409)', 'POST', '/gym-pay/{{linkToken}}/pay', { body: {}, expect: { status: 409, code: 'GYM_DUE_STATE' } })),
        owner('The owner sees the online payment with the ৳30 charge', 'GET', `${G}/members/{{memberId}}`, {
          expect: { status: 200 },
          checks: [['linked, online, 200 bps', "j.link.linked === true && j.dues[0].payments.some((p) => p.method === 'online' && p.providerCharge.poisha === 3000 && p.providerCharge.bps === 200 && p.providerCharge.netPoisha === 147000)"], setVar('feePaymentId', "j.dues[0].payments.find((p) => p.method === 'online').id")],
        }),
        cashier('Staff never see the provider charge', 'GET', `${G}/members/{{memberId}}`, { expect: { status: 200 }, checks: [['no providerCharge key', "j.dues[0].payments.every((p) => !('providerCharge' in p))"]] }),
        payer('The member sees the payment, never the charge', 'GET', '/me/gym-memberships/{{memberId}}', { expect: { status: 200 }, checks: [['linked, no charge', "j.member.linked === true && j.dues[0].payments.every((p) => p.providerCharge === null)"]] }),
        control('release the hold after 73 hours (and check the ledger)', 'release', { checks: [['released, ৳1,470 to the owner, ৳30 recovered, no fee revenue', 'j.released === 1 && j.payable === 147000 && j.providerFeeExpense === 3000 && j.feeRevenue === 0 && j.escrow === 0 && j.invariantsOk === true']] }),
        idem(owner('A refund after the release (expect 409)', 'POST', `${G}/fee-payments/{{feePaymentId}}/refund`, { body: { amountPoisha: 100, reason: 'Too late' }, expect: { status: 409, code: 'GYM_REFUND_WINDOW_CLOSED' } })),
        control('build the weekly payout', 'payout', { save: { payoutId: 'payoutId' } }),
        owner('The payout line: gross ৳1,500, provider charge ৳30, net ৳1,470', 'GET', '/me/payouts/{{payoutId}}', { expect: { status: 200 }, checks: [['one line', 'j.items.length === 1 && j.items[0].gross === 150000 && j.items[0].fee === 0 && j.items[0].providerCharge === 3000 && j.items[0].net === 147000 && j.amount === 147000']] }),
      ],
    },
    {
      name: '3. The member area and a refund from the hold (FR-41, FR-44)',
      item: [
        payer('My dues: ৳2,000 left, the gym takes fees online', 'GET', '/me/gym-dues', { expect: { status: 200 }, checks: [['one due', "j.items.length === 1 && j.items[0].outstandingPoisha === 200000 && j.items[0].onlineFees === true && j.items[0].openLink === null"]] }),
        idem(payer('Pay it from the member area', 'POST', '/me/gym-dues/{{dueId}}/pay', { expect: { status: 201 }, save: { payment2Id: 'paymentId' }, checks: [['the outstanding', 'j.amountPoisha === 200000 && j.willLink === false']] })),
        control('pay it by Nagad', 'pay?who=payer&paymentId={{payment2Id}}&method=nagad'),
        owner('The due is paid', 'GET', `${G}/members/{{memberId}}`, { expect: { status: 200 }, checks: [['paid', "j.dues[0].status === 'paid'"], setVar('feePayment2Id', "j.dues[0].payments.filter((p) => p.method === 'online' && p.amountPoisha === 200000)[0].id")] }),
        idem(cashier('Staff cannot refund (expect 403)', 'POST', `${G}/fee-payments/{{feePayment2Id}}/refund`, { body: { amountPoisha: 100, reason: 'No' }, expect: { status: 403, code: 'PERMISSION_REQUIRED' }, checks: [['owner only', "j.permission === 'owner.only'"]] })),
        idem(owner('Refund ৳500 from the hold', 'POST', `${G}/fee-payments/{{feePayment2Id}}/refund`, { body: { amountPoisha: 50000, reason: 'Charged twice by mistake' }, expect: { status: 201 }, checks: [['refund requested, the link remembers it', 'j.refund.amountPoisha === 50000 && j.link.refundedPoisha === 50000']] })),
        idem(owner('A second refund (expect 409)', 'POST', `${G}/fee-payments/{{feePayment2Id}}/refund`, { body: { amountPoisha: 100, reason: 'Again' }, expect: { status: 409, code: 'GYM_PAYMENT_NOT_REVERSIBLE' } })),
        control('settle the refund and deliver its event', 'refunds'),
        owner('The reversal row follows (method online)', 'GET', `${G}/members/{{memberId}}`, { expect: { status: 200 }, checks: [['−৳500, partial', "j.dues[0].status === 'partial' && j.dues[0].payments.some((p) => p.amountPoisha === -50000 && p.method === 'online')"]] }),
      ],
    },
    {
      name: '4. Reminders and reports (FR-55 to FR-61, FR-70 to FR-74)',
      item: [
        owner('The reminders page', 'GET', `${G}/reminders`, { expect: { status: 200 }, checks: [['offsets from settings, the log', "j.feature.reminders === true && JSON.stringify(j.offsets.renewalRemindDays) === '[7,3,1]' && j.offsets.overdueRemindDays[0] === 3 && j.log.items.some((x) => x.kind === 'pay_link') && j.log.items.some((x) => x.kind === 'receipt')"], noPhone] }),
        cashier('Staff never see the reminders page (expect 403)', 'GET', `${G}/reminders`, { expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        control('run the reminder jobs twice on a fake clock', 'reminders', { checks: [['once only: the second runs send nothing', 'j.second.renewal_due === 0 && j.second.overdue === 0 && j.secondMorning.sent === 0']] }),
        owner('Reports need Standard (expect 403)', 'GET', `${G}/reports?month={{month}}`, { expect: { status: 403, code: 'GYM_TIER_REQUIRED' }, checks: [['standard', "j.feature === 'reports' && j.minTier === 'standard'"]] }),
        owner('Choose Standard', 'PUT', '/manage/billing/tier', { body: { tier: 'standard' }, expect: { status: 200 } }),
        owner('The month report', 'GET', `${G}/reports?month={{month}}`, { expect: { status: 200 }, checks: [['online money apart', 'j.money.onlinePoisha === 300000 && j.money.byMethod.online === 300000 && j.money.monthOverMonth.length === 6 && typeof j.members.activeNow === "number"'], ['the period before, money per day and visit methods (M24-FR-154, FR-155)', 'j.previous.period.month !== null && j.previous.period.to < j.period.from && j.money.daily.reduce((n, d) => n + d.collectedPoisha, 0) === j.money.collectedPoisha && typeof j.attendance.byMethod === "object"']] }),
        owner('Members not seen', 'GET', `${G}/reports/absent`, { expect: { status: 200 } }),
        owner('Export the payments (CSV with a BOM)', 'GET', `${G}/reports/export?dataset=payments&month={{month}}`, { expect: { status: 200 }, checks: [['csv, provider charge column', "pm.response.headers.get('Content-Type').includes('text/csv') && pm.response.text().includes('Provider charge') && pm.response.text().includes('\"1500.00\"')"]] }),
        cashier('Staff cannot export (expect 403)', 'GET', `${G}/reports/export?dataset=members&month={{month}}`, { expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        owner('All my gyms', 'GET', '/manage/reports?month={{month}}', { expect: { status: 200 }, checks: [['totals, no side by side on Standard', 'j.multiGym === false && j.perGym === null && j.totals.money.onlinePoisha === 300000'], ['with the period before', 'typeof j.previous.money.collectedPoisha === "number"']] }),
      ],
    },
    {
      name: '5. The owner invoice and dunning (FR-82 to FR-89)',
      item: [
        control('issue next month’s invoice for this month (in arrears)', 'cycle', { save: { invoiceId: 'invoiceId' }, checks: [['one invoice', 'j.issued === 1']] }),
        owner('My invoices', 'GET', '/manage/billing/invoices', { expect: { status: 200 }, checks: [['issued, GI number', "j.items.length === 1 && j.items[0].status === 'issued' && /^GI-\\d{2}-\\d{6}$/.test(j.items[0].number)"]] }),
        owner('The invoice with its lines (Standard was chosen this month)', 'GET', '/manage/billing/invoices/{{invoiceId}}', { expect: { status: 200 }, checks: [['standard tier line', "j.billedTier === 'standard' && j.lines[0].kind === 'tier' && j.lines[0].amountPoisha === 150000 && j.totalPoisha === j.subtotalPoisha + j.vatPoisha"]] }),
        owner('The billing page lists it', 'GET', '/manage/billing', { expect: { status: 200 }, checks: [['open invoice', "j.openInvoices.length === 1 && j.openInvoices[0].id === pm.collectionVariables.get('invoiceId')"]] }),
        idem(owner('Pay the invoice', 'POST', '/manage/billing/invoices/{{invoiceId}}/pay', { expect: { status: 201 }, save: { invoicePaymentId: 'payment.id' }, checks: [['the gym app pay page', "j.payment.payUrl.endsWith('/pay/' + j.payment.id)"]] })),
        control('pay it through the simulator', 'pay?who=owner&paymentId={{invoicePaymentId}}&method=card'),
        owner('Paid', 'GET', '/manage/billing/invoices/{{invoiceId}}', { expect: { status: 200 }, checks: [['paid', "j.status === 'paid' && j.paidAt !== null"]] }),
        idem(owner('Paying again (expect 409)', 'POST', '/manage/billing/invoices/{{invoiceId}}/pay', { expect: { status: 409, code: 'GYM_INVOICE_STATE' } })),
      ],
    },
    {
      name: '6. The admin desk (§4.4: owners, invoices, founding partners, overrides)',
      item: [
        support('Kriraghor staff (manage_gyms): owners', 'GET', '/admin/gym-manage/owners', { expect: { status: 200 }, checks: [['the owner, counts only', "j.items.some((x) => x.ownerId === pm.variables.get('ownerId') && x.gyms === 1)"], noPhone] }),
        support('Owner detail (counts only, never member data)', 'GET', '/admin/gym-manage/owners/{{ownerId}}', { expect: { status: 200 }, checks: [['subscription, gyms, invoices', "j.subscription.chosenTier === 'standard' && j.gyms.length === 1 && j.invoices.length === 1 && !pm.response.text().includes('Rafiq')"]] }),
        support('All invoices', 'GET', '/admin/gym-manage/invoices?status=paid', { expect: { status: 200 }, checks: [['paid total', 'j.totals.paid.count === 1']] }),
        support('Staff cannot set a founding partner (expect 403)', 'PUT', '/admin/gym-manage/owners/{{ownerId}}/founding-partner', { body: { on: true, reason: 'No' }, expect: { status: 403, code: 'MASTER_REQUIRED' } }),
        master('A master without step-up (expect 403)', 'PUT', '/admin/gym-manage/owners/{{ownerId}}/founding-partner', { body: { on: true, reason: 'Pilot gym' }, expect: { status: 403, code: 'STEP_UP_REQUIRED' } }),
        control('step-up settings.write', 'stepup?scope=settings.write', { save: { stepUpToken: 'token' } }),
        master('Founding partner on (step-up settings.write)', 'PUT', '/admin/gym-manage/owners/{{ownerId}}/founding-partner', { body: { on: true, reason: 'Pilot gym' }, stepUp: true, expect: { status: 200 }, checks: [['number 1', 'j.foundingPartner === true && j.foundingNo === 1']] }),
        control('step-up settings.write', 'stepup?scope=settings.write', { save: { stepUpToken: 'token' } }),
        master('An owner referral fee override of ৳150', 'POST', '/admin/gym-manage/fee-overrides', { body: { scopeType: 'owner', scopeId: '{{ownerId}}', key: 'fees.gym_referral_poisha', value: 15000, reason: 'Founding deal' }, stepUp: true, expect: { status: 201 }, save: { overrideId: 'id' }, checks: [['active owner override', "j.status === 'active' && j.source === 'owner_override'"]] }),
        control('step-up settings.write', 'stepup?scope=settings.write', { save: { stepUpToken: 'token' } }),
        master('A second one for the same scope and fee (expect 409)', 'POST', '/admin/gym-manage/fee-overrides', { body: { scopeType: 'owner', scopeId: '{{ownerId}}', key: 'fees.gym_referral_poisha', value: 10000, reason: 'Again' }, stepUp: true, expect: { status: 409, code: 'GYM_OVERRIDE_ACTIVE' } }),
        control('step-up settings.write', 'stepup?scope=settings.write', { save: { stepUpToken: 'token' } }),
        master('A pass commission above the bounds (expect 422)', 'POST', '/admin/gym-manage/fee-overrides', { body: { scopeType: 'gym', scopeId: '{{gymId}}', key: 'fees.gym_pct', value: 26, reason: 'Too high' }, stepUp: true, expect: { status: 422, code: 'GYM_OVERRIDE_OUT_OF_BOUNDS' } }),
        owner('The owner sees the special rate', 'GET', '/manage/billing', { expect: { status: 200 }, checks: [['owner override, founding', "j.fees.referral.valuePoisha === 15000 && j.fees.referral.source === 'owner_override' && j.founding.partner === true"]] }),
        support('Overrides (manage_gyms reads)', 'GET', '/admin/gym-manage/fee-overrides?ownerId={{ownerId}}', { expect: { status: 200 }, checks: [['one', 'j.items.length === 1']] }),
        control('step-up settings.write', 'stepup?scope=settings.write', { save: { stepUpToken: 'token' } }),
        master('End the override', 'POST', '/admin/gym-manage/fee-overrides/{{overrideId}}/end', { body: { reason: 'Deal over' }, stepUp: true, expect: { status: 200 }, checks: [['ended', "j.status === 'ended'"]] }),
        control('step-up escrow.manage', 'stepup?scope=escrow.manage', { save: { stepUpToken: 'token' } }),
        master('Voiding a paid invoice (expect 409)', 'POST', '/admin/gym-manage/invoices/{{invoiceId}}/void', { body: { reason: 'Duplicate' }, stepUp: true, expect: { status: 409, code: 'GYM_INVOICE_STATE' } }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${collection.item.reduce((n, f) => n + f.item.length, 0)} requests)`);
