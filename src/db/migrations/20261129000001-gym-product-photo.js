'use strict';

/**
 * M27 counter shop (tester feedback, 19 Nov 2026): one photo per product, shown at the counter. The
 * object sits in the public bucket under gym-products/{gymId}/{productId}/{uuid}.{ext}; a new photo
 * replaces the key (the old object stays for the audit trail). Expand only: three nullable columns.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    await h.ensureColumn(queryInterface, 'gym_products', 'photo_key', { type: DataTypes.STRING(200), allowNull: true });
    await h.ensureColumn(queryInterface, 'gym_products', 'photo_mime', { type: DataTypes.STRING(20), allowNull: true });
    await h.ensureColumn(queryInterface, 'gym_products', 'photo_bytes', { type: DataTypes.INTEGER, allowNull: true });
    await h.ensureCheck(queryInterface, 'gym_products', 'chk_gym_products_photo', 'CHECK ((photo_key IS NULL) = (photo_mime IS NULL) AND (photo_bytes IS NULL OR photo_bytes > 0))');
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE gym_products DROP CONSTRAINT IF EXISTS chk_gym_products_photo');
    for (const c of ['photo_bytes', 'photo_mime', 'photo_key']) await queryInterface.removeColumn('gym_products', c);
  },
};
