'use strict';

/**
 * Builds postman/kriraghor-payouts.postman_collection.json (M07 payouts; the payout half of the
 * Phase 2 exit check). node postman/build-collection-m07.js
 *
 * Variables: adminAccessToken / adminAccessToken2 (masters A and B), accessToken (the payee),
 * accountCode (the code the runner had sent to the payee's phone).
 * Unattended: `node postman/run-m07.js` prepares a released ৳100 test charge for the payee, lowers
 * the four-eyes threshold to ৳50 so this payout needs both masters, pre-mints step-up tokens and runs
 * a worker loop next to the API.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-payouts.postman_collection.json');

/** Requests as the payee (customer token). */
const payee = (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: 'Bearer {{accessToken}}' });
  return r;
};
const idem = (item) => {
  item.request.header.push({ key: 'Idempotency-Key', value: 'pm-{{$guid}}' });
  return item;
};

const collection = {
  info: {
    name: 'Kriraghor API: M07 Payouts',
    description: [
      'The payee adds a bKash payout account with a code from their phone; finance verifies it against the NID name; the daily run turns the released ৳95 into a payout; above the (lowered) four-eyes threshold, masters A and B approve it with step-up; finance reveals the wallet number (audited), sends it by hand and marks it paid with the bKash reference; the payee sees it and the ledger checks pass.',
      'Unattended: `node postman/run-m07.js` (uses the kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m07.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    ['baseUrl', 'http://localhost:4000/api/v1'],
    ['adminAccessToken', ''],
    ['adminAccessToken2', ''],
    ['accessToken', ''],
    ['accountCode', ''],
    ['stepUpToken', ''],
    ['stepUpTokenB', ''],
    ['accountId', ''],
    ['payoutId', ''],
    ['payoutCode', ''],
  ].map(([key, value]) => ({ key, value })),
  item: [
    {
      name: '0. Guards',
      item: [
        req('Payout list without a staff token (expect 401)', 'GET', '/admin/payouts', { as: false, expect: { status: 401 } }),
        payee('Add an account with a wrong number (expect 422)', 'POST', '/me/payout-accounts', {
          body: { type: 'bkash', accountNo: '01212345678', accountName: 'Nusrat Jahan', code: '{{accountCode}}' },
          expect: { status: 422, code: 'PAYOUT_ACCOUNT_INVALID' },
        }),
      ],
    },
    {
      name: '1. Payout account',
      item: [
        payee('Payee adds a bKash account (code from the SMS)', 'POST', '/me/payout-accounts', {
          body: { type: 'bkash', accountNo: '01712345678', accountName: 'Nusrat Jahan', code: '{{accountCode}}' },
          expect: { status: 201 },
          save: { accountId: 'id' },
          checks: [['masked, waiting for review', "j.masked === 'bKash ••• 5678' && j.status === 'pending_verification' && !JSON.stringify(j).includes('01712345678')"]],
        }),
        req('Finance sees it next to the NID name', 'GET', '/admin/payout-accounts', {
          expect: { status: 200 },
          checks: [['in the queue, masked', "j.items.length === 1 && j.items[0].id === pm.collectionVariables.get('accountId') && j.items[0].sameWalletUsers === 0 && !JSON.stringify(j).includes('01712345678')"]],
        }),
        req('Finance verifies it', 'POST', '/admin/payout-accounts/{{accountId}}/verify', {
          body: { note: 'Name matches the NID' },
          expect: { status: 200 },
          checks: [['active, no change hold for a first account', "j.status === 'active' && j.holdUntil === null"]],
        }),
      ],
    },
    {
      name: '2. Payout run and four-eyes',
      item: [
        req('Master runs the daily payouts', 'POST', '/admin/payout-batches/run', {
          body: { schedule: 'daily' },
          expect: { status: 201 },
          checks: [['one payout of ৳95', 'j.created === true && j.batch.totals.payouts === 1 && j.batch.totals.amount === 9500']],
        }),
        req('It needs two approvals', 'GET', '/admin/payouts?status=needs_approval', {
          expect: { status: 200 },
          save: { payoutId: 'items.0.id', payoutCode: 'items.0.code' },
          checks: [['৳95 from ৳100 less the 5% fee', "j.items.length === 1 && j.items[0].amount === 9500 && j.items[0].gross === 10000 && j.items[0].deductions === 500 && j.items[0].account.masked === 'bKash ••• 5678'"]],
        }),
        idem(req('A single release is refused (expect 409)', 'POST', '/admin/payouts/{{payoutId}}/release', { stepUp: true, expect: { status: 409, code: 'INVALID_STATE' } })),
        idem(req('Master A approves (1 of 2)', 'POST', '/admin/payouts/{{payoutId}}/approve', {
          stepUp: true,
          expect: { status: 200 },
          checks: [['still needs approval', "j.status === 'needs_approval' && j.approvals.length === 1"]],
        })),
        idem(req('Master A again (expect 409)', 'POST', '/admin/payouts/{{payoutId}}/approve', { stepUp: true, expect: { status: 409, code: 'SAME_APPROVER' } })),
        idem(req('Master B approves (2 of 2): released', 'POST', '/admin/payouts/{{payoutId}}/approve', {
          as: 'B',
          stepUp: true,
          expect: { status: 200 },
          checks: [['sending', "j.status === 'processing' && j.approvals.length === 2 && j.approvals[0].by !== j.approvals[1].by"]],
        })),
      ],
    },
    {
      name: '3. Send by hand and mark paid',
      item: [
        req('Reveal without step-up (expect 403)', 'POST', '/admin/payouts/{{payoutId}}/reveal', { expect: { status: 403, code: 'STEP_UP_REQUIRED' } }),
        req('Finance reveals the number (audited)', 'POST', '/admin/payouts/{{payoutId}}/reveal', {
          stepUp: true,
          expect: { status: 200 },
          checks: [
            ['full number for 60 s', "j.number === '01712345678' && j.type === 'bkash' && j.amount === 9500 && j.showForSeconds === 60"],
            ['never cached', "pm.response.headers.get('Cache-Control') === 'no-store'"],
          ],
        }),
        idem(req('Finance marks it paid with the bKash reference', 'POST', '/admin/payouts/{{payoutId}}/mark-paid', {
          body: { reference: 'BKX9TR2Q1' },
          expect: { status: 200 },
          checks: [['paid', "j.status === 'paid' && j.providerRef === 'BKX9TR2Q1'"]],
        })),
        req('The reveal is in the payout detail, the number is not', 'GET', '/admin/payouts/{{payoutId}}', {
          expect: { status: 200 },
          checks: [['one reveal, masked only', "j.reveals === 1 && !JSON.stringify(j).includes('01712345678') && j.ledger.length === 2"]],
        }),
        req('Audit log has the critical reveal', 'GET', '/admin/audit-logs?action=payout.account_revealed', {
          expect: { status: 200 },
          checks: [['critical, with step-up', "j.items.length === 1 && j.items[0].severity === 'critical' && j.items[0].stepUp === true"]],
        }),
      ],
    },
    {
      name: '4. Payee and ledger',
      item: [
        payee('Payee sees the payout paid', 'GET', '/me/payouts', {
          expect: { status: 200 },
          checks: [['paid to bKash ••• 5678', "j.items.length === 1 && j.items[0].status === 'paid' && j.items[0].account.masked === 'bKash ••• 5678'"]],
        }),
        payee('Payee summary', 'GET', '/me/payouts/summary', {
          expect: { status: 200 },
          checks: [['paid ৳95 this month, nothing left', 'j.paidThisMonth === 9500 && j.nextPayout.projected === 0 && j.inPayouts === 0']],
        }),
        req('Payout clearing is empty', 'GET', '/admin/ledger/accounts?code=payout_clearing', {
          expect: { status: 200 },
          checks: [['cleared', 'j.items.length === 1 && j.items[0].balance === 0']],
        }),
        req('Trial balance is zero', 'GET', '/admin/ledger/trial-balance', { expect: { status: 200 }, checks: [['balanced', 'j.difference === 0']] }),
        req('Invariant checks pass (with payout_clearing_matches)', 'GET', '/admin/ledger/invariants', {
          expect: { status: 200 },
          checks: [['all ok', "j.ok === true && j.checks.some((c) => c.name === 'payout_clearing_matches' && c.ok)"]],
        }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
const count = collection.item.reduce((n, f) => n + f.item.length, 0);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${count} requests)`);
