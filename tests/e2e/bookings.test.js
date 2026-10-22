'use strict';

// M10 Bookings step 1 end to end (v3 money): availability (FR-01 to FR-03), holds and payment through
// the SSLCommerz simulator (FR-04 to FR-08), check-in releases the escrow with the fee on the full
// value (FR-13), member cancel (FR-10 to FR-12, Q120), owner cancel and platform cancel (FR-19),
// no-show (FR-15), auto-complete (Q68), extend and the venue balance (FR-16, FR-17), walk-ins (FR-18),
// moves (FR-20), the exclusion constraint under a race, and M09 step 2 closures and series
// (M09 FR-15 to FR-24) through the occupancy port.
//
// Grounds are built as fixtures (tests/fixtures/bookings.js: ৳2,000/h flat, open around the clock), so
// the CLAUDE.md worked example holds at any hour the suite runs. The M09 suite covers the real listing flow.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const ledger = require('../../src/modules/payments/ledger.service');
const invariants = require('../../src/modules/payments/invariants.service');
const bookings = require('../../src/modules/bookings/bookings.service');
const pr = require('../../src/modules/grounds/pricing.rules');
const { owner, liveGround, moveTo } = require('../fixtures/bookings');

const { api, P, models } = h;
const HALF = 30 * 60 * 1000;
let seq = 0;
const key = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

let master;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

/** A half-hour start `days` from now (tomorrow by default), well inside the 7-day window. */
const slot = (days = 1, plusHalfHours = 0) => new Date(Math.ceil((Date.now() + days * 86400000) / HALF) * HALF + plusHalfHours * HALF).toISOString();

async function hold(m, g, { court = g.courts[0], start = slot(), minutes = 60, payment = 'advance', status = 201 } = {}) {
  return api().post(`${P}/bookings/holds`).set(h.bearer(m)).set('Idempotency-Key', key('hold')).send({ groundId: g.id, courtIds: [court], start, minutes, payment }).expect(status);
}

/** Hold and pay; returns the confirmed booking. */
async function book(m, g, opts = {}) {
  const r = await hold(m, g, opts);
  await h.payWithSimulator(m, r.body.payment.id);
  await h.drainEvents();
  return models.Booking.findByPk(r.body.booking.id);
}

const balance = (code) => ledger.balance(code);

