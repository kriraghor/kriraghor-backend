'use strict';

/**
 * M10 bookings: the member's bookings and cancel (FR-10 to FR-12), the owner's day (timeline,
 * check-in, no-show, extend, balance, walk-ins, cancel, move: FR-13 to FR-21), platform cancels
 * (ground suspended or removed) and the minute tick (auto-complete, reminders, unrecorded balances).
 * Every state change locks the booking row and runs in one transaction with its money (settlement)
 * and its event; external effects (SMS, push, provider refunds) run after commit through M04/M06.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { nextCode } = require('../../common/sequences');
const { feeOf } = require('../../common/money');
const { sequelize, Booking, CheckIn } = require('../../models');
const settings = require('../settings/settings.service');
const audit = require('../audit/audit.service');
const fees = require('../payments/fee.service');
const reads = require('../grounds/grounds.reads');
const pricing = require('../grounds/pricing.service');
const pr = require('../grounds/pricing.rules');
const settlement = require('./settlement.service');
const holds = require('./holds.service');
const c = require('./bookings.common');
const rules = require('./bookings.rules');

const DAY = 24 * 60 * 60 * 1000;
const PENALTY_FREE = new Set(['weather', 'waterlogged', 'closure']);

async function courtNames(b) {
  const g = await reads.ground(b.groundId);
  return { ground: g ? { id: g.id } : null, courts: (g?.courts ?? []).filter((k) => b.courtIds.includes(k.id)).map((k) => ({ id: k.id, name: k.name })) };
}

const transition = (b, action) => {
  const to = rules.next(action, b.status);
  if (!to) throw c.fail('BOOKING_STATE', { status: b.status });
  return to;
};

// ---------------------------------------------------------------- member (FR-10 to FR-12)

async function listMine(principal, { scope = 'upcoming', cursor = null, limit = 20 }) {
  const now = new Date();
  const where = { bookerUserId: principal.id, status: { [Op.ne]: 'expired' } };
  if (scope === 'upcoming') where.endAt = { [Op.gt]: now };
  else where.endAt = { [Op.lte]: now };
  if (cursor) where.startAt = scope === 'upcoming' ? { [Op.gt]: new Date(cursor) } : { [Op.lt]: new Date(cursor) };
  const rows = await Booking.findAll({ where, order: [['startAt', scope === 'upcoming' ? 'ASC' : 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const items = [];
  for (const b of page) items.push(c.memberView(b, await courtNames(b)));
  return { items, nextCursor: rows.length > limit ? c.iso(page[page.length - 1].startAt) : null };
}

async function getMine(principal, id) {
  const b = await Booking.findOne({ where: { id, bookerUserId: principal.id } });
  if (!b) throw E.notFound('Booking');
  return { booking: c.memberView(b, await courtNames(b)), cancel: b.status === 'confirmed' ? cancelTerms(b) : null };
}

function cancelTerms(b) {
  const now = new Date();
  const started = rules.cancelBlock({ start: b.startAt, now });
  // A booking moved to another ground may be cancelled free until the start (M09 §6.4).
  const free = b.freeCancelUntil && now < b.freeCancelUntil;
  const plan = free ? rules.refundAllPlan({ online: b.onlinePoisha }) : rules.retainPlan({ online: b.onlinePoisha, advance: b.advancePoisha, feeBps: b.feeBps, ...c.policy() });
  return { allowed: !started, reasonCode: started, refund: plan.refund, retained: plan.release, free: Boolean(free) };
}

/** POST /me/bookings/:id/cancel-preview */
async function cancelPreview(principal, id) {
  const b = await Booking.findOne({ where: { id, bookerUserId: principal.id } });
  if (!b) throw E.notFound('Booking');
  if (b.status !== 'confirmed') throw c.fail('BOOKING_STATE', { status: b.status });
  return cancelTerms(b);
}

