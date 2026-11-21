'use strict';

/**
 * M19 dashboards (FR-01 to FR-07, §6): the ground owner's Overview and Analytics, the member's
 * Overview, the platform overview (masters and view_analytics staff) and, since Round B2 (§6.3), the
 * shop owner's, gym owner's and sports organiser's dashboards (the organiser's through M14's facade). Every number comes from M19's
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
  if (!rules.isPeriod(period)) throw new AppError(422, 'PERIOD_INVALID', 'Choose 30 days, 7 weeks, a quarter or a year', { meta: { allowed: Object.keys(rules.PERIODS) } });
  const today = rules.dhakaDate(now);
  const list = rules.buckets(period, today, settings.get('analytics.week_start'));
  const last = rules.lastYear(period, list);
  // cur: what a tile's headline and the "this period" charts cover (the last bucket; the whole period for 30d).
  return { period, today, list, last, cur: rules.headline(list), window: rules.comparable(list, today), from: last[0].from, to: list[list.length - 1].to };
}

/** A tile: the current bucket, the delta over the same elapsed part of the previous one, the sparkline. */
function tile(rows, f, field, { kind = 'amount', note = null } = {}) {
  const spark = rules.bucketize(rows, f.list, [field]).map((b) => b[field]);
  const value = rules.sumWindow(rows, f.cur, field);
  return { value, delta: rules.delta(rules.sumWindow(rows, f.window.current, field), rules.sumWindow(rows, f.window.previous, field), kind), spark, note };
}

/** A rate tile (occupancy, take rate) from two summed fields. */
function rateTile(rows, f, num, den) {
  const sums = rules.bucketize(rows, f.list, [num, den]);
  const rate = (w) => rules.occupancy(rules.sumWindow(rows, w, num), rules.sumWindow(rows, w, den));
  const spark = sums.map((b) => rules.occupancy(b[num], b[den]));
  return { value: rate(f.cur), delta: rules.delta(rate(f.window.current), rate(f.window.previous), 'rate'), spark };
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
    { ...q, since: new Date(now.getTime() - settings.get('analytics.repeat_customer_days') * DAY), now }
  );
  const cur = f.cur;
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
  const cur = f.cur;
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

// ---------------------------------------------------------------- Round B2: shops, gyms, organisers (§6.3)

const requireRole = (principal, role, what) => {
  if (principal.roles?.[role] !== 'active') throw E.forbidden('ROLE_REQUIRED', `This dashboard is for active ${what}`, undefined, { role });
};
const dhakaTs = (day) => new Date(`${day}T00:00:00+06:00`);
const num = (rows, fields) => rows.map((r) => ({ ...r, ...Object.fromEntries(fields.map((k) => [k, Number(r[k])])) }));

/** A line chart per bucket with the same buckets a year earlier (FR-05: hidden when last year is empty). */
function lineWithLastYear(rows, f, field) {
  const last = rules.bucketize(rows, f.last, [field]);
  return {
    points: rules.bucketize(rows, f.list, [field]).map((b, i) => ({ key: b.key, from: b.from, value: b[field], lastYear: last[i][field] })),
    lastYearShown: last.some((b) => b[field] > 0),
  };
}

/** Counts per day of the current bucket (bars that add up to the tile, FR-06). */
const byDay = (rows, cur, field) => rules.daysOf(cur).map((day) => ({ day, value: rows.filter((r) => r.day === day).reduce((n, r) => n + r[field], 0) }));

/** A money average tile (average order): value, delta over the comparable windows, sparkline per bucket. */
function averageTile(rows, f, total, count) {
  const avg = (w) => rules.average(rules.sumWindow(rows, w, total), rules.sumWindow(rows, w, count));
  return { value: avg(f.cur), delta: rules.delta(avg(f.window.current), avg(f.window.previous)), spark: rules.bucketize(rows, f.list, [total, count]).map((b) => rules.average(b[total], b[count])) };
}

/** A share tile (unused passes): value, points delta, sparkline per bucket. */
function shareTile(rows, f, part, whole) {
  const sh = (w) => rules.share(rules.sumWindow(rows, w, part), rules.sumWindow(rows, w, whole));
  return { value: sh(f.cur), delta: rules.delta(sh(f.window.current), sh(f.window.previous), 'rate'), spark: rules.bucketize(rows, f.list, [part, whole]).map((b) => rules.share(b[part], b[whole])) };
}

const COUNTED_SQL = `status IN (${[...rules.SHOP_COUNTED].map((s) => `'${s}'`).join(', ')})`;
const NO_CATEGORY = '00000000-0000-0000-0000-000000000000';

async function categoryNames(ids, locale) {
  const { ItemCategory } = require('../catalog').reference;
  const rows = ids.length ? await ItemCategory.findAll({ where: { id: ids }, attributes: ['id', 'nameEn', 'nameBn'] }) : [];
  return new Map(rows.map((c) => [c.id, locale === 'bn' ? c.nameBn : c.nameEn]));
}

