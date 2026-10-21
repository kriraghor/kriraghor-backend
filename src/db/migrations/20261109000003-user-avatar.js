'use strict';

/**
 * M01 (§6 users.avatar_key, Round B1): the member's photo, a key in the public bucket (the URL is
 * built with storage.publicUrl). NULL = no photo. Keys are never reused; removing the photo clears the
 * column. Expand-only.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    await h.ensureColumn(queryInterface, 'users', 'avatar_key', { type: Sequelize.DataTypes.STRING(200), allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('users', 'avatar_key');
  },
};
