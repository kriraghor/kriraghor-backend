'use strict';

/**
 * M06 split escrow (with M13): one payment for a basket from several shops opens one escrow hold per
 * split (a shop sub-order), so each releases, refunds or freezes on its own.
 *  - escrow_holds.split_ref: the split's reference (the M13 sub-order id); null for single-payee
 *    payments (one hold, as before).
 *  - "one hold per payment" (the column's UNIQUE) becomes: one hold per payment without splits
 *    (partial UNIQUE where split_ref IS NULL), and one per split (UNIQUE (payment_id, split_ref)).
 *  - refunds.escrow_hold_id: the hold a refund was reserved from (a payment may have several).
 * Old code never writes split_ref, so it still gets one hold per payment.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const q = (sql) => queryInterface.sequelize.query(sql);
    await queryInterface.addColumn('escrow_holds', 'split_ref', { type: DataTypes.UUID, allowNull: true });
    await q('CREATE UNIQUE INDEX uq_escrow_holds_payment ON escrow_holds (payment_id) WHERE split_ref IS NULL');
    await q('CREATE UNIQUE INDEX uq_escrow_holds_split ON escrow_holds (payment_id, split_ref) WHERE split_ref IS NOT NULL');
    await q('ALTER TABLE escrow_holds DROP CONSTRAINT IF EXISTS escrow_holds_payment_id_key');
    await queryInterface.addColumn('refunds', 'escrow_hold_id', { type: DataTypes.UUID, allowNull: true, references: { model: 'escrow_holds', key: 'id' }, onDelete: 'RESTRICT' });
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[{ n }]] = await q('SELECT COUNT(*) AS n FROM escrow_holds WHERE split_ref IS NOT NULL');
    if (Number(n) > 0) return;
    await queryInterface.removeColumn('refunds', 'escrow_hold_id');
    await q('ALTER TABLE escrow_holds ADD CONSTRAINT escrow_holds_payment_id_key UNIQUE (payment_id)');
    await q('DROP INDEX IF EXISTS uq_escrow_holds_split');
    await q('DROP INDEX IF EXISTS uq_escrow_holds_payment');
    await queryInterface.removeColumn('escrow_holds', 'split_ref');
  },
};
