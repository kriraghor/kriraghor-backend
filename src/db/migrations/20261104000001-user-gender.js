'use strict';

/**
 * M01 (for M16 eligibility, Q27): a member's gender, self-declared and private. Bangladeshi NID cards
 * do not print it, so it is not verified; staff can correct it (gender_source staff_corrected). Used
 * only for men's and women's events; never in a public or captain-facing response.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.addColumn(queryInterface, 'users', 'gender', { type: h.ENUM('male', 'female', 'third'), allowNull: true });
    await h.addColumn(queryInterface, 'users', 'gender_source', { type: h.ENUM('self_declared', 'staff_corrected'), allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('users', 'gender_source');
    await queryInterface.removeColumn('users', 'gender');
  },
};
