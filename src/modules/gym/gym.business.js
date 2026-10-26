'use strict';

/**
 * Round B3 business adapter for gyms (`gym`): what business-members may know about a gym (owner,
 * name, status). Staff to-dos come from gym-manage (M24: dues due today and overdue).
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
  // M24 (§2.1, M19): the gym's to-dos for its staff come from gym-manage (dues due today and overdue for fees.collect).
  staffActions: (gymId, permissions, now) => require('../gym-manage').reads.staffActions(gymId, permissions, now),
};

function register() {
  require('../business-members').businesses.register('gym', adapter);
}

module.exports = { register, adapter };
