'use strict';

/**
 * M09 Grounds, step 2 (§7.6, §7.7): closures and booking_series. M09 owns both tables; their time
 * on the courts is written as M10 booking_slots (the occupancy port), so they arrive with M10.
 *
 *  - closures: a half-hour aligned period on some or all courts of a ground. Never deleted: reopen
 *    (upcoming) and end now (in progress) are statuses; the period's upper bound moves for end now.
 *  - booking_series: a weekly slot for a team, materialised as M10 bookings (source `series`, one per
 *    week) in the same transaction. The price per session is snapshotted (pricing.rules.seriesPrice).
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
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const audit = () => ({ created_by: optUuid, updated_by: optUuid, created_at: now, updated_at: now });
    const q = (sql) => queryInterface.sequelize.query(sql);

    await h.createTable(queryInterface, 'closures', {
      id: { ...uuid, primaryKey: true },
      ground_id: fk('grounds'),
      court_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false },
      starts_at: { type: TS, allowNull: false },
      ends_at: { type: TS, allowNull: false },
      reason: { type: h.ENUM('maintenance', 're_turfing', 'floodlight_repair', 'private_event', 'waterlogged', 'platform'), allowNull: false },
      note: { type: DataTypes.STRING(200), allowNull: true },
      status: { type: h.ENUM('active', 'reopened', 'ended_early'), allowNull: false, defaultValue: 'active' },
      reopened_at: at,
      reopened_by: optUuid,
      ended_early_at: at,
      ...audit(),
    });
    await queryInterface.addIndex('closures', ['ground_id', 'starts_at'], { name: 'ix_closures_ground_start' });
    await q('ALTER TABLE closures ADD CONSTRAINT chk_closures_period CHECK (ends_at > starts_at AND cardinality(court_ids) > 0)');
    await q(
      'ALTER TABLE closures ADD CONSTRAINT chk_closures_half_hour CHECK (MOD(EXTRACT(EPOCH FROM starts_at)::BIGINT, 1800) = 0 AND MOD(EXTRACT(EPOCH FROM ends_at)::BIGINT, 1800) = 0)'
    );

    await h.createTable(queryInterface, 'booking_series', {
      id: { ...uuid, primaryKey: true },
      ground_id: fk('grounds'),
      court_id: fk('courts'),
      owner_id: fk('users'),
      team_name: { type: DataTypes.STRING(80), allowNull: false },
      contact_user_id: optFk('users'),
      contact_phone_enc: { type: DataTypes.STRING(255), allowNull: true },
      contact_phone_last4: { type: DataTypes.CHAR(4), allowNull: true },
      dow: { type: DataTypes.SMALLINT, allowNull: false },
      start_time: { type: DataTypes.STRING(5), allowNull: false },
      length_min: { type: DataTypes.SMALLINT, allowNull: false },
      weeks: { type: DataTypes.SMALLINT, allowNull: false },
      first_date: { type: DataTypes.DATEONLY, allowNull: false },
      pricing_rule_id: fk('pricing_rules'),
      discount_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
      price_per_session_poisha: { type: DataTypes.BIGINT, allowNull: false },
      status: { type: h.ENUM('active', 'ended', 'completed'), allowNull: false, defaultValue: 'active' },
      ended_at: at,
      ended_by: optUuid,
      end_reason: { type: DataTypes.STRING(40), allowNull: true },
      ...audit(),
    });
    await queryInterface.addIndex('booking_series', ['ground_id', 'status'], { name: 'ix_booking_series_ground_status' });
    await q(
      "ALTER TABLE booking_series ADD CONSTRAINT chk_booking_series_shape CHECK (dow BETWEEN 0 AND 6 AND start_time ~ '^([01][0-9]|2[0-3]):(00|30)$' " +
        'AND length_min IN (60, 90, 120, 180) AND weeks BETWEEN 1 AND 52 AND discount_pct BETWEEN 0 AND 100 AND price_per_session_poisha > 0)'
    );
  },

  async down(queryInterface) {
    for (const t of ['booking_series', 'closures']) await queryInterface.dropTable(t);
  },
};
