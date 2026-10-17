'use strict';

// M13 pure rules: quote and commission (FR-01 to FR-04), the sub-order state machine (§8),
// deadlines (FR-08 to FR-14), the derived order status. 100% branch gate in jest.config.
const r = require('../../src/modules/orders/orders.rules');

const at = (iso) => new Date(iso);

describe('M13 quote (FR-01 to FR-04)', () => {
  const fees = { dhakaFee: 8000, outsideFee: 15000, commissionBps: 500 };
  const boots = { variantId: 'v1', shopId: 'A', sellerId: 'sa', unitPrice: 260000, qty: 2 };

  it('prices one shop inside Dhaka: ৳5,200 items + ৳80 delivery, fee ৳260 on the items only', () => {
    const q = r.quote({ ...fees, lines: [boots], isDhakaMetro: true });
    expect(q).toMatchObject({ items: 520000, delivery: 8000, total: 528000 });
    expect(q.subOrders).toHaveLength(1);
    expect(q.subOrders[0]).toMatchObject({ shopId: 'A', sellerId: 'sa', items: 520000, delivery: 8000, total: 528000, commission: 26000, net: 502000 });
    expect(q.subOrders[0].lines[0].lineTotal).toBe(520000);
  });

  it('splits two shops into two sub-orders, each with its own delivery fee', () => {
    const lines = [boots, { variantId: 'v2', shopId: 'B', sellerId: 'sb', unitPrice: 50000, qty: 1 }, { variantId: 'v3', shopId: 'A', sellerId: 'sa', unitPrice: 30000, qty: 1 }];
    const q = r.quote({ ...fees, lines, isDhakaMetro: true });
    expect(q.subOrders.map((s) => s.shopId)).toEqual(['A', 'B']);
    expect(q.subOrders[0]).toMatchObject({ items: 550000, delivery: 8000, commission: 27500, net: 530500 });
    expect(q.subOrders[1]).toMatchObject({ items: 50000, delivery: 8000, commission: 2500, net: 55500 });
    expect(q).toMatchObject({ items: 600000, delivery: 16000, total: 616000 });
  });

  it('charges the outside-Dhaka fee elsewhere (the k3d journey: ৳6,500 + ৳80 → shop ৳6,255)', () => {
    expect(r.quote({ ...fees, lines: [boots], isDhakaMetro: false }).subOrders[0]).toMatchObject({ delivery: 15000, total: 535000 });
    const k3d = r.quote({ ...fees, lines: [{ ...boots, unitPrice: 650000, qty: 1 }], isDhakaMetro: true }).subOrders[0];
    expect(k3d).toMatchObject({ items: 650000, delivery: 8000, commission: 32500, net: 625500 });
    expect(r.deliveryFee({ isDhakaMetro: false, dhakaFee: 1, outsideFee: 2 })).toBe(2);
  });

  it('caps cart quantities by stock and the per-order limit (made to order has no stock)', () => {
    expect(r.maxQty({ available: 3, maxPerOrder: 10, isMto: false })).toBe(3);
    expect(r.maxQty({ available: 30, maxPerOrder: 10, isMto: false })).toBe(10);
    expect(r.maxQty({ available: -2, maxPerOrder: 10, isMto: false })).toBe(0);
    expect(r.maxQty({ available: 0, maxPerOrder: 4, isMto: true })).toBe(4);
  });

  it('blocks lines that cannot be bought', () => {
    const ok = { purchasable: true, qty: 2, available: 5, maxPerOrder: 10, isMto: false };
    expect(r.lineBlock(ok)).toBeNull();
    expect(r.lineBlock({ ...ok, purchasable: false })).toBe('ITEM_UNAVAILABLE');
    expect(r.lineBlock({ ...ok, qty: 11 })).toBe('QTY_LIMIT');
    expect(r.lineBlock({ ...ok, qty: 6 })).toBe('INSUFFICIENT_STOCK');
    expect(r.lineBlock({ ...ok, qty: 6, isMto: true })).toBeNull();
  });

  it('finds price changes since the member last saw them (PRICE_CHANGED)', () => {
    const lines = [
      { variantId: 'a', unitPrice: 100, seenPrice: 100 },
      { variantId: 'b', unitPrice: 120, seenPrice: 100 },
      { variantId: 'c', unitPrice: 90, seenPrice: null },
      { variantId: 'd', unitPrice: 90 },
    ];
    expect(r.priceChanges(lines)).toEqual([{ variantId: 'b', was: 100, now: 120 }]);
  });

  it('drops cart lines older than market.cart_line_days', () => {
    expect(r.lineStale({ addedAt: at('2026-10-01T00:00:00Z'), now: at('2026-10-31T00:00:01Z'), days: 30 })).toBe(true);
    expect(r.lineStale({ addedAt: at('2026-10-01T00:00:00Z'), now: at('2026-10-31T00:00:00Z'), days: 30 })).toBe(false);
  });
});