/** POST /me/bookings/:id/cancel { expectedRefund } (FR-10, FR-11; v3: the advance is retained). */
async function cancel(principal, id, { expectedRefund }, req) {
  return sequelize.transaction(async (transaction) => {
    const b = await c.lock(id, transaction);
    if (!b || b.bookerUserId !== principal.id) throw E.notFound('Booking');
    const to = transition(b, 'cancel');
    const terms = cancelTerms(b);
    if (!terms.allowed) throw c.fail(terms.reasonCode);
    if (terms.refund !== expectedRefund) throw c.fail('REFUND_CHANGED', { refund: terms.refund });
    const plan = terms.free ? rules.refundAllPlan({ online: b.onlinePoisha }) : rules.retainPlan({ online: b.onlinePoisha, advance: b.advancePoisha, feeBps: b.feeBps, ...c.policy() });
    const moved = await settlement.apply(b, plan, { step: 'retain', reasonCode: terms.free ? 'booking_moved_cancel' : 'booking_cancelled_by_booker', actor: principal, transaction });
    await c.release({ bookingId: b.id }, 'cancelled', { transaction, groundId: b.groundId });
    await b.update({ status: to, cancelledAt: new Date(), cancelActor: 'booker', cancelReason: 'booker', updatedBy: principal.id }, { transaction });
    await c.publish(transaction, 'booking.cancelled', b, { refund: moved.refunded, retained: moved.released }, principal);
    await audit.record({ action: 'booking.cancelled', actor: principal, entityType: 'booking', entityId: b.id, entityCode: b.code, after: { status: to, refund: moved.refunded, retained: moved.released }, req }, { transaction });
    return { booking: c.memberView(b, await courtNames(b)), refund: moved.refunded };
  });
}

// ---------------------------------------------------------------- owner (FR-13 to FR-21)

async function owned(principal, id, transaction) {
  const b = await c.lock(id, transaction);
  if (!b) throw E.notFound('Booking');
  if (b.ownerId !== principal.id) throw c.fail('NOT_OWNER');
  return b;
}

async function ownedGround(principal, groundId) {
  const g = await reads.ground(groundId);
  if (!g || g.status === 'removed') throw E.notFound('Ground');
  if (g.ownerId !== principal.id) throw c.fail('NOT_OWNER');
  return g;
}

/** GET /me/ground-bookings?groundId=&date= : the owner's day (FR-35, reads booking_slots). */
async function timeline(principal, { groundId, date }) {
  const g = await ownedGround(principal, groundId);
  const day = date ?? pr.dhakaParts(new Date()).date;
  const from = pr.dhakaInstant(day, 0);
  const to = new Date(from.getTime() + DAY);
  const rows = await Booking.findAll({ where: { groundId: g.id, startAt: { [Op.lt]: to }, endAt: { [Op.gt]: from }, status: { [Op.notIn]: ['expired'] } }, order: [['startAt', 'ASC']] });
  const slots = await c.overlapping({ courtIds: g.courts.map((k) => k.id), from, to });
  const hours = await reads.hoursFor(g.courts.map((k) => k.id));
  return {
    groundId: g.id,
    date: day,
    courts: g.courts.map((k) => ({ id: k.id, name: k.name, hours: hours.filter((h) => h.courtId === k.id) })),
    bookings: rows.map((b) => c.ownerView(b)),
    closures: slots.filter((s) => s.source === 'closure').map((s) => ({ closureId: s.closureId, courtId: s.courtId, start: c.iso(s.start), end: c.iso(s.end) })),
  };
}

/** GET /me/ground-bookings/:id */
async function ownerGet(principal, id) {
  const b = await Booking.findByPk(id);
  if (!b) throw E.notFound('Booking');
  if (b.ownerId !== principal.id) throw c.fail('NOT_OWNER');
  const { courts } = await courtNames(b);
  return { booking: c.ownerView(b, { courts }), checkIn: (await CheckIn.findOne({ where: { bookingId: b.id } }))?.toJSON() ?? null };
}