/**
 * Shop owner (§6.3 "Shop"): Sales (items, gross of the commission, no delivery), Orders, Average order
 * (= Sales / Orders) and Repeat buyers; weekly sales against last year, orders by day, sales by
 * category (adds up to Sales) and best sellers over 30 days. Conversion and the shopper funnel need
 * product-view counts that do not exist yet: listed in comingLater (no tracking in Round B).
 */
async function shopDashboard(principal, { period = '7w', locale = 'en' }, now = new Date()) {
  requireRole(principal, 'shop_owner', 'shop owners');
  const f = frame(period, now);
  const cur = f.cur;
  const q = { me: principal.id, from: f.from, to: f.to };
  const days = num(dayStr(await select('SELECT day, SUM(orders)::int AS orders, SUM(units)::int AS units, SUM(sales_poisha)::bigint AS sales FROM kpi_mv_shop_day WHERE seller_id = :me AND day >= :from AND day < :to GROUP BY day', q)), ['sales']);
  const buyers = await select(`SELECT buyer_id, COUNT(*)::int AS n FROM kpi_fact_sub_order WHERE seller_id = :me AND ${COUNTED_SQL} AND placed_at >= :since AND placed_at < :now GROUP BY buyer_id`, {
    me: principal.id,
    since: new Date(now.getTime() - settings.get('analytics.repeat_customer_days') * DAY),
    now,
  });
  const inCur = days.filter((r) => r.day >= cur.from && r.day < cur.to);
  const cats = await select('SELECT category_id, SUM(units)::int AS units, SUM(sales_poisha)::bigint AS sales FROM kpi_mv_shop_category_day WHERE seller_id = :me AND day >= :cfrom AND day < :cto GROUP BY category_id', {
    me: principal.id,
    cfrom: cur.from,
    cto: cur.to,
  });
  const names = await categoryNames(cats.map((c) => c.category_id).filter((id) => id !== NO_CATEGORY), locale);
  const today = rules.dhakaDate(now);
  const best = await select(
    `SELECT product_id, MAX(title) AS title, SUM(qty)::int AS units, SUM(amount_poisha)::bigint AS sales FROM kpi_fact_order_line WHERE seller_id = :me AND ${COUNTED_SQL} AND placed_at >= :since AND placed_at < :until GROUP BY product_id`,
    { me: principal.id, since: dhakaTs(rules.addDays(today, 1 - settings.get('analytics.best_sellers_days'))), until: dhakaTs(rules.addDays(today, 1)) }
  );
  return {
    role: 'shop_owner',
    tiles: {
      sales: tile(days, f, 'sales', { note: { items: inCur.reduce((n, r) => n + r.units, 0) } }),
      orders: tile(days, f, 'orders', { kind: 'count' }),
      averageOrder: averageTile(days, f, 'sales', 'orders'),
      repeatBuyers: { value: rules.repeatShare(Object.fromEntries(buyers.map((b) => [b.buyer_id, b.n]))), delta: null, spark: null },
    },
    charts: {
      weeklySales: lineWithLastYear(days, f, 'sales'),
      ordersByDay: byDay(days, cur, 'orders'),
      salesByCategory: cats.map((c) => ({ categoryId: c.category_id === NO_CATEGORY ? null : c.category_id, name: names.get(c.category_id) ?? '', units: c.units, value: Number(c.sales) })).sort((a, b) => b.value - a.value),
      bestSellers: rules.top(best.map((b) => ({ productId: b.product_id, title: b.title, units: b.units, value: Number(b.sales) })), 'units', settings.get('analytics.top_list_size'), 'title'),
    },
    comingLater: ['conversion', 'shopperFunnel'],
    ...(await meta(f, ['sales', 'orders', 'average_order', 'repeat_buyers', 'conversion'], locale)),
  };
}

/**
 * Gym owner (§6.3 gym, added in Round B2): Pass sales (gross of the fee), Passes sold by kind,
 * Admissions and the Unused share of ended passes; sales against last year, admissions by day,
 * busiest hours (Dhaka, over the period) and sales by package (adds up to Pass sales).
 */
