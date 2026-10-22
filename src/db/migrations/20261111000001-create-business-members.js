'use strict';

/**
 * Round B3 (Q69, Q169, Q170): staff accounts for businesses. The business-members module (identity
 * group, ADR-007) owns this one table.
 *  - business_members: a member account working at one venue, gym or shop (scope is per business,
 *    Q170) for its owner. `permissions` is a JSON array of permission keys, checked against the
 *    allow-list of the business type in business-members.rules (never written unchecked).
 *  - one active row per (business, member) (partial unique index); never deleted: `removed` keeps
 *    who removed them and when. The member is never the owner (CHECK).
 * Money never moves through this table: whatever staff do at the desk still pays the owner.
 */
const TYPES = ['venue', 'gym', 'shop'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const q = (sql) => queryInterface.sequelize.query(sql);

    await h.createTable(queryInterface, 'business_members', {
      id: { ...uuid, primaryKey: true },
      business_type: { type: h.ENUM(...TYPES), allowNull: false },
      business_id: uuid,
      owner_id: fk('users'),
      member_id: fk('users'),
      permissions: { type: DataTypes.JSONB, allowNull: false, defaultValue: Sequelize.literal("'[]'::jsonb") },
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      added_by: optFk('users'),
      removed_by: optFk('users'),
      removed_at: at,
      created_at: now,
      updated_at: now,
    });
    await q('ALTER TABLE business_members ADD CONSTRAINT ck_business_members_not_owner CHECK (member_id <> owner_id)');
    await q("ALTER TABLE business_members ADD CONSTRAINT ck_business_members_permissions CHECK (jsonb_typeof(permissions) = 'array')");
    await q("ALTER TABLE business_members ADD CONSTRAINT ck_business_members_removed CHECK ((status = 'removed') = (removed_at IS NOT NULL))");
    await q("CREATE UNIQUE INDEX uq_business_members_active ON business_members (business_type, business_id, member_id) WHERE status = 'active'");
    await queryInterface.addIndex('business_members', ['member_id', 'status'], { name: 'ix_business_members_member' });
    await queryInterface.addIndex('business_members', ['owner_id', 'status'], { name: 'ix_business_members_owner' });
    await queryInterface.addIndex('business_members', ['business_type', 'business_id', 'status'], { name: 'ix_business_members_business' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('business_members');
  },
};