/** Check-in releases the online money to the owner, fee on the full value (FR-13, v3). */
async function checkInInTx(b, { actor, method = 'owner_desk', at = new Date(), transaction }) {
  const to = transition(b, 'check_in');
  await CheckIn.create({ bookingId: b.id, checkedInAt: at, checkedInBy: actor?.id ?? null, lateMinutes: rules.lateMinutes(b.startAt, at), method }, { transaction });
  const moved = await settlement.apply(b, rules.releasePlan({ price: b.pricePoisha, online: b.onlinePoisha, feeBps: b.feeBps }), { step: 'release', reasonCode: 'booking.check_in_recorded', actor, transaction });
  const due = rules.balanceDue({ total: b.totalPoisha, online: b.onlinePoisha });
  await b.update({ status: to, checkedInAt: at, balanceStatus: b.balanceStatus === 'collected' ? 'collected' : due > 0 ? 'due' : 'not_due', updatedBy: actor?.id ?? null }, { transaction });
  await c.publish(transaction, 'booking.check_in_recorded', b, { released: moved.released, fee: moved.fee, lateMinutes: rules.lateMinutes(b.startAt, at) }, actor);
  return moved;
}

async function checkIn(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const b = await owned(principal, id, transaction);
    transition(b, 'check_in');
    const block = rules.checkInBlock({ start: b.startAt, end: b.endAt, now: new Date(), openBeforeMin: settings.get('booking.checkin_open_before_min') });
    if (block) throw c.fail(block);
    const moved = await checkInInTx(b, { actor: principal, transaction });
    await audit.record({ action: 'booking.check_in_recorded', actor: principal, entityType: 'booking', entityId: b.id, entityCode: b.code, after: { status: b.status, released: moved.released, fee: moved.fee }, req }, { transaction });
    return { booking: c.ownerView(b), released: moved };
  });
}

/**
 * FR-15 (v3): owner only, once late, until auto-complete. The advance is retained; the tail is freed.
 * M17 (17 Oct 2026): anything above the advance is refunded now (Q120), but the retained advance
 * stays in escrow for disputes.window_booking_hours so the member can contest the no-show; the tick
 * releases it (owner ৳475, fee ৳25) unless a dispute froze it (settleNoShowInTx).
 */
async function noShow(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const b = await owned(principal, id, transaction);
    const to = transition(b, 'no_show');
    const now = new Date();
    const block = rules.noShowBlock({ start: b.startAt, end: b.endAt, graceMin: b.graceMin, now, autoCompleteHours: settings.get('booking.auto_complete_after_hours') });
    if (block) throw c.fail(block);
    const plan = rules.retainPlan({ online: b.onlinePoisha, advance: b.advancePoisha, feeBps: b.feeBps, ...c.policy() });
    const moved = await settlement.apply(b, { ...plan, release: 0 }, { step: 'no_show', reasonCode: 'booking.no_show_marked', actor: principal, transaction });
    const tail = rules.noShowTailEnd({ start: b.startAt, end: b.endAt, now });
    if (tail) await c.setPeriod(b.id, b.groundId, b.startAt, tail, { transaction });
    else if (now < b.endAt) c.touch(b.groundId, transaction);
    const settleDueAt = plan.release > 0 ? new Date(now.getTime() + settings.get('disputes.window_booking_hours') * 3600000) : null;
    await b.update({ status: to, noShowAt: now, retainedPoisha: plan.release, settleDueAt, updatedBy: principal.id }, { transaction });
    await c.publish(transaction, 'booking.no_show_marked', b, { refund: moved.refunded, retained: plan.release }, principal);
    await audit.record({ action: 'booking.no_show_marked', actor: principal, entityType: 'booking', entityId: b.id, entityCode: b.code, after: { status: to, retained: plan.release, refund: moved.refunded, settleDueAt }, req }, { transaction });
    return { booking: c.ownerView(b), settled: { refunded: moved.refunded, retained: plan.release, settleDueAt: c.iso(settleDueAt) } };
  });
}

