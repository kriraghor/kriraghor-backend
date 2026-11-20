'use strict';

/**
 * M27 counter shop (M27-FR-10..21): the gym's products (supplements, drinks, gear), their stock and counter
 * sales with receipts. Products and stock need stock.manage; selling needs pos.sell; a reversal also needs
 * fees.adjust. Plan feature `pos`. Selling works while the owner's account is restricted, like counter fees
 * (M24-FR-08); changing products does not. Stock moves and sale lines are append-only; a sale is reversed,
 * never deleted. Bookkeeping only.
 */
const { Op, QueryTypes } = require('sequelize');
const crypto = require('crypto');
const { E } = require('../../common/errors');
const storage = require('../../common/storage');
const { sniffMime, PHOTO_TYPES, fileBlock } = require('../../common/filetype');
const { uuid7 } = require('../../common/uuid7');
const settings = require('../settings').settings;
const { sequelize, GymProduct, GymStockMove, GymSale, GymSaleLine, GymCashSession } = require('../../models');
const directory = require('../users').directory;
const gymFacade = require('../gym').gyms;
const rules = require('./gym-ops.rules');
const c = require('./gym-ops.common');

const FEATURE = 'pos';

function productView(p, { today, costs }) {
  return {
    id: p.id,
    name: p.name,
    barcode: p.barcode ?? null,
    category: p.category,
    pricePoisha: p.pricePoisha,
    ...(costs ? { costPoisha: p.costPoisha ?? null } : {}),
    stockQty: p.stockQty,
    reorderLevel: p.reorderLevel,
    low: p.reorderLevel > 0 && p.stockQty <= p.reorderLevel,
    batchNo: p.batchNo ?? null,
    expiresOn: p.expiresOn ?? null,
    expired: Boolean(p.expiresOn && p.expiresOn < today),
    importer: p.importer ?? null,
    photoUrl: p.photoKey ? storage.publicUrl(p.photoKey) : null,
    status: p.status,
  };
}

/** GET …/products (pos.sell or stock.manage): search by name, a barcode, low stock only. */
async function products(principal, gymId, { q, barcode, status = 'active', low } = {}) {
  const a = await c.access(principal, gymId, null, { anyOf: ['pos.sell', 'stock.manage'], feature: FEATURE });
  const where = { gymId, status, ...(barcode ? { barcode } : {}), ...(q ? { name: { [Op.iLike]: `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` } } : {}) };
  let rows = await GymProduct.findAll({ where, order: [['name', 'ASC']], limit: 500 });
  if (low === 'true') rows = rows.filter((p) => p.reorderLevel > 0 && p.stockQty <= p.reorderLevel);
  const today = c.today();
  const costs = a.owner || a.can('stock.manage');
  return { items: rows.map((p) => productView(p, { today, costs })) };
}

/**
 * POST …/products/:productId/photo (stock.manage): the raw JPEG, PNG or WebP body, at most
 * ground.photo_max_bytes (the shared photo limit); it replaces the product's photo. The old object
 * stays in the bucket for the audit trail (tester feedback, 19 Nov 2026).
 */
