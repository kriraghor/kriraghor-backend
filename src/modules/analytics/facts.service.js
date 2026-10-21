'use strict';

/**
 * M19 facts (FR-08 to FR-10): the read models are written here only. Each write reads the current
 * record through the owning module's read service (M06 payments and ledger, M10 bookings, M21 esports,
 * and since Round B2 M13 orders and M20 gym passes) and upserts it; a booking keeps the newest version (source_version guard), so a late or replayed
 * event never moves a fact backwards. The nightly reconcile re-reads the last
 * analytics.reconcile_days through the same services (FactsExporter), repairs differences and logs
 * them in kpi_drift; materialised views refresh CONCURRENTLY under an advisory lock.
 */
const { Op } = require('sequelize');
const logger = require('../../common/logger');
const config = require('../../config');
const { getRedis } = require('../../common/redis');
const {
  sequelize,
  KpiFactBooking,
  KpiFactCourtDay,
  KpiFactPayment,
  KpiFactLedgerTxn,
  KpiFactEsportsEntry,
  KpiFactEsportsTournament,
  KpiFactSubOrder,
  KpiFactOrderLine,
  KpiFactGymPass,
  KpiFactGymAdmission,
  KpiProcessedEvent,
  KpiDrift,
} = require('../../models');
const settings = require('../settings').settings;
const events = require('../events').events;
const rules = require('./analytics.rules');

const bookingsReads = () => require('../bookings').reads;
const payments = () => require('../payments').intents;
const ledger = () => require('../payments').ledger;
const esports = () => require('../esports').facts;
const ordersReads = () => require('../orders').reads;
const gymReads = () => require('../gym').reads;

const DAY = 24 * 60 * 60 * 1000;
const VIEWS = ['kpi_mv_owner_day', 'kpi_mv_owner_occupancy_day', 'kpi_mv_owner_hour_day', 'kpi_mv_platform_day', 'kpi_mv_shop_day', 'kpi_mv_shop_category_day', 'kpi_mv_gym_day', 'kpi_mv_gym_hour_day'];
/**
 * Round B2 backfill marker: the shop and gym facts started empty, so the first reconcile after the
 * migration re-reads every sub-order and pass once (not only the last reconcile_days) and stores this
 * row; later runs look back reconcile_days as usual. Backfilled rows are not drift.
 */
const BACKFILL = { eventId: '00000000-0000-4000-8000-0000000000b2', consumer: 'analytics.backfill.round-b2' };

// ---------------------------------------------------------------- bookings

function bookingRow(f) {
  return {
    booking_id: f.bookingId,
    source_version: f.sourceVersion,
    code: f.code,
    owner_id: f.ownerId,
    ground_id: f.groundId,
    court_ids: f.courtIds,
    area_id: f.areaId,
    source: f.source,
    status: f.status,
    booker_user_id: f.bookerUserId,
    booker_key: rules.bookerKey(f),
    start_at: f.startAt,
    end_at: f.endAt,
    half_hours: f.halfHours,
    total_poisha: f.total,
    online_poisha: f.online,
    refund_poisha: f.refund,
    retained_poisha: f.retained,
    fee_poisha: f.fee,
    earned_poisha: rules.earned(f),
    venue_collected_poisha: f.venueCollected,
    confirmed_at: f.confirmedAt,
    cancelled_at: f.cancelledAt,
  };
}

/** Upsert a booking fact unless a newer version is already stored. Returns true when written. */
async function upsertBooking(f, { transaction } = {}) {
  const row = bookingRow(f);
  const cols = Object.keys(row);
  const [, n] = await sequelize.query(
    `INSERT INTO kpi_fact_booking (${cols.join(', ')}, updated_at) VALUES (${cols.map((k) => (k === 'court_ids' ? 'CAST(:court_ids AS uuid[])' : `:${k}`)).join(', ')}, now())
     ON CONFLICT (booking_id) DO UPDATE SET ${cols.filter((k) => k !== 'booking_id').map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, updated_at = now()
     WHERE kpi_fact_booking.source_version <= EXCLUDED.source_version`,
    { replacements: { ...row, court_ids: `{${row.court_ids.join(',')}}` }, transaction }
  );
  return n > 0;
}

