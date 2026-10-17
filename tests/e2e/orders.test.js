'use strict';

// M13 Orders step 1 end to end: the cart (FR-01, FR-02), checkout with one payment split into an
// escrow hold per shop (FR-03 to FR-07, M06 splits), the shop's accept / reject / ship / delivered
// (FR-08 to FR-12; the address only after accepting, FR-10), received and auto-complete releasing
// the shop's money minus 5% on the items (FR-13, FR-14), the deadlines (accept expiry, late shipping),
// payment timeouts and late captures refunded hold by hold, "not received" as an M17 dispute, the
// staff desk and M07's weekly shop payout.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const ledger = require('../../src/modules/payments/ledger.service');
const payouts = require('../../src/modules/payouts/payouts.service');
const orderJobs = require('../../src/modules/orders/orders.jobs');
const orderReads = require('../../src/modules/orders/orders.reads');

const { api, P, models } = h;

let master;
let reviewer;
let docsReviewer;
let seq = 0;
const key = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  reviewer = await f.staffWith(master, ['approve_listings']);
  docsReviewer = await f.staffWith(master, ['approve_documents']);
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

/** A live shop with boots in the given sizes (each with `stock`), at `price` poisha. */
async function shopWithBoots(name, { price = 260000, stock = 2, sizes = ['42', '43'] } = {}) {
  const owner = await f.shopOwner(docsReviewer, name);
  await f.liveShop(owner, reviewer, { name });
  const ready = await f.readyBoots(owner, { sizes, stock, over: { title: `${name} Turf Boots`, basePricePoisha: price } });
  const product = await f.liveProduct(owner, reviewer, ready);
  const variant = (size) => product.variants.find((v) => v.attributes.eu_size === size).id;
  return { owner, product, variant };
}

const add = (who, variantId, qty = 1) => api().put(`${P}/me/cart/items/${variantId}`).set(h.bearer(who)).send({ qty });
const shipTo = async (area = 'dhanmondi') => ({ name: 'Tanvir Hasan', phone: '01711000111', areaId: typeof area === 'string' ? await f.areaId(area) : area, line: 'House 12, Road 5, Dhanmondi' });
async function checkout(who, { area = 'dhanmondi', expectedTotal, idem, status = 201 } = {}) {
  const ship = await shipTo(area);
  const total = expectedTotal ?? (await api().post(`${P}/checkout/quote`).set(h.bearer(who)).send({ areaId: ship.areaId }).expect(200)).body.total;
  const req = api().post(`${P}/checkout`).set(h.bearer(who)).set('Idempotency-Key', idem ?? key('co')).send({ ship, expectedTotal: total });
  return status ? req.expect(status) : req;
}
async function pay(who, placed) {
  await h.payWithSimulator(who, placed.body.payment.id);
  await h.drainEvents();
}
/** A buyer with a paid order from the given (shop, variant, qty) lines. */
async function paidOrder(lines, buyer) {
  const b = buyer ?? (await h.signupUser({ name: 'Tanvir Hasan' }));
  for (const [shop, size, qty] of lines) await add(b, shop.variant(size), qty).expect(200);
  const r = await checkout(b);
  await pay(b, r);
  return { buyer: b, order: r.body.order, paymentId: r.body.payment.id, subs: await models.SubOrder.findAll({ where: { orderId: r.body.order.id }, order: [['code', 'ASC']] }) };
}
const shopPost = (who, id, action, body) => api().post(`${P}/shop/sub-orders/${id}/${action}`).set(h.bearer(who)).send(body ?? {});
const buyerPost = (who, id, action, body) => api().post(`${P}/me/sub-orders/${id}/${action}`).set(h.bearer(who)).send(body ?? {});
const variantRow = (id) => models.ProductVariant.findByPk(id);
const holdOf = (paymentId, sub) => models.EscrowHold.findOne({ where: { paymentId, splitRef: sub.id } });
const codesOf = async (userId) => (await models.Notification.findAll({ where: { userId } })).map((n) => n.code);
const payable = (who) => ledger.balance(`payable:user:${who.user.id}`);

