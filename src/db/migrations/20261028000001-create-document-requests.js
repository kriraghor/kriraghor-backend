'use strict';

/**
 * M02 document requests (M18-FR-07, 18 Oct 2026). Staff ask a member for a document (a new NID upload
 * or a business document) by a due date; the member's next submission of that type fulfils it. M02
 * owns the table; M18 creates and cancels requests through M02's service.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const TS = 'TIMESTAMP(3) WITH TIME ZONE';
    const now = { type: TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const fk = (table, allowNull = false) => ({ type: DataTypes.UUID, allowNull, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });

    await h.createTable(queryInterface, 'document_requests', {
      id: { ...uuid, primaryKey: true },
      user_id: fk('users'),
      doc_type: { type: h.ENUM('nid', 'trade_license', 'deed_or_lease', 'tin'), allowNull: false },
      reason: { type: DataTypes.STRING(300), allowNull: false },
      source: { type: h.ENUM('risk', 'staff'), allowNull: false },
      source_ref: { type: DataTypes.UUID, allowNull: true },
      status: { type: h.ENUM('open', 'fulfilled', 'cancelled', 'overdue'), allowNull: false, defaultValue: 'open' },
      due_at: { type: TS, allowNull: false },
      requested_by: fk('users', true),
      fulfilled_document_id: fk('verification_documents', true),
      fulfilled_at: at,
      cancelled_at: at,
      cancelled_by: fk('users', true),
      cancel_reason: { type: DataTypes.STRING(300), allowNull: true },
      overdue_at: at,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query("CREATE UNIQUE INDEX uq_document_requests_open ON document_requests (user_id, doc_type) WHERE status IN ('open', 'overdue')");
    await queryInterface.addIndex('document_requests', ['status', 'due_at'], { name: 'ix_document_requests_due' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('document_requests');
  },
};
