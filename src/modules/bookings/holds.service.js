'use strict';

/**
 * M10 holds and payment (FR-04 to FR-08, v3).
 *
 * POST /bookings/holds (gate book_ground, Idempotency-Key): validate, price with the published
 * version (M09 pricing service), then in one transaction write the pending booking, its slots (the
 * exclusion constraint is the final guard: 409 SLOT_UNAVAILABLE) and the M06 payment intent for the
 * advance or the full price. The member pays on kriraghor.com/pay; only payment.succeeded confirms
 * (purpose hook onCaptured, instant booking, Q66). A failed or expired payment, or the hold job,
 * expires the booking and frees the court. A capture that lands after the hold lapsed takes the slot
 * again when it is still free, otherwise M06 refunds it in full (late_capture, FR-07).
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { feeOf } = require('../../common/money');
const { nextCode } = require('../../common/sequences');
const { sequelize, Booking } = require('../../models');
const settings = require('../settings/settings.service');
const audit = require('../audit/audit.service');
const payments = require('../payments/payments.service');
const purposes = require('../payments/payments.purposes');
const reads = require('../grounds/grounds.reads');
const pricing = require('../grounds/pricing.service');
const c = require('./bookings.common');
const rules = require('./bookings.rules');

const { payUrl } = require('../payments').intents;

async function response(b) {
  const g = await reads.ground(b.groundId);
  return {
    booking: c.memberView(b, { courts: (g?.courts ?? []).filter((k) => b.courtIds.includes(k.id)).map((k) => ({ id: k.id, name: k.name })) }),
    payment: b.status === 'pending_payment' && b.paymentId ? { id: b.paymentId, payUrl: payUrl(b.paymentId) } : null,
  };
}

/** POST /bookings/holds. Body { groundId, courtIds, start, minutes, payment: 'advance'|'full' }. */
async function create(principal, { groundId, courtIds, start, minutes, payment: choice }, idempotencyKey, req) {
  const userId = principal.id;
  const existing = await Booking.findOne({ where: { bookerUserId: userId, idempotencyKey } });
  if (existing) return response(existing);

  const g = await reads.ground(groundId);
  if (!g || !['live', 'paused'].includes(g.status)) throw E.notFound('Ground');
  if (!g.bookable) throw c.fail('GROUND_NOT_BOOKABLE');
  if (g.ownerId === userId) throw c.fail('OWN_GROUND');
  const ids = [...new Set(courtIds)];
  if (!ids.every((id) => g.courts.some((k) => k.id === id))) throw c.fail('COURT_UNKNOWN');

  const now = new Date();
  const startAt = new Date(start);
  const block = rules.slotBlock({ start: startAt, now, cutoffMin: g.bookingCutoffMin, windowDays: settings.get('booking.window_days') });
  if (block) throw c.fail(block);
  const [activeHolds, recentAttempts] = await Promise.all([
    Booking.count({ where: { bookerUserId: userId, status: 'pending_payment', holdExpiresAt: { [Op.gt]: now } } }),
    Booking.count({ where: { bookerUserId: userId, source: 'app', createdAt: { [Op.gt]: new Date(now.getTime() - 10 * 60000) } } }),
  ]);
  const limit = rules.holdBlock({ activeHolds, recentAttempts, maxHolds: settings.get('booking.max_active_holds'), maxAttempts: settings.get('booking.hold_attempts_per_10min') });
  if (limit) throw c.fail(limit);

  const version = await reads.publishedVersionAt(g.id, now);
  if (!version) throw c.fail('PRICING_MISSING');
  const quote = await pricing.priceSlot(g.id, { courtIds: ids, start: startAt, minutes, rules: version });
  const allowFull = settings.get('booking.allow_full_payment');
  if (choice === 'full' && !allowFull) throw c.fail('PAYMENT_CHOICE_UNAVAILABLE');
  const online = rules.onlineFor({ choice, price: quote.price, advance: quote.advance, allowFull });
  const endAt = new Date(startAt.getTime() + minutes * 60000);
  const holdExpiresAt = new Date(now.getTime() + settings.get('booking.hold_minutes') * 60000);

  try {
    const b = await sequelize.transaction(async (transaction) => {
      const row = await Booking.create(
        {
          code: await nextCode('BK', transaction),
          source: 'app',
          groundId: g.id,
          ownerId: g.ownerId,
          courtIds: ids,
          bookerUserId: userId,
          startAt,
          endAt,
          status: 'pending_payment',
          holdExpiresAt,
          pricingRuleId: version.id,
          pricePoisha: quote.price,
          totalPoisha: quote.price,
          advancePct: version.advancePct,
          advancePoisha: quote.advance,
          paymentChoice: choice,
          onlinePoisha: online,
          feeBps: 0,
          feePoisha: 0,
          graceMin: version.checkinGraceMin,
          minBookingMin: version.minBookingMin,
          idempotencyKey,
          createdBy: userId,
        },
        { transaction }
      );
      await c.reserve({ groundId: g.id, courtIds: ids, start: startAt, end: endAt, source: 'app', bookingId: row.id }, { transaction });
      const p = await payments.createIntent(
        {
          purpose: 'ground_booking',
          purposeId: row.id,
          payerId: userId,
          payeeId: g.ownerId,
          amount: online,
          title: `Booking ${row.code}`,
          expiresAt: holdExpiresAt,
          idempotencyKey: `booking:${row.id}`,
        },
        { transaction }
      );
      // The fee rate is the one M06 snapshotted on the payment, so the release at check-in matches.
      const feeBps = p.escrow.fee.feeBps;
      await row.update({ paymentId: p.id, feeBps, feePoisha: feeOf(quote.price, feeBps) }, { transaction });
      await c.publish(transaction, 'booking.held', row, { start: startAt.toISOString(), online });
      await audit.record({ action: 'booking.held', actor: principal, entityType: 'booking', entityId: row.id, entityCode: row.code, after: { status: row.status, online, choice }, req }, { transaction });
      return row;
    });
    return response(b);
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const again = await Booking.findOne({ where: { bookerUserId: userId, idempotencyKey } });
      if (again) return response(again);
    }
    throw err;
  }
}

