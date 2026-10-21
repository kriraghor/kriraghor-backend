'use strict';

/**
 * M19 exports (FR-22, FR-23): CSV of what the screen shows, scoped like the screen. UTF-8 with a
 * byte-order mark (Excel and Bangla), taka with two decimals, times in +06:00 (src/common/csv.js).
 * Read models hold no names or phones, and no export has a column for a person (no buyer, holder,
 * payer or booker id): codes, products, packages and money only. Synchronous up to
 * analytics.export_sync_max_rows (larger asks narrow the period: 422 EXPORT_TOO_LARGE); at most
 * analytics.exports_per_hour per user across every export, M14's registrations CSV included (Redis,
 * `take`); every export is audited.
 */
const { AppError } = require('../../common/errors');
const config = require('../../config');
const { getRedis } = require('../../common/redis');
const { csv, withBom, taka, dhakaTime, dhakaDay } = require('../../common/csv');
const { sequelize } = require('../../models');
const settings = require('../settings').settings;
const audit = require('../audit').audit;
const dashboards = require('./dashboards.service');
const rules = require('./analytics.rules');

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
const range = (f) => ({ fromTs: new Date(`${f.list[0].from}T00:00:00+06:00`), toTs: new Date(`${f.to}T00:00:00+06:00`) });
const COUNTED_SQL = `status IN (${[...rules.SHOP_COUNTED].map((s) => `'${s}'`).join(', ')})`;
const OWNER_ROLES = { ground_owner: 'venue owners', shop_owner: 'shop owners', gym_owner: 'gym owners' };

async function categoryNames(ids) {
  const { ItemCategory } = require('../catalog').reference;
  const rows = ids.length ? await ItemCategory.findAll({ where: { id: ids }, attributes: ['id', 'nameEn'] }) : [];
  return new Map(rows.map((c) => [c.id, c.nameEn]));
}

const DATASETS = {
  owner_bookings: {
    role: 'ground_owner',
    head: ['code', 'start', 'source', 'status', 'total_taka', 'paid_online_taka', 'earned_taka', 'recorded_at_venue_taka'],
    rows: async (p, f) =>
      (
        await select(
          'SELECT code, start_at, source, status, total_poisha, online_poisha, earned_poisha, venue_collected_poisha FROM kpi_fact_booking WHERE owner_id = :me AND start_at >= :fromTs AND start_at < :toTs ORDER BY start_at',
          { me: p.id, ...range(f) }
        )
      ).map((r) => [r.code, dhakaTime(r.start_at), r.source, r.status, taka(r.total_poisha), taka(r.online_poisha), taka(r.earned_poisha), taka(r.venue_collected_poisha)]),
  },
  owner_revenue: {
    role: 'ground_owner',
    head: ['bucket_from', 'bookings', 'earned_taka'],
    rows: async (p, f) => {
      const d = await dashboards.ownerDashboard(p, { period: f.period });
      return d.charts.weeklyRevenue.points.map((pt, i) => [pt.from, d.tiles.bookings.spark[i], taka(pt.value)]);
    },
  },
  member_payments: {
    role: 'member',
    head: ['captured', 'vertical', 'purpose', 'amount_taka', 'refunded_taka'],
    rows: async (p, f) =>
      (await select('SELECT captured_at, vertical, purpose, amount_poisha, refunded_poisha FROM kpi_fact_payment WHERE payer_id = :me AND captured_at >= :fromTs AND captured_at < :toTs ORDER BY captured_at', { me: p.id, ...range(f) })).map((r) => [
        dhakaTime(r.captured_at),
        r.vertical,
        r.purpose,
        taka(r.amount_poisha),
        taka(r.refunded_poisha),
      ]),
  },
  // Round B2 (M19 §6.3): the shop's orders (every placed sub-order, its status, items and money; no buyer).
  shop_orders: {
    role: 'shop_owner',
    head: ['code', 'placed', 'status', 'items', 'items_taka', 'delivery_taka', 'commission_taka', 'refunded_taka'],
    rows: async (p, f) =>
      (
        await select(
          'SELECT code, placed_at, status, units, items_poisha, delivery_poisha, commission_poisha, refunded_poisha FROM kpi_fact_sub_order WHERE seller_id = :me AND placed_at >= :fromTs AND placed_at < :toTs ORDER BY placed_at, code',
          { me: p.id, ...range(f) }
        )
      ).map((r) => [r.code, dhakaTime(r.placed_at), r.status, r.units, taka(r.items_poisha), taka(r.delivery_poisha), taka(r.commission_poisha), taka(r.refunded_poisha)]),
  },
  // Sales by product over the period (the counted orders only, like the Sales tile).
  shop_sales_by_product: {
    role: 'shop_owner',
    head: ['product', 'category', 'units', 'sales_taka'],
    rows: async (p, f) => {
      const rows = await select(
        `SELECT product_id, MAX(title) AS title, MAX(category_id::text) AS category_id, SUM(qty)::int AS units, SUM(amount_poisha)::bigint AS sales FROM kpi_fact_order_line WHERE seller_id = :me AND ${COUNTED_SQL} AND placed_at >= :fromTs AND placed_at < :toTs GROUP BY product_id ORDER BY 5 DESC, 2`,
        { me: p.id, ...range(f) }
      );
      const names = await categoryNames([...new Set(rows.map((r) => r.category_id).filter(Boolean))]);
      return rows.map((r) => [r.title, names.get(r.category_id) ?? '', r.units, taka(r.sales)]);
    },
  },
  // The gym's passes bought in the period (no holder).
  gym_passes: {
    role: 'gym_owner',
    head: ['code', 'kind', 'package', 'paid', 'valid_from', 'valid_to', 'status', 'price_taka', 'fee_taka', 'refunded_taka', 'admissions'],
    rows: async (p, f) =>
      (
        await select(
          'SELECT code, kind, title, paid_at, valid_from, valid_to, status, price_poisha, fee_poisha, refunded_poisha, admissions FROM kpi_fact_gym_pass WHERE owner_id = :me AND paid_at >= :fromTs AND paid_at < :toTs ORDER BY paid_at, code',
          { me: p.id, ...range(f) }
        )
      ).map((r) => [r.code, r.kind, r.title, dhakaTime(r.paid_at), dhakaDay(r.valid_from), dhakaDay(r.valid_to), r.status, taka(r.price_poisha), taka(r.fee_poisha), taka(r.refunded_poisha), r.admissions]),
  },
  // Front-desk admissions in the period (no holder).
  gym_admissions: {
    role: 'gym_owner',
    head: ['admitted', 'pass_code', 'kind', 'method'],
    rows: async (p, f) =>
      (
        await select(
          'SELECT a.redeemed_at, p.code, a.kind, a.method FROM kpi_fact_gym_admission a LEFT JOIN kpi_fact_gym_pass p ON p.pass_id = a.pass_id WHERE a.owner_id = :me AND a.redeemed_at >= :fromTs AND a.redeemed_at < :toTs ORDER BY a.redeemed_at',
          { me: p.id, ...range(f) }
        )
      ).map((r) => [dhakaTime(r.redeemed_at), r.code ?? '', r.kind, r.method]),
  },
  platform_daily: {
    role: 'platform',
    head: ['day', 'vertical', 'online_gmv_taka', 'venue_taka', 'fee_taka', 'bookings', 'esports_entries', 'prizes_taka'],
    rows: async (_p, f) =>
      (await select("SELECT * FROM kpi_mv_platform_day WHERE vertical <> 'test' AND day >= :from AND day < :to ORDER BY day, vertical", { from: f.list[0].from, to: f.to })).map((r) => [
        typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10),
        r.vertical,
        taka(r.online_gmv_poisha),
        taka(r.venue_poisha),
        taka(r.fee_poisha),
        r.bookings,
        r.entries,
        taka(r.prizes_poisha),
      ]),
  },
};

