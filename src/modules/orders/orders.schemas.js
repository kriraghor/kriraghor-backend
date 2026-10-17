'use strict';

/**
 * M13 request and response schemas (zod → validation and OpenAPI). Money in poisha; times ISO.
 */
const { z } = require('zod');
const { normalizePhone } = require('../../common/identifiers');

const id = z.uuid();
const poisha = z.number().int().nonnegative();
const dateTime = z.string();
const text = (min, max) => z.string().trim().min(min).max(max);
const limit = (max, dflt) => z.coerce.number().int().min(1).max(max).default(dflt);
const phone = z.string().transform((v, ctx) => {
  const p = normalizePhone(v);
  if (!p) ctx.addIssue({ code: 'custom', message: 'Enter a Bangladesh mobile number' });
  return p ?? v;
});
const orderCode = z.string().regex(/^KG-\d{2}-\d{6,}(-[A-Z])?$/);

const SUB_STATUSES = ['pending_payment', 'placed', 'accepted', 'shipped', 'delivered', 'completed', 'rejected', 'expired', 'cancelled', 'disputed', 'refunded'];
const ORDER_STATUSES = ['pending_payment', 'placed', 'cancelled', 'completed'];
const REJECT_REASONS = ['out_of_stock', 'cannot_deliver_area', 'price_error', 'shop_closed', 'other'];

// ---------------- requests
const idParam = z.object({ id });
const variantParam = z.object({ variantId: id });
const codeParam = z.object({ code: orderCode });
const cartQty = z.object({ qty: z.number().int().min(1).max(50) });
const quoteBody = z.object({ areaId: id });
const ship = z.object({
  name: text(2, 80),
  phone,
  areaId: id,
  line: text(5, 200).meta({ description: 'House, road, landmark' }),
  note: text(1, 200).optional(),
});
const checkoutBody = z.object({ ship, expectedTotal: poisha.meta({ description: 'The quote total the buyer confirmed; a different live total is PRICE_CHANGED' }) });
const myOrdersQuery = z.object({ status: z.enum(ORDER_STATUSES).optional(), cursor: dateTime.optional(), limit: limit(50, 20) });
const cancelBody = z.object({ reason: z.enum(['changed_mind', 'ordered_by_mistake', 'found_cheaper', 'buyer_cancelled', 'other']).optional() });
const notReceivedBody = z.object({ statement: text(10, 2000) });
const shopListQuery = z.object({ tab: z.enum(['to_accept', 'to_ship', 'shipped', 'done', 'cancelled']).default('to_accept'), cursor: dateTime.optional(), limit: limit(50, 20) });
const rejectBody = z.object({ reason: z.enum(REJECT_REASONS), note: text(2, 300).optional() });
const shipBody = z.object({ courierName: text(2, 60), trackingNo: z.string().trim().regex(/^[A-Za-z0-9/-]{4,40}$/, '4 to 40 letters, digits, - or /') });
const adminListQuery = z.object({ code: z.string().trim().max(24).optional(), status: z.enum(ORDER_STATUSES).optional(), cursor: dateTime.optional(), limit: limit(100, 50) });
const reasonBody = z.object({ reason: text(5, 300) });

// ---------------- responses
const Shop = z.object({ id, name: z.string(), slug: z.string().nullable() });
const Item = z.object({
  id,
  variantId: id,
  productId: id,
  title: z.string(),
  variantLabelEn: z.string(),
  variantLabelBn: z.string(),
  sku: z.string().nullable(),
  photoUrl: z.string().nullable(),
  unitPrice: poisha,
  qty: z.number().int(),
  lineTotal: poisha,
  isMto: z.boolean(),
  mtoDays: z.number().int().nullable(),
});
const Courier = z.object({ name: z.string(), trackingNo: z.string() }).nullable();
const times = {
  placedAt: dateTime.nullable(),
  acceptBy: dateTime.nullable(),
  acceptedAt: dateTime.nullable(),
  shipBy: dateTime.nullable(),
  buyerCancelFrom: dateTime.nullable(),
  shippedAt: dateTime.nullable(),
  deliveredAt: dateTime.nullable(),
  completeBy: dateTime.nullable(),
  completedAt: dateTime.nullable(),
  cancelledAt: dateTime.nullable(),
};
const BuyerSub = z.object({
  id,
  code: z.string(),
  status: z.enum(SUB_STATUSES),
  shop: Shop.nullable(),
  items: z.array(Item),
  money: z.object({ items: poisha, delivery: poisha, total: poisha, refunded: poisha }),
  courier: Courier,
  ...times,
  cancelReason: z.string().nullable(),
  disputeId: id.nullable(),
  can: z.object({ cancel: z.boolean(), received: z.boolean(), notReceived: z.boolean() }),
  notReceivedClosesAt: dateTime.nullable(),
});
const BuyerOrder = z
  .object({
    id,
    code: z.string(),
    status: z.enum(ORDER_STATUSES),
    paymentMethod: z.literal('online'),
    paymentId: id.nullable(),
    payBy: dateTime.nullable(),
    placedAt: dateTime.nullable(),
    createdAt: dateTime.nullable(),
    money: z.object({ items: poisha, delivery: poisha, total: poisha }),
    shipTo: z.object({ name: z.string(), phoneLast4: z.string(), areaId: id, line: z.string(), note: z.string().nullable() }),
    subOrders: z.array(BuyerSub),
  })
  .meta({ id: 'Order' });
