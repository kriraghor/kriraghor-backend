'use strict';

/**
 * M19 Dashboards and Analytics, step 1 (§7): read models only. M19 owns these tables; their rows are
 * written from other modules' events (through those modules' read services) and repaired by the
 * nightly reconcile. No foreign keys: a read model never blocks its sources.
 *
 *  - kpi_fact_*: one row per source record (booking, court-day, payment, ledger transaction, esports
 *    entry and tournament), upserted with a source_version guard so an older read never overwrites a
 *    newer one.
 *  - kpi_mv_*: day-grained materialised views (unique index each, refreshed CONCURRENTLY by
 *    analytics.refresh-mviews); weeks, quarters and months are summed from days at query time in
 *    Asia/Dhaka.
 *  - kpi_processed_events: the second idempotency guard beside the M04 inbox; kpi_drift: the reconcile log.
 * Public schema with the kpi_ prefix (the spec's `analytics` schema is not needed with one database user).
 */
const COUNTED = "status IN ('confirmed', 'checked_in', 'completed', 'no_show')";

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const TS = 'TIMESTAMP(3) WITH TIME ZONE';
    const now = { type: TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const money = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    const q = (sql) => queryInterface.sequelize.query(sql);

    await queryInterface.createTable('kpi_fact_booking', {
      booking_id: { ...uuid, primaryKey: true },
      source_version: { type: DataTypes.BIGINT, allowNull: false },
      code: { type: DataTypes.STRING(16), allowNull: false },
      owner_id: uuid,
      ground_id: uuid,
      court_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false },
      area_id: optUuid,
      source: { type: DataTypes.STRING(16), allowNull: false },
      status: { type: DataTypes.STRING(30), allowNull: false },
      booker_user_id: optUuid,
      booker_key: { type: DataTypes.STRING(80), allowNull: false },
      start_at: { type: TS, allowNull: false },
      end_at: { type: TS, allowNull: false },
      half_hours: { type: DataTypes.SMALLINT, allowNull: false },
      total_poisha: money,
      online_poisha: money,
      refund_poisha: money,
      retained_poisha: money,
      fee_poisha: money,
      earned_poisha: money,
      venue_collected_poisha: money,
      confirmed_at: at,
      cancelled_at: at,
      updated_at: now,
    });
    await queryInterface.addIndex('kpi_fact_booking', ['owner_id', 'start_at'], { name: 'ix_kpi_booking_owner_start' });
    await queryInterface.addIndex('kpi_fact_booking', ['booker_user_id', 'start_at'], { name: 'ix_kpi_booking_booker_start' });
    await queryInterface.addIndex('kpi_fact_booking', ['area_id', 'start_at'], { name: 'ix_kpi_booking_area_start' });

    await queryInterface.createTable('kpi_fact_court_day', {
      court_id: { ...uuid, primaryKey: true },
      day: { type: DataTypes.DATEONLY, allowNull: false, primaryKey: true },
      owner_id: uuid,
      ground_id: uuid,
      open_hh: { type: DataTypes.SMALLINT, allowNull: false },
      booked_hh: { type: DataTypes.SMALLINT, allowNull: false },
      updated_at: now,
    });
    await queryInterface.addIndex('kpi_fact_court_day', ['owner_id', 'day'], { name: 'ix_kpi_court_day_owner' });

    await queryInterface.createTable('kpi_fact_payment', {
      payment_id: { ...uuid, primaryKey: true },
      purpose: { type: DataTypes.STRING(30), allowNull: false },
      vertical: { type: DataTypes.STRING(20), allowNull: false },
      payer_id: uuid,
      amount_poisha: money,
      refunded_poisha: money,
      captured_at: { type: TS, allowNull: false },
      updated_at: now,
    });
    await queryInterface.addIndex('kpi_fact_payment', ['vertical', 'captured_at'], { name: 'ix_kpi_payment_vertical' });
    await queryInterface.addIndex('kpi_fact_payment', ['payer_id', 'captured_at'], { name: 'ix_kpi_payment_payer' });

    await queryInterface.createTable('kpi_fact_ledger_txn', {
      txn_id: { ...uuid, primaryKey: true },
      posted_at: { type: TS, allowNull: false },
      kind: { type: DataTypes.STRING(40), allowNull: false },
      vertical: { type: DataTypes.STRING(20), allowNull: false },
      fee_revenue_poisha: money,
      fee_reversal_poisha: money,
    });
    await queryInterface.addIndex('kpi_fact_ledger_txn', ['posted_at'], { name: 'ix_kpi_ledger_posted' });

    await queryInterface.createTable('kpi_fact_esports_entry', {
      registration_id: { ...uuid, primaryKey: true },
      tournament_id: uuid,
      user_id: uuid,
      confirmed_at: { type: TS, allowNull: false },
      paid: { type: DataTypes.BOOLEAN, allowNull: false },
    });
    await queryInterface.createTable('kpi_fact_esports_tournament', {
      tournament_id: { ...uuid, primaryKey: true },
      game_id: uuid,
      finalised_at: { type: TS, allowNull: false },
      awards: { type: DataTypes.INTEGER, allowNull: false },
      paid_poisha: money,
      subsidy_poisha: money,
      revenue_poisha: money,
    });

    await queryInterface.createTable('kpi_processed_events', {
      event_id: { ...uuid, primaryKey: true },
      consumer: { type: DataTypes.STRING(80), allowNull: false, primaryKey: true },
      processed_at: now,
    });
    await queryInterface.createTable('kpi_drift', {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      run_at: { type: TS, allowNull: false },
      dataset: { type: DataTypes.STRING(30), allowNull: false },
      record_id: { type: DataTypes.STRING(64), allowNull: false },
      vertical: { type: DataTypes.STRING(20), allowNull: true },
      expected_poisha: { type: DataTypes.BIGINT, allowNull: true },
      actual_poisha: { type: DataTypes.BIGINT, allowNull: true },
      note: { type: DataTypes.STRING(200), allowNull: true },
    });
    await queryInterface.addIndex('kpi_drift', ['run_at'], { name: 'ix_kpi_drift_run' });

    // ---- day-grained materialised views (Asia/Dhaka days)
    const dhakaDay = (col) => `(${col} AT TIME ZONE 'Asia/Dhaka')::date`;
    await q(`CREATE MATERIALIZED VIEW kpi_mv_owner_day AS
      SELECT owner_id, ground_id, ${dhakaDay('start_at')} AS day,
        COUNT(*) FILTER (WHERE ${COUNTED})::int AS bookings,
        COUNT(*) FILTER (WHERE ${COUNTED} AND source = 'app')::int AS app_bookings,
        COUNT(*) FILTER (WHERE ${COUNTED} AND source = 'walk_in')::int AS walk_in_bookings,
        COUNT(*) FILTER (WHERE ${COUNTED} AND source = 'series')::int AS series_bookings,
        COALESCE(SUM(earned_poisha), 0)::bigint AS earned_poisha,
        COALESCE(SUM(venue_collected_poisha), 0)::bigint AS venue_poisha
      FROM kpi_fact_booking GROUP BY 1, 2, 3`);
    await q('CREATE UNIQUE INDEX uq_kpi_mv_owner_day ON kpi_mv_owner_day (owner_id, ground_id, day)');

    await q(`CREATE MATERIALIZED VIEW kpi_mv_owner_occupancy_day AS
      SELECT owner_id, ground_id, day, SUM(open_hh)::int AS open_hh, SUM(booked_hh)::int AS booked_hh
      FROM kpi_fact_court_day GROUP BY 1, 2, 3`);
    await q('CREATE UNIQUE INDEX uq_kpi_mv_owner_occupancy_day ON kpi_mv_owner_occupancy_day (owner_id, ground_id, day)');

    await q(`CREATE MATERIALIZED VIEW kpi_mv_owner_hour_day AS
      SELECT b.owner_id, b.ground_id, ${dhakaDay('h')} AS day, EXTRACT(HOUR FROM h AT TIME ZONE 'Asia/Dhaka')::int AS hour,
        SUM(cardinality(b.court_ids))::int AS half_hours
      FROM kpi_fact_booking b, generate_series(b.start_at, b.end_at - interval '30 minutes', interval '30 minutes') h
      WHERE b.${COUNTED} GROUP BY b.owner_id, b.ground_id, 3, 4`);
    await q('CREATE UNIQUE INDEX uq_kpi_mv_owner_hour_day ON kpi_mv_owner_hour_day (owner_id, ground_id, day, hour)');

    await q(`CREATE MATERIALIZED VIEW kpi_mv_platform_day AS
      SELECT vertical, day, SUM(online)::bigint AS online_gmv_poisha, SUM(venue)::bigint AS venue_poisha, SUM(fee)::bigint AS fee_poisha,
        SUM(bookings)::int AS bookings, SUM(entries)::int AS entries, SUM(prizes)::bigint AS prizes_poisha
      FROM (
        SELECT vertical, ${dhakaDay('captured_at')} AS day, amount_poisha - refunded_poisha AS online, 0 AS venue, 0 AS fee, 0 AS bookings, 0 AS entries, 0 AS prizes FROM kpi_fact_payment
        UNION ALL SELECT 'grounds', ${dhakaDay('start_at')}, 0, venue_collected_poisha, 0, CASE WHEN ${COUNTED} THEN 1 ELSE 0 END, 0, 0 FROM kpi_fact_booking
        UNION ALL SELECT vertical, ${dhakaDay('posted_at')}, 0, 0, fee_revenue_poisha - fee_reversal_poisha, 0, 0, 0 FROM kpi_fact_ledger_txn
        UNION ALL SELECT 'esports', ${dhakaDay('confirmed_at')}, 0, 0, 0, 0, 1, 0 FROM kpi_fact_esports_entry
        UNION ALL SELECT 'esports', ${dhakaDay('finalised_at')}, 0, 0, 0, 0, 0, paid_poisha FROM kpi_fact_esports_tournament
      ) x GROUP BY vertical, day`);
    await q('CREATE UNIQUE INDEX uq_kpi_mv_platform_day ON kpi_mv_platform_day (vertical, day)');
  },

  async down(queryInterface) {
    for (const v of ['kpi_mv_platform_day', 'kpi_mv_owner_hour_day', 'kpi_mv_owner_occupancy_day', 'kpi_mv_owner_day']) await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS ${v}`);
    for (const t of ['kpi_drift', 'kpi_processed_events', 'kpi_fact_esports_tournament', 'kpi_fact_esports_entry', 'kpi_fact_ledger_txn', 'kpi_fact_payment', 'kpi_fact_court_day', 'kpi_fact_booking']) await queryInterface.dropTable(t);
  },
};