/** FR-16: +30 minutes while checked in, priced on the booking's snapshot version, paid at the venue. */
async function extend(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const b = await owned(principal, id, transaction);
    if (b.status !== 'checked_in') throw c.fail('BOOKING_STATE', { status: b.status });
    const block = rules.extendBlock({ end: b.endAt, now: new Date() });
    if (block) throw c.fail(block);
    if (!(await reads.isOpen(b.courtIds, b.endAt, 30, { transaction }))) throw c.fail('OUTSIDE_HOURS');
    const version = await reads.versionById(b.pricingRuleId, { transaction });
    const amount = pr.price(version, b.courtIds, b.endAt, 30);
    const newEnd = new Date(b.endAt.getTime() + rules.HALF_HOUR);
    await c.setPeriod(b.id, b.groundId, b.startAt, newEnd, { transaction, code: 'NEXT_SLOT_TAKEN' });
    const n = Math.round((newEnd.getTime() - b.startAt.getTime()) / rules.HALF_HOUR);
    await settlement.accrueVenueFee(b, rules.venueFee(amount, b.feeBps), `extension:${n}`, { actor: principal, transaction });
    await b.update({ endAt: newEnd, extensionsPoisha: b.extensionsPoisha + amount, totalPoisha: b.totalPoisha + amount, balanceStatus: 'due', updatedBy: principal.id }, { transaction });
    await c.publish(transaction, 'booking.extended', b, { amount, end: newEnd.toISOString() }, principal);
    await audit.record({ action: 'booking.extended', actor: principal, entityType: 'booking', entityId: b.id, entityCode: b.code, after: { end: newEnd.toISOString(), amount }, req }, { transaction });
    return { booking: c.ownerView(b), amount };
  });
}

/** FR-17: the owner records the venue balance (cash or bKash at the venue), the full amount due. */
async function collectBalance(principal, id, { method, amount }, req) {
  return sequelize.transaction(async (transaction) => {
    const b = await owned(principal, id, transaction);
    if (!['checked_in', 'completed'].includes(b.status)) throw c.fail('BOOKING_STATE', { status: b.status });
    const due = rules.balanceDue({ total: b.totalPoisha, online: b.onlinePoisha }) - (b.balanceCollectedPoisha ?? 0);
    if (due <= 0 || b.balanceStatus === 'collected') throw c.fail('NO_BALANCE_DUE');
    if (amount !== due) throw c.fail('BALANCE_MISMATCH', { due });
    await b.update({ balanceStatus: 'collected', balanceMethod: method, balanceCollectedPoisha: (b.balanceCollectedPoisha ?? 0) + amount, balanceCollectedAt: new Date(), balanceCollectedBy: principal.id, updatedBy: principal.id }, { transaction });
    await c.publish(transaction, 'booking.balance_collected', b, { amount, method }, principal);
    await audit.record({ action: 'booking.balance_collected', actor: principal, entityType: 'booking', entityId: b.id, entityCode: b.code, after: { amount, method }, req }, { transaction });
    return { booking: c.ownerView(b) };
  });
}

/**
 * POST /me/grounds/:id/walk-ins (FR-18, Idempotency-Key): paid in full at the counter, no booker.
 * The fee is owed as a receivable (M06 §6.4). Starting within booking.walkin_auto_checkin_min →
 * checked in at once.
 */