/** FR-23: count one export for the user; above analytics.exports_per_hour → 429 EXPORT_LIMIT. */
async function take(userId) {
  const key = `${config.redis.prefix}:analytics:exports:${userId}`;
  const n = await getRedis().incr(key);
  if (n === 1) await getRedis().expire(key, 3600);
  const max = settings.get('analytics.exports_per_hour');
  if (n > max) throw new AppError(429, 'EXPORT_LIMIT', 'You have exported the most allowed this hour. Try again later', { meta: { retryAfter: Number(await getRedis().ttl(key)) } });
}

/** FR-22: a synchronous export holds at most analytics.export_sync_max_rows rows. */
function checkSize(rows) {
  const max = settings.get('analytics.export_sync_max_rows');
  if (rows > max) throw new AppError(422, 'EXPORT_TOO_LARGE', 'Choose a shorter period', { meta: { rows, max } });
}

/** Build a CSV for `dataset` (scoped to `scope`: the member, a business owner, or the platform). */
async function exportCsv(principal, { dataset, period = '7w' }, scope, req) {
  const def = DATASETS[dataset];
  if (!def || def.role !== scope) throw new AppError(404, 'DATASET_UNKNOWN', 'This export is not available here');
  if (OWNER_ROLES[scope] && principal.roles?.[scope] !== 'active') throw new AppError(403, 'ROLE_REQUIRED', `This export is for active ${OWNER_ROLES[scope]}`, { meta: { role: scope } });
  const f = dashboards.frame(period);
  const rows = await def.rows(principal, f);
  checkSize(rows.length);
  await take(principal.id);
  await audit.record({ action: 'analytics.exported', actor: principal, entityType: 'analytics_export', entityId: principal.id, meta: { dataset, period, rows: rows.length }, req });
  return { filename: `kriraghor-${dataset}-${f.today}.csv`, body: withBom(csv([def.head, ...rows])) };
}

module.exports = { exportCsv, take, checkSize, DATASETS };
