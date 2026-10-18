'use strict';

/**
 * M20 Gym, step 1 (§7, v3): gyms, gym_hours, gym_photos, gym_packages, gym_passes, pass_redemptions,
 * trainer_plans, trainer_subscriptions, trainer_subscription_periods.
 *  - gyms: reviewed on the Moderation desk like an M09 ground: the owner edits a working copy, the
 *    public reads live_snapshot (hours and packages included), an edit of a live gym waits beside it.
 *  - gym_hours: windows of the working copy; a new week retires the old rows (removed_at), never deletes.
 *  - gym_packages: one active package per kind (day, month, quarter) per gym.
 *  - gym_passes: a package bought for dates; one M06 payment and one escrow hold each. The QR token is
 *    signed with the pass id and qr_nonce; the 6-character backup code is unique per gym among
 *    active passes. A day pass is redeemed once; month and quarter passes once per Dhaka day
 *    (pass_redemptions, UNIQUE (pass_id, redeemed_on)).
 *  - trainer_plans: a fitness trainer's monthly plan (an M11 hire profile); trainer_subscriptions and
 *    one trainer_subscription_periods row per month, each with its own payment and hold.
 */
const PROFILE_STATUSES = ['draft', 'pending_review', 'changes_requested', 'live', 'paused', 'rejected', 'withdrawn', 'suspended', 'removed'];
const EDIT_STATUSES = ['draft', 'pending_review', 'changes_requested', 'rejected'];
const KINDS = ['day', 'month', 'quarter'];
const PASS_STATUSES = ['pending_payment', 'active', 'redeemed', 'expired', 'cancelled', 'refunded', 'void'];
const SUB_STATUSES = ['pending_payment', 'active', 'cancelled', 'ended', 'lapsed', 'void'];
const PERIOD_STATUSES = ['pending_payment', 'paid', 'released', 'refunded', 'disputed', 'void'];

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
    const poisha = { type: DataTypes.BIGINT, allowNull: false };
    const poisha0 = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    const audit = () => ({ created_by: optUuid, updated_by: optUuid, created_at: now, updated_at: now });
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('CREATE EXTENSION IF NOT EXISTS pg_trgm');

    await h.createTable(queryInterface, 'gyms', {
      id: { ...uuid, primaryKey: true },
      owner_id: fk('users'),
      slug: { type: DataTypes.STRING(140), allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: false },
      area_id: fk('areas'),
      address_line: { type: DataTypes.STRING(300), allowNull: false },
      lat: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
      lng: { type: DataTypes.DECIMAL(9, 6), allowNull: true },
      about: { type: DataTypes.TEXT, allowNull: true },
      facility_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      daily_capacity: { type: DataTypes.INTEGER, allowNull: true },
      status: { type: h.ENUM(...PROFILE_STATUSES), allowNull: false, defaultValue: 'draft' },
      edit_status: { type: h.ENUM(...EDIT_STATUSES), allowNull: true },
      live_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      live_snapshot: { type: DataTypes.JSONB, allowNull: true },
      current_submission_id: optUuid,
      review_reason_code: { type: DataTypes.STRING(40), allowNull: true },
      review_reason_text: { type: DataTypes.STRING(500), allowNull: true },
      first_live_at: at,
      status_changed_at: at,
      public_name: { type: DataTypes.STRING(120), allowNull: true },
      public_area_id: optUuid,
      public_day_price_poisha: { type: DataTypes.BIGINT, allowNull: true },
      public_month_price_poisha: { type: DataTypes.BIGINT, allowNull: true },
      rating_avg: { type: DataTypes.DECIMAL(3, 2), allowNull: true },
      rating_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ...audit(),
    });
    await queryInterface.addIndex('gyms', ['slug'], { unique: true, name: 'uq_gyms_slug' });
    await queryInterface.addIndex('gyms', ['owner_id'], { name: 'ix_gyms_owner' });
    await queryInterface.addIndex('gyms', ['status', 'public_area_id'], { name: 'ix_gyms_directory' });
    await q('CREATE INDEX ix_gyms_name_trgm ON gyms USING GIN (name gin_trgm_ops)');
    await q("ALTER TABLE gyms ADD CONSTRAINT chk_gyms_snapshot CHECK (live_snapshot IS NOT NULL OR status NOT IN ('live', 'paused', 'suspended'))");
    await q('ALTER TABLE gyms ADD CONSTRAINT chk_gyms_capacity CHECK (daily_capacity IS NULL OR daily_capacity > 0)');

    await h.createTable(queryInterface, 'gym_hours', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      dow: { type: DataTypes.SMALLINT, allowNull: false },
      open_time: { type: DataTypes.STRING(5), allowNull: false },
      close_time: { type: DataTypes.STRING(5), allowNull: false },
      women_only: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      removed_at: at,
      created_at: now,
    });
    await queryInterface.addIndex('gym_hours', ['gym_id', 'dow'], { name: 'ix_gym_hours_gym', where: { removed_at: null } });
    await q("ALTER TABLE gym_hours ADD CONSTRAINT chk_gym_hours CHECK (dow BETWEEN 0 AND 6 AND open_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND close_time ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' AND close_time > open_time)");

    await h.createTable(queryInterface, 'gym_photos', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      storage_key: { type: DataTypes.STRING(300), allowNull: false },
      mime: { type: DataTypes.STRING(40), allowNull: false },
      size_bytes: { type: DataTypes.INTEGER, allowNull: false },
      sha256: { type: DataTypes.STRING(64), allowNull: false },
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      version_added: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      removed_at: at,
      ...audit(),
    });
    await queryInterface.addIndex('gym_photos', ['gym_id', 'status', 'sort'], { name: 'ix_gym_photos_gym' });

    await h.createTable(queryInterface, 'gym_packages', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      kind: { type: h.ENUM(...KINDS), allowNull: false },
      title: { type: DataTypes.STRING(80), allowNull: false },
      price_poisha: poisha,
      days: { type: DataTypes.SMALLINT, allowNull: false },
      status: { type: h.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
      ...audit(),
    });
    await q("CREATE UNIQUE INDEX uq_gym_packages_kind ON gym_packages (gym_id, kind) WHERE status = 'active'");
    await q('ALTER TABLE gym_packages ADD CONSTRAINT chk_gym_packages CHECK (price_poisha > 0 AND days BETWEEN 1 AND 366)');

    await h.createTable(queryInterface, 'gym_passes', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(20), allowNull: false },
      gym_id: fk('gyms'),
      package_id: fk('gym_packages'),
      holder_id: fk('users'),
      owner_id: fk('users'),
      kind: { type: h.ENUM(...KINDS), allowNull: false },
      title: { type: DataTypes.STRING(80), allowNull: false },
      valid_from: { type: DataTypes.DATEONLY, allowNull: false },
      valid_to: { type: DataTypes.DATEONLY, allowNull: false },
      price_poisha: poisha,
      fee_bps: { type: DataTypes.INTEGER, allowNull: false },
      fee_poisha: poisha,
      net_poisha: poisha,
      payment_id: optFk('payments'),
      qr_nonce: { type: DataTypes.STRING(24), allowNull: false },
      backup_code: { type: DataTypes.STRING(6), allowNull: true },
      status: { type: h.ENUM(...PASS_STATUSES), allowNull: false, defaultValue: 'pending_payment' },
      pay_by: at,
      paid_at: at,
      first_redeemed_at: at,
      last_redeemed_at: at,
      released_at: at,
      released_poisha: poisha0,
      refunded_poisha: poisha0,
      closed_at: at,
      close_reason: { type: DataTypes.STRING(40), allowNull: true },
      idempotency_key: { type: DataTypes.STRING(80), allowNull: false },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('gym_passes', ['code'], { unique: true, name: 'uq_gym_passes_code' });
    await queryInterface.addIndex('gym_passes', ['holder_id', 'idempotency_key'], { unique: true, name: 'uq_gym_passes_idempotency' });
    await queryInterface.addIndex('gym_passes', ['holder_id', 'created_at'], { name: 'ix_gym_passes_holder' });
    await queryInterface.addIndex('gym_passes', ['gym_id', 'valid_from', 'status'], { name: 'ix_gym_passes_gym_date' });
    await queryInterface.addIndex('gym_passes', ['payment_id'], { name: 'ix_gym_passes_payment' });
    await q("CREATE UNIQUE INDEX uq_gym_passes_backup ON gym_passes (gym_id, backup_code) WHERE status = 'active'");
    await q(
      "ALTER TABLE gym_passes ADD CONSTRAINT chk_gym_passes CHECK (valid_to >= valid_from AND price_poisha > 0 AND fee_poisha BETWEEN 0 AND price_poisha AND net_poisha = price_poisha - fee_poisha AND released_poisha >= 0 AND refunded_poisha >= 0 AND released_poisha + refunded_poisha <= price_poisha AND (status <> 'active' OR backup_code IS NOT NULL))"
    );

    await h.createTable(queryInterface, 'pass_redemptions', {
      id: { ...uuid, primaryKey: true },
      pass_id: fk('gym_passes'),
      gym_id: fk('gyms'),
      redeemed_on: { type: DataTypes.DATEONLY, allowNull: false },
      redeemed_at: { type: h.TS, allowNull: false },
      redeemed_by: fk('users'),
      method: { type: h.ENUM('qr', 'code'), allowNull: false },
      created_at: now,
    });
    await queryInterface.addIndex('pass_redemptions', ['pass_id', 'redeemed_on'], { unique: true, name: 'uq_pass_redemptions_day' });
    await queryInterface.addIndex('pass_redemptions', ['gym_id', 'redeemed_on'], { name: 'ix_pass_redemptions_gym_day' });
    await h.appendOnly(queryInterface, 'pass_redemptions');

    await h.createTable(queryInterface, 'trainer_plans', {
      id: { ...uuid, primaryKey: true },
      profile_id: fk('hire_profiles'),
      trainer_id: fk('users'),
      title: { type: DataTypes.STRING(80), allowNull: false },
      description: { type: DataTypes.STRING(500), allowNull: true },
      sessions_per_month: { type: DataTypes.SMALLINT, allowNull: true },
      price_poisha: poisha,
      where_kind: { type: h.ENUM('gym', 'home', 'online'), allowNull: false },
      gym_id: optFk('gyms'),
      area_id: optFk('areas'),
      status: { type: h.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
      ...audit(),
    });
    await queryInterface.addIndex('trainer_plans', ['profile_id', 'status'], { name: 'ix_trainer_plans_profile' });
    await q(
      "ALTER TABLE trainer_plans ADD CONSTRAINT chk_trainer_plans CHECK (price_poisha > 0 AND (sessions_per_month IS NULL OR sessions_per_month BETWEEN 1 AND 62) AND (where_kind <> 'gym' OR gym_id IS NOT NULL) AND (where_kind <> 'home' OR area_id IS NOT NULL))"
    );

    await h.createTable(queryInterface, 'trainer_subscriptions', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(20), allowNull: false },
      plan_id: fk('trainer_plans'),
      profile_id: fk('hire_profiles'),
      member_id: fk('users'),
      trainer_id: fk('users'),
      title: { type: DataTypes.STRING(80), allowNull: false },
      sessions_per_month: { type: DataTypes.SMALLINT, allowNull: true },
      price_poisha: poisha,
      status: { type: h.ENUM(...SUB_STATUSES), allowNull: false, defaultValue: 'pending_payment' },
      started_on: { type: DataTypes.DATEONLY, allowNull: false },
      paid_through: { type: DataTypes.DATEONLY, allowNull: true },
      renew: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      ended_at: at,
      end_reason: { type: DataTypes.STRING(40), allowNull: true },
      idempotency_key: { type: DataTypes.STRING(80), allowNull: false },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('trainer_subscriptions', ['code'], { unique: true, name: 'uq_trainer_subscriptions_code' });
    await queryInterface.addIndex('trainer_subscriptions', ['member_id', 'idempotency_key'], { unique: true, name: 'uq_trainer_subscriptions_idempotency' });
    await queryInterface.addIndex('trainer_subscriptions', ['trainer_id', 'status'], { name: 'ix_trainer_subscriptions_trainer' });
    await q("CREATE UNIQUE INDEX uq_trainer_subscriptions_open ON trainer_subscriptions (plan_id, member_id) WHERE status IN ('pending_payment', 'active')");

    await h.createTable(queryInterface, 'trainer_subscription_periods', {
      id: { ...uuid, primaryKey: true },
      subscription_id: fk('trainer_subscriptions'),
      seq: { type: DataTypes.INTEGER, allowNull: false },
      period_start: { type: DataTypes.DATEONLY, allowNull: false },
      period_end: { type: DataTypes.DATEONLY, allowNull: false },
      price_poisha: poisha,
      fee_bps: { type: DataTypes.INTEGER, allowNull: false },
      fee_poisha: poisha,
      net_poisha: poisha,
      payment_id: optFk('payments'),
      status: { type: h.ENUM(...PERIOD_STATUSES), allowNull: false, defaultValue: 'pending_payment' },
      pay_by: at,
      paid_at: at,
      release_at: at,
      released_at: at,
      released_poisha: poisha0,
      refunded_poisha: poisha0,
      dispute_id: optUuid,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('trainer_subscription_periods', ['subscription_id', 'seq'], { unique: true, name: 'uq_trainer_periods_seq' });
    await queryInterface.addIndex('trainer_subscription_periods', ['payment_id'], { name: 'ix_trainer_periods_payment' });
    await queryInterface.addIndex('trainer_subscription_periods', ['status', 'release_at'], { name: 'ix_trainer_periods_release' });
    await q(
      'ALTER TABLE trainer_subscription_periods ADD CONSTRAINT chk_trainer_periods CHECK (period_end >= period_start AND price_poisha > 0 AND fee_poisha BETWEEN 0 AND price_poisha AND net_poisha = price_poisha - fee_poisha AND released_poisha >= 0 AND refunded_poisha >= 0 AND released_poisha + refunded_poisha <= price_poisha)'
    );
  },

  async down(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.dropAppendOnly(queryInterface, 'pass_redemptions');
    for (const t of ['trainer_subscription_periods', 'trainer_subscriptions', 'trainer_plans', 'pass_redemptions', 'gym_passes', 'gym_packages', 'gym_photos', 'gym_hours', 'gyms']) await queryInterface.dropTable(t);
  },
};