async function walkIn(principal, groundId, { courtIds, start, minutes, name, phone = null }, idempotencyKey, req) {
  const existing = await Booking.findOne({ where: { createdBy: principal.id, idempotencyKey, source: 'walk_in' } });
  if (existing) return { booking: c.ownerView(existing) };
  const g = await ownedGround(principal, groundId);
  if (!['live', 'paused'].includes(g.status)) throw c.fail('GROUND_NOT_BOOKABLE');
  const ids = [...new Set(courtIds)];
  const startAt = new Date(start);
  const now = new Date();
  if (!rules.isHalfHour(startAt)) throw c.fail('NOT_HALF_HOUR');
  // The current half-hour still counts (a team walking in at 18:10 plays 18:00–19:00).
  if (startAt.getTime() < rules.ceilHalfHour(now) - rules.HALF_HOUR) throw c.fail('TOO_LATE');
  if (startAt.getTime() > now.getTime() + settings.get('booking.window_days') * DAY) throw c.fail('OUT_OF_RANGE');
  const version = await reads.publishedVersionAt(g.id, now);
  if (!version) throw c.fail('PRICING_MISSING');
  const quote = await pricing.priceSlot(g.id, { courtIds: ids, start: startAt, minutes, rules: version, ownerTool: true });
  const endAt = new Date(startAt.getTime() + minutes * 60000);
  const fee = fees.snapshot('grounds');
  const checkInNow = startAt.getTime() - now.getTime() <= settings.get('booking.walkin_auto_checkin_min') * 60000;
  try {
    const b = await sequelize.transaction(async (transaction) => {
      const row = await Booking.create(
        {
          code: await nextCode('BK', transaction),
          source: 'walk_in',
          groundId: g.id,
          ownerId: g.ownerId,
          courtIds: ids,
          contactName: name,
          ...c.phoneFields(phone),
          startAt,
          endAt,
          status: 'confirmed',
          pricingRuleId: version.id,
          pricePoisha: quote.price,
          totalPoisha: quote.price,
          advancePct: 100,
          advancePoisha: quote.price,
          paymentChoice: 'venue',
          onlinePoisha: 0,
          feeBps: fee.feeBps,
          feePoisha: feeOf(quote.price, fee.feeBps),
          balanceStatus: 'collected',
          balanceMethod: 'cash',
          balanceCollectedPoisha: quote.price,
          balanceCollectedAt: now,
          balanceCollectedBy: principal.id,
          graceMin: version.checkinGraceMin,
          minBookingMin: version.minBookingMin,
          idempotencyKey,
          confirmedAt: now,
          createdBy: principal.id,
        },
        { transaction }
      );
      await c.reserve({ groundId: g.id, courtIds: ids, start: startAt, end: endAt, source: 'walk_in', bookingId: row.id }, { transaction });
      await settlement.accrueVenueFee(row, row.feePoisha, 'walk_in', { actor: principal, transaction });
      await c.publish(transaction, 'booking.walk_in_recorded', row, { start: startAt.toISOString(), price: quote.price }, principal);
      if (checkInNow) await checkInInTx(row, { actor: principal, method: 'walk_in', at: now, transaction });
      await audit.record({ action: 'booking.walk_in_recorded', actor: principal, entityType: 'booking', entityId: row.id, entityCode: row.code, after: { status: row.status, price: quote.price }, req }, { transaction });
      return row;
    });
    return { booking: c.ownerView(b) };
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const again = await Booking.findOne({ where: { createdBy: principal.id, idempotencyKey, source: 'walk_in' } });
      if (again) return { booking: c.ownerView(again) };
    }
    throw err;
  }
}

/** Refund everything paid online and free the court (owner cancel, platform cancel). */
async function refundAllInTx(b, { to, actor, cancelActor, reason, note = null, transaction }) {
  const moved = await settlement.apply(b, rules.refundAllPlan({ online: b.onlinePoisha }), { step: 'refund_all', reasonCode: `booking_${to}`, actor, transaction });
  if (b.status === 'pending_payment') await holds.releaseIntent(b, transaction);
  if (b.source === 'walk_in') await settlement.reverseVenueFee(b, 'walk_in', { actor, transaction });
  await c.release({ bookingId: b.id }, 'cancelled', { transaction, groundId: b.groundId });
  await b.update({ status: to, cancelledAt: new Date(), cancelActor, cancelReason: reason, cancelNote: note, holdExpiresAt: null, updatedBy: actor?.id ?? null }, { transaction });
  return moved;
}