describe('M13 shop orders', () => {
  it('two shops, one payment, two holds: A ships and is paid ৳5,020 net; B rejects and its split is refunded (FR-01 to FR-14)', async () => {
    const A = await shopWithBoots('Elephant Road Sports');
    const B = await shopWithBoots('Gulshan Boot House', { price: 120000 });
    const buyer = await h.signupUser({ name: 'Tanvir Hasan' });

    // The cart: grouped by shop, live prices; not your own items; at most the stock.
    expect((await add(A.owner, A.variant('42')).expect(422)).body.code).toBe('OWN_ITEM');
    expect((await add(buyer, A.variant('42'), 3).expect(409)).body.code).toBe('INSUFFICIENT_STOCK');
    await add(buyer, A.variant('42'), 2).expect(200);
    const cart = (await add(buyer, B.variant('42'), 1).expect(200)).body;
    expect(cart).toMatchObject({ count: 3, items: 640000, ready: true });
    expect(cart.shops.map((s) => s.shop.name)).toEqual(['Elephant Road Sports', 'Gulshan Boot House']);

    // The quote: a sub-order per shop, ৳80 each inside Dhaka.
    const area = await f.areaId('dhanmondi');
    const q = (await api().post(`${P}/checkout/quote`).set(h.bearer(buyer)).send({ areaId: area }).expect(200)).body;
    expect(q).toMatchObject({ items: 640000, delivery: 16000, total: 656000, changes: [] });
    expect(q.subOrders.map((s) => [s.items, s.delivery, s.total])).toEqual([
      [520000, 8000, 528000],
      [120000, 8000, 128000],
    ]);

    // Place: stock held, one payment, order pending until paid.
    const placed = await checkout(buyer);
    const { order } = placed.body;
    expect(order).toMatchObject({ status: 'pending_payment', money: { total: 656000 }, shipTo: { phoneLast4: '0111', line: 'House 12, Road 5, Dhanmondi' } });
    expect(order.subOrders.map((s) => s.code)).toEqual([`${order.code}-A`, `${order.code}-B`]);
    expect(placed.body.payment.payUrl).toContain(`/pay/${placed.body.payment.id}`);
    expect((await variantRow(A.variant('42'))).held).toBe(2);
    const row = await models.Order.findByPk(order.id);
    expect(row.shipPhoneEnc).not.toContain('01711000111');

    // Paid: one capture posting, one hold per sub-order (M06 splits); the cart empties.
    await pay(buyer, placed);
    expect((await models.Order.findByPk(order.id)).status).toBe('placed');
    const [a, b] = await models.SubOrder.findAll({ where: { orderId: order.id }, order: [['code', 'ASC']] });
    expect([a.status, b.status]).toEqual(['placed', 'placed']);
    expect(a.acceptBy).not.toBeNull();
    const holds = await models.EscrowHold.findAll({ where: { paymentId: placed.body.payment.id }, order: [['heldPoisha', 'DESC']] });
    expect(holds.map((x) => [x.splitRef, x.heldPoisha, x.payeeId, x.purpose])).toEqual([
      [a.id, 528000, A.owner.user.id, 'market_order'],
      [b.id, 128000, B.owner.user.id, 'market_order'],
    ]);
    const capture = await models.LedgerTransaction.findOne({ where: { kind: 'payment.capture', refId: placed.body.payment.id } });
    expect(await models.LedgerEntry.count({ where: { txnId: capture.id } })).toBe(3);
    expect((await api().get(`${P}/me/cart`).set(h.bearer(buyer)).expect(200)).body.count).toBe(0);
    expect(await codesOf(A.owner.user.id)).toContain('SHOP_NEW_ORDER');
    expect(await codesOf(buyer.user.id)).toContain('ORDER_PLACED');

    // The shop desk: the area before accepting, the address after (FR-10); RBAC.
    const desk = (await api().get(`${P}/shop/sub-orders?tab=to_accept`).set(h.bearer(A.owner)).expect(200)).body;
    expect(desk.items).toHaveLength(1);
    expect(desk.items[0]).toMatchObject({ code: a.code, shipTo: null, area: expect.objectContaining({ nameEn: 'Dhanmondi' }), money: { items: 520000, delivery: 8000, commission: 26000, net: 502000 } });
    expect(desk.counts).toMatchObject({ to_accept: 1, to_ship: 0 });
    expect((await shopPost(B.owner, a.id, 'accept').expect(403)).body.code).toBe('NOT_YOUR_SHOP');
    await shopPost(buyer, a.id, 'accept').expect(403);
    expect((await shopPost(A.owner, a.id, 'ship', { courierName: 'Pathao', trackingNo: 'PTH-1001' }).expect(409)).body.code).toBe('ORDER_STATE');
    const accepted = (await shopPost(A.owner, a.id, 'accept').expect(200)).body;
    expect(accepted.shipTo).toMatchObject({ name: 'Tanvir Hasan', phone: '+8801711000111', line: 'House 12, Road 5, Dhanmondi' });

    // Ship: the held stock leaves the shelf; then delivered.
    await shopPost(A.owner, a.id, 'ship', { courierName: 'Pathao', trackingNo: 'no' }).expect(422);
    await shopPost(A.owner, a.id, 'ship', { courierName: 'Pathao', trackingNo: 'PTH-1001' }).expect(200);
    expect(await variantRow(A.variant('42'))).toMatchObject({ onHand: 0, held: 0 });
    const delivered = (await shopPost(A.owner, a.id, 'delivered').expect(200)).body;
    expect(delivered.completeBy).not.toBeNull();
    const mine = (await api().get(`${P}/me/orders/${order.code}`).set(h.bearer(buyer)).expect(200)).body.order;
    expect(mine.subOrders[0]).toMatchObject({ status: 'delivered', courier: { name: 'Pathao', trackingNo: 'PTH-1001' }, can: { received: true, notReceived: true, cancel: false } });

    // Received: A's hold is released, 5% on the ৳5,200 items only (৳260): ৳5,020 to A's payable.
    await buyerPost(buyer, a.id, 'received').expect(200);
    await h.drainEvents();
    expect(await models.SubOrder.findByPk(a.id)).toMatchObject({ status: 'completed', completedBy: 'buyer', releasedPoisha: 528000 });
    expect(await payable(A.owner)).toBe(502000);
    expect(await ledger.balance('fee_revenue:market')).toBe(26000);
    expect(await codesOf(A.owner.user.id)).toContain('ORDER_COMPLETED');

    // B rejects the whole sub-order: its split (৳1,280) is refunded from its own hold, the stock freed.
    await shopPost(B.owner, b.id, 'reject', { reason: 'out_of_stock' }).expect(200);
    await h.drainEvents();
    const refund = await models.Refund.findOne({ where: { paymentId: placed.body.payment.id } });
    expect(refund).toMatchObject({ amountPoisha: 128000, escrowHoldId: holds[1].id, reasonCode: 'shop_rejected' });
    expect((await variantRow(B.variant('42'))).held).toBe(0);
    expect((await models.Order.findByPk(order.id)).status).toBe('completed');
    expect(await codesOf(buyer.user.id)).toEqual(expect.arrayContaining(['ORDER_ACCEPTED', 'ORDER_SHIPPED', 'ORDER_DELIVERED', 'ORDER_REJECTED']));
    expect(await payable(B.owner)).toBe(0);

    // M07: Thursday's shop run pays A its ৳5,020.
    await payouts.buildBatch({ schedule: 'shop_weekly', windowEnd: new Date(Date.now() + 1000) });
    expect(await models.Payout.findOne({ where: { payeeId: A.owner.user.id } })).toMatchObject({ amountPoisha: 502000, kind: 'earning' });
    expect(await models.AuditLog.count({ where: { action: ['order.created', 'sub_order.accepted', 'sub_order.shipped', 'sub_order.delivered', 'sub_order.completed', 'sub_order.rejected'] } })).toBe(6);
  });

  it('the last pair: two checkouts at once, one wins; a replay gives the same order; a changed price is refused (FR-03, FR-05)', async () => {
    const A = await shopWithBoots('Elephant Road Sports', { stock: 1, sizes: ['42'] });
    const b1 = await h.signupUser({ name: 'First Buyer' });
    const b2 = await h.signupUser({ name: 'Second Buyer' });
    await add(b1, A.variant('42')).expect(200);
    await add(b2, A.variant('42')).expect(200);

    const stale = await checkout(b1, { expectedTotal: 1, status: 409 });
    expect(stale.body).toMatchObject({ code: 'PRICE_CHANGED', quote: { total: 268000 } });
    expect((await variantRow(A.variant('42'))).held).toBe(0);

    const idem = key('race');
    const [r1, r2] = await Promise.all([checkout(b1, { idem, status: null }), checkout(b2, { status: null })]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const [won, lost] = r1.status === 201 ? [r1, r2] : [r2, r1];
    expect(lost.body.code).toBe('INSUFFICIENT_STOCK');
    expect((await variantRow(A.variant('42'))).held).toBe(1);
    if (won === r1) {
      const again = await checkout(b1, { idem });
      expect(again.body.order.id).toBe(r1.body.order.id);
    }
    expect(await models.Order.count()).toBe(1);
  });

  it('an unpaid order lapses and frees the stock; a capture after that is refunded hold by hold (late_capture)', async () => {
    const A = await shopWithBoots('Elephant Road Sports');
    const B = await shopWithBoots('Gulshan Boot House', { price: 120000 });
    const buyer = await h.signupUser({ name: 'Late Payer' });
    await add(buyer, A.variant('42'), 1).expect(200);
    await add(buyer, B.variant('43'), 1).expect(200);
    const r = await checkout(buyer);
    const attempt = await api().post(`${P}/payments/${r.body.payment.id}/attempts`).set(h.bearer(buyer)).set('Idempotency-Key', key('att')).send({ method: 'bkash' }).expect(201);
    await models.Order.update({ payBy: new Date(Date.now() - 60 * 60000) }, { where: { id: r.body.order.id } });
    expect((await orderJobs.tick()).unpaid).toBe(1);
    expect((await models.Order.findByPk(r.body.order.id)).status).toBe('cancelled');
    expect((await variantRow(A.variant('42'))).held).toBe(0);
    expect((await variantRow(B.variant('43'))).held).toBe(0);

    await h.simulator.pay(attempt.body.redirectUrl.split('/').pop(), 'success');
    await h.drainEvents();
    const refunds = await models.Refund.findAll({ where: { paymentId: r.body.payment.id, kind: 'late_capture' } });
    expect(refunds.map((x) => x.amountPoisha).sort((x, y) => x - y)).toEqual([128000, 268000]);
    expect(new Set(refunds.map((x) => x.escrowHoldId)).size).toBe(2);
    // Nobody is told about an order that was never paid in time.
    expect(await codesOf(buyer.user.id)).not.toContain('ORDER_CANCELLED');
    expect(await codesOf(A.owner.user.id)).not.toContain('SHOP_NEW_ORDER');
  });

  it('deadlines: a reminder and accept expiry, the buyer cancelling a late shipment, auto-cancel and auto-complete (FR-08, FR-09, FR-14)', async () => {
    const A = await shopWithBoots('Elephant Road Sports', { stock: 5 });
    const B = await shopWithBoots('Gulshan Boot House', { price: 120000, stock: 5 });

    // A never accepts: reminded once 4 h before, then expired with a full refund.
    const one = await paidOrder([
      [A, '42', 1],
      [B, '42', 1],
    ]);
    const [a1, b1] = one.subs;
    expect((await orderJobs.tick(new Date(a1.acceptBy.getTime() - 3 * 3600000))).reminded).toBe(2);
    expect((await orderJobs.tick(new Date(a1.acceptBy.getTime() - 2 * 3600000))).reminded).toBe(0);
    await shopPost(B.owner, b1.id, 'accept').expect(200);
    expect((await orderJobs.tick(new Date(a1.acceptBy.getTime() + 1000))).expired).toBe(1);
    expect(await models.SubOrder.findByPk(a1.id)).toMatchObject({ status: 'expired', cancelReason: 'not_accepted', refundedPoisha: 268000 });
    expect((await variantRow(A.variant('42'))).held).toBe(0);

    // B accepted but is late: the buyer may cancel only from ship_by + 24 h.
    expect((await buyerPost(one.buyer, b1.id, 'cancel').expect(409)).body.code).toBe('CANCEL_NOT_YET');
    await models.SubOrder.update({ buyerCancelFrom: new Date(Date.now() - 1000) }, { where: { id: b1.id } });
    await buyerPost(one.buyer, b1.id, 'cancel').expect(200);
    expect(await models.SubOrder.findByPk(b1.id)).toMatchObject({ status: 'cancelled', cancelledBy: 'buyer', cancelReason: 'ship_overdue', refundedPoisha: 128000 });
    expect((await models.Order.findByPk(one.order.id)).status).toBe('cancelled');

    // Accepted and never shipped: cancelled by the tick at ship_by + 72 h.
    const two = await paidOrder([[A, '43', 1]]);
    await shopPost(A.owner, two.subs[0].id, 'accept').expect(200);
    const s2 = await models.SubOrder.findByPk(two.subs[0].id);
    expect((await orderJobs.tick(new Date(s2.autoCancelAt.getTime() + 1000))).overdue).toBe(1);
    expect(await models.SubOrder.findByPk(s2.id)).toMatchObject({ status: 'cancelled', cancelledBy: 'system', cancelReason: 'not_shipped' });

    // Delivered and not confirmed: auto-complete after 3 days pays the shop.
    const three = await paidOrder([[A, '43', 2]]);
    const s3 = three.subs[0];
    await shopPost(A.owner, s3.id, 'accept').expect(200);
    await shopPost(A.owner, s3.id, 'ship', { courierName: 'Steadfast', trackingNo: 'SF-889201' }).expect(200);
    await shopPost(A.owner, s3.id, 'delivered').expect(200);
    expect(await orderReads.pendingActions(three.buyer.user, 'member')).toEqual([expect.objectContaining({ key: 'orders_to_confirm', count: 1 })]);
    const d3 = await models.SubOrder.findByPk(s3.id);
    expect((await orderJobs.tick(new Date(d3.completeBy.getTime() - 1000))).completed).toBe(0);
    expect((await orderJobs.tick(new Date(d3.completeBy.getTime() + 1000))).completed).toBe(1);
    expect(await models.SubOrder.findByPk(s3.id)).toMatchObject({ status: 'completed', completedBy: 'auto' });
    expect(await payable(A.owner)).toBe(528000 - 26000);
  });

  it('not received: an M17 dispute freezes the hold; staff decide half; the shop keeps half less 5% (no fee on delivery)', async () => {
    const A = await shopWithBoots('Elephant Road Sports', { stock: 4 });
    const { buyer, paymentId, subs } = await paidOrder([[A, '42', 2]]);
    const s = subs[0];
    await shopPost(A.owner, s.id, 'accept').expect(200);
    await shopPost(A.owner, s.id, 'ship', { courierName: 'Pathao', trackingNo: 'PTH-2002' }).expect(200);

    const opts = await api().get(`${P}/me/disputes/options?sourceType=sub_order&sourceId=${s.id}`).set(h.bearer(buyer)).expect(200);
    expect(opts.body.items).toEqual([expect.objectContaining({ category: 'not_received', money: true, held: 528000 })]);
    const opened = await api().post(`${P}/me/sub-orders/${s.id}/not-received`).set(h.bearer(buyer)).set('Idempotency-Key', key('nr')).send({ statement: 'The courier says delivered but nothing came' }).expect(201);
    const code = opened.body.dispute.code;
    expect(opened.body.dispute).toMatchObject({ status: 'awaiting_response', money: true, held: 528000, policyKey: 'order.not_received' });
    expect((await models.SubOrder.findByPk(s.id)).status).toBe('disputed');
    expect((await holdOf(paymentId, s)).status).toBe('frozen');
    expect((await buyerPost(buyer, s.id, 'received').expect(409)).body.code).toBe('ORDER_STATE');

    await api().post(`${P}/me/disputes/${code}/respond`).set(h.bearer(A.owner)).send({ text: 'Pathao has a signed slip from the gate' }).expect(200);
    const staff = await f.staffWith(master, ['resolve_reports', 'refund_small']);
    const claimed = await api().post(`${P}/admin/disputes/${code}/claim`).set(h.bearer(staff)).expect(200);
    expect(claimed.body.source).toMatchObject({ kind: 'sub_order', code: s.code, courier: { name: 'Pathao' } });
    expect(JSON.stringify(claimed.body)).not.toContain('01711000111');
    expect(claimed.body.previews).toMatchObject({ all: { refund: 528000 }, half: { refund: 264000, fee: 13200, net: 250800 }, none: { refund: 0, feeBase: 520000, fee: 26000, net: 502000 } });
    const done = await api()
      .post(`${P}/admin/disputes/${code}/decide`)
      .set(h.bearer(staff))
      .set('Idempotency-Key', key('dec'))
      .send({ outcome: 'half', reason: 'No proof of hand-over at the flat', version: claimed.body.dispute.version })
      .expect(200);
    expect(done.body.dispute).toMatchObject({ status: 'resolved', refund: 264000, released: 264000, fee: 13200 });
    expect(await models.SubOrder.findByPk(s.id)).toMatchObject({ status: 'completed', completedBy: 'dispute', refundedPoisha: 264000, releasedPoisha: 264000 });
    expect(await payable(A.owner)).toBe(250800);
    expect(await models.Refund.findOne({ where: { paymentId, kind: 'dispute' } })).toMatchObject({ amountPoisha: 264000 });

    // A second case withdrawn: the hold thaws and the parcel is back to shipped.
    const two = await paidOrder([[A, '43', 1]], buyer);
    const t = two.subs[0];
    await shopPost(A.owner, t.id, 'accept').expect(200);
    await shopPost(A.owner, t.id, 'ship', { courierName: 'Pathao', trackingNo: 'PTH-2003' }).expect(200);
    const c2 = await api().post(`${P}/me/sub-orders/${t.id}/not-received`).set(h.bearer(buyer)).set('Idempotency-Key', key('nr')).send({ statement: 'Nothing yet after a week' }).expect(201);
    await api().post(`${P}/me/disputes/${c2.body.dispute.code}/withdraw`).set(h.bearer(buyer)).send({ reason: 'It came today' }).expect(200);
    expect(await models.SubOrder.findByPk(t.id)).toMatchObject({ status: 'shipped', disputeId: null });
    expect((await holdOf(two.paymentId, t)).status).not.toBe('frozen');
    await buyerPost(buyer, t.id, 'received').expect(200);
  });

  it('the staff desk: search by code, the escrow per sub-order, no phone or address; a master cancels with step-up', async () => {
    const A = await shopWithBoots('Elephant Road Sports');
    const { order, subs } = await paidOrder([[A, '42', 1]]);
    // Accepted: the shop sees the address; staff still do not.
    await shopPost(A.owner, subs[0].id, 'accept').expect(200);
    const plain = await f.staffWith(master, ['approve_listings']);
    await api().get(`${P}/admin/orders`).set(h.bearer(plain)).expect(403);
    const desk = await f.staffWith(master, ['refund_small']);
    const list = (await api().get(`${P}/admin/orders?code=${subs[0].code}`).set(h.bearer(desk)).expect(200)).body;
    expect(list.items.map((o) => o.code)).toEqual([order.code]);
    const one = (await api().get(`${P}/admin/orders/${order.code}`).set(h.bearer(desk)).expect(200)).body;
    expect(one.subOrders[0]).toMatchObject({ code: subs[0].code, status: 'accepted', orderCode: order.code, escrow: { held: 268000, status: 'holding', purpose: 'market_order' } });
    expect(one.subOrders[0].shipTo).toBeUndefined();
    expect(JSON.stringify(one)).not.toMatch(/01711000111|Road 5/);

    await api().post(`${P}/admin/orders/sub-orders/${subs[0].id}/cancel`).set(h.bearer(desk)).send({ reason: 'Shop asked us to cancel' }).expect(403);
    await api()
      .post(`${P}/admin/orders/sub-orders/${subs[0].id}/cancel`)
      .set(h.bearer(master))
      .set('X-Step-Up', await h.stepUp(master, 'escrow.manage'))
      .send({ reason: 'The shop is closed this week' })
      .expect(200);
    expect(await models.SubOrder.findByPk(subs[0].id)).toMatchObject({ status: 'cancelled', cancelledBy: 'staff', refundedPoisha: 268000 });
    expect((await variantRow(A.variant('42'))).held).toBe(0);
    expect(await models.AuditLog.count({ where: { action: 'sub_order.platform_cancelled' } })).toBe(1);
  });
});
