'use strict';

/**
 * M09 Grounds, step 1 (§7.1–§7.5): grounds, ground_photos, courts, court_hours, pricing_rules.
 * closures and booking_series come with M10 (they write its booking slots).
 *
 *  - grounds keeps the owner's working copy in its columns and the approved public version in
 *    live_snapshot (JSONB). An edit of a live ground runs beside it (edit_status) and the public
 *    keeps seeing the snapshot until the edit is approved (FR-03).
 *  - courts: `pending` until the ground (or the edit that added them) is approved; never deleted.
 *  - court_hours: one row per court and weekday, half-hour aligned (CHECKs; the 06:00–23:00 grid is
 *    a setting, checked in the service).
 *  - pricing_rules: versioned; one draft and one published version per ground (partial unique).
 *    The DB CHECK holds the design bounds; the live settings (base range, caps, advance ≥ fee) are
 *    checked in the service.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const TS = 'TIMESTAMP(3) WITH TIME ZONE';
    const now = { type: TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const audit = () => ({ created_by: optUuid, updated_by: optUuid, created_at: now, updated_at: now });
    const pct = { type: DataTypes.DECIMAL(5, 2), allowNull: false };
    const q = (sql) => queryInterface.sequelize.query(sql);

    await h.createTable(queryInterface, 'grounds', {
      id: { ...uuid, primaryKey: true },
      owner_id: fk('users'),
      name: { type: DataTypes.STRING(80), allowNull: false },
      slug: { type: DataTypes.STRING(96), allowNull: false },
      area_id: fk('areas'),
      address_line: { type: DataTypes.STRING(200), allowNull: false },
      lat: { type: DataTypes.DECIMAL(9, 6), allowNull: false },
      lng: { type: DataTypes.DECIMAL(9, 6), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      rules_text: { type: DataTypes.TEXT, allowNull: true },
      is_indoor: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      booking_cutoff_min: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      requires_official: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      facility_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      status: {
        type: h.ENUM('draft', 'pending_review', 'changes_requested', 'live', 'paused', 'rejected', 'withdrawn', 'suspended', 'removed'),
        allowNull: false,
        defaultValue: 'draft',
      },
      edit_status: { type: h.ENUM('draft', 'pending_review', 'changes_requested', 'rejected'), allowNull: true },
      live_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      live_snapshot: { type: DataTypes.JSONB, allowNull: true },
      current_submission_id: optUuid,
      review_reason_code: { type: DataTypes.STRING(40), allowNull: true },
      review_reason_text: { type: DataTypes.STRING(500), allowNull: true },
      first_live_at: at,
      status_changed_at: at,
      rating_avg: { type: DataTypes.DECIMAL(3, 2), allowNull: true },
      rating_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ...audit(),
    });
    await queryInterface.addIndex('grounds', ['slug'], { unique: true, name: 'uq_grounds_slug' });
    await queryInterface.addIndex('grounds', ['area_id', 'status'], { name: 'ix_grounds_area_status' });
    await queryInterface.addIndex('grounds', ['owner_id', 'status'], { name: 'ix_grounds_owner_status' });
    await q('CREATE INDEX ix_grounds_facilities ON grounds USING GIN (facility_ids)');
    await q('CREATE INDEX ix_grounds_name_trgm ON grounds USING GIN (name gin_trgm_ops)');
    await q('ALTER TABLE grounds ADD CONSTRAINT chk_grounds_cutoff CHECK (booking_cutoff_min IN (0, 15, 30, 60))');
    await q("ALTER TABLE grounds ADD CONSTRAINT chk_grounds_snapshot CHECK (live_snapshot IS NOT NULL OR status NOT IN ('live', 'paused', 'suspended'))");

    await h.createTable(queryInterface, 'ground_photos', {
      id: { ...uuid, primaryKey: true },
      ground_id: fk('grounds'),
      storage_key: { type: DataTypes.STRING(255), allowNull: false },
      mime: { type: h.ENUM('image/jpeg', 'image/png', 'image/webp'), allowNull: false },
      size_bytes: { type: DataTypes.INTEGER, allowNull: false },
      sha256: { type: DataTypes.CHAR(64), allowNull: false },
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      version_added: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      removed_at: at,
      ...audit(),
    });
    await queryInterface.addIndex('ground_photos', ['ground_id', 'status', 'sort'], { name: 'ix_ground_photos_ground' });
    await queryInterface.addIndex('ground_photos', ['sha256'], { name: 'ix_ground_photos_sha256' });

    await h.createTable(queryInterface, 'courts', {
      id: { ...uuid, primaryKey: true },
      ground_id: fk('grounds'),
      name: { type: DataTypes.STRING(40), allowNull: false },
      sport_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false },
      surface_id: fk('surfaces'),
      size_text: { type: DataTypes.STRING(40), allowNull: true },
      capacity_text: { type: DataTypes.STRING(40), allowNull: true },
      combinable_group: { type: DataTypes.STRING(32), allowNull: true },
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      status: { type: h.ENUM('pending', 'active', 'retired'), allowNull: false, defaultValue: 'pending' },
      retired_at: at,
      ...audit(),
    });
    await queryInterface.addIndex('courts', ['ground_id', 'status'], { name: 'ix_courts_ground_status' });
    await q("CREATE UNIQUE INDEX uq_courts_ground_name ON courts (ground_id, lower(name)) WHERE status <> 'retired'");
    await q('ALTER TABLE courts ADD CONSTRAINT chk_courts_sports CHECK (cardinality(sport_ids) >= 1)');

    await h.createTable(queryInterface, 'court_hours', {
      id: { ...uuid, primaryKey: true },
      court_id: fk('courts'),
      dow: { type: DataTypes.SMALLINT, allowNull: false },
      is_closed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      open_time: { type: DataTypes.TIME, allowNull: true },
      close_time: { type: DataTypes.TIME, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('court_hours', ['court_id', 'dow'], { unique: true, name: 'uq_court_hours_court_dow' });
    await q(
      'ALTER TABLE court_hours ADD CONSTRAINT chk_court_hours CHECK (dow BETWEEN 0 AND 6 AND (is_closed OR (open_time IS NOT NULL AND close_time IS NOT NULL ' +
        'AND close_time > open_time AND EXTRACT(MINUTE FROM open_time)::int % 30 = 0 AND EXTRACT(MINUTE FROM close_time)::int % 30 = 0)))'
    );

    await h.createTable(queryInterface, 'pricing_rules', {
      id: { ...uuid, primaryKey: true },
      ground_id: fk('grounds'),
      version: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: h.ENUM('draft', 'published', 'superseded', 'discarded'), allowNull: false },
      base_price_poisha: { type: DataTypes.BIGINT, allowNull: false },
      court_base_overrides: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      peak_from_hour: { type: DataTypes.SMALLINT, allowNull: false },
      early_to_hour: { type: DataTypes.SMALLINT, allowNull: false },
      peak_pct: pct,
      weekend_pct: pct,
      early_pct: pct,
      advance_pct: pct,
      series_discount_pct: pct,
      min_booking_min: { type: DataTypes.SMALLINT, allowNull: false },
      full_refund_hours: { type: DataTypes.SMALLINT, allowNull: false },
      half_refund_hours: { type: DataTypes.SMALLINT, allowNull: false },
      checkin_grace_min: { type: DataTypes.SMALLINT, allowNull: false },
      effective_from: at,
      effective_to: at,
      summary: { type: DataTypes.STRING(300), allowNull: true },
      changed_keys: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      published_by: optUuid,
      ...audit(),
    });
    await queryInterface.addIndex('pricing_rules', ['ground_id', 'version'], { unique: true, name: 'uq_pricing_rules_version' });
    await queryInterface.addIndex('pricing_rules', ['ground_id', 'status'], { name: 'ix_pricing_rules_ground_status' });
    await q("CREATE UNIQUE INDEX pricing_one_draft ON pricing_rules (ground_id) WHERE status = 'draft'");
    await q("CREATE UNIQUE INDEX pricing_one_live ON pricing_rules (ground_id) WHERE status = 'published'");
    await q(
      'ALTER TABLE pricing_rules ADD CONSTRAINT pr_bounds CHECK (base_price_poisha > 0 AND advance_pct BETWEEN 0 AND 100 AND peak_pct BETWEEN 0 AND 100 ' +
        'AND weekend_pct BETWEEN 0 AND 100 AND early_pct BETWEEN 0 AND 100 AND series_discount_pct BETWEEN 0 AND 100 AND half_refund_hours < full_refund_hours ' +
        'AND min_booking_min IN (60, 90, 120) AND peak_from_hour BETWEEN 15 AND 20 AND early_to_hour BETWEEN 7 AND 10)'
    );
  },

  async down(queryInterface) {
    for (const t of ['pricing_rules', 'court_hours', 'courts', 'ground_photos', 'grounds']) await queryInterface.dropTable(t);
  },
};
