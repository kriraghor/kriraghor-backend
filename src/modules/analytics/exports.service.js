'use strict';

/**
 * M19 exports (FR-22, FR-23): CSV of what the screen shows, scoped like the screen. UTF-8 with a
 * byte-order mark (Excel and Bangla), taka with two decimals, times in +06:00. Read models hold no
 * names or phones, so nothing personal leaves. Synchronous up to analytics.export_sync_max_rows
 * (larger asks narrow the period: 422 EXPORT_TOO_LARGE); at most analytics.exports_per_hour per user
 * (Redis); every export is audited.
 */
const { AppError } = require('../../common/errors');
const config = require('../../config');
const { getRedis } = require('../../common/redis');
const { sequelize } = require('../../models');
const settings = require('../settings/settings.service');
const audit = require('../audit/audit.service');
const { csv } = require('../payouts/payouts.rules');
const dashboards = require('./dashboards.service');

const taka = (p) => (Number(p) / 100).toFixed(2);
const local = (d) => new Date(new Date(d).getTime() + 6 * 3600 * 1000).toISOString().replace('Z', '+06:00').replace(/\.\d{3}/, '');
const select = (sql, replacements) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
const range = (f) => ({ fromTs: new Date(`${f.list[0].from}T00:00:00+06:00`), toTs: new Date(`${f.to}T00:00:00+06:00`) });

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
      ).map((r) => [r.code, local(r.start_at), r.source, r.status, taka(r.total_poisha), taka(r.online_poisha), taka(r.earned_poisha), taka(r.venue_collected_poisha)]),
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
        local(r.captured_at),
        r.vertical,
        r.purpose,
        taka(r.amount_poisha),
        taka(r.refunded_poisha),
      ]),
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

async function limit(userId) {
  const key = `${config.redis.prefix}:analytics:exports:${userId}`;
  const n = await getRedis().incr(key);
  if (n === 1) await getRedis().expire(key, 3600);
  const max = settings.get('analytics.exports_per_hour');
  if (n > max) throw new AppError(429, 'EXPORT_LIMIT', 'You have exported the most allowed this hour. Try again later', { meta: { retryAfter: Number(await getRedis().ttl(key)) } });
}

/** Build a CSV for `dataset` (scoped to `scope`: the member, the owner, or the platform). */
async function exportCsv(principal, { dataset, period = '7w' }, scope, req) {
  const def = DATASETS[dataset];
  if (!def || def.role !== scope) throw new AppError(404, 'DATASET_UNKNOWN', 'This export is not available here');
  if (scope === 'ground_owner' && principal.roles?.ground_owner !== 'active') throw new AppError(403, 'ROLE_REQUIRED', 'This export is for active venue owners', { meta: { role: 'ground_owner' } });
  const f = dashboards.frame(period);
  const rows = await def.rows(principal, f);
  const max = settings.get('analytics.export_sync_max_rows');
  if (rows.length > max) throw new AppError(422, 'EXPORT_TOO_LARGE', 'Choose a shorter period', { meta: { rows: rows.length, max } });
  await limit(principal.id);
  await audit.record({ action: 'analytics.exported', actor: principal, entityType: 'analytics_export', entityId: principal.id, meta: { dataset, period, rows: rows.length }, req });
  return { filename: `kriraghor-${dataset}-${f.today}.csv`, body: `${String.fromCharCode(0xfeff)}${csv([def.head, ...rows])}` };
}

module.exports = { exportCsv, DATASETS };
