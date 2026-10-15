'use strict';

/**
 * Builds postman/kriraghor-payments.postman_collection.json (M06 payments, ledger and escrow; the
 * money half of the Phase 2 exit check). node postman/build-collection-m06.js
 *
 * Variables: adminAccessToken (master), accessToken (the payer, a member), payerId, payeeId.
 * Unattended: `node postman/run-m06.js` signs them in, pre-mints the master's escrow.manage step-up
 * token and runs a worker loop (outbox, consumers, notifications, payment jobs) next to the API.
 * The gateway is the built-in SSLCommerz simulator.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-payments.postman_collection.json');

/** Adds lines to a request's test script. */
const script = (item, lines) => {
  item.event.find((e) => e.listen === 'test').script.exec.push(...lines);
  return item;
};
/** Requests as the payer (customer token). */
const payer = (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: 'Bearer {{accessToken}}' });
  return r;
};
/** A fresh Idempotency-Key per request ({{$guid}} is a Postman dynamic variable). */
const idem = (item) => {
  item.request.header.push({ key: 'Idempotency-Key', value: 'pm-{{$guid}}' });
  return item;
};

/** A raw request to an absolute URL held in a variable, without following redirects. */
const raw = (name, method, urlVar, { form, checks }) => ({
  name,
  protocolProfileBehavior: { followRedirects: false },
  event: [{ listen: 'test', script: { type: 'text/javascript', exec: checks } }],
  request: {
    method,
    header: form ? [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }] : [],
    ...(form ? { body: { mode: 'urlencoded', urlencoded: Object.entries(form).map(([key, value]) => ({ key, value })) } } : {}),
    url: `{{${urlVar}}}`,
  },
});

