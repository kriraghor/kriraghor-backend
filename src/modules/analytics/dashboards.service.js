'use strict';

/**
 * M19 dashboards (FR-01 to FR-07, §6): the ground owner's Overview and Analytics, the member's
 * Overview and the platform overview (masters and view_analytics staff). Every number comes from M19's
 * own read models (facts and day-grained materialised views, summed into Dhaka buckets here); live
 * counts (verified members, the review queue) come from the owning services. Every answer carries
 * asOf. Money in poisha; the role is always checked on the server.
 */
const { E, AppError } = require('../../common/errors');
const { sequelize } = require('../../models');
const settings = require('../settings').settings;
const facts = require('./facts.service');
const rules = require('./analytics.rules');
const { definitionsFor } = require('./kpis');

const DAY = 24 * 60 * 60 * 1000;
const select = (sql, replacements) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
const dayStr = (rows) => rows.map((r) => ({ ...r, day: typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10) }));

function frame(period, now = new Date()) {
  if (!rules.isPeriod(period)) throw new AppError(422, 'PERIOD_INVALID', 'Choose 7 weeks, a quarter or a year', { meta: { allowed: Object.keys(rules.PERIODS) } });
  const today = rules.dhakaDate(now);
  const list = rules.buckets(period, today, settings.get('analytics.week_start'));
  const last = rules.lastYear(period, list);
  return { period, today, list, last, window: rules.comparable(list, today), from: last[0].from, to: list[list.length - 1].to };
}

/** A tile: the current bucket, the delta over the same elapsed part of the previous one, the sparkline. */
function tile(rows, f, field, { kind = 'amount', note = null } = {}) {
  const spark = rules.bucketize(rows, f.list, [field]).map((b) => b[field]);
  const value = spark[spark.length - 1];
  return { value, delta: rules.delta(rules.sumWindow(rows, f.window.current, field), rules.sumWindow(rows, f.window.previous, field), kind), spark, note };
}

/** A rate tile (occupancy, take rate) from two summed fields. */
function rateTile(rows, f, num, den) {
  const sums = rules.bucketize(rows, f.list, [num, den]);
  const rate = (w) => rules.occupancy(rules.sumWindow(rows, w, num), rules.sumWindow(rows, w, den));
  const spark = sums.map((b) => rules.occupancy(b[num], b[den]));
  return { value: spark[spark.length - 1], delta: rules.delta(rate(f.window.current), rate(f.window.previous), 'rate'), spark };
}

const meta = async (f, keys, locale) => ({ period: f.period, buckets: f.list.map((b) => ({ key: b.key, from: b.from, to: b.to })), asOf: (await facts.asOf())?.toISOString() ?? null, definitions: definitionsFor(keys, locale) });

// ---------------------------------------------------------------- ground owner (§6.2)

