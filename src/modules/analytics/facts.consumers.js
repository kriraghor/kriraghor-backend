'use strict';

/**
 * M19 consumers (§2.2, FR-08): every source event refreshes its fact by re-reading the record through
 * the owning module's read service, inside the consumer transaction (M04 inbox: once per consumer).
 * kpi_processed_events is the second guard. Payloads carry ids only (M04 PII rule), so names and
 * amounts always come from the services.
 */
const { onEvent } = require('../events/events.consumers');
const { KpiProcessedEvent } = require('../../models');
const facts = require('./facts.service');
const rules = require('./analytics.rules');

const BOOKING = [
  'booking.held', 'booking.confirmed', 'booking.hold_expired', 'booking.check_in_recorded', 'booking.extended', 'booking.balance_collected',
  'booking.completed', 'booking.no_show_marked', 'booking.cancelled', 'booking.owner_cancelled', 'booking.platform_cancelled', 'booking.moved', 'booking.walk_in_recorded',
  'booking.no_show_settled', 'booking.dispute_settled',
];
const SERIES = ['booking_series.created', 'booking_series.week_skipped', 'booking_series.week_restored', 'booking_series.ended'];
const CLOSURE = ['closure.created', 'closure.reopened', 'closure.shortened'];
const DAY = 24 * 60 * 60 * 1000;
const MAX_CLOSURE_DAYS = 31;

/** Run once per (event, consumer), also when the M04 inbox is bypassed by a replay. */
async function once(e, consumer, transaction, fn) {
  const [, created] = await KpiProcessedEvent.findOrCreate({ where: { eventId: e.id, consumer }, defaults: { processedAt: new Date() }, transaction });
  if (!created) return 'duplicate';
  return fn();
}

function on(names, consumer, fn) {
  for (const name of names) onEvent(name, `analytics.${consumer}`, (e, { transaction }) => once(e, `analytics.${consumer}`, transaction, () => fn(e, { transaction })));
}

function registerAnalyticsConsumers() {
  on(BOOKING, 'booking', (e, { transaction }) => facts.refreshBooking(e.payload.bookingId, { transaction, alsoGroundId: e.payload.fromGroundId ?? null }));
  on(SERIES, 'series', async (e, { transaction }) => {
    for (const id of await require('../bookings/bookings.reads').seriesBookingIds(e.payload.seriesId)) await facts.refreshBooking(id, { transaction });
  });
  on(CLOSURE, 'closure', async (e, { transaction }) => {
    const g = await require('../grounds/grounds.reads').ground(e.payload.groundId);
    const courtIds = (g?.courts ?? []).map((k) => k.id);
    const start = new Date(e.payload.start).getTime();
    const end = new Date(e.payload.end).getTime();
    for (let t = start, i = 0; t < end && i < MAX_CLOSURE_DAYS; t += DAY, i += 1) await facts.rebuildCourtDays(courtIds, rules.dhakaDate(t), { transaction });
    await facts.rebuildCourtDays(courtIds, rules.dhakaDate(end - 1), { transaction });
  });
  on(['payment.succeeded', 'refund.succeeded'], 'payment', (e, { transaction }) => facts.refreshPayment(e.payload.paymentId, { transaction }));
  on(['ledger.transaction_posted'], 'ledger', (e, { transaction }) => facts.refreshLedgerTxn(e.payload.transactionId, { transaction }));
  on(['esports_registration.confirmed'], 'esports-entry', (e, { transaction }) => facts.refreshEntry(e.payload.registrationId, { transaction }));
  on(['esports_tournament.finalised'], 'esports-tournament', (e, { transaction }) => facts.refreshTournament(e.payload.tournamentId, { transaction }));
}

module.exports = { registerAnalyticsConsumers, BOOKING };
