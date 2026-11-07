'use strict';

/**
 * M27 Gym operations, round 2 (approved 7 Nov 2026): members and engagement. Bookkeeping only, like round 1.
 *
 * gym-manage (owns and writes them):
 *  - gym_attendance_exits (append-only): check-out of a visit, by the desk, a second entrance scan or the
 *    auto-close job; one per attendance row (M27-FR-40..43). gym_attendance itself stays append-only.
 * gym-ops (gym group, ADR-007):
 *  - gym_classes, gym_class_schedules, gym_class_sessions, gym_class_bookings: classes with a weekly timetable,
 *    sessions made ahead, bookings with a waitlist (M27-FR-45..54);
 *  - gym_rewards, gym_point_entries (append-only), gym_member_referrals: reward points (M27-FR-55..61);
 *  - gym_notices: notices to a segment of members, in-app, push and email (M27-FR-62..65);
 *  - gym_leads: enquiries from the gym page (M27-FR-66..69).
 * catalog (M03 reference data):
 *  - exercises: the exercise library, EN and BN, seeded from exercises.v1.json (M27-FR-70, FR-71).
 * Settings: gym_saas.feature_min_tiers gains classes, points, notices (standard) and leads (basic), keeping
 * what a master changed. Value lists are VARCHAR + named CHECK; nothing is deleted.
 */
const crypto = require('node:crypto');

