'use strict';

/**
 * M24 §19 and §20 (product owner, 11 Nov 2026): a member renews their own membership, and body progress.
 * Expand only:
 *  - gym_manage_settings.self_renew_open (on by default: each gym can switch member renewals off, FR-121);
 *  - gym_memberships.created_via (desk | member): who made the membership, so the desk can tell a renewal
 *    made in the app (FR-126);
 *  - gym_body_entries: a member's measurements on a date (FR-128). At least one value; one live entry per
 *    member and date (a second one for the same date replaces the first, which is voided, never deleted).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ type: DataTypes.UUID, allowNull: true, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const measure = (precision, scale) => ({ type: DataTypes.DECIMAL(precision, scale), allowNull: true });

    await h.ensureColumn(queryInterface, 'gym_manage_settings', 'self_renew_open', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true });
    await h.ensureColumn(queryInterface, 'gym_memberships', 'created_via', { type: h.ENUM('desk', 'member'), allowNull: false, defaultValue: 'desk' });

    await h.ensureTable(queryInterface, 'gym_body_entries', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      member_id: fk('gym_members'),
      measured_on: { type: DataTypes.DATEONLY, allowNull: false },
      weight_kg: measure(4, 1),
      body_fat_pct: measure(3, 1),
      chest_cm: measure(4, 1),
      waist_cm: measure(4, 1),
      hips_cm: measure(4, 1),
      arm_cm: measure(4, 1),
      thigh_cm: measure(4, 1),
      by_user: fk('users'),
      by_role: { type: h.ENUM('member', 'staff'), allowNull: false },
      voided_at: { type: h.TS, allowNull: true },
      voided_by: optFk('users'),
      created_at: now,
    });
    await h.ensureCheck(
      queryInterface,
      'gym_body_entries',
      'chk_gym_body_entries',
      'CHECK (COALESCE(weight_kg, body_fat_pct, chest_cm, waist_cm, hips_cm, arm_cm, thigh_cm) IS NOT NULL' +
        ' AND (weight_kg IS NULL OR weight_kg BETWEEN 10 AND 400) AND (body_fat_pct IS NULL OR body_fat_pct BETWEEN 2 AND 70)' +
        ' AND (chest_cm IS NULL OR chest_cm BETWEEN 10 AND 300) AND (waist_cm IS NULL OR waist_cm BETWEEN 10 AND 300)' +
        ' AND (hips_cm IS NULL OR hips_cm BETWEEN 10 AND 300) AND (arm_cm IS NULL OR arm_cm BETWEEN 10 AND 300)' +
        ' AND (thigh_cm IS NULL OR thigh_cm BETWEEN 10 AND 300) AND ((voided_at IS NULL) = (voided_by IS NULL)))'
    );
    await h.ensureIndexSql(queryInterface, 'uq_gym_body_entries_day', 'CREATE UNIQUE INDEX uq_gym_body_entries_day ON gym_body_entries (member_id, measured_on) WHERE voided_at IS NULL');
    await h.ensureIndexSql(queryInterface, 'ix_gym_body_entries_member', 'CREATE INDEX ix_gym_body_entries_member ON gym_body_entries (member_id, measured_on DESC)');
  },

  // Expand only: the table and the two columns stay.
  async down() {},
};