const groundCourts = async (groundId) => ((await require('../grounds').reads.ground(groundId))?.courts ?? []).map((k) => k.id);

/** Refresh a booking fact and the occupancy of its ground (and the ground it left, on a move) on its days. */
async function refreshBooking(bookingId, { transaction, alsoGroundId = null } = {}) {
  const f = await bookingsReads().bookingFact(bookingId);
  if (!f) return null;
  await upsertBooking(f, { transaction });
  const touched = await bookingsReads().courtsOfBooking(bookingId);
  const courtIds = [...new Set([...touched.courtIds, ...(await groundCourts(f.groundId)), ...(alsoGroundId && alsoGroundId !== f.groundId ? await groundCourts(alsoGroundId) : [])])];
  for (const day of touched.days) await rebuildCourtDays(courtIds, day, { transaction });
  return f;
}

/** Rebuild the occupancy of some courts on a Dhaka day (bookings, closures, hours, series). */
async function rebuildCourtDays(courtIds, day, { transaction } = {}) {
  const rows = await bookingsReads().courtDays(courtIds, day);
  for (const r of rows) {
    await KpiFactCourtDay.upsert({ courtId: r.courtId, day: r.day, ownerId: r.ownerId, groundId: r.groundId, openHh: r.openHh, bookedHh: r.bookedHh, updatedAt: new Date() }, { transaction });
  }
  return rows.length;
}

// ---------------------------------------------------------------- money and esports

async function refreshPayment(paymentId, { transaction } = {}) {
  const f = await payments().paymentFact(paymentId);
  if (!f || f.vertical === 'test') return null;
  await KpiFactPayment.upsert({ paymentId: f.paymentId, purpose: f.purpose, vertical: f.vertical, payerId: f.payerId, amountPoisha: f.amount, refundedPoisha: f.refunded, capturedAt: f.capturedAt, updatedAt: new Date() }, { transaction });
  return f;
}

async function refreshLedgerTxn(txnId, { transaction } = {}) {
  const f = await ledger().feeFact(txnId);
  if (!f || f.vertical === 'test') return null;
  await KpiFactLedgerTxn.upsert({ txnId: f.txnId, postedAt: f.postedAt, kind: f.kind, vertical: f.vertical, feeRevenuePoisha: f.feeRevenue, feeReversalPoisha: f.feeReversal }, { transaction });
  return f;
}

async function refreshEntry(registrationId, { transaction } = {}) {
  const f = await esports().entryFact(registrationId);
  if (!f) return null;
  await KpiFactEsportsEntry.upsert(f, { transaction });
  return f;
}

async function refreshTournament(tournamentId, { transaction } = {}) {
  const f = await esports().tournamentFact(tournamentId);
  if (!f) return null;
  await KpiFactEsportsTournament.upsert({ tournamentId: f.tournamentId, gameId: f.gameId, finalisedAt: f.finalisedAt, awards: f.awards, paidPoisha: f.paid, subsidyPoisha: f.subsidy, revenuePoisha: f.revenue }, { transaction });
  return f;
}

// ---------------------------------------------------------------- shop and gym (Round B2, §6.3)

/** INSERT … ON CONFLICT (pk) DO UPDATE, guarded by source_version when the table has one. */
async function upsertRow(table, pk, row, { transaction, versioned = false } = {}) {
  const cols = Object.keys(row);
  const [, n] = await sequelize.query(
    `INSERT INTO ${table} (${cols.join(', ')}, updated_at) VALUES (${cols.map((k) => `:${k}`).join(', ')}, now())
     ON CONFLICT (${pk}) DO UPDATE SET ${cols.filter((k) => k !== pk).map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, updated_at = now()
     ${versioned ? `WHERE ${table}.source_version <= EXCLUDED.source_version` : ''}`,
    { replacements: row, transaction }
  );
  return n > 0;
}

