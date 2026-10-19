'use strict';

/**
 * M12 saved items (FR-33, FR-34). Polymorphic (shop products now, used listings in step 2), one per
 * member and item, at most market.saved_max. Unsaving sets removed_at; nothing is deleted. Badges on
 * the list: price dropped since saved, out of stock, no longer listed. Savers hear about a restock or
 * a price drop at most once per market.saved_alert_cooldown_hours per item (saved_item.alerted).
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, Shop, Product, SavedItem } = require('../../models');
const events = require('../events').events;
const settings = require('../settings').settings;
const c = require('./market.common');
const pub = require('./public.service');

const { fail } = c;
const ACTIVE = { removedAt: null };

/** PUT /me/saved/:itemType/:itemId (idempotent). */
async function save(principal, itemType, itemId) {
  return sequelize.transaction(async (transaction) => {
    const p = await Product.findByPk(itemId, { transaction });
    if (!p || p.status !== 'live' || !p.liveSnapshot) throw E.notFound('Product');
    const shop = await Shop.findByPk(p.shopId, { transaction });
    if (shop.ownerId === principal.id) throw fail('OWN_ITEM');
    const existing = await SavedItem.findOne({ where: { userId: principal.id, itemType, itemId, ...ACTIVE }, transaction });
    if (existing) return { saved: true, itemType, itemId, savedAt: c.iso(existing.createdAt) };
    // Serialise the cap check per member (a transaction-scoped advisory lock on the member).
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `saved:${principal.id}` }, transaction });
    if ((await SavedItem.count({ where: { userId: principal.id, ...ACTIVE }, transaction })) >= settings.get('market.saved_max')) throw fail('SAVED_LIMIT');
    try {
      const row = await SavedItem.create({ userId: principal.id, itemType, itemId, priceAtSavePoisha: p.publicPriceFromPoisha }, { transaction });
      return { saved: true, itemType, itemId, savedAt: c.iso(row.createdAt) };
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') return { saved: true, itemType, itemId, savedAt: null };
      throw err;
    }
  });
}

/** DELETE /me/saved/:itemType/:itemId */
async function unsave(principal, itemType, itemId) {
  const [n] = await SavedItem.update({ removedAt: new Date() }, { where: { userId: principal.id, itemType, itemId, ...ACTIVE } });
  return { saved: false, itemType, itemId, removed: n > 0 };
}

/** GET /me/saved: newest first, with the current card and badges. */
async function list(principal) {
  const rows = await SavedItem.findAll({ where: { userId: principal.id, ...ACTIVE }, order: [['createdAt', 'DESC']] });
  const products = rows.length ? await Product.findAll({ where: { id: rows.map((r) => r.itemId) } }) : [];
  const shops = products.length ? await Shop.findAll({ where: { id: [...new Set(products.map((p) => p.shopId))] }, attributes: ['id', 'status'] }) : [];
  const listed = products.filter((p) => p.liveSnapshot);
  const cards = await pub.cardsFor(listed);
  return {
    items: rows.map((r) => {
      const p = products.find((x) => x.id === r.itemId);
      const card = cards[listed.indexOf(p)] ?? null;
      const shopLive = shops.find((s) => s.id === p?.shopId)?.status === 'live';
      const live = Boolean(p && p.status === 'live' && shopLive);
      const badges = [];
      if (!live) badges.push('unavailable');
      else if (p.visibility === 'hidden_oos') badges.push('out_of_stock');
      if (live && p.publicPriceFromPoisha < r.priceAtSavePoisha) badges.push('price_dropped');
      return { itemType: r.itemType, itemId: r.itemId, savedAt: c.iso(r.createdAt), priceAtSavePoisha: r.priceAtSavePoisha, item: card, badges };
    }),
    max: settings.get('market.saved_max'),
  };
}

/**
 * Consumers of variant.restocked and product.price_lowered: tell each saver once per cooldown. A
 * price alert goes only to savers who saved at a higher price.
 */
async function alertSavers(productId, reason, { transaction }) {
  const p = await Product.findByPk(productId, { transaction });
  if (!p || p.status !== 'live' || p.visibility !== 'visible') return 0;
  const since = new Date(Date.now() - settings.get('market.saved_alert_cooldown_hours') * 3600 * 1000);
  const rows = await SavedItem.findAll({
    where: {
      itemType: 'product',
      itemId: productId,
      ...ACTIVE,
      [Op.or]: [{ lastAlertedAt: null }, { lastAlertedAt: { [Op.lt]: since } }],
      ...(reason === 'price_dropped' ? { priceAtSavePoisha: { [Op.gt]: p.publicPriceFromPoisha } } : {}),
    },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  for (const r of rows) {
    await r.update({ lastAlertedAt: new Date() }, { transaction });
    await events.publish(transaction, { name: 'saved_item.alerted', aggregateType: 'saved_item', aggregateId: r.id, payload: { savedItemId: r.id, userId: r.userId, itemType: r.itemType, itemId: r.itemId, reason, pricePoisha: p.publicPriceFromPoisha } });
  }
  return rows.length;
}

module.exports = { save, unsave, list, alertSavers };
