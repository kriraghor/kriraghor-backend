'use strict';

/**
 * M07 on-demand withdrawal (M21-FR-26, v3): a payee withdraws their esports winnings (payable lines
 * from pool settlements, which scheduled runs never sweep) as a single payout of kind 'withdrawal'.
 * One open withdrawal per payee (partial unique index), like one open earning payout.
 */
const OPEN = ['scheduled', 'needs_approval', 'on_hold', 'processing'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await queryInterface.sequelize.query('ALTER TABLE payouts ALTER COLUMN kind TYPE VARCHAR(10)');
    await h.replaceEnumCheck(queryInterface, 'payouts', 'kind', ['earning', 'refund', 'withdrawal']);
    await queryInterface.addIndex('payouts', ['payee_id'], { unique: true, name: 'uq_payouts_one_open_withdrawal', where: { kind: 'withdrawal', status: OPEN } });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('payouts', 'uq_payouts_one_open_withdrawal');
    const [[{ n }]] = await queryInterface.sequelize.query("SELECT COUNT(*) AS n FROM payouts WHERE kind = 'withdrawal'");
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.replaceEnumCheck(queryInterface, 'payouts', 'kind', ['earning', 'refund']);
  },
};
