'use strict';

/**
 * M19 Round B2 (owned by analytics): read models for the shop and gym dashboards (M19 §6.3, §7.1).
 * Only kpi_* tables and views, so no other module's table is touched (ADR-007). Rows are written from
 * the owning modules' events, re-read through their facades (M13 orders.reads, M20 gym.reads), and
 * repaired by the nightly reconcile; the first reconcile after this migration also backfills every
 * existing sub-order and pass once (facts.service backfill marker). No foreign keys: a read model
 * never blocks its sources. Money is BIGINT poisha; days are Asia/Dhaka.
 *
 *  - kpi_fact_sub_order: one row per M13 sub-order (items without delivery, commission, refunds), the
 *    newest version kept (source_version = the sub-order's updated time).
 *  - kpi_fact_order_line: one row per order item (product, category, units, line total), with the
 *    sub-order's status and placed time copied so sales by category and best sellers read one table.
 *  - kpi_fact_gym_pass: one row per M20 pass (kind, package, price, fee, refunds, validity, first use).
 *  - kpi_fact_gym_admission: one row per front-desk admission (pass_redemptions).
 *  - kpi_mv_shop_day, kpi_mv_shop_category_day: counted sub-orders by seller, shop and Dhaka day of
 *    placing (and by category); kpi_mv_gym_day: passes sold, sales, admissions and ended/unused passes
 *    by owner, gym and Dhaka day; kpi_mv_gym_hour_day: admissions by Dhaka hour. Unique index each
 *    (refreshed CONCURRENTLY by analytics.refresh-mviews).
 * The organiser dashboard needs no table: M14 answers it through its facade (live counts, M06 escrow).
 * Expand-only; pg-v2 helpers and IF NOT EXISTS (re-runnable).
 */
