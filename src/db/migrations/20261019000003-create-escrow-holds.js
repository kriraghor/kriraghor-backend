'use strict';

/**
 * M06 escrow holds (§7, §8, FR-06, FR-07, FR-13, FR-14). One hold per captured payment. The ledger
 * is the truth for money; a hold is the state machine and the sub-ledger key (ledger_entries carry
 * escrow_hold_id), and the nightly invariants job checks that every escrow account equals the sum of
 * its open holds.
 *
 * payee_id is NULL for pooled holds (esports entry fees, M21 §6.5), which are settled together by
 * group_ref (the tournament) rather than released to one payee.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const poisha = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };

    await h.createTable(queryInterface, 'escrow_holds', {
      id: { ...uuid, primaryKey: true },
      purpose: { type: DataTypes.STRING(30), allowNull: false },
      purpose_id: uuid,
      payment_id: { ...uuid, unique: true, references: { model: 'payments', key: 'id' }, onDelete: 'RESTRICT' },
      group_ref: { type: DataTypes.UUID, allowNull: true },
      payee_id: { type: DataTypes.UUID, allowNull: true },
      vertical: { type: DataTypes.STRING(20), allowNull: false },
      fee_bps: { type: DataTypes.INTEGER, allowNull: false },
      fee_setting_key: { type: DataTypes.STRING(80), allowNull: false },
      fee_setting_version: { type: DataTypes.INTEGER, allowNull: false },
      held_poisha: poisha,
      released_poisha: poisha,
      refunded_poisha: poisha,
      fee_taken_poisha: poisha,
      release_rule: { type: DataTypes.JSONB, allowNull: false },
      release_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      release_count: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      status: {
        type: h.ENUM('holding', 'partially_released', 'released', 'refunded', 'frozen', 'closed'),
        allowNull: false,
        defaultValue: 'holding',
      },
      // The status to return to when unfrozen.
      status_before_freeze: { type: DataTypes.STRING(20), allowNull: true },
      frozen_reason: { type: DataTypes.STRING(40), allowNull: true },
      frozen_ref: { type: DataTypes.UUID, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('escrow_holds', ['purpose', 'purpose_id'], { name: 'ix_escrow_purpose' });
    await queryInterface.addIndex('escrow_holds', ['group_ref'], { name: 'ix_escrow_group' });
    await queryInterface.addIndex('escrow_holds', ['status', 'release_at'], { name: 'ix_escrow_due' });
    await queryInterface.addIndex('escrow_holds', ['payee_id'], { name: 'ix_escrow_payee' });
    await queryInterface.sequelize.query(
      'ALTER TABLE escrow_holds ADD CONSTRAINT ck_escrow_amounts CHECK (held_poisha >= 0 AND released_poisha >= 0 AND refunded_poisha >= 0 ' +
        'AND fee_taken_poisha >= 0 AND released_poisha + refunded_poisha <= held_poisha AND fee_taken_poisha <= released_poisha)'
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('escrow_holds');
  },
};
