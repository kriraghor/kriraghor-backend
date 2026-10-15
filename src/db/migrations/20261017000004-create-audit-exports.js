'use strict';

/**
 * M04-FR-10 audit exports. The spec leaves the export's state implicit; it is kept here so the status
 * survives worker restarts. The CSV lives in the private bucket; the API streams it to the master who
 * asked for it until expires_at (audit.export_link_hours), instead of a public signed URL.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    await h.createTable(queryInterface, 'audit_exports', {
      id: { type: DataTypes.UUID, primaryKey: true },
      requested_by: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      filters: { type: DataTypes.JSONB, allowNull: false },
      status: { type: h.ENUM('queued', 'running', 'ready', 'failed', 'expired'), allowNull: false, defaultValue: 'queued' },
      row_count: { type: DataTypes.INTEGER, allowNull: true },
      object_key: { type: DataTypes.STRING(255), allowNull: true },
      error: { type: DataTypes.TEXT, allowNull: true },
      completed_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      expires_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('audit_exports', ['requested_by', 'created_at'], { name: 'ix_audit_exports_requester' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('audit_exports');
  },
};