async function ownerDashboard(principal, { period = '7w', groundId = null, locale = 'en' }, now = new Date()) {
  if (principal.roles?.ground_owner !== 'active') throw E.forbidden('ROLE_REQUIRED', 'This dashboard is for active venue owners', undefined, { role: 'ground_owner' });
  const f = frame(period, now);
  const ground = groundId ? 'AND ground_id = :groundId' : '';
  const q = { owner: principal.id, from: f.from, to: f.to, groundId };
  const days = dayStr(await select(`SELECT day, SUM(bookings)::int AS bookings, SUM(app_bookings)::int AS app, SUM(walk_in_bookings)::int AS walk_in, SUM(series_bookings)::int AS series, SUM(earned_poisha)::bigint AS earned FROM kpi_mv_owner_day WHERE owner_id = :owner AND day >= :from AND day < :to ${ground} GROUP BY day`, q));
  const occ = dayStr(await select(`SELECT day, SUM(open_hh)::int AS open, SUM(booked_hh)::int AS booked FROM kpi_mv_owner_occupancy_day WHERE owner_id = :owner AND day >= :from AND day < :to ${ground} GROUP BY day`, q));
  const [ahead] = await select(`SELECT COALESCE(SUM(total_poisha), 0)::bigint AS ahead FROM kpi_fact_booking WHERE owner_id = :owner AND status = 'confirmed' AND start_at > :now ${ground}`, { ...q, now });
  const keys = await select(
    `SELECT booker_key, COUNT(*)::int AS n FROM kpi_fact_booking WHERE owner_id = :owner AND status IN ('confirmed', 'checked_in', 'completed', 'no_show') AND start_at >= :since AND start_at < :now ${ground} GROUP BY booker_key`,
    { ...q, since: new Date(now.getTime() - 90 * DAY), now }
  );
  const cur = f.list[f.list.length - 1];
  const inCur = (r) => r.day >= cur.from && r.day < cur.to;
  const split = days.filter(inCur).reduce((a, r) => ({ app: a.app + r.app, walkIn: a.walkIn + r.walk_in, series: a.series + r.series }), { app: 0, walkIn: 0, series: 0 });
  const tiles = {
    revenue: tile(days, f, 'earned', { note: { bookedAhead: Number(ahead.ahead) } }),
    occupancy: rateTile(occ, f, 'booked', 'open'),
    bookings: tile(days, f, 'bookings', { kind: 'count', note: split }),
    repeatTeams: { value: rules.repeatShare(Object.fromEntries(keys.map((k) => [k.booker_key, k.n]))), delta: null, spark: null },
  };

  // Analytics charts (FR-06: the splits add up to their tiles).
  const lastYear = rules.bucketize(days, f.last, ['earned']);
  const weeklyRevenue = rules.bucketize(days, f.list, ['earned']).map((b, i) => ({ key: b.key, from: b.from, value: b.earned, lastYear: lastYear[i].earned }));
  const hasLastYear = lastYear.some((b) => b.earned > 0);
  const bookingsByDay = [];
  for (let d = cur.from; d < cur.to; d = rules.addDays(d, 1)) bookingsByDay.push({ day: d, value: days.filter((r) => r.day === d).reduce((n, r) => n + r.bookings, 0) });
  const hours = await select(`SELECT hour, SUM(half_hours)::int AS half_hours FROM kpi_mv_owner_hour_day WHERE owner_id = :owner AND day >= :cfrom AND day < :to ${ground} GROUP BY hour ORDER BY 2 DESC, 1 ASC LIMIT 6`, { ...q, cfrom: f.list[0].from });
  const byGround = await select(`SELECT ground_id, SUM(earned_poisha)::bigint AS earned FROM kpi_mv_owner_day WHERE owner_id = :owner AND day >= :cfrom AND day < :cto ${ground} GROUP BY ground_id ORDER BY 2 DESC`, { ...q, cfrom: cur.from, cto: cur.to });
  const names = await groundNames(byGround.map((g) => g.ground_id));
  return {
    role: 'ground_owner',
    tiles,
    charts: {
      weeklyRevenue: { points: weeklyRevenue, lastYearShown: hasLastYear },
      bookingsByDay,
      busiestHours: hours.map((h) => ({ hour: h.hour, hours: h.half_hours / 2 })),
      revenueByGround: byGround.map((g) => ({ groundId: g.ground_id, name: names.get(g.ground_id) ?? '', value: Number(g.earned) })),
    },
    ...(await meta(f, ['revenue', 'occupancy', 'bookings', 'repeat_teams'], locale)),
  };
}

async function groundNames(ids) {
  const svc = require('../grounds').grounds;
  const out = new Map();
  for (const id of ids) out.set(id, (await svc.facts(id).catch(() => null))?.name ?? '');
  return out;
}

// ---------------------------------------------------------------- member (§6.3)

async function memberDashboard(principal, { period = '7w', locale = 'en' }, now = new Date()) {
  const f = frame(period, now);
  const pays = await select(
    `SELECT (captured_at AT TIME ZONE 'Asia/Dhaka')::date AS day, vertical, SUM(amount_poisha - refunded_poisha)::bigint AS spent FROM kpi_fact_payment WHERE payer_id = :me AND captured_at >= :fromTs AND captured_at < :toTs GROUP BY 1, 2`,
    { me: principal.id, fromTs: new Date(`${f.list[0].from}T00:00:00+06:00`), toTs: new Date(`${f.to}T00:00:00+06:00`) }
  );
  const rows = dayStr(pays).map((r) => ({ ...r, spent: Number(r.spent) }));
  const books = dayStr(
    await select(
      `SELECT (start_at AT TIME ZONE 'Asia/Dhaka')::date AS day, COUNT(*)::int AS bookings FROM kpi_fact_booking WHERE booker_user_id = :me AND status IN ('confirmed', 'checked_in', 'completed', 'no_show') AND start_at >= :fromTs AND start_at < :toTs GROUP BY 1`,
      { me: principal.id, fromTs: new Date(`${f.list[0].from}T00:00:00+06:00`), toTs: new Date(`${f.to}T00:00:00+06:00`) }
    )
  );
  const [up] = await select("SELECT COUNT(*)::int AS n FROM kpi_fact_booking WHERE booker_user_id = :me AND status = 'confirmed' AND start_at > :now", { me: principal.id, now });
  const byVertical = new Map();
  for (const r of rows) byVertical.set(r.vertical, (byVertical.get(r.vertical) ?? 0) + r.spent);
  return {
    role: 'member',
    tiles: { spent: tile(rows, f, 'spent'), bookings: tile(books, f, 'bookings', { kind: 'count' }), upcoming: { value: up.n, delta: null, spark: null } },
    charts: { whereItWent: [...byVertical].map(([vertical, value]) => ({ vertical, value })).sort((a, b) => b.value - a.value) },
    ...(await meta(f, ['spent', 'member_bookings'], locale)),
  };
}