describe('M10 availability and holds', () => {
  it('shows the grid, holds a slot, takes the advance, and confirms on payment (FR-01 to FR-06)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser({ name: 'Rafi Ahmed' });
    const start = slot();
    const day = new Date(new Date(start).getTime() + 6 * 3600000).toISOString().slice(0, 10);

    const before = await api().get(`${P}/grounds/${g.id}/availability?date=${day}`).expect(200);
    const cell = before.body.courts[0].cells.find((c) => c.start === start);
    if (cell) expect(cell).toMatchObject({ state: 'open', rate: 200000 });
    expect(before.body.lengths).toEqual([60, 90, 120, 180]);

    const r = await hold(m, g, { start });
    expect(r.body.booking).toMatchObject({ status: 'pending_payment', money: { price: 200000, advance: 50000, paidOnline: 50000, dueAtVenue: 150000, fee: 10000 } });
    expect(r.body.payment.payUrl).toMatch(/\/pay\//);
    expect((await models.Payment.findByPk(r.body.payment.id)).amountPoisha).toBe(50000);

    // Another member cannot take the same court and time (exclusion constraint).
    const other = await h.signupUser({ name: 'Nadia Islam' });
    expect((await hold(other, g, { start, status: 409 })).body.code).toBe('SLOT_UNAVAILABLE');
    // A touching slot is fine ([) ranges).
    await hold(other, g, { start: new Date(new Date(start).getTime() + 3600000).toISOString() });

    await h.payWithSimulator(m, r.body.payment.id);
    await h.drainEvents();
    const b = await models.Booking.findByPk(r.body.booking.id);
    expect(b.status).toBe('confirmed');
    expect(await balance('escrow:ground_booking')).toBe(50000); // the other member's hold is not paid
    const mine = await api().get(`${P}/grounds/${g.id}/availability?date=${day}`).set(h.bearer(m)).expect(200);
    if (cell) expect(mine.body.courts[0].cells.find((c) => c.start === start).state).toBe('yours');
    const note = await models.Notification.findOne({ where: { userId: m.user.id, code: 'BOOKING_CONFIRMED' } });
    expect(note.body).toContain(b.code);
    expect(await models.NotificationDelivery.count({ where: { notificationId: note.id, channel: 'sms' } })).toBe(1);
    expect(await models.Notification.count({ where: { userId: o.user.id, code: 'BOOKING_NEW_FOR_OWNER' } })).toBe(1);
    expect((await api().get(`${P}/me/bookings`).set(h.bearer(m)).expect(200)).body.items.map((x) => x.code)).toEqual([b.code]);
  });

  it('refuses bad holds: own ground, grid, window, choice, limits (§6.1, FR-05)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    expect((await hold(o, g, { status: 422 })).body.code).toBe('OWN_GROUND');
    const m = await h.signupUser();
    expect((await hold(m, g, { start: new Date(new Date(slot()).getTime() + 10 * 60000).toISOString(), status: 422 })).body.code).toBe('NOT_HALF_HOUR');
    expect((await hold(m, g, { start: slot(9), status: 422 })).body.code).toBe('OUT_OF_RANGE');
    expect((await hold(m, g, { minutes: 30, status: 422 })).body.code).toBe('LENGTH_INVALID');
    await h.setSettingForTest('booking.allow_full_payment', false);
    expect((await hold(m, g, { payment: 'full', status: 422 })).body.code).toBe('PAYMENT_CHOICE_UNAVAILABLE');
    await h.setSettingForTest('booking.allow_full_payment', true);
    await hold(m, g, { start: slot(1, 0) });
    await hold(m, g, { start: slot(1, 4) });
    expect((await hold(m, g, { start: slot(1, 8), status: 429 })).body.code).toBe('HOLD_LIMIT');
  });

  it('20 members racing for one slot: exactly one hold wins (§12 #1)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const members = [];
    for (let i = 0; i < 20; i += 1) members.push(await h.signupUser({ name: `Player ${i}` }));
    const start = slot(2);
    const results = await Promise.all(members.map((m) => api().post(`${P}/bookings/holds`).set(h.bearer(m)).set('Idempotency-Key', key('race')).send({ groundId: g.id, courtIds: [g.courts[0]], start, minutes: 60, payment: 'advance' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'SLOT_UNAVAILABLE')).toBe(true);
    expect(await models.BookingSlot.count({ where: { status: 'active' } })).toBe(1);
  });

  it('combinable courts need every court free; overlapping groups conflict (FR-03)', async () => {
    const o = await owner();
    const g = await liveGround(o, { courts: 2, combinable: true });
    const a = await h.signupUser();
    const b = await h.signupUser();
    const start = slot();
    await hold(a, g, { court: g.courts[1], start });
    const r = await api().post(`${P}/bookings/holds`).set(h.bearer(b)).set('Idempotency-Key', key('combo')).send({ groundId: g.id, courtIds: g.courts, start, minutes: 60, payment: 'advance' }).expect(409);
    expect(r.body.code).toBe('SLOT_UNAVAILABLE');
    const ok = await api().post(`${P}/bookings/holds`).set(h.bearer(b)).set('Idempotency-Key', key('combo')).send({ groundId: g.id, courtIds: g.courts, start: slot(1, 4), minutes: 60, payment: 'advance' }).expect(201);
    expect(ok.body.booking.money.price).toBe(400000); // the sum of the courts (Q62)
  });

  it('a hold expires and frees the court; a late capture takes it again, or is refunded (FR-07, FR-08)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    const start = slot();
    const r = await hold(m, g, { start });
    const id = r.body.booking.id;
    const attempt = await api().post(`${P}/payments/${r.body.payment.id}/attempts`).set(h.bearer(m)).set('Idempotency-Key', key('att')).send({ method: 'bkash' }).expect(201);
    await models.Booking.update({ holdExpiresAt: new Date(Date.now() - 60 * 60000) }, { where: { id } });
    await bookings.tick();
    expect((await models.Booking.findByPk(id)).status).toBe('expired');
    expect(await models.BookingSlot.count({ where: { bookingId: id, status: 'active' } })).toBe(0);

    // The money arrives late and the slot is still free: the booking comes back.
    await h.simulator.pay(attempt.body.redirectUrl.split('/').pop(), 'success');
    await h.drainEvents();
    expect((await models.Booking.findByPk(id)).status).toBe('confirmed');

    // A second hold lapses, someone else takes the slot, then the money arrives: a full refund.
    const late = await hold(m, g, { start: slot(1, 4) });
    const a2 = await api().post(`${P}/payments/${late.body.payment.id}/attempts`).set(h.bearer(m)).set('Idempotency-Key', key('att')).send({ method: 'bkash' }).expect(201);
    await models.Booking.update({ holdExpiresAt: new Date(Date.now() - 60 * 60000) }, { where: { id: late.body.booking.id } });
    await bookings.tick();
    const other = await h.signupUser();
    await hold(other, g, { start: slot(1, 4) });
    await h.simulator.pay(a2.body.redirectUrl.split('/').pop(), 'success');
    await h.drainEvents();
    expect((await models.Booking.findByPk(late.body.booking.id)).status).toBe('expired');
    expect(await models.Refund.count({ where: { paymentId: late.body.payment.id, kind: 'late_capture' } })).toBe(1);
  });
});