async function gymDashboard(principal, { period = '7w', locale = 'en' }, now = new Date()) {
  requireRole(principal, 'gym_owner', 'gym owners');
  const f = frame(period, now);
  const cur = f.cur;
  const days = num(
    dayStr(
      await select(
        'SELECT day, SUM(passes_sold)::int AS sold, SUM(day_passes)::int AS day_passes, SUM(month_passes)::int AS month_passes, SUM(quarter_passes)::int AS quarter_passes, SUM(sales_poisha)::bigint AS sales, SUM(admissions)::int AS admissions, SUM(ended)::int AS ended, SUM(unused)::int AS unused FROM kpi_mv_gym_day WHERE owner_id = :me AND day >= :from AND day < :to GROUP BY day',
        { me: principal.id, from: f.from, to: f.to }
      )
    ),
    ['sales']
  );
  const inCur = days.filter((r) => r.day >= cur.from && r.day < cur.to);
  const kinds = inCur.reduce((a, r) => ({ day: a.day + r.day_passes, month: a.month + r.month_passes, quarter: a.quarter + r.quarter_passes }), { day: 0, month: 0, quarter: 0 });
  const hours = await select('SELECT hour, SUM(admissions)::int AS admissions FROM kpi_mv_gym_hour_day WHERE owner_id = :me AND day >= :pfrom AND day < :to GROUP BY hour', { me: principal.id, pfrom: f.list[0].from, to: f.to });
  const packages = await select(
    "SELECT package_id, kind, MAX(title) AS title, COUNT(*)::int AS passes, SUM(price_poisha)::bigint AS sales FROM kpi_fact_gym_pass WHERE owner_id = :me AND status IN ('active', 'redeemed', 'expired') AND paid_at >= :fromTs AND paid_at < :toTs GROUP BY package_id, kind",
    { me: principal.id, fromTs: dhakaTs(cur.from), toTs: dhakaTs(cur.to) }
  );
  return {
    role: 'gym_owner',
    tiles: {
      passSales: tile(days, f, 'sales'),
      passesSold: tile(days, f, 'sold', { kind: 'count', note: kinds }),
      admissions: tile(days, f, 'admissions', { kind: 'count' }),
      unusedShare: shareTile(days, f, 'unused', 'ended'),
    },
    charts: {
      sales: lineWithLastYear(days, f, 'sales'),
      admissionsByDay: byDay(days, cur, 'admissions'),
      // Every Dhaka hour with admissions, in hour order (the chart shows all 24).
      busiestHours: hours.map((h) => ({ hour: Number(h.hour), admissions: Number(h.admissions) })).sort((a, b) => a.hour - b.hour),
      salesByPackage: packages.map((p) => ({ packageId: p.package_id, kind: p.kind, title: p.title, passes: p.passes, value: Number(p.sales) })).sort((a, b) => b.value - a.value),
    },
    ...(await meta(f, ['pass_sales', 'passes_sold', 'admissions', 'unused_share'], locale)),
  };
}

/**
 * Sports organiser (§6.3 "Organiser", M14 §4.1) for one organisation the caller is a member of
 * (M22-FR-03: anyone else gets 404). Teams approved of the places (+ waiting, unpaid, reserve),
 * entry fees collected in the period from M06 escrow (note: held, released, refunded now) and matches
 * played; registrations over time and fees by event. M14 answers through its facade: no fact table.
 */
async function organiserDashboard(principal, { period = '7w', orgId, locale = 'en' }, now = new Date()) {
  const org = await require('../organisations').organisations.getMine(principal, orgId);
  if (org.kind !== 'sports' || !['verified', 'suspended'].includes(org.status)) throw E.notFound('Organisation');
  const f = frame(period, now);
  const data = await require('../tournaments').reads.organiserFacts(org.id);
  const t = rules.organiserTotals(data.tournaments);
  const regRows = [
    ...data.registrations.map((r) => ({ day: rules.dhakaDate(r.createdAt), registered: 1, approved: 0 })),
    ...data.registrations.filter((r) => r.approvedAt).map((r) => ({ day: rules.dhakaDate(r.approvedAt), registered: 0, approved: 1 })),
  ];
  const feeRows = data.collections.map((c) => ({ day: rules.dhakaDate(c.at), collected: c.amount }));
  return {
    role: 'organiser',
    organisation: { id: org.id, name: org.name },
    tiles: {
      teams: { value: t.approved, delta: null, spark: null, note: { maxTeams: t.maxTeams, waiting: t.waiting, unpaid: t.unpaid, reserve: t.reserve } },
      entryFees: tile(feeRows, f, 'collected', { note: { held: t.held, released: t.released, refunded: t.refunded } }),
      matchesPlayed: { value: t.played, delta: null, spark: null, note: { total: t.matches } },
    },
    charts: {
      registrationsOverTime: rules.bucketize(regRows, f.list, ['registered', 'approved']).map((b) => ({ key: b.key, from: b.from, registered: b.registered, approved: b.approved })),
      feesByEvent: data.tournaments
        .map((x) => ({ tournamentId: x.id, name: x.name, status: x.status, collected: x.money.collected, held: x.money.held, released: x.money.released, refunded: x.money.refunded }))
        .sort((a, b) => b.collected - a.collected),
    },
    ...(await meta(f, ['teams', 'entry_fees', 'matches_played'], locale)),
  };
}

module.exports = { ownerDashboard, memberDashboard, platformOverview, shopDashboard, gymDashboard, organiserDashboard, frame };