describe('M13 sub-order state machine (§8)', () => {
  const cases = [
    ['pay', 'pending_payment', 'system', 'placed'],
    ['payment_closed', 'pending_payment', 'system', 'cancelled'],
    ['accept', 'placed', 'shop', 'accepted'],
    ['reject', 'placed', 'shop', 'rejected'],
    ['expire', 'placed', 'system', 'expired'],
    ['buyer_cancel', 'placed', 'buyer', 'cancelled'],
    ['buyer_cancel', 'accepted', 'buyer', 'cancelled'],
    ['auto_cancel', 'accepted', 'system', 'cancelled'],
    ['platform_cancel', 'placed', 'staff', 'cancelled'],
    ['platform_cancel', 'accepted', 'staff', 'cancelled'],
    ['ship', 'accepted', 'shop', 'shipped'],
    ['deliver', 'shipped', 'shop', 'delivered'],
    ['receive', 'shipped', 'buyer', 'completed'],
    ['receive', 'delivered', 'buyer', 'completed'],
    ['auto_complete', 'delivered', 'system', 'completed'],
    ['dispute', 'shipped', 'buyer', 'disputed'],
    ['dispute', 'delivered', 'buyer', 'disputed'],
    ['dispute_release', 'disputed', 'dispute', 'completed'],
    ['dispute_refund', 'disputed', 'dispute', 'refunded'],
  ];
  it.each(cases)('%s from %s by %s → %s', (action, from, actor, to) => expect(r.next(action, from, actor)).toBe(to));

  it('refuses the wrong actor, the wrong status and unknown actions', () => {
    expect(r.next('accept', 'placed', 'buyer')).toBeNull();
    expect(r.next('ship', 'placed', 'shop')).toBeNull();
    expect(r.next('platform_cancel', 'shipped', 'staff')).toBeNull();
    expect(r.next('receive', 'accepted', 'buyer')).toBeNull();
    expect(r.next('teleport', 'placed', 'shop')).toBeNull();
  });

  it('knows where stock is held and when the shop sees the address (FR-10)', () => {
    expect(['pending_payment', 'placed', 'accepted'].every(r.holdsStock)).toBe(true);
    expect(r.holdsStock('shipped')).toBe(false);
    expect(r.revealsAddress('placed')).toBe(false);
    expect(r.revealsAddress('accepted')).toBe(true);
    expect(r.revealsAddress('cancelled')).toBe(false);
  });

  it('derives the order status from its sub-orders', () => {
    expect(r.orderStatus(['pending_payment', 'pending_payment'])).toBe('pending_payment');
    expect(r.orderStatus(['cancelled', 'rejected', 'expired', 'refunded'])).toBe('cancelled');
    expect(r.orderStatus(['completed', 'rejected'])).toBe('completed');
    expect(r.orderStatus(['accepted', 'rejected'])).toBe('placed');
    expect(r.orderStatus(['placed'])).toBe('placed');
  });
});

describe('M13 deadlines (FR-08 to FR-14)', () => {
  const placedAt = at('2026-10-17T06:00:00Z');

  it('accepts within 24 h and ships within 48 h, or the made-to-order time when later', () => {
    expect(r.placedDeadlines({ placedAt, acceptHours: 24, shipHours: 48 })).toEqual({ acceptBy: at('2026-10-18T06:00:00Z'), shipBy: at('2026-10-19T06:00:00Z') });
    expect(r.placedDeadlines({ placedAt, acceptHours: 24, shipHours: 48, mtoDays: [5, 1] }).shipBy).toEqual(at('2026-10-22T06:00:00Z'));
  });

  it('lets the buyer cancel a late shipment, then cancels it by itself', () => {
    const o = r.overdue({ shipBy: at('2026-10-19T06:00:00Z'), buyerCancelHours: 24, autoCancelHours: 72 });
    expect(o).toEqual({ buyerCancelFrom: at('2026-10-20T06:00:00Z'), autoCancelAt: at('2026-10-22T06:00:00Z') });
    expect(r.buyerCancelBlock({ status: 'placed', now: placedAt, buyerCancelFrom: o.buyerCancelFrom })).toBeNull();
    expect(r.buyerCancelBlock({ status: 'accepted', now: at('2026-10-20T05:59:59Z'), buyerCancelFrom: o.buyerCancelFrom })).toBe('CANCEL_NOT_YET');
    expect(r.buyerCancelBlock({ status: 'accepted', now: o.buyerCancelFrom, buyerCancelFrom: o.buyerCancelFrom })).toBeNull();
    expect(r.buyerCancelBlock({ status: 'shipped', now: o.buyerCancelFrom, buyerCancelFrom: o.buyerCancelFrom })).toBe('ORDER_STATE');
  });

  it('auto-completes 3 days after delivery', () => expect(r.completeBy({ deliveredAt: at('2026-10-20T10:00:00Z'), days: 3 })).toEqual(at('2026-10-23T10:00:00Z')));

  it('opens "not received" while shipped, and for 48 h after delivered', () => {
    const deliveredAt = at('2026-10-20T10:00:00Z');
    expect(r.notReceivedBlock({ status: 'shipped', deliveredAt: null, now: deliveredAt, windowHours: 48 })).toBeNull();
    expect(r.notReceivedBlock({ status: 'delivered', deliveredAt, now: at('2026-10-22T09:59:59Z'), windowHours: 48 })).toBeNull();
    expect(r.notReceivedBlock({ status: 'delivered', deliveredAt, now: at('2026-10-22T10:00:00Z'), windowHours: 48 })).toBe('DISPUTE_WINDOW_CLOSED');
    expect(r.notReceivedBlock({ status: 'completed', deliveredAt, now: deliveredAt, windowHours: 48 })).toBe('DISPUTE_NOT_ELIGIBLE');
    expect(r.notReceivedClosesAt({ status: 'delivered', deliveredAt, windowHours: 48 })).toEqual(at('2026-10-22T10:00:00Z'));
    expect(r.notReceivedClosesAt({ status: 'shipped', deliveredAt: null, windowHours: 48 })).toBeNull();
  });

  it('checks courier tracking numbers', () => {
    expect(r.trackingValid('PTH-2026/0042')).toBe(true);
    expect(r.trackingValid('abc')).toBe(false);
    expect(r.trackingValid('has space')).toBe(false);
    expect(r.trackingValid(42)).toBe(false);
  });
});
