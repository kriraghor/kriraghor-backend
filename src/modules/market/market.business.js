'use strict';

/**
 * Round B3 business adapter for shops (`shop`): what business-members may know about a shop (owner,
 * name, status) and the staff to-do of one shop: stock running low, out or blocked (stock.view, M12)
 * and orders to accept or ship (orders.accept / orders.ship, M13 through its facade).
 * Registered once per process (registry.registerAll), through market/index.js.
 */
const { Op } = require('sequelize');
const { Shop } = require('../../models');

const adapter = {
  async business(id, { transaction } = {}) {
    const s = await Shop.findByPk(id, { attributes: ['id', 'ownerId', 'name', 'status'], transaction });
    return s ? { id: s.id, ownerId: s.ownerId, name: s.name, status: s.status } : null;
  },
  async businessesOf(ownerId) {
    const rows = await Shop.findAll({ where: { ownerId, status: { [Op.ne]: 'removed' } }, attributes: ['id', 'name', 'status'], order: [['createdAt', 'ASC']] });
    return rows.map((s) => ({ id: s.id, name: s.name, status: s.status }));
  },
  async staffActions(shopId, permissions) {
    const stock = permissions.includes('stock.view') ? await require('./market.reads').stockActions(shopId) : [];
    const orders = await require('../orders').reads.staffActions(shopId, permissions);
    return [...orders, ...stock];
  },
};

function register() {
  require('../business-members').businesses.register('shop', adapter);
}

module.exports = { register, adapter };