// Sub-orders that count as a sale (M19 §6.3: not pending payment, cancelled, rejected; expired and
// refunded sub-orders gave the money back too).
const SHOP_COUNTED = "status IN ('placed', 'accepted', 'shipped', 'delivered', 'completed', 'disputed')";
// Passes that were sold and not given back.
const GYM_SOLD = "status IN ('active', 'redeemed', 'expired')";
const NO_CATEGORY = "'00000000-0000-0000-0000-000000000000'::uuid";
const VIEWS = ['kpi_mv_gym_hour_day', 'kpi_mv_gym_day', 'kpi_mv_shop_category_day', 'kpi_mv_shop_day'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const q = (sql) => queryInterface.sequelize.query(sql);
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const money = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    const dhakaDay = (col) => `(${col} AT TIME ZONE 'Asia/Dhaka')::date`;

    // ---- shop (M13 sub-orders and their lines)
    await h.ensureTable(queryInterface, 'kpi_fact_sub_order', {
      sub_order_id: { ...uuid, primaryKey: true },
      source_version: { type: DataTypes.BIGINT, allowNull: false },
      code: { type: DataTypes.STRING(24), allowNull: false },
      order_id: uuid,
      shop_id: uuid,
      seller_id: uuid,
      buyer_id: uuid,
      status: { type: DataTypes.STRING(20), allowNull: false },
      units: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      items_poisha: money,
      delivery_poisha: money,
      commission_poisha: money,
      refunded_poisha: money,
      placed_at: at,
      completed_at: at,
      cancelled_at: at,
      updated_at: now,
    });
    await h.ensureIndex(queryInterface, 'kpi_fact_sub_order', ['seller_id', 'placed_at'], { name: 'ix_kpi_sub_order_seller_placed' });
    await h.ensureIndex(queryInterface, 'kpi_fact_sub_order', ['seller_id', 'buyer_id'], { name: 'ix_kpi_sub_order_seller_buyer' });

    await h.ensureTable(queryInterface, 'kpi_fact_order_line', {
      order_item_id: { ...uuid, primaryKey: true },
      sub_order_id: uuid,
      shop_id: uuid,
      seller_id: uuid,
      product_id: uuid,
      category_id: { type: DataTypes.UUID, allowNull: true },
      title: { type: DataTypes.STRING(120), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false },
      placed_at: at,
      qty: { type: DataTypes.INTEGER, allowNull: false },
      amount_poisha: money,
      updated_at: now,
    });
    await h.ensureIndex(queryInterface, 'kpi_fact_order_line', ['seller_id', 'placed_at'], { name: 'ix_kpi_order_line_seller_placed' });
    await h.ensureIndex(queryInterface, 'kpi_fact_order_line', ['sub_order_id'], { name: 'ix_kpi_order_line_sub_order' });

    // ---- gym (M20 passes and admissions)
    await h.ensureTable(queryInterface, 'kpi_fact_gym_pass', {
      pass_id: { ...uuid, primaryKey: true },
      source_version: { type: DataTypes.BIGINT, allowNull: false },
      code: { type: DataTypes.STRING(20), allowNull: false },
      gym_id: uuid,
      owner_id: uuid,
      package_id: uuid,
      kind: { type: DataTypes.STRING(10), allowNull: false },
      title: { type: DataTypes.STRING(80), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false },
      price_poisha: money,
      fee_poisha: money,
      refunded_poisha: money,
      released_poisha: money,
      paid_at: at,
      valid_from: { type: DataTypes.DATEONLY, allowNull: false },
      valid_to: { type: DataTypes.DATEONLY, allowNull: false },
      first_redeemed_at: at,
      admissions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      updated_at: now,
    });
    await h.ensureIndex(queryInterface, 'kpi_fact_gym_pass', ['owner_id', 'paid_at'], { name: 'ix_kpi_gym_pass_owner_paid' });

    await h.ensureTable(queryInterface, 'kpi_fact_gym_admission', {
      redemption_id: { ...uuid, primaryKey: true },
      pass_id: uuid,
      gym_id: uuid,
      owner_id: uuid,
      kind: { type: DataTypes.STRING(10), allowNull: false },
      method: { type: DataTypes.STRING(8), allowNull: false },
      redeemed_at: { type: h.TS, allowNull: false },
      updated_at: now,
    });
    await h.ensureIndex(queryInterface, 'kpi_fact_gym_admission', ['owner_id', 'redeemed_at'], { name: 'ix_kpi_gym_admission_owner' });
    await h.ensureIndex(queryInterface, 'kpi_fact_gym_admission', ['pass_id'], { name: 'ix_kpi_gym_admission_pass' });

    // ---- day-grained materialised views (Asia/Dhaka days)
    await q(`CREATE MATERIALIZED VIEW IF NOT EXISTS kpi_mv_shop_day AS
      SELECT seller_id, shop_id, ${dhakaDay('placed_at')} AS day,
        COUNT(*)::int AS orders, COALESCE(SUM(units), 0)::int AS units,
        COALESCE(SUM(items_poisha), 0)::bigint AS sales_poisha,
        COALESCE(SUM(delivery_poisha), 0)::bigint AS delivery_poisha,
        COALESCE(SUM(commission_poisha), 0)::bigint AS commission_poisha
      FROM kpi_fact_sub_order WHERE placed_at IS NOT NULL AND ${SHOP_COUNTED} GROUP BY 1, 2, 3`);
    await h.ensureIndexSql(queryInterface, 'uq_kpi_mv_shop_day', 'CREATE UNIQUE INDEX uq_kpi_mv_shop_day ON kpi_mv_shop_day (seller_id, shop_id, day)');

    await q(`CREATE MATERIALIZED VIEW IF NOT EXISTS kpi_mv_shop_category_day AS
      SELECT seller_id, shop_id, ${dhakaDay('placed_at')} AS day, COALESCE(category_id, ${NO_CATEGORY}) AS category_id,
        COALESCE(SUM(qty), 0)::int AS units, COALESCE(SUM(amount_poisha), 0)::bigint AS sales_poisha
      FROM kpi_fact_order_line WHERE placed_at IS NOT NULL AND ${SHOP_COUNTED} GROUP BY 1, 2, 3, 4`);
    await h.ensureIndexSql(queryInterface, 'uq_kpi_mv_shop_category_day', 'CREATE UNIQUE INDEX uq_kpi_mv_shop_category_day ON kpi_mv_shop_category_day (seller_id, shop_id, day, category_id)');

    // A pass "ends" on its last valid day once it is used up (redeemed) or expired; unused = never admitted.
    await q(`CREATE MATERIALIZED VIEW IF NOT EXISTS kpi_mv_gym_day AS
      SELECT owner_id, gym_id, day, SUM(sold)::int AS passes_sold, SUM(day_passes)::int AS day_passes, SUM(month_passes)::int AS month_passes,
        SUM(quarter_passes)::int AS quarter_passes, SUM(sales)::bigint AS sales_poisha, SUM(fee)::bigint AS fee_poisha,
        SUM(admissions)::int AS admissions, SUM(ended)::int AS ended, SUM(unused)::int AS unused
      FROM (
        SELECT owner_id, gym_id, ${dhakaDay('paid_at')} AS day, 1 AS sold, (kind = 'day')::int AS day_passes, (kind = 'month')::int AS month_passes,
          (kind = 'quarter')::int AS quarter_passes, price_poisha AS sales, fee_poisha AS fee, 0 AS admissions, 0 AS ended, 0 AS unused
          FROM kpi_fact_gym_pass WHERE paid_at IS NOT NULL AND ${GYM_SOLD}
        UNION ALL SELECT owner_id, gym_id, ${dhakaDay('redeemed_at')}, 0, 0, 0, 0, 0, 0, 1, 0, 0 FROM kpi_fact_gym_admission
        UNION ALL SELECT owner_id, gym_id, valid_to, 0, 0, 0, 0, 0, 0, 0, 1, (first_redeemed_at IS NULL)::int FROM kpi_fact_gym_pass WHERE status IN ('redeemed', 'expired')
      ) x GROUP BY owner_id, gym_id, day`);
    await h.ensureIndexSql(queryInterface, 'uq_kpi_mv_gym_day', 'CREATE UNIQUE INDEX uq_kpi_mv_gym_day ON kpi_mv_gym_day (owner_id, gym_id, day)');

    await q(`CREATE MATERIALIZED VIEW IF NOT EXISTS kpi_mv_gym_hour_day AS
      SELECT owner_id, gym_id, ${dhakaDay('redeemed_at')} AS day, EXTRACT(HOUR FROM redeemed_at AT TIME ZONE 'Asia/Dhaka')::int AS hour, COUNT(*)::int AS admissions
      FROM kpi_fact_gym_admission GROUP BY 1, 2, 3, 4`);
    await h.ensureIndexSql(queryInterface, 'uq_kpi_mv_gym_hour_day', 'CREATE UNIQUE INDEX uq_kpi_mv_gym_hour_day ON kpi_mv_gym_hour_day (owner_id, gym_id, day, hour)');
  },

  async down(queryInterface) {
    for (const v of VIEWS) await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS ${v}`);
    for (const t of ['kpi_fact_gym_admission', 'kpi_fact_gym_pass', 'kpi_fact_order_line', 'kpi_fact_sub_order']) await queryInterface.dropTable(t);
  },
};
