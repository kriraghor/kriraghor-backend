'use strict';

/**
 * M11 Hire, step 1 (the core hire loop, §7): hire_profiles, rate_cards, rate_card_items,
 * hire_requests, hire_jobs, hire_messages, hire_shortlists. Contracts (month and season), conduct
 * reports, the M10 official add-on, reliability and the availability grid come in step 2.
 *
 *  - hire_profiles: one per (user, hire role); reviewed on the Moderation desk like an M09 ground: the
 *    public sees live_snapshot, edits of a live profile run beside it (edit_status), and public_*
 *    columns follow the public version so the directory filters and sorts in SQL.
 *  - rate_cards: versioned (a save is a new version); requests snapshot the version they were quoted on.
 *  - hire_requests: one per hire; the quote per engagement is snapshotted; one M06 payment split into
 *    one escrow hold per job.
 *  - hire_jobs: one per engagement. busy = the job widened by half the travel buffer on each side, so
 *    the exclusion constraint keeps a buffer between two active jobs of the same person (per user, not
 *    per profile: an umpire who is also a scorer is one person).
 *  - hire_messages: the request's thread (append-only).
 */
const PROFILE_STATUSES = ['draft', 'pending_review', 'changes_requested', 'live', 'paused', 'rejected', 'withdrawn', 'suspended', 'removed'];
const EDIT_STATUSES = ['draft', 'pending_review', 'changes_requested', 'rejected'];
const REQUEST_STATUSES = ['pending', 'accepted_unpaid', 'confirmed', 'completed', 'declined', 'expired', 'withdrawn', 'lapsed', 'cancelled'];
const JOB_STATUSES = ['reserved', 'scheduled', 'checked_in', 'live', 'completed_marked', 'released', 'cancelled', 'withdrawn', 'void', 'disputed', 'refunded'];
const ACTIVE_JOBS = "('reserved', 'scheduled', 'checked_in', 'live', 'completed_marked')";

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
    const audit = () => ({ created_by: optUuid, updated_by: optUuid, created_at: now, updated_at: now });
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('CREATE EXTENSION IF NOT EXISTS btree_gist');

    await h.createTable(queryInterface, 'hire_profiles', {
      id: { ...uuid, primaryKey: true },
      user_id: fk('users'),
      role_id: fk('hire_roles'),
      slug: { type: DataTypes.STRING(96), allowNull: false },
      headline: { type: DataTypes.STRING(80), allowNull: false },
      specialisation: { type: DataTypes.STRING(40), allowNull: true },
      sport_keys: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
      experience_level: { type: h.ENUM('amateur', 'semi_pro', 'pro', 'national'), allowNull: false },
      years: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      base_area_id: fk('areas'),
      bio: { type: DataTypes.TEXT, allowNull: true },
      works_with_u16: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: h.ENUM(...PROFILE_STATUSES), allowNull: false, defaultValue: 'draft' },
      edit_status: { type: h.ENUM(...EDIT_STATUSES), allowNull: true },
      live_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      live_snapshot: { type: DataTypes.JSONB, allowNull: true },
      current_submission_id: optUuid,
      review_reason_code: { type: DataTypes.STRING(40), allowNull: true },
      review_reason_text: { type: DataTypes.STRING(500), allowNull: true },
      first_live_at: at,
      status_changed_at: at,
      public_headline: { type: DataTypes.STRING(80), allowNull: true },
      public_experience_level: { type: DataTypes.STRING(10), allowNull: true },
      public_area_id: optUuid,
      normalised_hourly_poisha: { type: DataTypes.BIGINT, allowNull: true },
      rating_avg: { type: DataTypes.DECIMAL(3, 2), allowNull: true },
      rating_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      jobs_done: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ...audit(),
    });
    await queryInterface.addIndex('hire_profiles', ['user_id', 'role_id'], { unique: true, name: 'uq_hire_profiles_user_role' });
    await queryInterface.addIndex('hire_profiles', ['slug'], { unique: true, name: 'uq_hire_profiles_slug' });
    await queryInterface.addIndex('hire_profiles', ['role_id', 'status', 'public_experience_level'], { name: 'ix_hire_profiles_directory' });
    await q('CREATE INDEX ix_hire_profiles_headline_trgm ON hire_profiles USING GIN (public_headline gin_trgm_ops)');
    await q("ALTER TABLE hire_profiles ADD CONSTRAINT chk_hire_profiles_snapshot CHECK (live_snapshot IS NOT NULL OR status NOT IN ('live', 'paused', 'suspended'))");
    await q('ALTER TABLE hire_profiles ADD CONSTRAINT chk_hire_profiles_years CHECK (years BETWEEN 0 AND 60)');

    await h.createTable(queryInterface, 'rate_cards', {
      id: { ...uuid, primaryKey: true },
      profile_id: fk('hire_profiles'),
      version: { type: DataTypes.INTEGER, allowNull: false },
      night_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
      short_notice_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
      short_notice_hours: { type: DataTypes.SMALLINT, allowNull: false },
      travel_north_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      travel_south_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      travel_outside_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      max_jobs_per_day: { type: DataTypes.SMALLINT, allowNull: false },
      created_by: optUuid,
      created_at: now,
    });
    await queryInterface.addIndex('rate_cards', ['profile_id', 'version'], { unique: true, name: 'uq_rate_cards_version' });
    await q('ALTER TABLE rate_cards ADD CONSTRAINT chk_rate_cards_values CHECK (night_pct BETWEEN 0 AND 100 AND short_notice_pct BETWEEN 0 AND 100 AND short_notice_hours BETWEEN 0 AND 336 AND travel_north_poisha >= 0 AND travel_south_poisha >= 0 AND travel_outside_poisha >= 0 AND max_jobs_per_day BETWEEN 1 AND 12)');
    await h.appendOnly(queryInterface, 'rate_cards');

    await h.createTable(queryInterface, 'rate_card_items', {
      id: { ...uuid, primaryKey: true },
      rate_card_id: fk('rate_cards'),
      unit: { type: h.ENUM('hourly', 'match'), allowNull: false },
      format: { type: h.ENUM('T10', 'T20', 'OD', 'TAPE'), allowNull: true },
      rate_poisha: poisha,
    });
    await q("CREATE UNIQUE INDEX uq_rate_card_items ON rate_card_items (rate_card_id, unit, COALESCE(format, ''))");
    await q('ALTER TABLE rate_card_items ADD CONSTRAINT chk_rate_card_items_rate CHECK (rate_poisha > 0)');
    await h.appendOnly(queryInterface, 'rate_card_items');

    await h.createTable(queryInterface, 'hire_requests', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(20), allowNull: false },
      hirer_id: fk('users'),
      profile_id: fk('hire_profiles'),
      pro_user_id: fk('users'),
      unit: { type: h.ENUM('hourly', 'match'), allowNull: false },
      note: { type: DataTypes.STRING(500), allowNull: true },
      rate_card_id: fk('rate_cards'),
      quote_snapshot: { type: DataTypes.JSONB, allowNull: false },
      total_poisha: poisha,
      fee_bps: { type: DataTypes.INTEGER, allowNull: false },
      fee_poisha: poisha,
      net_poisha: poisha,
      status: { type: h.ENUM(...REQUEST_STATUSES), allowNull: false, defaultValue: 'pending' },
      reply_by: { type: h.TS, allowNull: false },
      pay_by: at,
      payment_id: optFk('payments'),
      decline_reason_code: { type: DataTypes.STRING(40), allowNull: true },
      decline_text: { type: DataTypes.STRING(300), allowNull: true },
      decided_at: at,
      confirmed_at: at,
      closed_at: at,
      idempotency_key: { type: DataTypes.STRING(80), allowNull: false },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('hire_requests', ['code'], { unique: true, name: 'uq_hire_requests_code' });
    await queryInterface.addIndex('hire_requests', ['hirer_id', 'idempotency_key'], { unique: true, name: 'uq_hire_requests_idempotency' });
    await queryInterface.addIndex('hire_requests', ['hirer_id', 'created_at'], { name: 'ix_hire_requests_hirer' });
    await queryInterface.addIndex('hire_requests', ['profile_id', 'status'], { name: 'ix_hire_requests_profile' });
    await queryInterface.addIndex('hire_requests', ['payment_id'], { name: 'ix_hire_requests_payment' });
    await q("CREATE INDEX ix_hire_requests_reply_by ON hire_requests (reply_by) WHERE status = 'pending'");
    await q("CREATE INDEX ix_hire_requests_pay_by ON hire_requests (pay_by) WHERE status = 'accepted_unpaid'");
    await q('ALTER TABLE hire_requests ADD CONSTRAINT chk_hire_requests_money CHECK (total_poisha > 0 AND fee_bps BETWEEN 0 AND 10000 AND fee_poisha BETWEEN 0 AND total_poisha AND net_poisha = total_poisha - fee_poisha)');

    await h.createTable(queryInterface, 'hire_jobs', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(24), allowNull: false },
      request_id: fk('hire_requests'),
      profile_id: fk('hire_profiles'),
      pro_user_id: fk('users'),
      hirer_id: fk('users'),
      start_at: { type: h.TS, allowNull: false },
      end_at: { type: h.TS, allowNull: false },
      busy: { type: DataTypes.RANGE(DataTypes.DATE), allowNull: false },
      format: { type: h.ENUM('T10', 'T20', 'OD', 'TAPE'), allowNull: true },
      hours: { type: DataTypes.DECIMAL(4, 1), allowNull: false },
      night: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      u16: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      venue_ground_id: optFk('grounds'),
      venue_text: { type: DataTypes.STRING(200), allowNull: false },
      venue_area_id: fk('areas'),
      zone: { type: h.ENUM('home', 'north', 'south', 'outside'), allowNull: false },
      quote_poisha: poisha,
      fee_poisha: poisha,
      net_poisha: poisha,
      refunded_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      released_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      status: { type: h.ENUM(...JOB_STATUSES), allowNull: false, defaultValue: 'reserved' },
      checked_in_at: at,
      late: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      started_at: at,
      completed_at: at,
      work_note: { type: DataTypes.STRING(1000), allowNull: true },
      result_text: { type: DataTypes.STRING(120), allowNull: true },
      release_at: at,
      released_at: at,
      released_by: { type: h.ENUM('hirer', 'auto', 'dispute', 'cancellation'), allowNull: true },
      cancelled_at: at,
      cancelled_by: { type: h.ENUM('hirer', 'pro', 'system', 'staff'), allowNull: true },
      cancel_reason: { type: DataTypes.STRING(40), allowNull: true },
      cancel_fee_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      reminded_at: at,
      dispute_id: optUuid,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('hire_jobs', ['code'], { unique: true, name: 'uq_hire_jobs_code' });
    await queryInterface.addIndex('hire_jobs', ['request_id'], { name: 'ix_hire_jobs_request' });
    await queryInterface.addIndex('hire_jobs', ['pro_user_id', 'start_at'], { name: 'ix_hire_jobs_pro' });
    await queryInterface.addIndex('hire_jobs', ['hirer_id', 'start_at'], { name: 'ix_hire_jobs_hirer' });
    await q("CREATE INDEX ix_hire_jobs_release_at ON hire_jobs (release_at) WHERE status = 'completed_marked'");
    await q(`ALTER TABLE hire_jobs ADD CONSTRAINT hire_jobs_no_overlap EXCLUDE USING gist (pro_user_id WITH =, busy WITH &&) WHERE (status IN ${ACTIVE_JOBS})`);
    await q(
      'ALTER TABLE hire_jobs ADD CONSTRAINT chk_hire_jobs_money CHECK (end_at > start_at AND hours > 0 AND quote_poisha > 0 AND fee_poisha BETWEEN 0 AND quote_poisha AND net_poisha = quote_poisha - fee_poisha ' +
        'AND refunded_poisha >= 0 AND released_poisha >= 0 AND refunded_poisha + released_poisha <= quote_poisha AND cancel_fee_poisha BETWEEN 0 AND quote_poisha)'
    );

    await h.createTable(queryInterface, 'hire_messages', {
      id: { ...uuid, primaryKey: true },
      request_id: fk('hire_requests'),
      author_id: fk('users'),
      body: { type: DataTypes.STRING(1000), allowNull: false },
      created_at: now,
    });
    await queryInterface.addIndex('hire_messages', ['request_id', 'created_at'], { name: 'ix_hire_messages_request' });
    await h.appendOnly(queryInterface, 'hire_messages');

    await h.createTable(queryInterface, 'hire_shortlists', {
      id: { ...uuid, primaryKey: true },
      user_id: fk('users'),
      profile_id: fk('hire_profiles'),
      removed_at: at,
      created_at: now,
    });
    await q('CREATE UNIQUE INDEX uq_hire_shortlists ON hire_shortlists (user_id, profile_id) WHERE removed_at IS NULL');
  },

  async down(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    for (const t of ['hire_messages', 'rate_card_items', 'rate_cards']) await h.dropAppendOnly(queryInterface, t);
    for (const t of ['hire_shortlists', 'hire_messages', 'hire_jobs', 'hire_requests', 'rate_card_items', 'rate_cards', 'hire_profiles']) await queryInterface.dropTable(t);
  },
};
