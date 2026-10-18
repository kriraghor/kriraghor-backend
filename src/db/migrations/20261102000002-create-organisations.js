'use strict';

/**
 * M14 lite (built early for M22, 18 Oct 2026): organisations and their members. M14 owns these tables;
 * its teams, players and physical tournaments come later on top of them.
 *  - organisations: kind `esports` for now; the owner applies (organiser role, NID and the
 *    org_registration document), the organisation is reviewed on the Moderation desk (M05 kind
 *    organisation) and becomes `verified`. Never deleted: `suspended` or `rejected`.
 *  - organisation_members: owner, admin or staff; one active row per (organisation, user).
 */
const ORG_STATUSES = ['draft', 'pending_review', 'changes_requested', 'verified', 'rejected', 'suspended'];
const MEMBER_ROLES = ['owner', 'admin', 'staff'];

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
    const audit = () => ({ created_by: optUuid, updated_by: optUuid, created_at: now, updated_at: now });
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('CREATE EXTENSION IF NOT EXISTS pg_trgm');

    await h.createTable(queryInterface, 'organisations', {
      id: { ...uuid, primaryKey: true },
      kind: { type: h.ENUM('esports'), allowNull: false, defaultValue: 'esports' },
      owner_user_id: fk('users'),
      name: { type: DataTypes.STRING(120), allowNull: false },
      slug: { type: DataTypes.STRING(140), allowNull: false },
      area_id: optFk('areas'),
      about: { type: DataTypes.STRING(1000), allowNull: true },
      contact_email: { type: DataTypes.STRING(160), allowNull: true },
      status: { type: h.ENUM(...ORG_STATUSES), allowNull: false, defaultValue: 'draft' },
      current_submission_id: optUuid,
      review_reason_code: { type: DataTypes.STRING(40), allowNull: true },
      review_reason_text: { type: DataTypes.STRING(500), allowNull: true },
      verified_at: at,
      status_changed_at: at,
      ...audit(),
    });
    await queryInterface.addIndex('organisations', ['slug'], { unique: true, name: 'uq_organisations_slug' });
    await queryInterface.addIndex('organisations', ['owner_user_id'], { name: 'ix_organisations_owner' });
    await queryInterface.addIndex('organisations', ['status'], { name: 'ix_organisations_status' });
    await q('CREATE INDEX ix_organisations_name_trgm ON organisations USING GIN (name gin_trgm_ops)');

    await h.createTable(queryInterface, 'organisation_members', {
      id: { ...uuid, primaryKey: true },
      organisation_id: fk('organisations'),
      user_id: fk('users'),
      role: { type: h.ENUM(...MEMBER_ROLES), allowNull: false },
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      added_by: optUuid,
      removed_by: optUuid,
      removed_at: at,
      created_at: now,
      updated_at: now,
    });
    await q("CREATE UNIQUE INDEX uq_organisation_members_active ON organisation_members (organisation_id, user_id) WHERE status = 'active'");
    await q("CREATE UNIQUE INDEX uq_organisation_members_owner ON organisation_members (organisation_id) WHERE status = 'active' AND role = 'owner'");
    await queryInterface.addIndex('organisation_members', ['user_id', 'status'], { name: 'ix_organisation_members_user' });
  },

  async down(queryInterface) {
    for (const t of ['organisation_members', 'organisations']) await queryInterface.dropTable(t);
  },
};