describe('M10 v3 money', () => {
  it('check-in releases the advance: owner ৳400, Kriraghor ৳100; ৳1,500 due at the venue (FR-13)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    let b = await book(m, g);
    await api().post(`${P}/me/ground-bookings/${b.id}/check-in`).set(h.bearer(o)).expect(409); // tomorrow: not the window
    b = await moveTo(b, new Date());
    const r = await api().post(`${P}/me/ground-bookings/${b.id}/check-in`).set(h.bearer(o)).expect(200);
    expect(r.body.booking).toMatchObject({ status: 'checked_in', money: { released: 50000, dueAtVenue: 150000, balanceStatus: 'due' } });
    expect(await balance(`payable:user:${o.user.id}`)).toBe(40000);
    expect(await balance('fee_revenue:grounds')).toBe(10000);
    expect(await balance('escrow:ground_booking')).toBe(0);

    // Balance at the venue: the full amount, once.
    expect((await api().post(`${P}/me/ground-bookings/${b.id}/collect-balance`).set(h.bearer(o)).send({ method: 'cash', amount: 100000 }).expect(422)).body.code).toBe('BALANCE_MISMATCH');
    await api().post(`${P}/me/ground-bookings/${b.id}/collect-balance`).set(h.bearer(o)).send({ method: 'cash', amount: 150000 }).expect(200);
    expect((await api().post(`${P}/me/ground-bookings/${b.id}/collect-balance`).set(h.bearer(o)).send({ method: 'cash', amount: 150000 }).expect(409)).body.code).toBe('NO_BALANCE_DUE');

    // At the end the tick completes it; no more money moves.
    await moveTo(b, new Date(Date.now() - 2 * 3600000));
    await bookings.tick();
    expect((await models.Booking.findByPk(b.id)).status).toBe('completed');
    expect(await balance(`payable:user:${o.user.id}`)).toBe(40000);
    const inv = await invariants.check({ publish: false });
    expect(inv.checks.filter((x) => !x.ok)).toEqual([]);
  });

  it('paid in full online: the owner receives ৳1,900 at check-in', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    let b = await book(m, g, { payment: 'full' });
    expect(b.onlinePoisha).toBe(200000);
    b = await moveTo(b, new Date());
    await api().post(`${P}/me/ground-bookings/${b.id}/check-in`).set(h.bearer(o)).expect(200);
    expect(await balance(`payable:user:${o.user.id}`)).toBe(190000);
    expect(await balance('fee_revenue:grounds')).toBe(10000);
    expect((await models.Booking.findByPk(b.id)).balanceStatus).toBe('not_due');
  });

  it('member cancel: the advance is retained (৳475 / ৳25); above the advance is refunded (FR-10, Q120)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    const a = await book(m, g);
    const preview = await api().post(`${P}/me/bookings/${a.id}/cancel-preview`).set(h.bearer(m)).expect(200);
    expect(preview.body).toMatchObject({ allowed: true, refund: 0, retained: 50000 });
    expect((await api().post(`${P}/me/bookings/${a.id}/cancel`).set(h.bearer(m)).send({ expectedRefund: 100 }).expect(409)).body.code).toBe('REFUND_CHANGED');
    await api().post(`${P}/me/bookings/${a.id}/cancel`).set(h.bearer(m)).send({ expectedRefund: 0 }).expect(200);
    expect(await balance(`payable:user:${o.user.id}`)).toBe(47500);
    expect(await balance('fee_revenue:grounds')).toBe(2500);

    const f = await book(m, g, { start: slot(1, 4), payment: 'full' });
    const p2 = await api().post(`${P}/me/bookings/${f.id}/cancel-preview`).set(h.bearer(m)).expect(200);
    expect(p2.body).toMatchObject({ refund: 150000, retained: 50000 });
    const c2 = await api().post(`${P}/me/bookings/${f.id}/cancel`).set(h.bearer(m)).send({ expectedRefund: 150000 }).expect(200);
    expect(c2.body.refund).toBe(150000);
    expect(await balance(`payable:user:${o.user.id}`)).toBe(95000);
    expect(await models.Refund.sum('amountPoisha', { where: { paymentId: f.paymentId } })).toBe(150000);
    expect(await models.BookingSlot.count({ where: { status: 'active' } })).toBe(0);

    // After the start, no cancel.
    const s = await moveTo(await book(m, g, { start: slot(2) }), new Date());
    expect((await api().post(`${P}/me/bookings/${s.id}/cancel`).set(h.bearer(m)).send({ expectedRefund: 0 }).expect(409)).body.code).toBe('ALREADY_STARTED');
  });

  it('owner cancel refunds 100%; a suspended ground cancels its bookings for the platform (FR-19)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    const a = await book(m, g, { payment: 'full' });
    const r = await api().post(`${P}/me/ground-bookings/${a.id}/cancel`).set(h.bearer(o)).send({ reason: 'weather' }).expect(200);
    expect(r.body).toMatchObject({ refund: 200000, booking: { status: 'cancelled_by_owner' } });
    expect(h.events.recorded().find((e) => e.name === 'booking.owner_cancelled').payload).toMatchObject({ penalised: false, refund: 200000 });

    const b = await book(m, g, { start: slot(1, 4) });
    await api().post(`${P}/admin/grounds/${g.id}/suspend`).set(h.bearer(master)).send({ reason: 'Fake listing reported' }).expect(200);
    await h.drainEvents();
    expect((await models.Booking.findByPk(b.id)).status).toBe('cancelled_by_platform');
    expect(await models.Refund.sum('amountPoisha', { where: { paymentId: b.paymentId } })).toBe(50000);
    expect(await balance(`payable:user:${o.user.id}`)).toBe(0);
  });

  it('no-show: only once late; the advance is retained and the rest of the court is freed (FR-15)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    let b = await book(m, g, { minutes: 120, payment: 'full' });
    b = await moveTo(b, new Date());
    if (Date.now() - b.startAt.getTime() <= 15 * 60000) {
      expect((await api().post(`${P}/me/ground-bookings/${b.id}/no-show`).set(h.bearer(o)).expect(409)).body.code).toBe('NOT_LATE_YET');
    }
    b = await moveTo(b, new Date(Date.now() - 30 * 60000));
    const r = await api().post(`${P}/me/ground-bookings/${b.id}/no-show`).set(h.bearer(o)).expect(200);
    // ৳4,000 for two hours, paid in full: ৳3,000 is refunded now; the ৳1,000 advance is retained and
    // waits in escrow for the M17 dispute window (disputes.window_booking_hours) before it is released.
    expect(r.body.settled).toMatchObject({ refunded: 300000, retained: 100000 });
    expect(await balance(`payable:user:${o.user.id}`)).toBe(0);
    const [s] = await models.sequelize.query("SELECT upper(period) AS e FROM booking_slots WHERE booking_id = :id AND status = 'active'", { replacements: { id: b.id }, type: models.sequelize.QueryTypes.SELECT });
    expect(new Date(s.e).getTime()).toBeLessThan(b.endAt.getTime());
    // Nothing is released before the window closes; after it the tick releases ৳950 to the owner, ৳50 fee.
    expect((await bookings.tick()).noShowsSettled).toBe(0);
    const out = await bookings.tick(new Date(Date.now() + 49 * 3600000));
    expect(out.noShowsSettled).toBe(1);
    expect(await balance(`payable:user:${o.user.id}`)).toBe(95000);
    expect(await models.Booking.findByPk(b.id)).toMatchObject({ retainedPoisha: 100000, releasedPoisha: 100000, refundPoisha: 300000, settleDueAt: null });
  });

  it('never checked in: auto-complete after 24 h releases in full (Q68)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    const b = await book(m, g);
    await moveTo(b, new Date(Date.now() - 26 * 3600000));
    const out = await bookings.tick();
    expect(out.autoCompleted).toBe(1);
    expect((await models.Booking.findByPk(b.id)).status).toBe('completed');
    expect(await balance(`payable:user:${o.user.id}`)).toBe(40000);
    expect((await api().post(`${P}/me/ground-bookings/${b.id}/no-show`).set(h.bearer(o)).expect(409)).body.code).toBe('BOOKING_STATE');
  });

  it('extend +30 min owes the fee as a receivable; walk-ins too (FR-16, FR-18, M06 §6.4)', async () => {
    const o = await owner();
    const g = await liveGround(o, { courts: 2 });
    const m = await h.signupUser();
    let b = await book(m, g);
    b = await moveTo(b, new Date());
    await api().post(`${P}/me/ground-bookings/${b.id}/check-in`).set(h.bearer(o)).expect(200);
    const x = await api().post(`${P}/me/ground-bookings/${b.id}/extend`).set(h.bearer(o)).expect(200);
    expect(x.body).toMatchObject({ amount: 100000, booking: { money: { total: 300000, dueAtVenue: 250000 } } });
    expect(await balance(`fee_receivable:user:${o.user.id}`)).toBe(-5000); // an asset: debit 5% × ৳1,000

    const w = await api()
      .post(`${P}/me/grounds/${g.id}/walk-ins`)
      .set(h.bearer(o))
      .set('Idempotency-Key', key('walk'))
      .send({ courtIds: [g.courts[1]], start: new Date(Math.floor(Date.now() / HALF) * HALF).toISOString(), minutes: 60, name: 'Shapla FC', phone: '01711000099' })
      .expect(201);
    expect(w.body.booking).toMatchObject({ source: 'walk_in', status: 'checked_in', phoneLast4: '0099', money: { paidOnline: 0, balanceStatus: 'collected' } });
    expect(await balance(`fee_receivable:user:${o.user.id}`)).toBe(-15000);
    expect(JSON.stringify(w.body)).not.toContain('01711000099');
  });

  it('owners act only on their own grounds (NOT_OWNER)', async () => {
    const o = await owner();
    const other = await owner('Rina Begum');
    const g = await liveGround(o);
    const m = await h.signupUser();
    const b = await book(m, g);
    expect((await api().post(`${P}/me/ground-bookings/${b.id}/check-in`).set(h.bearer(other)).expect(403)).body.code).toBe('NOT_OWNER');
    expect((await api().get(`${P}/me/ground-bookings?groundId=${g.id}`).set(h.bearer(other)).expect(403)).body.code).toBe('NOT_OWNER');
    await api().get(`${P}/me/ground-bookings/${b.id}`).set(h.bearer(m)).expect(403); // a member is not an owner
    const day = new Date(b.startAt.getTime() + 6 * 3600000).toISOString().slice(0, 10);
    expect((await api().get(`${P}/me/ground-bookings?groundId=${g.id}&date=${day}`).set(h.bearer(o)).expect(200)).body.bookings.map((x) => x.code)).toEqual([b.code]);
  });
});