/** Upsert a sub-order fact and its lines unless a newer version is stored. Returns true when written. */
async function upsertSubOrder(f, { transaction } = {}) {
  const written = await upsertRow(
    'kpi_fact_sub_order',
    'sub_order_id',
    {
      sub_order_id: f.subOrderId,
      source_version: f.sourceVersion,
      code: f.code,
      order_id: f.orderId,
      shop_id: f.shopId,
      seller_id: f.sellerId,
      buyer_id: f.buyerId,
      status: f.status,
      units: f.units,
      items_poisha: f.items,
      delivery_poisha: f.delivery,
      commission_poisha: f.commission,
      refunded_poisha: f.refunded,
      placed_at: f.placedAt ?? null,
      completed_at: f.completedAt ?? null,
      cancelled_at: f.cancelledAt ?? null,
    },
    { transaction, versioned: true }
  );
  if (!written) return false;
  for (const l of f.lines) {
    await upsertRow(
      'kpi_fact_order_line',
      'order_item_id',
      { order_item_id: l.itemId, sub_order_id: f.subOrderId, shop_id: f.shopId, seller_id: f.sellerId, product_id: l.productId, category_id: l.categoryId, title: l.title, status: f.status, placed_at: f.placedAt ?? null, qty: l.qty, amount_poisha: l.amount },
      { transaction }
    );
  }
  return true;
}

/** Upsert a pass fact and its admissions unless a newer version is stored. Returns true when written. */
async function upsertGymPass(f, { transaction } = {}) {
  const written = await upsertRow(
    'kpi_fact_gym_pass',
    'pass_id',
    {
      pass_id: f.passId,
      source_version: f.sourceVersion,
      code: f.code,
      gym_id: f.gymId,
      owner_id: f.ownerId,
      package_id: f.packageId,
      kind: f.kind,
      title: f.title,
      status: f.status,
      price_poisha: f.price,
      fee_poisha: f.fee,
      refunded_poisha: f.refunded,
      released_poisha: f.released,
      paid_at: f.paidAt ?? null,
      valid_from: f.validFrom,
      valid_to: f.validTo,
      first_redeemed_at: f.firstRedeemedAt ?? null,
      admissions: f.admissions.length,
    },
    { transaction, versioned: true }
  );
  if (!written) return false;
  for (const a of f.admissions) {
    await upsertRow('kpi_fact_gym_admission', 'redemption_id', { redemption_id: a.id, pass_id: f.passId, gym_id: f.gymId, owner_id: f.ownerId, kind: f.kind, method: a.method, redeemed_at: a.redeemedAt }, { transaction });
  }
  return true;
}

/** sub_order.* (M13): re-read the sub-order and its lines through orders.reads. */
async function refreshSubOrder(subOrderId, { transaction } = {}) {
  const f = await ordersReads().subOrderKpiFact(subOrderId);
  if (!f) return null;
  await upsertSubOrder(f, { transaction });
  return f;
}

/** gym_pass.* (M20): re-read the pass and its admissions through gym.reads. */
async function refreshGymPass(passId, { transaction } = {}) {
  const f = await gymReads().passKpiFact(passId);
  if (!f) return null;
  await upsertGymPass(f, { transaction });
  return f;
}

// ---------------------------------------------------------------- materialised views