async function setPhoto(principal, gymId, productId, { contentType, body }, req) {
  const a = await c.access(principal, gymId, 'stock.manage', { feature: FEATURE, restricted: true });
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const block = fileBlock({ declared, sniffed: sniffMime(buf), size: buf.length, max: settings.get('ground.photo_max_bytes') });
  if (block) throw c.fail(block);
  const p = await sequelize.transaction(async (transaction) => {
    const row = await GymProduct.findOne({ where: { id: productId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw E.notFound('Product');
    const key = `gym-products/${gymId}/${row.id}/${uuid7()}.${PHOTO_TYPES[declared]}`;
    await storage.putPublic(key, buf, declared);
    const before = { photo: Boolean(row.photoKey) };
    await row.update({ photoKey: key, photoMime: declared, photoBytes: buf.length, updatedBy: principal.id }, { transaction });
    await c.record(
      { action: 'gym_product.photo_set', actor: a.actor, entityType: 'gym_product', entityId: row.id, before, after: { photo: true }, meta: { gymId, sizeBytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }, req },
      transaction
    );
    return row;
  });
  return productView(p, { today: c.today(), costs: true });
}

/** POST …/products/:productId/photo/remove (stock.manage): no photo (the object stays). */
async function removePhoto(principal, gymId, productId, req) {
  const a = await c.access(principal, gymId, 'stock.manage', { feature: FEATURE, restricted: true });
  const p = await sequelize.transaction(async (transaction) => {
    const row = await GymProduct.findOne({ where: { id: productId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw E.notFound('Product');
    if (row.photoKey) {
      await row.update({ photoKey: null, photoMime: null, photoBytes: null, updatedBy: principal.id }, { transaction });
      await c.record({ action: 'gym_product.photo_removed', actor: a.actor, entityType: 'gym_product', entityId: row.id, before: { photo: true }, after: { photo: false }, meta: { gymId }, req }, transaction);
    }
    return row;
  });
  return productView(p, { today: c.today(), costs: true });
}

async function barcodeFree(gymId, barcode, { exceptId = null, transaction } = {}) {
  if (!barcode) return;
  const taken = await GymProduct.findOne({ where: { gymId, barcode, status: 'active', ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) }, transaction });
  if (taken) throw c.fail('GYM_PRODUCT_BARCODE_TAKEN', { productId: taken.id });
}

/** POST …/products (stock.manage): a product with no stock yet (stock comes in through a stock move). */
async function createProduct(principal, gymId, input, req) {
  const a = await c.access(principal, gymId, 'stock.manage', { feature: FEATURE, restricted: true });
  const block = rules.amountBlock(input.pricePoisha, { max: c.cfg().priceMax });
  if (block) throw c.fail(block, { max: c.cfg().priceMax });
  const p = await sequelize.transaction(async (transaction) => {
    await barcodeFree(gymId, input.barcode, { transaction });
    const row = await GymProduct.create({ gymId, ...input, barcode: input.barcode ?? null, createdBy: principal.id, updatedBy: principal.id }, { transaction });
    await c.record({ action: 'gym_product.created', actor: a.actor, entityType: 'gym_product', entityId: row.id, after: { name: row.name, price: row.pricePoisha }, meta: { gymId }, req }, transaction);
    return row;
  });
  return productView(p, { today: c.today(), costs: true });
}

/** PATCH …/products/:productId (stock.manage). */
async function updateProduct(principal, gymId, productId, input, req) {
  const a = await c.access(principal, gymId, 'stock.manage', { feature: FEATURE, restricted: true });
  if (input.pricePoisha !== undefined) {
    const block = rules.amountBlock(input.pricePoisha, { max: c.cfg().priceMax });
    if (block) throw c.fail(block, { max: c.cfg().priceMax });
  }
  const p = await sequelize.transaction(async (transaction) => {
    const row = await GymProduct.findOne({ where: { id: productId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw E.notFound('Product');
    if (input.barcode) await barcodeFree(gymId, input.barcode, { exceptId: row.id, transaction });
    const before = { name: row.name, price: row.pricePoisha, status: row.status };
    await row.update({ ...input, updatedBy: principal.id }, { transaction });
    await c.record({ action: 'gym_product.updated', actor: a.actor, entityType: 'gym_product', entityId: row.id, before, after: { name: row.name, price: row.pricePoisha, status: row.status }, meta: { gymId }, req }, transaction);
    return row;
  });
  return productView(p, { today: c.today(), costs: true });
}

/**
 * Apply one stock move to a locked product: the move row (append-only), the product's quantity and the
 * low-stock alert (once per crossing, M27-FR-14).
 */
async function moveIn(transaction, { product, kind, qty, unitCost = null, saleId = null, note = null, by, actor }) {
  const before = product.stockQty;
  const after = before + qty;
  if (after < 0) throw c.fail('GYM_STOCK_SHORT', { productId: product.id, available: before });
  await GymStockMove.create({ gymId: product.gymId, productId: product.id, kind, qty, qtyAfter: after, unitCostPoisha: unitCost, saleId, note, byUser: by }, { transaction });
  const change = rules.lowStockChange({ before, after, reorderLevel: product.reorderLevel, alerted: Boolean(product.lowAlertedAt) });
  await product.update({ stockQty: after, ...(change === 'alert' ? { lowAlertedAt: new Date() } : change === 'rearm' ? { lowAlertedAt: null } : {}) }, { transaction });
  if (change === 'alert') {
    await c.publish(transaction, 'gym_stock.low_reached', 'gym_product', product.id, { productId: product.id, gymId: product.gymId, item: product.name, stockQty: after, reorderLevel: product.reorderLevel }, actor);
  }
  return after;
}

/** POST …/products/:productId/stock (stock.manage, Idempotency-Key): stock in, an adjustment or a write-off (M27-FR-12, FR-13). */
async function stock(principal, gymId, productId, input, req) {
  const a = await c.access(principal, gymId, 'stock.manage', { feature: FEATURE, restricted: true });
  if (input.kind !== 'adjust' && input.qty < 0) throw E.validation([{ field: 'qty', message: 'More than 0' }]);
  const p = await sequelize.transaction(async (transaction) => {
    const row = await GymProduct.findOne({ where: { id: productId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw E.notFound('Product');
    const qty = input.kind === 'write_off' ? -input.qty : input.qty;
    await moveIn(transaction, { product: row, kind: input.kind, qty, unitCost: input.unitCostPoisha ?? null, note: input.note ?? null, by: principal.id, actor: a.actor });
    // A new batch brings its own expiry, batch number and cost (M27-FR-15).
    if (input.kind === 'in') {
      const batch = {};
      if (input.batchNo !== undefined) batch.batchNo = input.batchNo;
      if (input.expiresOn !== undefined) Object.assign(batch, { expiresOn: input.expiresOn, expiryAlertedOn: null });
      if (input.unitCostPoisha !== undefined && input.unitCostPoisha !== null) batch.costPoisha = input.unitCostPoisha;
      if (Object.keys(batch).length) await row.update(batch, { transaction });
    }
    await c.record({ action: `gym_stock.${input.kind === 'in' ? 'added' : 'adjusted'}`, actor: a.actor, entityType: 'gym_product', entityId: row.id, reason: input.note ?? null, after: { qty, stockQty: row.stockQty }, meta: { gymId }, req }, transaction);
    return row;
  });
  return productView(p, { today: c.today(), costs: true });
}

async function refuseClosedCash(gymId, day, method, transaction) {
  if (method !== 'cash') return;
  const s = await GymCashSession.findOne({ where: { gymId, businessDate: day }, transaction });
  if (s?.status === 'closed') throw c.fail('GYM_DRAWER_CLOSED');
}

/**
 * A sale in the caller's transaction: the receipt number from the gym's series (gym-manage), the VAT rate
 * at this moment, the lines and, for products, the stock moves. Used by the counter and by locker fees.
 */
async function saleIn(transaction, { gymId, kind, lines, method, memberId = null, by, actor }) {
  const today = c.today();
  await refuseClosedCash(gymId, today, method, transaction);
  const { total, cost } = rules.saleTotals(lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, unitCost: l.unitCost ?? null })));
  const receiptNo = await c.ops.nextReceiptNo(gymId, transaction);
  const vatBps = await c.ops.vatBpsOf(gymId, { transaction });
  const sale = await GymSale.create({ gymId, receiptNo, kind, memberId, totalPoisha: total, costPoisha: cost, method, vatBps, soldOn: today, soldBy: by }, { transaction });
  for (const l of lines) {
    await GymSaleLine.create(
      { saleId: sale.id, productId: l.product?.id ?? null, lockerRentalId: l.lockerRentalId ?? null, description: l.description, qty: l.qty, unitPricePoisha: l.unitPrice, unitCostPoisha: l.unitCost ?? null, lineTotalPoisha: l.qty * l.unitPrice },
      { transaction }
    );
    if (l.product) await moveIn(transaction, { product: l.product, kind: 'sale', qty: -l.qty, unitCost: l.unitCost ?? null, saleId: sale.id, by, actor });
  }
  await c.publish(transaction, 'gym_sale.recorded', 'gym_sale', sale.id, { saleId: sale.id, gymId, kind, amount: total, method, receiptNo, memberId }, actor);
  return sale;
}

/** POST …/sales (pos.sell, Idempotency-Key): a counter sale of products (M27-FR-17, FR-18). */
async function sell(principal, gymId, input, req) {
  const a = await c.access(principal, gymId, 'pos.sell', { feature: FEATURE });
  if (input.lines.length > c.cfg().saleMaxLines) throw E.validation([{ field: 'lines', message: `At most ${c.cfg().saleMaxLines} lines` }]);
  const sale = await sequelize.transaction(async (transaction) => {
    if (input.memberId && !(await c.ops.member(gymId, input.memberId, { transaction }))) throw c.fail('GYM_MEMBER_UNKNOWN');
    // Lock the products in a fixed order (no deadlocks between two tills); one line per product.
    const qty = new Map();
    for (const l of input.lines) qty.set(l.productId, (qty.get(l.productId) ?? 0) + l.qty);
    const ids = [...qty.keys()].sort();
    const found = await GymProduct.findAll({ where: { id: ids, gymId }, order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
    if (found.length !== ids.length) throw c.fail('GYM_PRODUCT_UNAVAILABLE');
    const today = c.today();
    const lines = found.map((p) => {
      const block = rules.sellBlock(p, { qty: qty.get(p.id), today });
      if (block) throw c.fail(block, { productId: p.id, available: p.stockQty });
      return { product: p, description: p.name, qty: qty.get(p.id), unitPrice: p.pricePoisha, unitCost: p.costPoisha ?? null };
    });
    const s = await saleIn(transaction, { gymId, kind: 'pos', lines, method: input.method, memberId: input.memberId ?? null, by: principal.id, actor: a.actor });
    await c.record({ action: 'gym_sale.recorded', actor: a.actor, entityType: 'gym_sale', entityId: s.id, after: { amount: s.totalPoisha, method: s.method, receiptNo: s.receiptNo, lines: lines.length }, meta: { gymId }, req }, transaction);
    return s;
  });
  return saleOf(gymId, sale.id, { gym: true });
}

/** POST …/sales/:saleId/reverse (pos.sell and fees.adjust): money back, stock back, the sale kept as reversed (M27-FR-19). */
async function reverse(principal, gymId, saleId, { reason }, req) {
  const a = await c.access(principal, gymId, 'pos.sell', { feature: FEATURE });
  c.needs(a, 'fees.adjust');
  await sequelize.transaction(async (transaction) => {
    const s = await GymSale.findOne({ where: { id: saleId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!s) throw E.notFound('Sale');
    if (s.status === 'reversed') throw c.fail('GYM_SALE_STATE');
    const today = c.today();
    await refuseClosedCash(gymId, today, s.method, transaction);
    const lines = await GymSaleLine.findAll({ where: { saleId: s.id }, transaction });
    const ids = lines.filter((l) => l.productId).map((l) => l.productId).sort();
    const products = new Map((await GymProduct.findAll({ where: { id: ids }, order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE })).map((p) => [p.id, p]));
    for (const l of lines) {
      if (l.productId) await moveIn(transaction, { product: products.get(l.productId), kind: 'sale_reversal', qty: l.qty, unitCost: l.unitCostPoisha ?? null, saleId: s.id, by: principal.id, actor: a.actor });
    }
    await s.update({ status: 'reversed', reverseReason: reason, reversedOn: today, reversedBy: principal.id, reversedAt: new Date() }, { transaction });
    // A locker fee taken back: the rental is unpaid again.
    if (s.kind === 'locker') await require('./lockers.service').unpayIn(transaction, s.id);
    await c.publish(transaction, 'gym_sale.reversed', 'gym_sale', s.id, { saleId: s.id, gymId, kind: s.kind, amount: s.totalPoisha, method: s.method, receiptNo: s.receiptNo }, a.actor);
    await c.record({ action: 'gym_sale.reversed', actor: a.actor, entityType: 'gym_sale', entityId: s.id, reason, after: { amount: s.totalPoisha, receiptNo: s.receiptNo }, meta: { gymId }, req }, transaction);
  });
  return saleOf(gymId, saleId, { gym: true });
}

/** One sale as a receipt: lines, VAT inside the total, the member, the gym's header (M27-FR-20, FR-28). */
async function saleOf(gymId, saleId, { gym: withGym = false } = {}) {
  const s = await GymSale.findOne({ where: { id: saleId, gymId } });
  if (!s) throw E.notFound('Sale');
  const [lines, names, member] = await Promise.all([
    GymSaleLine.findAll({ where: { saleId: s.id }, order: [['createdAt', 'ASC']] }),
    directory.displayNames([s.soldBy]),
    s.memberId ? c.ops.member(gymId, s.memberId) : null,
  ]);
  let gym;
  if (withGym) {
    const [g, settings] = await Promise.all([gymFacade.get(gymId), c.ops.gymSettings(gymId)]);
    gym = { id: gymId, name: g?.name ?? '', addressLine: g?.addressLine ?? null, tin: settings?.tin || null, bin: settings?.bin || null, footer: settings?.receiptFooter || null };
  }
  return saleView(s, { lines, soldBy: names.get(s.soldBy) ?? null, member, gym });
}

function saleView(s, { lines, soldBy, member, gym }) {
  return {
    id: s.id,
    receiptNo: s.receiptNo,
    kind: s.kind,
    member: member ? { id: member.id, memberCode: member.memberCode, displayName: member.displayName } : null,
    lines: lines.map((l) => ({ productId: l.productId ?? null, description: l.description, qty: l.qty, unitPricePoisha: l.unitPricePoisha, lineTotalPoisha: l.lineTotalPoisha })),
    totalPoisha: s.totalPoisha,
    vat: rules.vatPart(s.totalPoisha, s.vatBps),
    method: s.method,
    soldOn: s.soldOn,
    soldBy,
    status: s.status,
    reverseReason: s.reverseReason ?? null,
    reversedOn: s.reversedOn ?? null,
    createdAt: c.iso(s.createdAt),
    ...(gym ? { gym } : {}),
  };
}

/** GET …/sales/:saleId/receipt (pos.sell or lockers.manage). */
async function receipt(principal, gymId, saleId) {
  await c.access(principal, gymId, null, { anyOf: ['pos.sell', 'lockers.manage', 'reports.view'] });
  return saleOf(gymId, saleId, { gym: true });
}

/** GET …/sales (pos.sell: own; owner and reports.view: everyone's): a day's sales, newest first. */
async function sales(principal, gymId, { date, cursor, limit = 25 } = {}) {
  const a = await c.access(principal, gymId, null, { anyOf: ['pos.sell', 'reports.view'] });
  const all = a.owner || a.can('reports.view');
  const where = { gymId, soldOn: date ?? c.today(), ...(all ? {} : { soldBy: principal.id }) };
  const offset = cursor ? Number(cursor) || 0 : 0;
  const rows = await GymSale.findAll({ where, order: [['createdAt', 'DESC']], offset, limit: limit + 1 });
  const page = rows.slice(0, limit);
  const names = await directory.displayNames([...new Set(page.map((s) => s.soldBy))]);
  const items = [];
  for (const s of page) {
    const lines = await GymSaleLine.findAll({ where: { saleId: s.id } });
    const member = s.memberId ? await c.ops.member(gymId, s.memberId) : null;
    items.push(saleView(s, { lines, soldBy: names.get(s.soldBy) ?? null, member }));
  }
  return { items, nextCursor: rows.length > limit ? String(offset + limit) : null };
}

/** For the drawer: cash sold on a day minus cash given back on that day (M27-FR-07). */
async function cashOfDay(gymId, day, { transaction } = {}) {
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(total_poisha) FILTER (WHERE sold_on = :day), 0)::bigint AS sold,
            COALESCE(SUM(total_poisha) FILTER (WHERE reversed_on = :day), 0)::bigint AS back
       FROM gym_sales WHERE gym_id = :gymId AND method = 'cash' AND (sold_on = :day OR reversed_on = :day)`,
    { replacements: { gymId, day }, type: QueryTypes.SELECT, transaction }
  );
  return Number(row.sold) - Number(row.back);
}

/** For profit and loss: sales of a period that stand (not reversed), by kind, and the cost of the goods. */
async function totals(gymId, from, to) {
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(total_poisha) FILTER (WHERE kind = 'pos'), 0)::bigint AS pos,
            COALESCE(SUM(total_poisha) FILTER (WHERE kind = 'locker'), 0)::bigint AS locker,
            COALESCE(SUM(cost_poisha) FILTER (WHERE kind = 'pos'), 0)::bigint AS cost
       FROM gym_sales WHERE gym_id = :gymId AND status = 'recorded' AND sold_on BETWEEN :from AND :to`,
    { replacements: { gymId, from, to }, type: QueryTypes.SELECT }
  );
  return { posSales: Number(row.pos), lockerFees: Number(row.locker), goodsCost: Number(row.cost) };
}

/** Daily job (M27-FR-15): products expiring within gym_ops.stock_expiry_alert_days, alerted once per expiry date. */
async function expiryAlerts(now = new Date()) {
  const today = c.today(now);
  const alertDays = c.cfg().expiryAlertDays;
  const rows = await GymProduct.findAll({ where: { status: 'active', expiresOn: { [Op.ne]: null, [Op.lte]: rules.addDays(today, alertDays) }, stockQty: { [Op.gt]: 0 } } });
  let n = 0;
  for (const p of rows) {
    if (!rules.expiryAlertDue(p, { today, alertDays })) continue;
    await sequelize.transaction(async (transaction) => {
      await p.update({ expiryAlertedOn: p.expiresOn }, { transaction });
      await c.publish(transaction, 'gym_product.expiry_warned', 'gym_product', p.id, { productId: p.id, gymId: p.gymId, item: p.name, expiresOn: p.expiresOn, stockQty: p.stockQty, expired: p.expiresOn < today });
    });
    n += 1;
  }
  return n;
}

module.exports = {
  setPhoto,
  removePhoto, products, createProduct, updateProduct, stock, sell, reverse, receipt, sales, saleIn, saleOf, cashOfDay, totals, expiryAlerts };
