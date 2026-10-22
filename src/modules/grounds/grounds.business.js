'use strict';

/**
 * Round B3 business adapter for venues (`venue`): what business-members may know about a ground
 * (owner, name, status) and the staff to-do of one venue (M10 counts, by the staff's permissions).
 * Registered once per process (registry.registerAll), through grounds/index.js.
 */
const { Op } = require('sequelize');
const { Ground } = require('../../models');

const ref = (g) => ({ id: g.id, ownerId: g.ownerId, name: g.name, status: g.status });

const adapter = {
  async business(id, { transaction } = {}) {
    const g = await Ground.findByPk(id, { attributes: ['id', 'ownerId', 'name', 'status'], transaction });
    return g ? ref(g) : null;
  },
  async businessesOf(ownerId) {
    const rows = await Ground.findAll({ where: { ownerId, status: { [Op.ne]: 'removed' } }, attributes: ['id', 'ownerId', 'name', 'status'], order: [['createdAt', 'ASC']] });
    return rows.map((g) => ({ id: g.id, name: g.name, status: g.status }));
  },
  staffActions: (groundId, permissions, now) => require('../bookings').reads.staffActions(groundId, permissions, now),
};

function register() {
  require('../business-members').businesses.register('venue', adapter);
}

module.exports = { register, adapter };
