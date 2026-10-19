'use strict';

/**
 * Demo data (owned by src/modules/demo): one row per record the demo seeder created, so demo content
 * is marked without a flag column on any other module's table, and `npm run demo:hide` can find every
 * demo user and listing again. Rows are never deleted; hiding changes the records' own statuses.
 */
const ENTITIES = ['user', 'staff', 'ground', 'shop', 'product', 'gym', 'hire_profile', 'organisation', 'sports_tournament', 'esports_tournament', 'esports_event', 'team'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    await h.ensureTable(queryInterface, 'demo_records', {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
      run_id: { type: DataTypes.STRING(40), allowNull: false },
      profile: { type: h.ENUM('listings', 'full'), allowNull: false },
      entity: { type: h.ENUM(...ENTITIES), allowNull: false },
      entity_id: { type: DataTypes.UUID, allowNull: false },
      label: { type: DataTypes.STRING(120), allowNull: true },
      created_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
    });
    await h.ensureIndex(queryInterface, 'demo_records', ['entity', 'entity_id'], { unique: true, name: 'uq_demo_records_entity' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('demo_records');
  },
};
