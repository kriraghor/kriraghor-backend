'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };

    // 1. Safely add username column if not exists
    const tableInfo = await queryInterface.describeTable('users');
    if (!tableInfo.username) {
      await queryInterface.addColumn('users', 'username', { type: DataTypes.STRING(30), allowNull: true });
    }

    // 2. Safely add username index
    try {
      await queryInterface.addIndex('users', ['username'], { unique: true, name: 'uq_users_username' });
    } catch (e) {
      // Index already exists
    }
    
    // 3. Safely update identifier check constraint
    try {
      await queryInterface.sequelize.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_identifier;');
    } catch (e) {
      void e;
    }
    await queryInterface.sequelize.query(
      'ALTER TABLE users ADD CONSTRAINT chk_users_identifier CHECK (phone IS NOT NULL OR email IS NOT NULL OR username IS NOT NULL)'
    );

    // 4. Safely create oauth_identities table if it doesn't exist
    try {
      await h.createTable(queryInterface, 'oauth_identities', {
        id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        user_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
        provider: { type: h.ENUM('google'), allowNull: false },
        provider_user_id: { type: DataTypes.STRING(191), allowNull: false },
        email: { type: DataTypes.STRING(191), allowNull: true },
        email_verified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        display_name: { type: DataTypes.STRING(120), allowNull: true },
        picture_url: { type: DataTypes.STRING(512), allowNull: true },
        last_used_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
        created_at: now,
        updated_at: now,
      });
    } catch (e) {
      // Table already exists
    }

    // 5. Safely handle oauth_identities indexes
    try { await queryInterface.removeIndex('oauth_identities', 'uq_oauth_provider_subject'); } catch (e) { void e; }
    try { await queryInterface.removeIndex('oauth_identities', 'uq_oauth_user_provider'); } catch (e) { void e; }
    
    try {
      await queryInterface.addIndex('oauth_identities', ['provider', 'provider_user_id'], { unique: true, name: 'uq_oauth_provider_subject' });
    } catch (e) { void e; }
    try {
      await queryInterface.addIndex('oauth_identities', ['user_id', 'provider'], { unique: true, name: 'uq_oauth_user_provider' });
    } catch (e) { void e; }
  },

  async down(queryInterface) {
    try { await queryInterface.dropTable('oauth_identities'); } catch (e) { void e; }
    try { await queryInterface.sequelize.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_identifier;'); } catch (e) { void e; }
    try { await queryInterface.sequelize.query('ALTER TABLE users ADD CONSTRAINT chk_users_identifier CHECK (phone IS NOT NULL OR email IS NOT NULL);'); } catch (e) { void e; }
    try { await queryInterface.removeIndex('users', 'uq_users_username'); } catch (e) { void e; }
    try { await queryInterface.removeColumn('users', 'username'); } catch (e) { void e; }
  },
};