const NEW_FEATURES = { classes: 'standard', points: 'standard', notices: 'standard', leads: 'basic' };

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes, QueryTypes } = Sequelize;
    const db = queryInterface.sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const atReq = { type: h.TS, allowNull: false };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const str = (n, allowNull = true) => ({ type: DataTypes.STRING(n), allowNull });
    const int = (allowNull = false) => ({ type: DataTypes.INTEGER, allowNull });
    const small = (allowNull = false) => ({ type: DataTypes.SMALLINT, allowNull });
    const day = (allowNull = false) => ({ type: DataTypes.DATEONLY, allowNull });
    const jsonb = (def) => ({ type: DataTypes.JSONB, allowNull: false, defaultValue: Sequelize.literal(`'${JSON.stringify(def)}'::jsonb`) });
    const index = (name, sql) => h.ensureIndexSql(queryInterface, name, sql);

    // ---------------- gym-manage: check-out (append-only)
    await h.ensureTable(queryInterface, 'gym_attendance_exits', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      member_id: fk('gym_members'),
      attendance_id: fk('gym_attendance'),
      checked_out_at: atReq,
      method: { type: h.ENUM('desk', 'entrance_qr', 'auto'), allowNull: false },
      visit_minutes: int(true),
      by_user: optFk('users'),
      created_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_attendance_exits', 'chk_gym_attendance_exits', "CHECK ((visit_minutes IS NULL OR visit_minutes >= 0) AND ((method = 'auto') = (visit_minutes IS NULL)))");
    await index('uq_gym_attendance_exits_visit', 'CREATE UNIQUE INDEX uq_gym_attendance_exits_visit ON gym_attendance_exits (attendance_id)');
    await index('ix_gym_attendance_exits_gym', 'CREATE INDEX ix_gym_attendance_exits_gym ON gym_attendance_exits (gym_id, checked_out_at DESC)');
    await h.ensureAppendOnly(queryInterface, 'gym_attendance_exits');

    // ---------------- classes
    await h.ensureTable(queryInterface, 'gym_classes', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      name: str(80, false),
      description: str(500),
      trainer_user_id: optFk('users'),
      capacity: small(),
      minutes: small(),
      room: str(40),
      status: { type: h.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
      created_by: fk('users'),
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_classes', 'chk_gym_classes', 'CHECK (capacity BETWEEN 1 AND 500 AND minutes BETWEEN 10 AND 480)');
    await index('ix_gym_classes_gym', 'CREATE INDEX ix_gym_classes_gym ON gym_classes (gym_id, status)');

    await h.ensureTable(queryInterface, 'gym_class_schedules', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      class_id: fk('gym_classes'),
      dow: small(),
      start_time: { type: DataTypes.STRING(5), allowNull: false },
      status: { type: h.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_class_schedules', 'chk_gym_class_schedules', "CHECK (dow BETWEEN 0 AND 6 AND start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')");
    await index('uq_gym_class_schedules_slot', "CREATE UNIQUE INDEX uq_gym_class_schedules_slot ON gym_class_schedules (class_id, dow, start_time) WHERE status = 'active'");

    await h.ensureTable(queryInterface, 'gym_class_sessions', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      class_id: fk('gym_classes'),
      schedule_id: optFk('gym_class_schedules'),
      local_date: day(),
      starts_at: atReq,
      ends_at: atReq,
      capacity: small(),
      trainer_user_id: optFk('users'),
      status: { type: h.ENUM('scheduled', 'cancelled', 'done'), allowNull: false, defaultValue: 'scheduled' },
      cancel_reason: str(300),
      cancelled_by: optUuid,
      cancelled_at: at,
      reminded_at: at,
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(
      queryInterface,
      'gym_class_sessions',
      'chk_gym_class_sessions',
      "CHECK (ends_at > starts_at AND capacity BETWEEN 1 AND 500 AND ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)))"
    );
    await index('uq_gym_class_sessions_slot', 'CREATE UNIQUE INDEX uq_gym_class_sessions_slot ON gym_class_sessions (schedule_id, local_date) WHERE schedule_id IS NOT NULL');
    await index('ix_gym_class_sessions_gym', 'CREATE INDEX ix_gym_class_sessions_gym ON gym_class_sessions (gym_id, starts_at)');

    await h.ensureTable(queryInterface, 'gym_class_bookings', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      session_id: fk('gym_class_sessions'),
      member_id: fk('gym_members'),
      status: { type: h.ENUM('booked', 'waitlisted', 'cancelled', 'attended', 'no_show'), allowNull: false },
      booked_by: fk('users'),
      source: { type: h.ENUM('member', 'desk'), allowNull: false },
      promoted_at: at,
      cancelled_at: at,
      marked_at: at,
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_class_bookings', 'chk_gym_class_bookings', "CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))");
    await index('uq_gym_class_bookings_live', "CREATE UNIQUE INDEX uq_gym_class_bookings_live ON gym_class_bookings (session_id, member_id) WHERE status <> 'cancelled'");
    await index('ix_gym_class_bookings_session', 'CREATE INDEX ix_gym_class_bookings_session ON gym_class_bookings (session_id, status, created_at)');
    await index('ix_gym_class_bookings_member', 'CREATE INDEX ix_gym_class_bookings_member ON gym_class_bookings (member_id, status)');

    // ---------------- reward points
    await h.ensureTable(queryInterface, 'gym_rewards', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      title: str(80, false),
      points: int(),
      kind: { type: h.ENUM('days', 'discount'), allowNull: false },
      value: int(),
      status: { type: h.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_rewards', 'chk_gym_rewards', "CHECK (points > 0 AND value > 0 AND (kind <> 'days' OR value <= 90))");

    await h.ensureTable(queryInterface, 'gym_point_entries', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      member_id: fk('gym_members'),
      kind: { type: h.ENUM('checkin', 'streak', 'referral', 'redeem', 'expire', 'adjust'), allowNull: false },
      points: int(),
      ref_id: optUuid,
      local_date: day(),
      expires_on: day(true),
      note: str(200),
      by_user: optFk('users'),
      created_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_point_entries', 'chk_gym_point_entries', "CHECK (points <> 0 AND ((kind IN ('redeem', 'expire')) = (points < 0) OR kind = 'adjust'))");
    await index('uq_gym_point_entries_ref', "CREATE UNIQUE INDEX uq_gym_point_entries_ref ON gym_point_entries (member_id, kind, ref_id) WHERE ref_id IS NOT NULL AND kind IN ('checkin', 'streak', 'referral', 'expire')");
    await index('ix_gym_point_entries_member', 'CREATE INDEX ix_gym_point_entries_member ON gym_point_entries (member_id, created_at DESC)');
    await h.ensureAppendOnly(queryInterface, 'gym_point_entries');

    await h.ensureTable(queryInterface, 'gym_member_referrals', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      referrer_member_id: fk('gym_members'),
      referred_member_id: fk('gym_members'),
      status: { type: h.ENUM('pending', 'rewarded'), allowNull: false, defaultValue: 'pending' },
      rewarded_at: at,
      by_user: fk('users'),
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_member_referrals', 'chk_gym_member_referrals', "CHECK (referrer_member_id <> referred_member_id AND ((status = 'rewarded') = (rewarded_at IS NOT NULL)))");
    await index('uq_gym_member_referrals_referred', 'CREATE UNIQUE INDEX uq_gym_member_referrals_referred ON gym_member_referrals (referred_member_id)');

    // ---------------- notices
    await h.ensureTable(queryInterface, 'gym_notices', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      title: str(80, false),
      body: str(500, false),
      segment: jsonb({}),
      channels: jsonb([]),
      target_count: int(),
      local_date: day(),
      sent_by: fk('users'),
      created_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_notices', 'chk_gym_notices', 'CHECK (target_count >= 0)');
    await index('ix_gym_notices_gym', 'CREATE INDEX ix_gym_notices_gym ON gym_notices (gym_id, created_at DESC)');
    await h.ensureAppendOnly(queryInterface, 'gym_notices');

    // ---------------- enquiries (leads)
    await h.ensureTable(queryInterface, 'gym_leads', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      name: str(80, false),
      phone_enc: { type: DataTypes.TEXT, allowNull: false },
      phone_last4: { type: DataTypes.CHAR(4), allowNull: false },
      phone_hash: str(64, false),
      message: str(500),
      best_time: str(40),
      status: { type: h.ENUM('new', 'contacted', 'joined', 'lost'), allowNull: false, defaultValue: 'new' },
      note: str(300),
      member_id: optFk('gym_members'),
      source: { type: h.ENUM('gym_page', 'desk'), allowNull: false, defaultValue: 'gym_page' },
      updated_by: optUuid,
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_leads', 'chk_gym_leads', "CHECK (status <> 'joined' OR member_id IS NOT NULL)");
    await index('ix_gym_leads_gym', 'CREATE INDEX ix_gym_leads_gym ON gym_leads (gym_id, status, created_at DESC)');
    await index('ix_gym_leads_phone', 'CREATE INDEX ix_gym_leads_phone ON gym_leads (gym_id, phone_hash, created_at DESC)');

    // ---------------- catalog: the exercise library (M03 reference data)
    await h.ensureTable(queryInterface, 'exercises', {
      id: { ...uuid, primaryKey: true },
      key: str(40, false),
      name_en: str(80, false),
      name_bn: str(80, false),
      muscle: { type: h.ENUM('chest', 'back', 'shoulders', 'arms', 'legs', 'glutes', 'core', 'full_body', 'cardio'), allowNull: false },
      equipment: { type: h.ENUM('none', 'dumbbell', 'barbell', 'machine', 'cable', 'kettlebell', 'band', 'bench', 'other'), allowNull: false },
      level: { type: h.ENUM('beginner', 'intermediate', 'advanced'), allowNull: false },
      steps_en: jsonb([]),
      steps_bn: jsonb([]),
      video_url: str(500),
      sort: small(),
      status: { type: h.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
      created_at: now,
      updated_at: now,
    });
    await index('uq_exercises_key', 'CREATE UNIQUE INDEX uq_exercises_key ON exercises (key)');

    // ---------------- settings: new features into the tier map (values a master set are kept)
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
          replacements: { id: crypto.randomUUID(), v: Number(version) + 1, old: JSON.stringify(value), next: JSON.stringify(next), reason: 'M27 round 2 (7 Nov 2026): new gym features; values already set were kept' },
          transaction,
        }
      );
    });
  },

  // Tables stay (expand and contract); settings history is append-only.
  async down() {},
};
