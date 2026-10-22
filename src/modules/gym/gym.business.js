'use strict';

/**
 * Round B3 business adapter for gyms (`gym`): what business-members may know about a gym (owner,
 * name, status). The front desk has no to-do of its own (admissions happen as members walk in).
 * Registered once per process (registry.registerAll), through gym/index.js.
 */
const { Op } = require('sequelize');
const { Gym } = require('../../models');

const adapter = {
  async business(id, { transaction } = {}) {
    const g = await Gym.findByPk(id, { attributes: ['id', 'ownerId', 'name', 'status'], transaction });
    return g ? { id: g.id, ownerId: g.ownerId, name: g.name, status: g.status } : null;
  },
  async businessesOf(ownerId) {
    const rows = await Gym.findAll({ where: { ownerId, status: { [Op.ne]: 'removed' } }, attributes: ['id', 'name', 'status'], order: [['createdAt', 'ASC']] });
    return rows.map((g) => ({ id: g.id, name: g.name, status: g.status }));
  },
  staffActions: async () => [],
};

function register() {
  require('../business-members').businesses.register('gym', adapter);
}

module.exports = { register, adapter };