// ---------------------------------------------------------------- platform (§6.4, Q106)

async function platformOverview(principal, { period = 'yr', locale = 'en' }, now = new Date()) {
  const f = frame(period, now);
  const raw = dayStr(await select("SELECT vertical, day, online_gmv_poisha AS online, venue_poisha AS venue, fee_poisha AS fee, bookings, entries, prizes_poisha AS prizes FROM kpi_mv_platform_day WHERE vertical <> 'test' AND day >= :from AND day < :to", f));
  const rows = raw.map((r) => ({ ...r, online: Number(r.online), venue: Number(r.venue), fee: Number(r.fee), prizes: Number(r.prizes), gtv: rules.gtv({ online: Number(r.online), venue: Number(r.venue) }) }));
  const cur = f.list[f.list.length - 1];
  const inCur = (r) => r.day >= cur.from && r.day < cur.to;
  const sumCur = (field) => rows.filter(inCur).reduce((n, r) => n + r[field], 0);
  const [people, queue] = await Promise.all([require('../users').directory.counts(), require('../moderation').moderation.stats(principal)]);
  const byVertical = new Map();
  for (const r of rows.filter(inCur)) byVertical.set(r.vertical, (byVertical.get(r.vertical) ?? 0) + r.gtv);
  const areas = await select(
    "SELECT area_id, COUNT(*)::int AS bookings FROM kpi_fact_booking WHERE status IN ('confirmed', 'checked_in', 'completed', 'no_show') AND start_at >= :fromTs AND start_at < :toTs AND area_id IS NOT NULL GROUP BY area_id ORDER BY 2 DESC",
    { fromTs: new Date(`${cur.from}T00:00:00+06:00`), toTs: new Date(`${cur.to}T00:00:00+06:00`) }
  );
  const areaNames = new Map((await require('../catalog').catalog.publicAreas()).items.map((a) => [a.id, locale === 'bn' ? a.nameBn : a.nameEn]));
  const big = areas.filter((a) => a.bookings >= 5);
  const other = areas.filter((a) => a.bookings < 5).reduce((n, a) => n + a.bookings, 0);
  return {
    role: 'platform',
    tiles: {
      gtv: tile(rows, f, 'gtv', { note: { online: sumCur('online') } }),
      feeRevenue: tile(rows, f, 'fee'),
      takeRate: (() => {
        const t = rateTile(rows, f, 'fee', 'gtv');
        return { ...t, value: rules.takeRate(sumCur('fee'), sumCur('gtv')) };
      })(),
      bookings: tile(rows, f, 'bookings', { kind: 'count' }),
      esportsEntries: tile(rows, f, 'entries', { kind: 'count' }),
      prizesPaid: tile(rows, f, 'prizes'),
      verifiedMembers: { value: people.verifiedMembers, delta: null, spark: null, note: { businesses: people.businesses } },
      waitingForReview: { value: queue.inQueue, delta: null, spark: null, note: { overdue: queue.overdue } },
    },
    charts: {
      volume: rules.bucketize(rows, f.list, ['gtv', 'online']).map((b) => ({ key: b.key, from: b.from, value: b.gtv, online: b.online })),
      volumeByVertical: [...byVertical].map(([vertical, value]) => ({ vertical, value })).sort((a, b) => b.value - a.value),
      topAreas: [...big.slice(0, 8).map((a) => ({ areaId: a.area_id, name: areaNames.get(a.area_id) ?? '', bookings: a.bookings })), ...(other ? [{ areaId: null, name: locale === 'bn' ? 'অন্যান্য' : 'Other', bookings: other }] : [])],
    },
    ...(await meta(f, ['gtv', 'fee_revenue', 'take_rate', 'bookings', 'esports_entries', 'prizes_paid'], locale)),
  };
}

module.exports = { ownerDashboard, memberDashboard, platformOverview, frame };