/** GET a member's pending booking's payment link (POST /bookings/:id/pay). */
async function payLink(principal, id) {
  const b = await Booking.findOne({ where: { id, bookerUserId: principal.id } });
  if (!b) throw E.notFound('Booking');
  if (b.status !== 'pending_payment') throw c.fail('BOOKING_STATE');
  return response(b);
}

async function releaseIntent(b, transaction) {
  if (!b.paymentId) return;
  try {
    await payments.cancelIntent(b.paymentId, { transaction });
  } catch {
    // A capture that lands later is rejected by onCaptured and refunded in full by M06.
  }
}

/** Expire a pending booking and free the court (FR-08). */
async function expireInTx(b, reason, { transaction, actor = null }) {
  await c.release({ bookingId: b.id }, 'expired', { transaction, groundId: b.groundId });
  await b.update({ status: 'expired', expiredAt: new Date(), holdExpiresAt: null, cancelReason: reason, updatedBy: actor?.id ?? null }, { transaction });
  await c.publish(transaction, 'booking.hold_expired', b, { reason });
}

/** POST /bookings/:id/release: the member lets the hold go. */
async function releaseHold(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const b = await c.lock(id, transaction);
    if (!b || b.bookerUserId !== principal.id) throw E.notFound('Booking');
    if (!rules.next('expire', b.status)) throw c.fail('BOOKING_STATE');
    await releaseIntent(b, transaction);
    await expireInTx(b, 'released', { transaction, actor: principal });
    await audit.record({ action: 'booking.released', actor: principal, entityType: 'booking', entityId: b.id, entityCode: b.code, req }, { transaction });
    return { booking: c.memberView(b), payment: null };
  });
}

/** M06 purpose hook (inside the capture transaction). */
async function onCaptured({ payment, transaction }) {
  const b = await Booking.findOne({ where: { paymentId: payment.id }, transaction, lock: transaction.LOCK.UPDATE });
  if (!b) return 'reject';
  if (['confirmed', 'checked_in', 'completed'].includes(b.status)) return 'accept';
  if (b.status === 'expired') {
    // The hold lapsed before the money arrived (FR-07): take the slot again if it is still free.
    if (rules.cancelBlock({ start: b.startAt, now: new Date() })) return 'reject';
    try {
      await c.reserve({ groundId: b.groundId, courtIds: b.courtIds, start: b.startAt, end: b.endAt, source: 'app', bookingId: b.id }, { transaction });
    } catch (err) {
      if (err.code === 'SLOT_UNAVAILABLE') return 'reject';
      throw err;
    }
  } else if (b.status !== 'pending_payment') {
    return 'reject';
  }
  await b.update({ status: 'confirmed', confirmedAt: new Date(), holdExpiresAt: null, expiredAt: null, cancelReason: null }, { transaction });
  await c.publish(transaction, 'booking.confirmed', b, { start: b.startAt.toISOString(), online: b.onlinePoisha, choice: b.paymentChoice });
  return 'accept';
}

/** payment.failed / payment.expired (purpose ground_booking): the hold ends. */
async function onPaymentClosed(paymentId, { transaction }) {
  const b = await Booking.findOne({ where: { paymentId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!b || b.status !== 'pending_payment') return null;
  await expireInTx(b, 'payment_not_completed', { transaction });
  return 'expired';
}

/** Tick: holds past their time (plus the M06 grace for an unknown result). */
async function expireHolds(now = new Date()) {
  const grace = settings.get('payments.unknown_grace_minutes') * 60000;
  const due = await Booking.findAll({ where: { status: 'pending_payment', holdExpiresAt: { [Op.lt]: new Date(now.getTime() - grace) } }, attributes: ['id'] });
  let expired = 0;
  for (const { id } of due) {
    await sequelize.transaction(async (transaction) => {
      const b = await c.lock(id, transaction);
      if (b.status !== 'pending_payment') return;
      await releaseIntent(b, transaction);
      await expireInTx(b, 'hold_expired', { transaction });
      expired += 1;
    });
  }
  return expired;
}

purposes.register('ground_booking', { onCaptured });

module.exports = { create, payLink, releaseHold, onCaptured, onPaymentClosed, expireHolds, expireInTx, releaseIntent };
