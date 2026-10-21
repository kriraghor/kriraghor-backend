'use strict';

/**
 * M13's side of the M17 review-sources port (M17-FR-30; source `sub_order`, subject `shop`): the
 * buyer rates the shop once the sub-order is completed (received, auto-completed or settled by a
 * dispute), within reviews.window_days of completion. The seller replies. The shop's rating columns
 * belong to M12 (market.reviews).
 */
const { Op } = require('sequelize');
const { SubOrder } = require('../../models');

async function source(subOrderId, { transaction } = {}) {
  const s = await SubOrder.findByPk(subOrderId, { transaction });
  if (!s) return null;
  return { ref: s.code, subjectId: s.shopId, ownerId: s.sellerId, payerId: s.buyerId, doneAt: s.status === 'completed' ? (s.completedAt ?? s.updatedAt) : null };
}

async function reviewableBy(userId, since) {
  const rows = await SubOrder.findAll({ where: { buyerId: userId, status: 'completed', completedAt: { [Op.gt]: since } }, order: [['completedAt', 'DESC']], limit: 50 });
  return rows.map((s) => ({ sourceId: s.id, ref: s.code, subjectId: s.shopId, doneAt: s.completedAt }));
}

async function subject(shopId) {
  const f = await require('../market').shops.facts(shopId);
  return f ? { name: f.name, slug: f.slug ?? null } : null;
}

function register() {
  require('../trust').reviewSources.register('sub_order', { subjectType: 'shop', codes: { notPayer: 'NOT_YOUR_ORDER', notDone: 'ORDER_NOT_COMPLETED' }, source, reviewableBy, subject });
}

module.exports = { register, source, reviewableBy, subject };
