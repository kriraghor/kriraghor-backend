'use strict';

/**
 * M19 facts (FR-08 to FR-10): the read models are written here only. Each write reads the current
 * record through the owning module's read service (M06 payments and ledger, M10 bookings, M21 esports)
 * and upserts it; a booking keeps the newest version (source_version guard), so a late or replayed
 * event never moves a fact backwards. The nightly reconcile re-reads the last
 * analytics.reconcile_days through the same services (FactsExporter), repairs differences and logs
 * them in kpi_drift; materialised views refresh CONCURRENTLY under an advisory lock.
 */
const { Op } = require('sequelize');
const logger = require('../../common/logger');
const config = require('../../config');
const { getRedis } = require('../../common/redis');
const { sequelize, KpiFactBooking, KpiFactCourtDay, KpiFactPayment, KpiFactLedgerTxn, KpiFactEsportsEntry, KpiFactEsportsTournament, KpiDrift } = require('../../models');
const settings = require('../settings').settings;
const events = require('../events').events;
const rules = require('./analytics.rules');

const bookingsReads = () => require('../bookings').reads;
const payments = () => require('../payments').intents;
const ledger = () => require('../payments').ledger;
const esports = () => require('../esports').facts;

const DAY = 24 * 60 * 60 * 1000;
const VIEWS = ['kpi_mv_owner_day', 'kpi_mv_owner_occupancy_day', 'kpi_mv_owner_hour_day', 'kpi_mv_platform_day'];

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
  return { checkedSince: since.toISOString(), repaired: found.length };
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
  refreshViews: refreshViewsAndStamp,
  asOf,
  reconcile,
  rebuildRecentCourtDays,
  VIEWS,
};
