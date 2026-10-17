'use strict';

/**
 * M10 Bookings, step 1 (§7.1–§7.3, v3 money rules): bookings, booking_slots, check_ins.
 *
 *  - booking_slots is the single occupancy table (FR-33, FR-35): every source (app bookings, walk-ins,
 *    series weeks and M09 closures) writes a row per court. The exclusion constraint makes a
 *    double-booking impossible: two active rows on one court can never overlap ([) ranges, so
 *    18:00–19:00 and 19:00–20:00 touch without overlapping). Moves, extensions and the released
 *    tail are in-place updates; released rows are kept (status), never deleted.
 *  - bookings snapshots the money of v3: the payment choice (advance or full online), what was paid
 *    online, the fee rate and the fee on the full value, plus what was retained and refunded.
 *  - check_ins: one per booking.
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
    const money = (dflt = null) => ({ type: DataTypes.BIGINT, allowNull: false, ...(dflt === null ? {} : { defaultValue: dflt }) });
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q('CREATE EXTENSION IF NOT EXISTS btree_gist');

    await h.createTable(queryInterface, 'bookings', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(16), allowNull: false },
      source: { type: h.ENUM('app', 'walk_in', 'series'), allowNull: false },
      ground_id: fk('grounds'),
      owner_id: fk('users'),
      court_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false },
      booker_user_id: optFk('users'),
      team_name: { type: DataTypes.STRING(80), allowNull: true },
      contact_name: { type: DataTypes.STRING(80), allowNull: true },
      contact_phone_enc: { type: DataTypes.STRING(255), allowNull: true },
      contact_phone_last4: { type: DataTypes.CHAR(4), allowNull: true },
      start_at: { type: TS, allowNull: false },
      end_at: { type: TS, allowNull: false },
      status: {
        type: h.ENUM('pending_payment', 'confirmed', 'checked_in', 'completed', 'no_show', 'cancelled', 'cancelled_by_owner', 'cancelled_by_platform', 'expired', 'skipped'),
        allowNull: false,
      },
      hold_expires_at: at,
      pricing_rule_id: fk('pricing_rules'),
      price_poisha: money(),
      extensions_poisha: money(0),
      total_poisha: money(),
      advance_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
      advance_poisha: money(),
      payment_choice: { type: h.ENUM('advance', 'full', 'venue'), allowNull: false },
      online_poisha: money(0),
      fee_bps: { type: DataTypes.INTEGER, allowNull: false },
      fee_poisha: money(),
      released_poisha: money(0),
      retained_poisha: money(0),
      refund_poisha: money(0),
      balance_status: { type: h.ENUM('not_due', 'due', 'collected', 'unrecorded', 'waived'), allowNull: false, defaultValue: 'not_due' },
      balance_method: { type: h.ENUM('cash', 'bkash_venue'), allowNull: true },
      balance_collected_poisha: { type: DataTypes.BIGINT, allowNull: true },
      balance_collected_at: at,
      balance_collected_by: optUuid,
      grace_min: { type: DataTypes.SMALLINT, allowNull: false },
      min_booking_min: { type: DataTypes.SMALLINT, allowNull: false },
      series_id: optFk('booking_series'),
      series_week: { type: DataTypes.SMALLINT, allowNull: true },
      payment_id: optFk('payments'),
      idempotency_key: { type: DataTypes.STRING(80), allowNull: true },
      move_count: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      free_cancel_until: at,
      confirmed_at: at,
      checked_in_at: at,
      completed_at: at,
      no_show_at: at,
      cancelled_at: at,
      expired_at: at,
      cancel_actor: { type: h.ENUM('booker', 'owner', 'platform', 'system'), allowNull: true },
      cancel_reason: { type: DataTypes.STRING(40), allowNull: true },
      cancel_note: { type: DataTypes.STRING(200), allowNull: true },
      reminded_at: at,
      unrecorded_at: at,
      ...audit(),
    });
    await queryInterface.addIndex('bookings', ['code'], { unique: true, name: 'uq_bookings_code' });
    await queryInterface.addIndex('bookings', ['ground_id', 'start_at'], { name: 'ix_bookings_ground_start' });
    await queryInterface.addIndex('bookings', ['owner_id', 'start_at'], { name: 'ix_bookings_owner_start' });
    await q('CREATE INDEX ix_bookings_booker_start ON bookings (booker_user_id, start_at DESC) WHERE booker_user_id IS NOT NULL');
    await queryInterface.addIndex('bookings', ['status', 'end_at'], { name: 'ix_bookings_status_end' });
    await queryInterface.addIndex('bookings', ['payment_id'], { name: 'ix_bookings_payment' });
    await q('CREATE UNIQUE INDEX uq_bookings_series_week ON bookings (series_id, series_week) WHERE series_id IS NOT NULL');
    await q('CREATE UNIQUE INDEX uq_bookings_idempotency ON bookings (booker_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
    await q(
      'ALTER TABLE bookings ADD CONSTRAINT chk_bookings_time CHECK (end_at > start_at AND MOD(EXTRACT(EPOCH FROM start_at)::BIGINT, 1800) = 0 AND MOD(EXTRACT(EPOCH FROM end_at)::BIGINT, 1800) = 0)'
    );
    await q(
      "ALTER TABLE bookings ADD CONSTRAINT chk_bookings_source CHECK ((source = 'app') = (booker_user_id IS NOT NULL) AND (source <> 'series' OR series_id IS NOT NULL) " +
        "AND (source = 'app' OR payment_choice = 'venue'))"
    );
    await q(
      'ALTER TABLE bookings ADD CONSTRAINT chk_bookings_money CHECK (price_poisha > 0 AND total_poisha = price_poisha + extensions_poisha AND advance_poisha BETWEEN 0 AND price_poisha ' +
        'AND online_poisha BETWEEN 0 AND total_poisha AND fee_poisha >= 0 AND released_poisha + refund_poisha <= online_poisha AND retained_poisha <= online_poisha AND cardinality(court_ids) > 0)'
    );

    await h.createTable(queryInterface, 'booking_slots', {
      id: { ...uuid, primaryKey: true },
      court_id: fk('courts'),
      ground_id: fk('grounds'),
      source: { type: h.ENUM('app', 'walk_in', 'series', 'closure'), allowNull: false },
      booking_id: optFk('bookings'),
      closure_id: optFk('closures'),
      status: { type: h.ENUM('active', 'released'), allowNull: false, defaultValue: 'active' },
      released_at: at,
      release_reason: { type: h.ENUM('expired', 'cancelled', 'no_show_tail', 'moved', 'skipped', 'reopened'), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    // tstzrange is not a Sequelize type: added by hand, [) bounds.
    await q('ALTER TABLE booking_slots ADD COLUMN period TSTZRANGE NOT NULL');
    await q("ALTER TABLE booking_slots ADD CONSTRAINT booking_slots_no_overlap EXCLUDE USING gist (court_id WITH =, period WITH &&) WHERE (status = 'active')");
    await q(
      "ALTER TABLE booking_slots ADD CONSTRAINT slot_owner_ck CHECK ((source = 'closure') = (closure_id IS NOT NULL) AND (source = 'closure') = (booking_id IS NULL))"
    );
    await q(
      'ALTER TABLE booking_slots ADD CONSTRAINT chk_booking_slots_period CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period) ' +
        'AND MOD(EXTRACT(EPOCH FROM lower(period))::BIGINT, 1800) = 0 AND MOD(EXTRACT(EPOCH FROM upper(period))::BIGINT, 1800) = 0)'
    );
    await q("CREATE INDEX ix_booking_slots_ground_start ON booking_slots (ground_id, lower(period)) WHERE status = 'active'");
    await queryInterface.addIndex('booking_slots', ['booking_id'], { name: 'ix_booking_slots_booking' });
    await queryInterface.addIndex('booking_slots', ['closure_id'], { name: 'ix_booking_slots_closure' });

    await h.createTable(queryInterface, 'check_ins', {
      id: { ...uuid, primaryKey: true },
      booking_id: fk('bookings'),
      checked_in_at: { type: TS, allowNull: false },
      checked_in_by: optFk('users'),
      late_minutes: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      method: { type: h.ENUM('owner_desk', 'walk_in'), allowNull: false },
      created_at: now,
    });
    await queryInterface.addIndex('check_ins', ['booking_id'], { unique: true, name: 'uq_check_ins_booking' });
  },

  async down(queryInterface) {
    for (const t of ['check_ins', 'booking_slots', 'bookings']) await queryInterface.dropTable(t);
    // btree_gist stays: other objects may use it, and it holds no data.
  },
};