/** FR-19 (v3): before the start, with a reason; 100% back to the member. Weather is not penalised (Q22). */
async function ownerCancel(principal, id, { reason, note = null }, req) {
  return sequelize.transaction(async (transaction) => {
    const b = await owned(principal, id, transaction);
    const to = transition(b, 'owner_cancel');
    const block = rules.cancelBlock({ start: b.startAt, now: new Date() });
    if (block) throw c.fail(block);
    const moved = await refundAllInTx(b, { to, actor: principal, cancelActor: 'owner', reason, note, transaction });
    await c.publish(transaction, 'booking.owner_cancelled', b, { refund: moved.refunded, reason, penalised: !PENALTY_FREE.has(reason) }, principal);
    await audit.record({ action: 'booking.owner_cancelled', actor: principal, entityType: 'booking', entityId: b.id, entityCode: b.code, after: { status: to, refund: moved.refunded }, reason, req }, { transaction });
    return { booking: c.ownerView(b), refund: moved.refunded };
  });
}

/**
 * Move targets (M09 §6.4): a free court of the same length at one of the owner's live grounds,
 * open for the whole period and sharing a sport. Same ground first, then the same area, then others.
 */
async function moveTargets(principal, id) {
  const b = await Booking.findByPk(id);
  if (!b) throw E.notFound('Booking');
  if (b.ownerId !== principal.id) throw c.fail('NOT_OWNER');
  const current = await reads.courts(b.courtIds);
  const sports = new Set(current.flatMap((k) => k.sportIds));
  const home = await reads.ground(b.groundId);
  const out = [];
  for (const g of await reads.liveGroundsOf(principal.id)) {
    for (const k of g.courts) {
      if (b.courtIds.includes(k.id) || !k.sportIds.some((s) => sports.has(s))) continue;
      if (!(await reads.isOpen([k.id], b.startAt, (b.endAt - b.startAt) / 60000))) continue;
      if ((await c.overlapping({ courtIds: [k.id], from: b.startAt, to: b.endAt })).length) continue;
      out.push({ groundId: g.id, groundName: g.name, courtId: k.id, courtName: k.name, sameGround: g.id === b.groundId, sameArea: g.areaId === home?.areaId });
    }
  }
  return { items: out.sort((x, y) => Number(y.sameGround) - Number(x.sameGround) || Number(y.sameArea) - Number(x.sameArea)) };
}

/** POST /me/ground-bookings/:id/move { courtId } (FR-20): price unchanged; a new address lets the member cancel free. */
async function move(principal, id, { courtId }, req) {
  return sequelize.transaction(async (transaction) => {
    const b = await owned(principal, id, transaction);
    if (b.status !== 'confirmed' || b.courtIds.length !== 1) throw c.fail('BOOKING_STATE', { status: b.status });
    if (rules.cancelBlock({ start: b.startAt, now: new Date() })) throw c.fail('ALREADY_STARTED');
    const [target] = await reads.courts([courtId], { transaction });
    const g = target ? await reads.ground(target.groundId, { transaction }) : null;
    const [from] = await reads.courts(b.courtIds, { transaction });
    if (!target || !g || g.ownerId !== principal.id || !g.bookable || target.status !== 'active' || courtId === b.courtIds[0] || !target.sportIds.some((s) => from.sportIds.includes(s))) {
      throw c.fail('MOVE_TARGET_INVALID');
    }
    if (!(await reads.isOpen([courtId], b.startAt, (b.endAt - b.startAt) / 60000, { transaction }))) throw c.fail('OUTSIDE_HOURS');
    const before = { groundId: b.groundId, courtIds: b.courtIds };
    await c.release({ bookingId: b.id }, 'moved', { transaction, groundId: b.groundId });
    await c.reserve({ groundId: g.id, courtIds: [courtId], start: b.startAt, end: b.endAt, source: b.source, bookingId: b.id }, { transaction });
    const newGround = g.id !== b.groundId;
    await b.update({ groundId: g.id, courtIds: [courtId], moveCount: b.moveCount + 1, freeCancelUntil: newGround ? b.startAt : b.freeCancelUntil, updatedBy: principal.id }, { transaction });
    await c.publish(transaction, 'booking.moved', b, { fromGroundId: before.groundId, newGround }, principal);
    await audit.record({ action: 'booking.moved', actor: principal, entityType: 'booking', entityId: b.id, entityCode: b.code, before, after: { groundId: g.id, courtIds: [courtId] }, req }, { transaction });
    return { booking: c.ownerView(b) };
  });
}