const OrderResult = z.object({ order: BuyerOrder, payment: z.object({ id, payUrl: z.string() }).nullable() }).meta({ id: 'OrderResult' });
const OrderList = z.object({ items: z.array(BuyerOrder), nextCursor: z.string().nullable() }).meta({ id: 'OrderList' });

const CartLine = z.object({
  variantId: id,
  productId: id.optional(),
  productSlug: z.string().optional(),
  title: z.string().optional(),
  variantLabelEn: z.string().optional(),
  variantLabelBn: z.string().optional(),
  photoUrl: z.string().nullable().optional(),
  shop: Shop.optional(),
  qty: z.number().int(),
  maxQty: z.number().int().optional(),
  unitPrice: poisha.optional(),
  addedPrice: poisha,
  priceChanged: z.boolean().optional(),
  lineTotal: poisha.optional(),
  isMto: z.boolean().optional(),
  mtoDays: z.number().int().nullable().optional(),
  unavailable: z.boolean(),
  block: z.string().nullable(),
});
const Cart = z
  .object({ shops: z.array(z.object({ shop: Shop, lines: z.array(CartLine), items: poisha })), unavailable: z.array(CartLine), count: z.number().int(), items: poisha, ready: z.boolean() })
  .meta({ id: 'Cart' });
const Quote = z
  .object({
    area: z.object({ id, nameEn: z.string(), nameBn: z.string(), isDhakaMetro: z.boolean() }),
    subOrders: z.array(
      z.object({
        shop: Shop,
        lines: z.array(z.object({ variantId: id, title: z.string(), variantLabelEn: z.string(), variantLabelBn: z.string(), unitPrice: poisha, qty: z.number().int(), lineTotal: poisha, isMto: z.boolean(), mtoDays: z.number().int().nullable() })),
        items: poisha,
        delivery: poisha,
        total: poisha,
      })
    ),
    items: poisha,
    delivery: poisha,
    total: poisha,
    changes: z.array(z.object({ variantId: id, was: poisha, now: poisha })),
  })
  .meta({ id: 'OrderQuote' });

const AreaRef = z.object({ id, nameEn: z.string(), nameBn: z.string(), isDhakaMetro: z.boolean() }).nullable();
const shopSubFields = {
  id,
  code: z.string(),
  orderCode: z.string(),
  status: z.enum(SUB_STATUSES),
  items: z.array(Item),
  money: z.object({ items: poisha, delivery: poisha, total: poisha, refunded: poisha, commissionBps: z.number().int(), commission: poisha, net: poisha, released: poisha }),
  courier: Courier,
  ...times,
  autoCancelAt: dateTime.nullable(),
  cancelReason: z.string().nullable(),
  cancelledBy: z.string().nullable(),
  completedBy: z.string().nullable(),
  disputeId: id.nullable(),
  area: AreaRef,
};
const ShopSub = z
  .object({ ...shopSubFields, shipTo: z.object({ name: z.string(), phone: z.string(), line: z.string(), note: z.string().nullable() }).nullable().meta({ description: 'Shown once the shop accepts (FR-10)' }) })
  .meta({ id: 'ShopSubOrder' });
const ShopSubList = z.object({ items: z.array(ShopSub), counts: z.record(z.string(), z.number().int()), nextCursor: z.string().nullable() }).meta({ id: 'ShopSubOrderList' });
const Settlement = z
  .object({
    completed: z.object({ count: z.number().int(), gross: poisha, commission: poisha, net: poisha }),
    inEscrow: z.object({ count: z.number().int(), net: poisha }),
    refunded: poisha,
    payoutsHref: z.string(),
  })
  .meta({ id: 'ShopSettlement' });
const StaffOrderRow = z.object({ id, code: z.string(), status: z.enum(ORDER_STATUSES), total: poisha, createdAt: dateTime.nullable(), subOrders: z.array(z.string()) });
const StaffOrderList = z.object({ items: z.array(StaffOrderRow), nextCursor: z.string().nullable() }).meta({ id: 'StaffOrderList' });
const StaffOrder = z
  .object({
    id,
    code: z.string(),
    status: z.enum(ORDER_STATUSES),
    buyerId: id,
    paymentId: id.nullable(),
    money: z.object({ items: poisha, delivery: poisha, total: poisha }),
    area: AreaRef,
    createdAt: dateTime.nullable(),
    placedAt: dateTime.nullable(),
    subOrders: z.array(z.object({ ...shopSubFields, shop: Shop.optional(), sellerId: id, buyerId: id, escrow: z.record(z.string(), z.unknown()).nullable() })),
  })
  .meta({ id: 'StaffOrder' });

module.exports = {
  REJECT_REASONS,
  idParam,
  variantParam,
  codeParam,
  cartQty,
  quoteBody,
  checkoutBody,
  myOrdersQuery,
  cancelBody,
  notReceivedBody,
  shopListQuery,
  rejectBody,
  shipBody,
  adminListQuery,
  reasonBody,
  Cart,
  Quote,
  OrderResult,
  OrderList,
  ShopSub,
  ShopSubList,
  Settlement,
  StaffOrderList,
  StaffOrder,
};
