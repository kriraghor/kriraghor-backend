'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') };

    await queryInterface.addColumn('users', 'username', { type: DataTypes.STRING(30), allowNull: true });
    await queryInterface.addIndex('users', ['username'], { unique: true, name: 'uq_users_username' });
    
    await queryInterface.sequelize.query('ALTER TABLE users DROP CONSTRAINT chk_users_identifier');
    await queryInterface.sequelize.query(
      'ALTER TABLE users ADD CONSTRAINT chk_users_identifier CHECK (phone IS NOT NULL OR email IS NOT NULL OR username IS NOT NULL)'
    );

    await queryInterface.createTable('oauth_identities', {
      id: { type: DataTypes.CHAR(36), allowNull: false, primaryKey: true },
      user_id: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      provider: { type: DataTypes.ENUM('google'), allowNull: false },
      provider_user_id: { type: DataTypes.STRING(191), allowNull: false },
      email: { type: DataTypes.STRING(191), allowNull: true },
      email_verified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      display_name: { type: DataTypes.STRING(120), allowNull: true },
      picture_url: { type: DataTypes.STRING(512), allowNull: true },
      last_used_at: { type: DataTypes.DATE(3), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('oauth_identities', ['provider', 'provider_user_id'], { unique: true, name: 'uq_oauth_provider_subject' });
    await queryInterface.addIndex('oauth_identities', ['user_id', 'provider'], { unique: true, name: 'uq_oauth_user_provider' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('oauth_identities');
    await queryInterface.sequelize.query('ALTER TABLE users DROP CONSTRAINT chk_users_identifier');
    await queryInterface.sequelize.query('ALTER TABLE users ADD CONSTRAINT chk_users_identifier CHECK (phone IS NOT NULL OR email IS NOT NULL)');
    await queryInterface.removeIndex('users', 'uq_users_username');
    await queryInterface.removeColumn('users', 'username');
  },
};