/** FR-10: refresh every view CONCURRENTLY; skipped when another refresh holds the lock. */
async function refreshViews() {
  return sequelize.transaction(async (transaction) => {
    const [[{ locked }]] = await sequelize.query("SELECT pg_try_advisory_xact_lock(hashtext('analytics.refresh-mviews')) AS locked", { transaction });
    if (!locked) return { skipped: true };
    for (const v of VIEWS) await sequelize.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${v}`, { transaction });
    return { refreshed: VIEWS.length, at: new Date().toISOString() };
  });
}

/** When the views were last refreshed (asOf on every answer), shared by every pod through Redis. */
const ASOF_KEY = `${config.redis.prefix}:analytics:asof`;
async function refreshViewsAndStamp() {
  const r = await refreshViews();
  if (!r.skipped) await getRedis().set(ASOF_KEY, r.at);
  return r;
}
async function asOf() {
  const v = await getRedis().get(ASOF_KEY);
  return v ? new Date(v) : null;
}

// ---------------------------------------------------------------- reconcile (FR-09)

async function drift(rows, { runAt, transaction }) {
  if (rows.length) await KpiDrift.bulkCreate(rows.map((r) => ({ runAt, ...r })), { transaction });
}

/**
 * Re-read the last analytics.reconcile_days through the owning services; repair and log every
 * difference. A vertical whose drift on a day is above analytics.drift_alert_pct of its online GMV
 * publishes analytics.drift_detected (engineering is alerted through M08).
 */
async function reconcile(now = new Date()) {
  const days = settings.get('analytics.reconcile_days');
  const since = new Date(now.getTime() - days * DAY);
  const runAt = new Date();
  const found = [];

  for (const f of await bookingsReads().exportFacts({ since, until: now })) {
    const have = await KpiFactBooking.findByPk(f.bookingId);
    const earned = rules.earned(f);
    if (!have || have.status !== f.status || have.earnedPoisha !== earned || have.totalPoisha !== f.total) {
      found.push({ dataset: 'booking', recordId: f.bookingId, vertical: 'grounds', expectedPoisha: earned, actualPoisha: have?.earnedPoisha ?? null, note: have ? `status ${have.status} → ${f.status}` : 'missing' });
      await upsertBooking(f);
    }
  }
  for (const f of await payments().exportPaymentFacts({ since, until: now })) {
    if (!f || f.vertical === 'test') continue;
    const have = await KpiFactPayment.findByPk(f.paymentId);
    if (!have || have.amountPoisha !== f.amount || have.refundedPoisha !== f.refunded) {
      found.push({ dataset: 'payment', recordId: f.paymentId, vertical: f.vertical, expectedPoisha: f.amount - f.refunded, actualPoisha: have ? have.amountPoisha - have.refundedPoisha : null, note: have ? 'amounts' : 'missing' });
      await refreshPayment(f.paymentId);
    }
  }
  for (const f of await ledger().exportFeeFacts({ since, until: now })) {
    if (f.vertical === 'test') continue;
    const have = await KpiFactLedgerTxn.findByPk(f.txnId);
    if (!have || have.feeRevenuePoisha !== f.feeRevenue || have.feeReversalPoisha !== f.feeReversal) {
      found.push({ dataset: 'ledger', recordId: f.txnId, vertical: f.vertical, expectedPoisha: f.feeRevenue - f.feeReversal, actualPoisha: have ? have.feeRevenuePoisha - have.feeReversalPoisha : null, note: have ? 'amounts' : 'missing' });
      await refreshLedgerTxn(f.txnId);
    }
  }
  // Round B2: shop and gym facts (the first run after the migration backfills every record once).
  const backfilled = (await isBackfilled()) ? null : await backfillBusiness(now);
  for (const f of await ordersReads().exportSubOrderKpiFacts({ since, until: now })) {
    const have = await KpiFactSubOrder.findByPk(f.subOrderId);
    const lines = await KpiFactOrderLine.count({ where: { subOrderId: f.subOrderId } });
    if (!have || have.status !== f.status || have.itemsPoisha !== f.items || have.refundedPoisha !== f.refunded || lines !== f.lines.length) {
      found.push({ dataset: 'sub_order', recordId: f.subOrderId, vertical: 'market', expectedPoisha: f.items, actualPoisha: have?.itemsPoisha ?? null, note: have ? `status ${have.status} → ${f.status}, ${lines}/${f.lines.length} lines` : 'missing' });
      await upsertSubOrder(f);
    }
  }
  for (const f of await gymReads().exportPassKpiFacts({ since, until: now })) {
    const have = await KpiFactGymPass.findByPk(f.passId);
    const admissions = await KpiFactGymAdmission.count({ where: { passId: f.passId } });
    if (!have || have.status !== f.status || have.pricePoisha !== f.price || have.refundedPoisha !== f.refunded || admissions !== f.admissions.length) {
      found.push({ dataset: 'gym_pass', recordId: f.passId, vertical: 'gym', expectedPoisha: f.price, actualPoisha: have?.pricePoisha ?? null, note: have ? `status ${have.status} → ${f.status}, ${admissions}/${f.admissions.length} admissions` : 'missing' });
      await upsertGymPass(f);
    }
  }
  await sequelize.transaction(async (transaction) => {
    await drift(found, { runAt, transaction });
    const pct = settings.get('analytics.drift_alert_pct');
    const byVertical = new Map();
    for (const d of found) byVertical.set(d.vertical, (byVertical.get(d.vertical) ?? 0) + Math.abs((d.expectedPoisha ?? 0) - (d.actualPoisha ?? 0)));
    for (const [vertical, amount] of byVertical) {
      const [[{ gmv }]] = await sequelize.query("SELECT COALESCE(SUM(amount_poisha - refunded_poisha), 0)::bigint AS gmv FROM kpi_fact_payment WHERE vertical = :vertical AND captured_at >= now() - interval '1 day'", { replacements: { vertical }, transaction });
      if (amount > 0 && amount * 100 > Number(gmv) * pct) {
        await events.publish(transaction, { name: 'analytics.drift_detected', aggregateType: 'analytics', aggregateId: vertical, payload: { vertical, records: found.filter((d) => d.vertical === vertical).length, amount, runAt: runAt.toISOString() } });
      }
    }
  });
  if (found.length) logger.warn({ drift: found.length }, 'analytics reconcile repaired facts');
  await refreshViewsAndStamp();
  return { checkedSince: since.toISOString(), repaired: found.length, ...(backfilled ? { backfilled } : {}) };
}

const isBackfilled = async () => Boolean(await KpiProcessedEvent.findOne({ where: BACKFILL }));

/**
 * Round B2 one-off backfill (run by the first reconcile after the migration, or by hand): every
 * sub-order and pass is re-read through its owner's facade and upserted (a newer stored version is
 * kept), then the marker is stored. Not drift: these facts never existed.
 */
async function backfillBusiness(now = new Date()) {
  const out = { subOrders: 0, passes: 0 };
  for (const f of await ordersReads().exportSubOrderKpiFacts({ since: null, until: now })) if (await upsertSubOrder(f)) out.subOrders += 1;
  for (const f of await gymReads().exportPassKpiFacts({ since: null, until: now })) if (await upsertGymPass(f)) out.passes += 1;
  await KpiProcessedEvent.findOrCreate({ where: BACKFILL, defaults: { processedAt: new Date() } });
  logger.info(out, 'analytics backfilled shop and gym facts');
  return out;
}

/** Nightly: rebuild court-day occupancy for the last 2 and next 14 days of every court with facts. */
async function rebuildRecentCourtDays(now = new Date()) {
  const courts = await KpiFactCourtDay.findAll({ attributes: ['courtId'], group: ['courtId'], raw: true });
  const fromBookings = await KpiFactBooking.findAll({ attributes: ['courtIds'], where: { startAt: { [Op.gte]: new Date(now.getTime() - 2 * DAY) } }, raw: true });
  const ids = [...new Set([...courts.map((c) => c.courtId), ...fromBookings.flatMap((b) => b.courtIds)])];
  if (!ids.length) return 0;
  let n = 0;
  for (let i = -2; i <= 14; i += 1) n += await rebuildCourtDays(ids, rules.dhakaDate(now.getTime() + i * DAY));
  return n;
}

module.exports = {
  upsertBooking,
  refreshBooking,
  rebuildCourtDays,
  refreshPayment,
  refreshLedgerTxn,
  refreshEntry,
  refreshTournament,
  upsertSubOrder,
  upsertGymPass,
  refreshSubOrder,
  refreshGymPass,
  backfillBusiness,
  refreshViews: refreshViewsAndStamp,
  asOf,
  reconcile,
  rebuildRecentCourtDays,
  VIEWS,
};