// ---------------------------------------------------------------- platform (ground suspended or removed; staff)

/** Every upcoming booking of a ground is cancelled by the platform with a full refund. */
async function cancelAllForGround(groundId, reason, { transaction }) {
  const rows = await Booking.findAll({ where: { groundId, status: ['pending_payment', 'confirmed'], startAt: { [Op.gt]: new Date() } }, transaction, lock: transaction.LOCK.UPDATE });
  for (const b of rows) {
    const to = transition(b, 'platform_cancel');
    const moved = await refundAllInTx(b, { to, actor: null, cancelActor: 'platform', reason, transaction });
    await c.publish(transaction, 'booking.platform_cancelled', b, { refund: moved.refunded, reason });
  }
  return rows.length;
}

/** POST /admin/bookings/:id/cancel (master + step-up). */
async function staffCancel(actor, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const b = await c.lock(id, transaction);
    if (!b) throw E.notFound('Booking');
    const to = transition(b, 'platform_cancel');
    const moved = await refundAllInTx(b, { to, actor, cancelActor: 'platform', reason: 'platform', note: reason, transaction });
    await c.publish(transaction, 'booking.platform_cancelled', b, { refund: moved.refunded, reason: 'platform' }, actor);
    await audit.record({ action: 'booking.platform_cancelled', actor, entityType: 'booking', entityId: b.id, entityCode: b.code, after: { status: to, refund: moved.refunded }, reason, stepUp: true, req }, { transaction });
    return { booking: c.ownerView(b), refund: moved.refunded };
  });
}

