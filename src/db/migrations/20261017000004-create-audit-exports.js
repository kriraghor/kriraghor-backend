'use strict';

/**
 * M04-FR-10 audit exports. The spec leaves the export's state implicit; it is kept here so the status
 * survives worker restarts. The CSV lives in the private bucket; the API streams it to the master who
 * asked for it until expires_at (audit.export_link_hours), instead of a public signed URL.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    await queryInterface.createTable('audit_exports', {
      id: { type: DataTypes.CHAR(36), primaryKey: true },
      requested_by: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      filters: { type: DataTypes.JSON, allowNull: false },
      status: { type: DataTypes.ENUM('queued', 'running', 'ready', 'failed', 'expired'), allowNull: false, defaultValue: 'queued' },
      row_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      object_key: { type: DataTypes.STRING(255), allowNull: true },
      error: { type: DataTypes.TEXT, allowNull: true },
      completed_at: { type: DataTypes.DATE(3), allowNull: true },
      expires_at: { type: DataTypes.DATE(3), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('audit_exports', ['requested_by', 'created_at'], { name: 'ix_audit_exports_requester' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('audit_exports');
  },
};
