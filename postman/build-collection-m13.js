'use strict';

/**
 * Builds postman/kriraghor-orders.postman_collection.json (M13 Orders step 1: shop orders end to end,
 * with M06 split escrow and the M17 not-received dispute). node postman/build-collection-m13.js
 *
 * Variables: adminAccessToken (master A), deskToken (resolve_reports, refund_small), shopAToken and
 * shopBToken (two live shops with boots), buyerToken, vA42 / vA43 / vB42 (the variants), areaDhaka /
 * areaOutside, stepUpQueueA (one escrow.manage step-up), controlUrl (the runner: /pay pays through the
 * simulator, /expire runs the tick past an accept deadline, /check reads the ledger, /settle drains events).
 * Unattended: `node postman/run-m13.js` (kriraghor_test database).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-orders.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const buyer = as('buyerToken');
const shopA = as('shopAToken');
const shopB = as('shopBToken');
const desk = as('deskToken');
const idem = (item, k = 'pm-{{$guid}}') => {
  item.request.header.push({ key: 'Idempotency-Key', value: k });
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
const ship = { name: 'Tanvir Hasan', phone: '01711000111', areaId: '{{areaDhaka}}', line: 'House 12, Road 5, Dhanmondi' };
const checkout = (name, total, save, k) => idem(buyer(name, 'POST', '/checkout', { body: { ship, expectedTotal: total }, expect: { status: 201 }, save }), k);
const add = (name, v, qty, checks) => buyer(name, 'PUT', `/me/cart/items/{{${v}}}`, { body: { qty }, expect: { status: 200 }, checks });

const collection = {
  info: {
    name: 'Kriraghor API: M13 Orders (step 1, shop orders)',
    description: [
      'Two live shops (M12): A sells turf boots at ৳2,600, B at ৳1,200. A buyer with a verified phone (gate buy) puts 2 × A and 1 × B in the cart; the quote has a sub-order per shop with ৳80 delivery each inside Dhaka (৳150 outside); checkout holds the stock and starts one payment split into two escrow holds (M06).',
      'Paid through the simulator: shop A accepts (the address shows only now), ships with a tracking number and marks delivered; the buyer confirms and A is paid ৳5,020 (5% on the ৳5,200 items, none on delivery). Shop B rejects: its ৳1,280 split is refunded from its own hold.',
      'A second order is "not received": an M17 dispute freezes its hold; the desk decides half (৳1,340 back, A keeps ৳1,273 after ৳67). A master cancels a third with step-up; a fourth expires unaccepted; the buyer cancels a fifth before the shop accepts. The ledger invariants hold throughout.',
      'Requests named "Runner" go to the local test runner (pay through the simulator, run the tick, read the ledger).',
      'Unattended: `node postman/run-m13.js` (kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m13.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'controlUrl', 'orderCode', 'paymentId', 'subA', 'subB', 'order2', 'payment2', 'sub2', 'disputeCode', 'version', 'order3', 'payment3', 'sub3', 'order4', 'payment4', 'sub4', 'order5', 'payment5', 'sub5'].map((key) => ({
    key,
    value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '',
  })),
  item: [
    {
      name: '1. The cart and the quote (FR-01 to FR-03)',
      item: [
        shopA('Not your own shop (expect 422)', 'PUT', '/me/cart/items/{{vA42}}', { body: { qty: 1 }, expect: { status: 422, code: 'OWN_ITEM' } }),
        buyer('More than the stock (expect 409)', 'PUT', '/me/cart/items/{{vA42}}', { body: { qty: 4 }, expect: { status: 409, code: 'INSUFFICIENT_STOCK' } }),
        add('Two of A in EU 42', 'vA42', 2),
        add('One of B in EU 42', 'vB42', 1, [['two shops, three items, ৳6,400', "j.shops.length === 2 && j.count === 3 && j.items === 640000 && j.ready === true"]]),
        buyer('Quote outside Dhaka: ৳150 per shop', 'POST', '/checkout/quote', { body: { areaId: '{{areaOutside}}' }, expect: { status: 200 }, checks: [['delivery ৳300, total ৳6,700', 'j.delivery === 30000 && j.total === 670000']] }),
        buyer('Quote in Dhanmondi: ৳80 per shop', 'POST', '/checkout/quote', {
          body: { areaId: '{{areaDhaka}}' },
          expect: { status: 200 },
          checks: [
            ['two sub-orders', "j.subOrders.map((s) => s.total).join(',') === '528000,128000'"],
            ['total ৳6,560, no price changes', 'j.total === 656000 && j.changes.length === 0'],
          ],
        }),
      ],
    },
    {
      name: '2. Checkout and payment (FR-04 to FR-07, M06 splits)',
      item: [
        idem(buyer('A stale total is refused (expect 409)', 'POST', '/checkout', { body: { ship, expectedTotal: 650000 }, expect: { status: 409, code: 'PRICE_CHANGED' }, checks: [['the new quote', 'j.quote.total === 656000']] })),
        checkout('Place the order', 656000, { orderCode: 'order.code', paymentId: 'payment.id', subA: 'order.subOrders.0.id', subB: 'order.subOrders.1.id' }, 'pm-order-one-{{orderRun}}'),
        checkout('Replay with the same key: the same order', 656000, {}, 'pm-order-one-{{orderRun}}'),
        buyer('Pending payment, phone masked', 'GET', '/me/orders/{{orderCode}}', {
          expect: { status: 200 },
          checks: [['pending', "j.order.status === 'pending_payment' && j.order.shipTo.phoneLast4 === '0111' && j.payment.payUrl.includes('/pay/')"]],
        }),
        control('pay through the simulator', 'pay?paymentId={{paymentId}}'),
        buyer('Placed; each sub-order has its deadline', 'GET', '/me/orders/{{orderCode}}', {
          expect: { status: 200 },
          checks: [['placed', "j.order.status === 'placed' && j.order.subOrders.every((s) => s.status === 'placed' && s.acceptBy)"], ['no payment link', 'j.payment === null']],
        }),
        buyer('The cart is empty', 'GET', '/me/cart', { expect: { status: 200 }, checks: [['empty', 'j.count === 0']] }),
      ],
    },
    {
      name: '3. Shop A fulfils, the buyer confirms (FR-08 to FR-14)',
      item: [
        shopA('To accept: the area, not the address (FR-10)', 'GET', '/shop/sub-orders?tab=to_accept', {
          expect: { status: 200 },
          checks: [['one, no address', 'j.items.length === 1 && j.items[0].shipTo === null && j.items[0].area !== null'], ['net ৳5,020', 'j.items[0].money.commission === 26000 && j.items[0].money.net === 502000']],
        }),
        shopB('Another shop cannot accept it (expect 403)', 'POST', '/shop/sub-orders/{{subA}}/accept', { expect: { status: 403, code: 'NOT_YOUR_SHOP' } }),
        buyer('The buyer is not a shop (expect 403)', 'GET', '/shop/sub-orders', { expect: { status: 403 } }),
        shopA('Shipping before accepting (expect 409)', 'POST', '/shop/sub-orders/{{subA}}/ship', { body: { courierName: 'Pathao', trackingNo: 'PTH-1001' }, expect: { status: 409, code: 'ORDER_STATE' } }),
        shopA('Accept: the address shows', 'POST', '/shop/sub-orders/{{subA}}/accept', { expect: { status: 200 }, checks: [['address', "j.status === 'accepted' && j.shipTo.phone === '+8801711000111' && j.shipTo.line.startsWith('House 12')"]] }),
        shopA('A bad tracking number (expect 422)', 'POST', '/shop/sub-orders/{{subA}}/ship', { body: { courierName: 'Pathao', trackingNo: 'x' }, expect: { status: 422 } }),
        shopA('Ship with Pathao', 'POST', '/shop/sub-orders/{{subA}}/ship', { body: { courierName: 'Pathao', trackingNo: 'PTH-1001' }, expect: { status: 200 }, checks: [['shipped', "j.status === 'shipped' && j.courier.trackingNo === 'PTH-1001'"]] }),
        shopA('Mark delivered', 'POST', '/shop/sub-orders/{{subA}}/delivered', { expect: { status: 200 }, checks: [['auto-complete set', "j.status === 'delivered' && Boolean(j.completeBy)"]] }),
        buyer('The buyer can confirm or report it', 'GET', '/me/orders/{{orderCode}}', { expect: { status: 200 }, checks: [['can', 'j.order.subOrders[0].can.received === true && j.order.subOrders[0].can.notReceived === true']] }),
        buyer('Received', 'POST', '/me/sub-orders/{{subA}}/received', { expect: { status: 200 }, checks: [['completed', "j.order.subOrders[0].status === 'completed'"]] }),
        shopB('B rejects its sub-order (out of stock)', 'POST', '/shop/sub-orders/{{subB}}/reject', { body: { reason: 'out_of_stock' }, expect: { status: 200 }, checks: [['refunded ৳1,280', "j.status === 'rejected' && j.money.refunded === 128000"]] }),
        buyer('The order is complete', 'GET', '/me/orders/{{orderCode}}', { expect: { status: 200 }, checks: [['completed', "j.order.status === 'completed'"]] }),
        control('ledger: A has ৳5,020, B nothing, fee ৳260', 'check', { checks: [['balanced', 'j.invariantsOk === true'], ['payables', 'j.payableA === 502000 && j.payableB === 0 && j.feeRevenue === 26000']] }),
        shopA('Settlement', 'GET', '/shop/settlement', { expect: { status: 200 }, checks: [['one completed, ৳5,020 net', 'j.completed.count === 1 && j.completed.net === 502000 && j.inEscrow.count === 0']] }),
      ],
    },
    {
      name: '4. Not received: an M17 dispute (category not_received)',
      item: [
        add('One of A in EU 43', 'vA43', 1),
        checkout('Order two', 268000, { order2: 'order.code', payment2: 'payment.id', sub2: 'order.subOrders.0.id' }),
        control('pay order two', 'pay?paymentId={{payment2}}'),
        shopA('Accept order two', 'POST', '/shop/sub-orders/{{sub2}}/accept', { expect: { status: 200 } }),
        shopA('Ship order two', 'POST', '/shop/sub-orders/{{sub2}}/ship', { body: { courierName: 'Steadfast', trackingNo: 'SF-889201' }, expect: { status: 200 } }),
        buyer('What the buyer can open', 'GET', '/me/disputes/options?sourceType=sub_order&sourceId={{sub2}}', { expect: { status: 200 }, checks: [['not_received ৳2,680', "j.items[0].category === 'not_received' && j.items[0].held === 268000"]] }),
        idem(
          buyer('Not received', 'POST', '/me/sub-orders/{{sub2}}/not-received', {
            body: { statement: 'Steadfast says delivered; nothing came to the flat' },
            expect: { status: 201 },
            save: { disputeCode: 'dispute.code' },
            checks: [['awaiting the shop', "j.dispute.status === 'awaiting_response' && j.dispute.policyKey === 'order.not_received'"]],
          })
        ),
        buyer('Received is blocked while disputed (expect 409)', 'POST', '/me/sub-orders/{{sub2}}/received', { expect: { status: 409, code: 'ORDER_STATE' } }),
        shopA('The shop answers', 'POST', '/me/disputes/{{disputeCode}}/respond', { body: { text: 'Steadfast has a signed slip from the guard' }, expect: { status: 200 } }),
        desk('The desk claims it: previews without delivery fee', 'POST', '/admin/disputes/{{disputeCode}}/claim', {
          expect: { status: 200 },
          save: { version: 'dispute.version' },
          checks: [['half: ৳1,340 back, fee ৳67', 'j.previews.half.refund === 134000 && j.previews.half.fee === 6700'], ['none: fee on items only', 'j.previews.none.feeBase === 260000']],
        }),
        numeric(
          idem(
            desk('Decide half', 'POST', '/admin/disputes/{{disputeCode}}/decide', {
              body: { outcome: 'half', reason: 'No proof of hand-over at the flat', version: '{{version}}' },
              expect: { status: 200 },
              checks: [['resolved', "j.dispute.status === 'resolved' && j.dispute.refund === 134000 && j.dispute.fee === 6700"]],
            })
          ),
          'version',
          'version'
        ),
        control('ledger: A has ৳6,293, fee ৳327', 'check', { checks: [['balanced', 'j.invariantsOk === true'], ['payable', 'j.payableA === 629300 && j.feeRevenue === 32700']] }),
      ],
    },
    {
      name: '5. Staff, deadlines and cancellations',
      item: [
        add('One of A in EU 43 again', 'vA43', 1),
        checkout('Order three', 268000, { order3: 'order.code', payment3: 'payment.id', sub3: 'order.subOrders.0.id' }),
        control('pay order three', 'pay?paymentId={{payment3}}'),
        req('Staff: find it by sub-order code', 'GET', '/admin/orders?code={{order3}}-A', { expect: { status: 200 }, checks: [['one', 'j.items.length === 1']] }),
        desk('Staff: the order with its escrow hold, no phone', 'GET', '/admin/orders/{{order3}}', {
          expect: { status: 200 },
          checks: [['holding ৳2,680', "j.subOrders[0].escrow.held === 268000 && j.subOrders[0].escrow.status === 'holding'"], ['no phone', "!JSON.stringify(j).includes('01711000111')"]],
        }),
        req('A master cancels it for the platform (step-up)', 'POST', '/admin/orders/sub-orders/{{sub3}}/cancel', {
          stepUp: true,
          body: { reason: 'The shop is closed this week' },
          expect: { status: 200 },
          checks: [['cancelled, refunded', "j.subOrders[0].status === 'cancelled' && j.subOrders[0].money.refunded === 268000"]],
        }),
        add('One of A in EU 42', 'vA42', 1),
        checkout('Order four', 268000, { order4: 'order.code', payment4: 'payment.id', sub4: 'order.subOrders.0.id' }),
        control('pay order four', 'pay?paymentId={{payment4}}'),
        control('the accept deadline passes', 'expire?subOrderId={{sub4}}', { checks: [['expired one', 'j.tick.expired === 1']] }),
        buyer('Expired and refunded', 'GET', '/me/orders/{{order4}}', { expect: { status: 200 }, checks: [['expired', "j.order.status === 'cancelled' && j.order.subOrders[0].status === 'expired' && j.order.subOrders[0].money.refunded === 268000"]] }),
        add('One of B', 'vB42', 1),
        checkout('Order five', 128000, { order5: 'order.code', payment5: 'payment.id', sub5: 'order.subOrders.0.id' }),
        control('pay order five', 'pay?paymentId={{payment5}}'),
        buyer('The buyer cancels before B accepts', 'POST', '/me/sub-orders/{{sub5}}/cancel', { body: { reason: 'changed_mind' }, expect: { status: 200 }, checks: [['cancelled', "j.order.subOrders[0].status === 'cancelled' && j.order.subOrders[0].money.refunded === 128000"]] }),
        buyer('My orders', 'GET', '/me/orders', { expect: { status: 200 }, checks: [['five', 'j.items.length === 5']] }),
        control('ledger still balanced', 'check', { checks: [['balanced', 'j.invariantsOk === true']] }),
      ],
    },
  ],
};

// A fixed key per run for the replay check (the runner gives none; the guid keeps runs apart).
collection.event = [{ listen: 'prerequest', script: { type: 'text/javascript', exec: ["if (!pm.collectionVariables.get('orderRun')) pm.collectionVariables.set('orderRun', pm.variables.replaceIn('{{$guid}}'));"] } }];
collection.variable.push({ key: 'orderRun', value: '' });

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