async function staffList({ status, groundId, code, cursor, limit = 50 }) {
  const where = {};
  if (status) where.status = status;
  if (groundId) where.groundId = groundId;
  if (code) where.code = code;
  if (cursor) where.createdAt = { [Op.lt]: new Date(cursor) };
  const rows = await Booking.findAll({ where, order: [['createdAt', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  return { items: page.map((b) => c.ownerView(b)), nextCursor: rows.length > limit ? c.iso(page[page.length - 1].createdAt) : null };
}

async function staffGet(id) {
  const b = await Booking.findByPk(id);
  if (!b) throw E.notFound('Booking');
  const ledger = require('../payments/ledger.service');
  const holdId = b.paymentId ? await require('../payments/escrow.service').holdIdForPayment(b.paymentId) : null;
  const trail = await ledger.transactionsFor([['booking', b.id], ...(holdId ? [['escrow_hold', holdId]] : [])]);
  return { booking: c.ownerView(b, await courtNames(b)), checkIn: (await CheckIn.findOne({ where: { bookingId: b.id } }))?.toJSON() ?? null, ledger: trail };
}

// ---------------------------------------------------------------- no-show settlement (M17)

/** A frozen hold (an open M17 dispute) waits for the decision. */
async function frozen(b, transaction) {
  if (!b.paymentId) return false;
  const hold = await require('../payments/escrow.service').lockHoldForPayment(b.paymentId, transaction);
  return hold?.status === 'frozen';
}

/** The dispute window closed with no dispute: release the retained advance (fee on what is retained). */
async function settleNoShowInTx(b, { transaction }) {
  const moved = await settlement.apply(b, { refund: 0, release: b.retainedPoisha, feeBase: b.retainedPoisha }, { step: 'no_show_release', reasonCode: 'booking.no_show_settled', transaction });
  await b.update({ settleDueAt: null }, { transaction });
  await c.publish(transaction, 'booking.no_show_settled', b, { released: moved.released, fee: moved.fee });
  return moved;
}

// ---------------------------------------------------------------- tick (§10)

/** Complete a booking: a checked-in one at its end; a confirmed one 24 h after (auto, full release). */
async function completeInTx(b, { transaction, auto }) {
  const to = transition(b, 'complete');
  let moved = { released: 0, fee: 0 };
  if (auto) moved = await settlement.apply(b, rules.releasePlan({ price: b.pricePoisha, online: b.onlinePoisha, feeBps: b.feeBps }), { step: 'release', reasonCode: 'booking_auto_completed', transaction });
  // Series sessions are paid at the venue: the fee is owed once the session is done (M06 §6.4).
  if (b.source === 'series') await settlement.accrueVenueFee(b, b.feePoisha, 'series', { transaction });
  const due = rules.balanceDue({ total: b.totalPoisha, online: b.onlinePoisha }) - (b.balanceCollectedPoisha ?? 0);
  await b.update({ status: to, completedAt: new Date(), balanceStatus: b.balanceStatus === 'collected' ? 'collected' : due > 0 ? 'due' : 'not_due' }, { transaction });
  await c.publish(transaction, 'booking.completed', b, { auto, released: moved.released, fee: moved.fee });
}

async function tick(now = new Date()) {
  const out = { expired: await holds.expireHolds(now), completed: 0, autoCompleted: 0, noShowsSettled: 0, reminded: 0, unrecorded: 0 };
  const autoHours = settings.get('booking.auto_complete_after_hours');
  const ended = await Booking.findAll({ where: { status: 'checked_in', endAt: { [Op.lte]: now } }, attributes: ['id'], limit: 500 });
  const stale = await Booking.findAll({ where: { status: 'confirmed', endAt: { [Op.lte]: new Date(now.getTime() - autoHours * 3600000) } }, attributes: ['id'], limit: 500 });
  for (const [list, auto] of [
    [ended, false],
    [stale, true],
  ]) {
    for (const { id } of list) {
      await sequelize.transaction(async (transaction) => {
        const b = await c.lock(id, transaction);
        if (auto ? b.status !== 'confirmed' || !rules.autoCompleteDue({ end: b.endAt, now, hours: autoHours }) : b.status !== 'checked_in') return;
        if (auto && (await frozen(b, transaction))) return; // a venue-problem dispute decides the money (M17)
        await completeInTx(b, { transaction, auto });
        out[auto ? 'autoCompleted' : 'completed'] += 1;
      });
    }
  }
  const settle = await Booking.findAll({ where: { status: 'no_show', settleDueAt: { [Op.lte]: now } }, attributes: ['id'], limit: 500 });
  for (const { id } of settle) {
    await sequelize.transaction(async (transaction) => {
      const b = await c.lock(id, transaction);
      if (b.status !== 'no_show' || !b.settleDueAt || b.settleDueAt > now || (await frozen(b, transaction))) return;
      await settleNoShowInTx(b, { transaction });
      out.noShowsSettled += 1;
    });
  }
  const remindAt = new Date(now.getTime() + settings.get('booking.start_reminder_hours') * 3600000);
  const soon = await Booking.findAll({ where: { status: 'confirmed', source: 'app', remindedAt: null, startAt: { [Op.gt]: now, [Op.lte]: remindAt } }, attributes: ['id'], limit: 500 });
  for (const { id } of soon) {
    await sequelize.transaction(async (transaction) => {
      const b = await c.lock(id, transaction);
      if (b.remindedAt || b.status !== 'confirmed') return;
      await b.update({ remindedAt: now }, { transaction });
      await c.publish(transaction, 'booking.reminded', b, { start: b.startAt.toISOString() });
      out.reminded += 1;
    });
  }
  const days = settings.get('booking.balance_unrecorded_days');
  const [n] = await Booking.update(
    { balanceStatus: 'unrecorded', unrecordedAt: now },
    { where: { status: 'completed', balanceStatus: 'due', completedAt: { [Op.lte]: new Date(now.getTime() - days * DAY) } } }
  );
  out.unrecorded = n;
  return out;
}

module.exports = {
  listMine,
  getMine,
  cancelPreview,
  cancel,
  timeline,
  ownerGet,
  checkIn,
  noShow,
  extend,
  collectBalance,
  walkIn,
  ownerCancel,
  moveTargets,
  move,
  cancelAllForGround,
  staffCancel,
  staffList,
  staffGet,
  tick,
  checkInInTx,
  completeInTx,
  settleNoShowInTx,
  transition,
};
