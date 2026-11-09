'use strict';

/**
 * M24 trial visits (product owner, 9 Nov 2026): a signed-in person with a verified phone books a free visit
 * to a gym before joining; the gym is told and sees today's guests. Free, so nothing moves through M06 or the
 * gym's books. Owned by gym-manage (next to join requests, the entrance QR and members).
 *  - gym_manage_settings: visits_open (off by default), visit_daily_cap (null: the platform default),
 *    visit_per_person (default 1), visit_note.
 *  - gym_visits: one row per booked visit, with its own QR nonce and a 6-character code for the desk;
 *    booked → attended | cancelled | no_show; member_id once the guest becomes a member.
 *  - gym_reminders: kinds guests_today (the gym's morning list) and visit_reminder (the guest's morning
 *    reminder), subject type visit; the kind column grows to 20 characters (expand only).
 * Settings: gym_saas.feature_min_tiers gains visits (basic), keeping what a master changed.
 */
const crypto = require('node:crypto');

const NEW_FEATURES = { visits: 'basic' };
const REMINDER_KINDS = ['renewal_due', 'ends_today', 'overdue', 'expired', 'receipt', 'pay_link', 'plan', 'morning', 'monthly', 'tier_notice', 'invoice_due', 'sms_low', 'sms_empty', 'guests_today', 'visit_reminder'];
const REMINDER_SUBJECTS = ['membership', 'due', 'fee_payment', 'link', 'assignment', 'gym', 'owner', 'invoice', 'visit'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes, QueryTypes } = Sequelize;
    const db = queryInterface.sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const index = (name, sql) => h.ensureIndexSql(queryInterface, name, sql);

    // ---------------- the gym's visit rules
    await h.ensureColumn(queryInterface, 'gym_manage_settings', 'visits_open', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await h.ensureColumn(queryInterface, 'gym_manage_settings', 'visit_daily_cap', { type: DataTypes.SMALLINT, allowNull: true });
    await h.ensureColumn(queryInterface, 'gym_manage_settings', 'visit_per_person', { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 });
    await h.ensureColumn(queryInterface, 'gym_manage_settings', 'visit_note', { type: DataTypes.STRING(300), allowNull: true });
    await h.ensureCheck(queryInterface, 'gym_manage_settings', 'chk_gym_manage_settings_visits', 'CHECK ((visit_daily_cap IS NULL OR visit_daily_cap BETWEEN 1 AND 1000) AND visit_per_person BETWEEN 1 AND 100)');

    // ---------------- visits
    await h.ensureTable(queryInterface, 'gym_visits', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      user_id: fk('users'),
      visit_date: { type: DataTypes.DATEONLY, allowNull: false },
      arrive_at: { type: DataTypes.STRING(5), allowNull: false },
      status: { type: h.ENUM('booked', 'attended', 'cancelled', 'no_show'), allowNull: false, defaultValue: 'booked' },
      code: { type: DataTypes.STRING(6), allowNull: false },
      qr_nonce: { type: DataTypes.STRING(32), allowNull: false },
      cancel_by: { type: h.ENUM('guest', 'gym'), allowNull: true },
      cancel_reason: { type: DataTypes.STRING(300), allowNull: true },
      cancelled_at: at,
      attended_at: at,
      attended_by: optFk('users'),
      member_id: optFk('gym_members'),
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(
      queryInterface,
      'gym_visits',
      'chk_gym_visits',
      "CHECK (arrive_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND code ~ '^[0-9A-HJKMNP-TV-Z]{6}$' AND ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_by IS NOT NULL)) AND ((status = 'attended') = (attended_at IS NOT NULL)))"
    );
    await index('uq_gym_visits_open', "CREATE UNIQUE INDEX uq_gym_visits_open ON gym_visits (gym_id, user_id, visit_date) WHERE status = 'booked'");
    await index('uq_gym_visits_code', "CREATE UNIQUE INDEX uq_gym_visits_code ON gym_visits (gym_id, code) WHERE status = 'booked'");
    await index('ix_gym_visits_day', 'CREATE INDEX ix_gym_visits_day ON gym_visits (gym_id, visit_date, status)');
    await index('ix_gym_visits_user', 'CREATE INDEX ix_gym_visits_user ON gym_visits (user_id, created_at DESC)');

    // ---------------- the send-once log learns the two new notices (expand only)
    await db.query('ALTER TABLE gym_reminders ALTER COLUMN kind TYPE VARCHAR(20)');
    await h.replaceEnumCheck(queryInterface, 'gym_reminders', 'kind', REMINDER_KINDS);
    await h.replaceEnumCheck(queryInterface, 'gym_reminders', 'subject_type', REMINDER_SUBJECTS);

    // ---------------- settings: the new feature into the tier map (values a master set are kept)
    await db.transaction(async (transaction) => {
      const rows = await db.query("SELECT value, version FROM platform_settings WHERE key = 'gym_saas.feature_min_tiers' FOR UPDATE", { type: QueryTypes.SELECT, transaction });
      if (!rows.length) return;
      const { value, version } = rows[0];
      const next = { ...NEW_FEATURES, ...(value ?? {}) };
      if (JSON.stringify(next) === JSON.stringify(value)) return;
      await db.query("UPDATE platform_settings SET value = CAST(:next AS jsonb), version = :v, updated_at = CURRENT_TIMESTAMP(3) WHERE key = 'gym_saas.feature_min_tiers'", {
        replacements: { next: JSON.stringify(next), v: Number(version) + 1 },
        transaction,
      });
      await db.query(
        `INSERT INTO settings_history (id, key, version, old_value, new_value, effective_at, request_id, changed_by, approved_by, reason, created_at)
         VALUES (:id, 'gym_saas.feature_min_tiers', :v, CAST(:old AS jsonb), CAST(:next AS jsonb), CURRENT_TIMESTAMP(3), NULL, NULL, NULL, :reason, CURRENT_TIMESTAMP(3))`,
        {
          replacements: { id: crypto.randomUUID(), v: Number(version) + 1, old: JSON.stringify(value), next: JSON.stringify(next), reason: 'Trial visits (9 Nov 2026): a new gym feature; values already set were kept' },
          transaction,
        }
      );
    });
  },

  // Expand only: the table, columns and wider check stay.
  async down() {},
};