const collection = {
  info: {
    name: 'Kriraghor API: M06 Payments, ledger and escrow',
    description: [
      'A master creates a ৳100 test charge; the payer pays with bKash on the SSLCommerz simulator; the money waits in escrow; the master releases it with step-up (payee ৳95, fee ৳5); a partial refund goes back through the gateway; the day is reconciled and the ledger checks pass.',
      'Unattended: `node postman/run-m06.js` (uses the kriraghor_test database and the built-in simulator).',
      'Rebuild this file with: node postman/build-collection-m06.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    ['baseUrl', 'http://localhost:4000/api/v1'],
    ['adminAccessToken', ''],
    ['accessToken', ''],
    ['payerId', ''],
    ['payeeId', ''],
    ['stepUpToken', ''],
    ['paymentId', ''],
    ['paymentCode', ''],
    ['holdId', ''],
    ['gatewayPay', ''],
    ['returnUrl', ''],
    ['refundId', ''],
    ['runId', ''],
    ['businessDate', ''],
  ].map(([key, value]) => ({ key, value })),
  item: [
    {
      name: '0. Guards',
      item: [
        idem(req('Test charge as a payer (expect 401)', 'POST', '/admin/payments/test-charges', { as: false, body: { payerId: '{{payerId}}', payeeId: '{{payeeId}}', amount: 100 }, expect: { status: 401 } })),
        req('Test charge without an Idempotency-Key (expect 400)', 'POST', '/admin/payments/test-charges', {
          body: { payerId: '{{payerId}}', payeeId: '{{payeeId}}', amount: 100 },
          expect: { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' },
        }),
        idem(req('Test charge above the maximum (expect 422)', 'POST', '/admin/payments/test-charges', {
          body: { payerId: '{{payerId}}', payeeId: '{{payeeId}}', amount: 100001 },
          expect: { status: 422 },
        })),
      ],
    },
    {
      name: '1. Pay into escrow',
      item: [
        idem(req('Master creates a ৳100 test charge', 'POST', '/admin/payments/test-charges', {
          body: { payerId: '{{payerId}}', payeeId: '{{payeeId}}', amount: 10000, title: 'Postman test charge' },
          expect: { status: 201 },
          save: { paymentId: 'payment.id', paymentCode: 'payment.code' },
          checks: [['initiated, PAY code', "j.payment.status === 'initiated' && /^PAY-\\d{2}-\\d{6}$/.test(j.payment.code)"]],
        })),
        payer('Payer opens the payment', 'GET', '/payments/{{paymentId}}', {
          expect: { status: 200 },
          checks: [['three methods', "j.methods.join() === 'bkash,nagad,card' && j.amount === 10000"]],
        }),
        script(
          idem(payer('Payer starts paying with bKash', 'POST', '/payments/{{paymentId}}/attempts', { body: { method: 'bkash' }, expect: { status: 201 } })),
          ["if (j && j.redirectUrl) pm.collectionVariables.set('gatewayPay', j.redirectUrl);", "pm.test('gateway page', () => pm.expect(j.redirectUrl).to.match(/\\/dev\\/sslcommerz\\/pay\\//));"]
        ),
        raw('Gateway: the payer pays (simulator)', 'POST', 'gatewayPay', {
          form: { outcome: 'success' },
          checks: [
            "pm.test('303 back to the API', () => pm.response.to.have.status(303));",
            "const loc = pm.response.headers.get('Location'); pm.collectionVariables.set('returnUrl', loc);",
            "pm.test('return URL carries tran_id and val_id', () => pm.expect(loc).to.match(/payments\\/return\\/sslcommerz\\?pid=.*tran_id=.*val_id=/));",
          ],
        }),
        raw('Browser comes back through the return URL', 'GET', 'returnUrl', {
          checks: [
            "pm.test('303 to the web result page', () => pm.response.to.have.status(303));",
            "pm.test('result page', () => pm.expect(pm.response.headers.get('Location')).to.match(new RegExp('/pay/' + pm.collectionVariables.get('paymentId') + '/result$')));",
          ],
        }),
        payer('Payment succeeded (verified by the server)', 'GET', '/payments/{{paymentId}}', {
          expect: { status: 200 },
          checks: [['succeeded with bKash', "j.status === 'succeeded' && j.captured === 10000 && j.methodDisplay === 'bKash ••• 4321'"]],
        }),
        req('Finance sees the hold and the capture posting', 'GET', '/admin/payments/{{paymentId}}', {
          expect: { status: 200 },
          save: { holdId: 'hold.id' },
          checks: [
            ['holding ৳100, fee 5% snapshotted', "j.hold.status === 'holding' && j.hold.available === 10000 && j.hold.fee.bps === 500"],
            ['capture posted', "j.ledger.length === 1 && j.ledger[0].kind === 'payment.capture'"],
          ],
        }),
      ],
    },
    {
      name: '2. Release and refund',
      item: [
        req('Release without step-up (expect 403)', 'POST', '/admin/escrow/{{holdId}}/release', { body: { reason: 'Postman exit check' }, expect: { status: 403, code: 'STEP_UP_REQUIRED' } }),
        req('Master releases with step-up', 'POST', '/admin/escrow/{{holdId}}/release', {
          stepUp: true,
          body: { amount: 7000, reason: 'Postman exit check: first tranche' },
          expect: { status: 200 },
          checks: [['payee ৳66.50, fee ৳3.50', "j.gross === 7000 && j.fee === 350 && j.net === 6650 && j.hold.status === 'partially_released'"]],
        }),
        idem(req('Refund ৳20 of what is still held', 'POST', '/admin/refunds', {
          body: { paymentId: '{{paymentId}}', amount: 2000, reasonCode: 'customer_request', reasonText: 'Postman partial refund' },
          expect: { status: 201 },
          save: { refundId: 'id' },
          checks: [['approved from escrow', "j.status === 'approved' && j.source === 'escrow'"]],
        })),
        idem(req('Refund more than is left (expect 422)', 'POST', '/admin/refunds', {
          body: { paymentId: '{{paymentId}}', amount: 1001, reasonCode: 'customer_request' },
          expect: { status: 422, code: 'REFUND_EXCEEDS_HELD' },
        })),
        req('The gateway confirmed the refund', 'GET', '/admin/refunds?paymentId={{paymentId}}', {
          waitMs: 2500,
          expect: { status: 200 },
          checks: [['succeeded', "j.items[0].status === 'succeeded' && j.items[0].amount === 2000"]],
        }),
        payer('Payer sees the partial refund', 'GET', '/me/payments', {
          expect: { status: 200 },
          checks: [['partially refunded', "j.items[0].status === 'partially_refunded' && j.items[0].refunds[0].status === 'succeeded'"]],
        }),
      ],
    },
    {
      name: '3. Ledger and reconciliation',
      item: [
        req('Payee balance and platform fee', 'GET', '/admin/ledger/accounts?code=payable', {
          expect: { status: 200 },
          checks: [['payee owed ৳66.50', "j.items.length === 1 && j.items[0].balance === 6650"]],
        }),
        req('Escrow still holds ৳10', 'GET', '/admin/ledger/accounts?code=escrow', {
          expect: { status: 200 },
          checks: [['৳10 left', "j.items[0].balance === 1000"]],
        }),
        req('Trial balance is zero', 'GET', '/admin/ledger/trial-balance', { expect: { status: 200 }, checks: [['balanced', 'j.difference === 0']] }),
        req('Invariant checks pass', 'GET', '/admin/ledger/invariants', { expect: { status: 200 }, checks: [['all ok', 'j.ok === true && j.checks.length === 5']] }),
        req('Reconcile today', 'POST', '/admin/reconciliation/runs', {
          body: { businessDate: '{{businessDate}}' },
          expect: { status: 201 },
          save: { runId: 'id' },
          checks: [['all matched', "j.status === 'completed' && j.totals.matched === 2 && j.totals.exceptions === 0"]],
        }),
        req('Reconcile today again (expect 409)', 'POST', '/admin/reconciliation/runs', { body: { businessDate: '{{businessDate}}' }, expect: { status: 409, code: 'RECON_RUN_EXISTS' } }),
        req('Run items', 'GET', '/admin/reconciliation/runs/{{runId}}/items', {
          expect: { status: 200 },
          checks: [['capture and refund matched', "j.items.filter((i) => i.type === 'matched').length === 2"]],
        }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
const count = collection.item.reduce((n, f) => n + f.item.length, 0);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${count} requests)`);