describe('M10 moves and M09 step 2 (closures, series, the port)', () => {
  it('moves a booking to a free court; the court with bookings cannot retire; hours cannot exclude it', async () => {
    const o = await owner();
    const g = await liveGround(o, { courts: 2 });
    const m = await h.signupUser();
    const b = await book(m, g);
    expect((await api().post(`${P}/me/courts/${g.courts[0]}/retire`).set(h.bearer(o)).expect(409)).body.code).toBe('COURT_HAS_BOOKINGS');
    const closed = Array.from({ length: 7 }, (_, dow) => ({ dow, isClosed: true }));
    const hc = await api().put(`${P}/me/courts/${g.courts[0]}/hours`).set(h.bearer(o)).send({ hours: closed }).expect(409);
    expect(hc.body).toMatchObject({ code: 'HOURS_CONFLICT', conflicts: [expect.objectContaining({ code: b.code })] });

    const targets = await api().get(`${P}/me/ground-bookings/${b.id}/move-targets`).set(h.bearer(o)).expect(200);
    expect(targets.body.items).toEqual([expect.objectContaining({ courtId: g.courts[1], sameGround: true })]);
    const r = await api().post(`${P}/me/ground-bookings/${b.id}/move`).set(h.bearer(o)).send({ courtId: g.courts[1] }).expect(200);
    expect(r.body.booking.courtIds).toEqual([g.courts[1]]);
    expect(await models.BookingSlot.count({ where: { bookingId: b.id, status: 'active', courtId: g.courts[1] } })).toBe(1);
    await api().post(`${P}/me/courts/${g.courts[0]}/retire`).set(h.bearer(o)).expect(200);
  });

  it('closures clash with bookings, block new holds, and reopen (FR-15 to FR-17)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    const b = await book(m, g);
    const body = (start, hours = 2) => ({ start, end: new Date(new Date(start).getTime() + hours * 3600000).toISOString(), reason: 'maintenance' });
    const clash = await api().post(`${P}/me/grounds/${g.id}/closures`).set(h.bearer(o)).send(body(b.startAt.toISOString())).expect(409);
    expect(clash.body).toMatchObject({ code: 'CLOSURE_CLASHES', conflicts: [expect.objectContaining({ kind: 'booking', code: b.code })] });
    expect((await api().post(`${P}/me/grounds/${g.id}/closures/preview`).set(h.bearer(o)).send(body(b.startAt.toISOString())).expect(200)).body.conflicts).toHaveLength(1);
    expect((await api().post(`${P}/me/grounds/${g.id}/closures`).set(h.bearer(o)).send({ ...body(slot(2)), reason: 'platform' }).expect(403)).body.code).toBe('REASON_NOT_ALLOWED');

    const x = await api().post(`${P}/me/grounds/${g.id}/closures`).set(h.bearer(o)).send(body(slot(2))).expect(201);
    expect(x.body).toMatchObject({ status: 'active', phase: 'upcoming', courtIds: g.courts });
    expect((await hold(m, g, { start: slot(2), status: 409 })).body.code).toBe('SLOT_UNAVAILABLE');
    await api().post(`${P}/me/closures/${x.body.id}/reopen`).set(h.bearer(o)).expect(200);
    await hold(m, g, { start: slot(2) });
    expect((await api().get(`${P}/me/grounds/${g.id}/closures?scope=past`).set(h.bearer(o)).expect(200)).body.items.map((c) => c.status)).toEqual(['reopened']);
  });

  it('series: weeks become bookings paid at the venue; clashes skip; skip, restore and end (FR-19 to FR-23)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    // The first series week (next week, same weekday as tomorrow) is taken by a member.
    const first = new Date(slot(1));
    const dhaka = new Date(first.getTime() + 6 * 3600000);
    const startTime = `${String(dhaka.getUTCHours()).padStart(2, '0')}:${String(dhaka.getUTCMinutes()).padStart(2, '0')}`;
    const body = { courtId: g.courts[0], teamName: 'Dhanmondi Lions', phone: '01711000077', dow: dhaka.getUTCDay(), startTime, lengthMin: 60, weeks: 4, firstDate: dhaka.toISOString().slice(0, 10) };
    await book(m, g, { start: first.toISOString() });

    const pv = await api().post(`${P}/me/grounds/${g.id}/series/preview`).set(h.bearer(o)).send(body).expect(200);
    expect(pv.body).toMatchObject({ pricePerSession: 180000, discountPct: 10 });
    expect(pv.body.weeks.map((w) => w.clash)).toEqual(['booking', null, null, null]);
    expect((await api().post(`${P}/me/grounds/${g.id}/series`).set(h.bearer(o)).send(body).expect(409)).body.code).toBe('SERIES_CLASHES');
    const s = await api().post(`${P}/me/grounds/${g.id}/series`).set(h.bearer(o)).send({ ...body, skipClashingWeeks: true }).expect(201);
    expect(s.body.sessions.map((x) => x.status)).toEqual(['skipped', 'confirmed', 'confirmed', 'confirmed']);
    expect(JSON.stringify(s.body)).not.toContain('01711000077');
    const week1 = await models.Booking.findOne({ where: { seriesId: s.body.id, seriesWeek: 1 } });
    expect(week1).toMatchObject({ source: 'series', paymentChoice: 'venue', onlinePoisha: 0, pricePoisha: 180000 });

    await api().post(`${P}/me/series/${s.body.id}/weeks/1/skip`).set(h.bearer(o)).expect(200);
    // Week 1 is beyond the 7-day booking window, so a closure takes its time instead.
    await api().post(`${P}/me/grounds/${g.id}/closures`).set(h.bearer(o)).send({ start: week1.startAt.toISOString(), end: week1.endAt.toISOString(), reason: 'private_event' }).expect(201);
    expect((await api().post(`${P}/me/series/${s.body.id}/weeks/1/restore`).set(h.bearer(o)).expect(409)).body.code).toBe('SLOT_UNAVAILABLE');
    const ended = await api().post(`${P}/me/series/${s.body.id}/end`).set(h.bearer(o)).send({ reason: 'team_left' }).expect(200);
    expect(ended.body.status).toBe('ended');
    expect(ended.body.sessions.filter((x) => x.status === 'cancelled_by_owner')).toHaveLength(2);
  });

  it('the public list shows open hours today and sorts by them (FR-26); detail says booking is open', async () => {
    const o = await owner();
    const busy = await liveGround(o, { name: 'Busy Arena' });
    await liveGround(o, { name: 'Quiet Arena' });
    const m = await h.signupUser();
    const start = new Date(Math.ceil((Date.now() + 60000) / HALF) * HALF + HALF);
    // The fixture is open all day, so the 2-hour hold counts in full only if it ends by Dhaka midnight;
    // from about 21:30 Dhaka no such window is left today and the list check is skipped.
    const midnight = pr.dhakaInstant(pr.dhakaParts(new Date()).date, 24 * 60);
    if (start.getTime() + 2 * 3600000 <= midnight.getTime()) {
      await hold(m, busy, { start: start.toISOString(), minutes: 120 });
      const list = await api().get(`${P}/grounds?sort=most_open`).expect(200);
      expect(list.body.items.map((x) => x.name)).toEqual(['Quiet Arena', 'Busy Arena']);
      expect(list.body.items[0].openHoursToday - list.body.items[1].openHoursToday).toBe(2);
    }
    const slug = (await models.Ground.findByPk(busy.id)).slug;
    expect((await api().get(`${P}/grounds/${slug}`).expect(200)).body.bookingOpen).toBe(true);
  });
});
