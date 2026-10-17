'use strict';

// M17 Disputes, Reports and Reviews step 1 end to end:
//  - a no-show contested inside the window: the retained advance stays frozen in escrow (the tick
//    cannot release it), both sides add statements and files, staff decide half (৳250 back, owner
//    ৳237.50, fee ৳12.50) with the money moving in the decision transaction (FR-01 to FR-13);
//  - above refunds.staff_limit_poisha the case is escalated and a master decides with step-up (§6.3);
//  - withdraw unfreezes; respondent timeouts, SLA breaches, claims, RBAC, audited file views;
//  - reports: three eligible reporters hide a review, ineligible ones do not; staff suspend an account
//    through M01 (Q99, FR-15 to FR-19);
//  - reviews: only after play, held during a dispute, owner reply, the rating reaches the ground (Q98).
// The esports result dispute bridge (M21 → M17 → M21 corrections) is covered in esports.test.js.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const ledger = require('../../src/modules/payments/ledger.service');
const bookings = require('../../src/modules/bookings/bookings.service');
const disputes = require('../../src/modules/trust/disputes.service');
const { owner, liveGround, moveTo, refresh } = require('../fixtures/bookings');

const { api, P, models } = h;
const HALF = 30 * 60 * 1000;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('scoreboard photo')]);
let seq = 0;
const key = (p) => `${p}-${Date.now()}-${(seq += 1)}`;
const balance = (code) => ledger.balance(code);

let master;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

let emp = 0;
async function staffWith(permissions, name = 'Sadia Rahman') {
  emp += 1;
  const s = await h.signupUser({ name });
  await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'staff.write')).send({ userId: s.user.id, employeeId: `KG-T-${emp}`, permissions }).expect(201);
  return h.signInStaff(s.phone, s.user.id);
}

// Each booking takes its own hour (tomorrow onwards), so fixtures never collide on one court.
let hour = 0;
const slot = (days = 1) => new Date(Math.ceil((Date.now() + days * 86400000) / HALF) * HALF + (hour += 2) * HALF).toISOString();
async function book(m, g, { payment = 'advance', days = 1 } = {}) {
  const r = await api().post(`${P}/bookings/holds`).set(h.bearer(m)).set('Idempotency-Key', key('hold')).send({ groundId: g.id, courtIds: [g.courts[0]], start: slot(days), minutes: 60, payment }).expect(201);
  await h.payWithSimulator(m, r.body.payment.id);
  await h.drainEvents();
  return models.Booking.findByPk(r.body.booking.id);
}

/** A ৳2,000 booking at 25% advance, marked a no-show by the owner: ৳500 retained and waiting. */
async function noShow() {
  const o = await owner();
  const g = await liveGround(o);
  const m = await h.signupUser({ name: 'Rafi Ahmed' });
  let b = await book(m, g);
  b = await moveTo(b, new Date(Date.now() - 60 * 60000));
  await api().post(`${P}/me/ground-bookings/${b.id}/no-show`).set(h.bearer(o)).expect(200);
  await h.drainEvents();
  return { o, g, m, b: await b.reload() };
}

/** A played booking (auto-completed after 24 h: the full release to the owner), each in its own past hour. */
let past = 0;
async function played(m, g) {
  const b = await book(m, g);
  await moveTo(b, new Date(Date.now() - (26 + (past += 2)) * 3600000));
  await bookings.tick();
  await h.drainEvents();
  return b.reload();
}

const open = (m, b, body = {}) =>
  api().post(`${P}/disputes`).set(h.bearer(m)).set('Idempotency-Key', key('dsp')).send({ sourceType: 'booking', sourceId: b.id, category: 'no_show_contest', statement: 'We were there at 6, the gate was locked', ...body });
const decide = (who, code, body) => api().post(`${P}/admin/disputes/${code}/decide`).set(h.bearer(who)).set('Idempotency-Key', key('dec')).send(body);
const holdOf = (b) => models.EscrowHold.findOne({ where: { paymentId: b.paymentId } });
const codesOf = async (userId) => (await models.Notification.findAll({ where: { userId } })).map((n) => n.code);

describe('M17 booking disputes', () => {
  it('a contested no-show: frozen while open, both sides, staff decide half; the ledger matches (৳250 / ৳237.50 / ৳12.50)', async () => {
    const { o, m, b } = await noShow();
    expect(b).toMatchObject({ status: 'no_show', retainedPoisha: 50000, releasedPoisha: 0 });
    expect(b.settleDueAt).not.toBeNull();

    const opts = await api().get(`${P}/me/disputes/options?sourceId=${b.id}`).set(h.bearer(m)).expect(200);
    expect(opts.body.items).toEqual([expect.objectContaining({ category: 'no_show_contest', money: true, held: 50000 })]);
    // Only the payer can dispute; the owner cannot.
    expect((await open(o, b).expect(403)).body.code).toBe('NOT_YOUR_BOOKING');
    const r = await open(m, b).expect(201);
    const code = r.body.dispute.code;
    expect(r.body).toMatchObject({ role: 'claimant', dispute: { status: 'awaiting_response', money: true, held: 50000, policyKey: 'booking.no_show' }, can: { withdraw: true } });
    expect((await holdOf(b)).status).toBe('frozen');
    expect((await open(m, b).expect(409)).body.code).toBe('DISPUTE_ALREADY_OPEN');

    // The tick cannot release a frozen advance, even after the window.
    expect((await bookings.tick(new Date(Date.now() + 49 * 3600000))).noShowsSettled).toBe(0);
    expect(await balance(`payable:user:${o.user.id}`)).toBe(0);

    // Evidence: typed by its bytes, at most per party, private.
    const bad = await api().post(`${P}/me/disputes/${code}/evidence`).set(h.bearer(m)).set('Content-Type', 'image/png').send(Buffer.from('not an image')).expect(415);
    expect(bad.body.code).toBe('FILE_TYPE');
    const file = await api().post(`${P}/me/disputes/${code}/evidence`).set(h.bearer(m)).set('Content-Type', 'image/png').send(PNG).expect(201);
    expect(file.body.evidence).toMatchObject({ party: 'claimant', kind: 'file', file: { mime: 'image/png' } });

    // The owner sees the case, answers; a stranger gets 404.
    await h.drainEvents();
    expect(await codesOf(o.user.id)).toContain('DISPUTE_OPENED');
    expect(await codesOf(m.user.id)).toContain('DISPUTE_RECEIVED');
    const stranger = await h.signupUser({ name: 'Nobody' });
    expect((await api().get(`${P}/me/disputes/${code}`).set(h.bearer(stranger)).expect(404)).body.code).toBe('NOT_A_PARTY');
    expect((await api().get(`${P}/me/disputes?role=respondent`).set(h.bearer(o)).expect(200)).body.items.map((d) => d.code)).toEqual([code]);
    const answered = await api().post(`${P}/me/disputes/${code}/respond`).set(h.bearer(o)).send({ text: 'Nobody came; the CCTV shows an empty court' }).expect(200);
    expect(answered.body.dispute.status).toBe('under_review');
    const ownerFile = await api().get(`${P}/me/disputes/${code}/evidence/${file.body.evidence.id}/file`).set(h.bearer(o)).expect(200);
    expect(ownerFile.headers['cache-control']).toBe('no-store');

    // The desk: RBAC, claims, staff notes are never shown to the parties.
    const plain = await staffWith(['approve_listings'], 'No Disputes');
    await api().get(`${P}/admin/disputes`).set(h.bearer(plain)).expect(403);
    const staff = await staffWith(['resolve_reports', 'refund_small']);
    const other = await staffWith(['resolve_reports'], 'Second Reviewer');
    const queue = await api().get(`${P}/admin/disputes`).set(h.bearer(staff)).expect(200);
    expect(queue.body.items.map((d) => d.code)).toEqual([code]);
    expect((await decide(staff, code, { outcome: 'half', reason: 'Half' }).expect(403)).body.code).toBe('CLAIM_REQUIRED');
    const claimed = await api().post(`${P}/admin/disputes/${code}/claim`).set(h.bearer(staff)).expect(200);
    expect(claimed.body.previews).toMatchObject({ all: { refund: 50000 }, half: { refund: 25000, net: 23750, fee: 1250 }, none: { refund: 0, net: 47500, fee: 2500 } });
    expect((await api().post(`${P}/admin/disputes/${code}/claim`).set(h.bearer(other)).expect(409)).body.code).toBe('CLAIMED_BY_OTHER');
    await api().post(`${P}/admin/disputes/${code}/notes`).set(h.bearer(staff)).send({ text: 'Called the owner; CCTV not shared yet' }).expect(200);
    const view = await api().get(`${P}/admin/disputes/${code}/evidence/${file.body.evidence.id}/file`).set(h.bearer(staff)).expect(200);
    expect(Buffer.from(view.body).subarray(0, 4)).toEqual(PNG.subarray(0, 4));
    expect(await models.AuditLog.count({ where: { action: 'dispute.evidence_viewed' } })).toBe(2);
    const party = await api().get(`${P}/me/disputes/${code}`).set(h.bearer(m)).expect(200);
    expect(party.body.evidence.some((e) => e.party === 'staff')).toBe(false);

    // Decide half: the hold is unfrozen, ৳250 refunded, ৳250 released (owner ৳237.50, fee ৳12.50).
    expect((await decide(staff, code, { outcome: 'custom', refund: 60000, reason: 'Too much' }).expect(422)).body.code).toBe('REFUND_INVALID');
    expect((await decide(staff, code, { outcome: 'upheld', reason: 'Wrong kind' }).expect(422)).body.code).toBe('OUTCOME_NOT_ALLOWED');
    const done = await decide(staff, code, { outcome: 'half', reason: 'The gate was locked for part of the hour', version: claimed.body.dispute.version }).expect(200);
    expect(done.body.dispute).toMatchObject({ status: 'resolved', outcome: 'half', refund: 25000, released: 25000, fee: 1250 });
    expect(await balance(`payable:user:${o.user.id}`)).toBe(23750);
    expect(await models.Refund.sum('amountPoisha', { where: { paymentId: b.paymentId, kind: 'dispute' } })).toBe(25000);
    expect(await models.Booking.findByPk(b.id)).toMatchObject({ retainedPoisha: 25000, refundPoisha: 25000, releasedPoisha: 25000, settleDueAt: null });
    expect((await holdOf(b)).status).toBe('closed');
    // Nothing moves twice: the tick has nothing left to settle.
    expect((await bookings.tick(new Date(Date.now() + 49 * 3600000))).noShowsSettled).toBe(0);
    await h.drainEvents();
    expect(await codesOf(m.user.id)).toContain('DISPUTE_DECIDED');
    expect(await codesOf(o.user.id)).toContain('DISPUTE_DECIDED');
  });

  it('above the staff limit: escalate with a recommendation; a master decides all with step-up (§6.3)', async () => {
    const { o, m, b } = await noShow();
    await h.setSettingForTest('refunds.staff_limit_poisha', 10000);
    const code = (await open(m, b).expect(201)).body.dispute.code;
    await disputes.tick(new Date(Date.now() + 49 * 3600000)); // the owner never answered
    expect((await models.Dispute.findOne({ where: { code } })).status).toBe('under_review');
    const staff = await staffWith(['resolve_reports', 'refund_small']);
    await api().post(`${P}/admin/disputes/${code}/claim`).set(h.bearer(staff)).expect(200);
    const over = await decide(staff, code, { outcome: 'all', reason: 'Owner did not answer' }).expect(403);
    expect(over.body.code).toBe('ESCALATION_REQUIRED');
    // Staff can still decide "nothing back" without the refund limit; here they escalate instead.
    const esc = await api().post(`${P}/admin/disputes/${code}/escalate`).set(h.bearer(staff)).send({ outcome: 'all', note: 'Recommend a full refund' }).expect(200);
    expect(esc.body.dispute).toMatchObject({ status: 'escalated', recommendedOutcome: 'all', recommendedRefund: 50000 });
    await h.drainEvents();
    expect(await codesOf(master.user.id)).toContain('DISPUTE_ESCALATED');
    const md = (step) => {
      const q = api().post(`${P}/admin/disputes/${code}/master-decide`).set(h.bearer(master)).set('Idempotency-Key', key('md'));
      if (step) q.set('X-Step-Up', step);
      return q.send({ outcome: 'all', reason: 'No answer from the venue' });
    };
    await md(null).expect(403);
    const done = await md(await h.stepUp(master, 'refund.large')).expect(200);
    expect(done.body.dispute).toMatchObject({ status: 'resolved', outcome: 'all', refund: 50000, decidedRole: 'master' });
    expect(await balance(`payable:user:${o.user.id}`)).toBe(0);
    expect(await models.Refund.sum('amountPoisha', { where: { paymentId: b.paymentId } })).toBe(50000);
    expect(await models.Booking.findByPk(b.id)).toMatchObject({ retainedPoisha: 0, refundPoisha: 50000 });
    expect(await models.AuditLog.count({ where: { action: 'dispute.decided', stepUp: true } })).toBe(1);
  });

  it('withdraw unfreezes; the tick then releases ৳475 / ৳25; limits, windows and SLA breaches', async () => {
    const { o, m, b } = await noShow();
    const code = (await open(m, b).expect(201)).body.dispute.code;
    await api().post(`${P}/me/disputes/${code}/withdraw`).set(h.bearer(o)).send({}).expect(404); // only the claimant
    const w = await api().post(`${P}/me/disputes/${code}/withdraw`).set(h.bearer(m)).send({ reason: 'Sorted it out with the owner' }).expect(200);
    expect(w.body.dispute.status).toBe('withdrawn');
    expect((await holdOf(b)).status).not.toBe('frozen');
    expect((await bookings.tick(new Date(Date.now() + 49 * 3600000))).noShowsSettled).toBe(1);
    expect(await balance(`payable:user:${o.user.id}`)).toBe(47500);
    // The window has passed: nothing more to dispute.
    expect((await open(m, b).expect(409)).body.code).toBe('DISPUTE_WINDOW_CLOSED');

    // Respondent reminder, timeout, then the staff SLA breach (once).
    const second = await noShow();
    const c2 = (await open(second.m, second.b).expect(201)).body.dispute.code;
    const d2 = await models.Dispute.findOne({ where: { code: c2 } });
    expect((await disputes.tick(new Date(d2.respondentDueAt.getTime() - 3600000))).reminded).toBe(1);
    expect((await disputes.tick(new Date(d2.respondentDueAt.getTime() + 1000))).timedOut).toBe(1);
    await d2.reload();
    expect((await disputes.tick(new Date(d2.slaDueAt.getTime() + 1000))).breached).toBe(1);
    expect((await disputes.tick(new Date(d2.slaDueAt.getTime() + 2000))).breached).toBe(0);
    await h.drainEvents();
    expect(await codesOf(second.o.user.id)).toContain('DISPUTE_RESPONSE_DUE');
    expect(await codesOf(master.user.id)).toContain('DISPUTE_SLA_BREACHED');
  });

  it('a started booking never checked in (venue problem): all back cancels it for the platform', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    let b = await book(m, g);
    expect((await open(m, b, { category: 'venue_problem' }).expect(409)).body.code).toBe('DISPUTE_NOT_ELIGIBLE'); // not started yet
    b = await moveTo(b, new Date(Date.now() - 2 * 3600000));
    const code = (await open(m, b, { category: 'venue_problem', statement: 'The floodlights were off' }).expect(201)).body.dispute.code;
    // Auto-complete waits for the decision.
    await moveTo(b, new Date(Date.now() - 26 * 3600000));
    expect((await bookings.tick()).autoCompleted).toBe(0);
    await api().post(`${P}/me/disputes/${code}/respond`).set(h.bearer(o)).send({ text: 'A power cut, sorry' }).expect(200);
    const staff = await staffWith(['resolve_reports', 'refund_small']);
    await api().post(`${P}/admin/disputes/${code}/claim`).set(h.bearer(staff)).expect(200);
    await decide(staff, code, { outcome: 'all', reason: 'No lights, no game' }).expect(200);
    expect(await models.Booking.findByPk(b.id)).toMatchObject({ status: 'cancelled_by_platform', cancelReason: 'dispute', refundPoisha: 50000 });
    expect(await balance(`payable:user:${o.user.id}`)).toBe(0);
  });

  it('a played booking: findings only (Q96); at most disputes.max_open_per_user open cases', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    const b = await played(m, g);
    expect(await balance(`payable:user:${o.user.id}`)).toBe(40000);
    const r = await open(m, b, { category: 'cash_problem', statement: 'Charged twice at the counter' }).expect(201);
    expect(r.body.dispute).toMatchObject({ money: false, held: 0 });
    await api().post(`${P}/me/disputes/${r.body.dispute.code}/respond`).set(h.bearer(o)).send({ text: 'Only once' }).expect(200);
    const staff = await staffWith(['resolve_reports']);
    await api().post(`${P}/admin/disputes/${r.body.dispute.code}/claim`).set(h.bearer(staff)).expect(200);
    expect((await decide(staff, r.body.dispute.code, { outcome: 'half', reason: 'Half back' }).expect(422)).body.code).toBe('OUTCOME_NOT_ALLOWED');
    await decide(staff, r.body.dispute.code, { outcome: 'upheld', reason: 'Two receipts shown' }).expect(200);
    expect(await balance(`payable:user:${o.user.id}`)).toBe(40000); // no clawback

    await h.setSettingForTest('disputes.max_open_per_user', 1);
    const b2 = await played(m, g);
    await open(m, b2, { category: 'cash_problem' }).expect(201);
    const b3 = await played(m, g);
    expect((await open(m, b3, { category: 'cash_problem' }).expect(429)).body.code).toBe('DISPUTE_LIMIT');
  });
});

describe('M17 reviews (Q98)', () => {
  it('only after play; held during a dispute; owner reply; the rating reaches the ground from 3 reviews', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser({ name: 'Mitu Khan' });
    const upcoming = await book(m, g);
    expect((await api().post(`${P}/reviews`).set(h.bearer(m)).send({ bookingId: upcoming.id, stars: 5 }).expect(409)).body.code).toBe('NOT_PLAYED');
    const b = await played(m, g);
    expect((await api().get(`${P}/me/reviewable`).set(h.bearer(m)).expect(200)).body.items.map((x) => x.bookingId)).toEqual([b.id]);
    const other = await h.signupUser();
    expect((await api().post(`${P}/reviews`).set(h.bearer(other)).send({ bookingId: b.id, stars: 1 }).expect(403)).body.code).toBe('NOT_YOUR_BOOKING');

    // A dispute on the booking holds the review until it closes.
    const code = (await open(m, b, { category: 'cash_problem', statement: 'Asked for extra cash' }).expect(201)).body.dispute.code;
    const rv = await api().post(`${P}/reviews`).set(h.bearer(m)).send({ bookingId: b.id, stars: 4, text: 'Good turf, the counter was rude' }).expect(201);
    expect(rv.body.review).toMatchObject({ status: 'held', heldReason: 'dispute' });
    expect((await api().post(`${P}/reviews`).set(h.bearer(m)).send({ bookingId: b.id, stars: 4 }).expect(409)).body.code).toBe('REVIEW_EXISTS');
    expect((await api().get(`${P}/grounds/${g.id}/reviews`).expect(200)).body.items).toEqual([]);
    await api().post(`${P}/me/disputes/${code}/withdraw`).set(h.bearer(m)).send({}).expect(200);
    const pub = await api().get(`${P}/grounds/${g.id}/reviews`).expect(200);
    expect(pub.body.items.map((x) => x.id)).toEqual([rv.body.review.id]);
    expect(pub.body.summary).toEqual({ count: 1, avg: null, histogram: [0, 0, 0, 1, 0] }); // the average shows from 3

    // The owner replies; the member edits; links are held for staff.
    await h.drainEvents();
    expect(await codesOf(o.user.id)).not.toContain('REVIEW_NEW'); // it was held when posted
    const rep = await api().post(`${P}/me/ground-reviews/${rv.body.review.id}/reply`).set(h.bearer(o)).send({ text: 'Sorry, we have spoken to the staff' }).expect(200);
    expect(rep.body.review.reply.text).toContain('spoken');
    expect((await api().post(`${P}/me/ground-reviews/${rv.body.review.id}/reply`).set(h.bearer(other)).send({ text: 'Not mine' }).expect(403)).body.code).toBe('KYC_REQUIRED');
    const rival = await owner('Rival Owner');
    expect((await api().post(`${P}/me/ground-reviews/${rv.body.review.id}/reply`).set(h.bearer(rival)).send({ text: 'Not mine' }).expect(403)).body.code).toBe('NOT_OWNER');
    const edited = await api().patch(`${P}/reviews/${rv.body.review.id}`).set(h.bearer(m)).send({ text: 'Book cheaper at turfdeals.bd' }).expect(200);
    expect(edited.body.review).toMatchObject({ status: 'held', heldReason: 'content' });
    const staff = await staffWith(['resolve_reports']);
    expect((await api().get(`${P}/admin/reviews?status=held`).set(h.bearer(staff)).expect(200)).body.items.map((x) => x.id)).toEqual([rv.body.review.id]);
    await api().post(`${P}/admin/reviews/${rv.body.review.id}/publish`).set(h.bearer(staff)).expect(200);

    // Two more members rate it: 4, 5, 3 → 4.00 on the ground card.
    for (const [stars, name] of [[5, 'Second Player'], [3, 'Third Player']]) {
      const x = await h.signupUser({ name });
      await api().post(`${P}/reviews`).set(h.bearer(x)).send({ bookingId: (await played(x, g)).id, stars }).expect(201);
    }
    await h.drainEvents();
    expect(await codesOf(o.user.id)).toContain('REVIEW_NEW');
    expect((await api().get(`${P}/grounds/${g.id}/reviews`).expect(200)).body.summary).toEqual({ count: 3, avg: 4, histogram: [0, 0, 1, 1, 1] });
    expect(await models.Ground.findByPk(g.id)).toMatchObject({ ratingCount: 3, ratingAvg: 4 });
    const card = await api().get(`${P}/grounds/${g.slug}`).expect(200);
    expect(card.body).toMatchObject({ ratingAvg: 4, ratingCount: 3 });
  });
});

describe('M17 reports (Q99)', () => {
  async function reporter(name, { eligible = true } = {}) {
    const r = await h.signupUser({ name });
    if (eligible) {
      await h.verifyMember(r.user.id);
      await models.User.update({ createdAt: new Date(Date.now() - 10 * 86400000) }, { where: { id: r.user.id }, silent: true });
      await models.sequelize.query("UPDATE users SET created_at = now() - interval '10 days' WHERE id = :id", { replacements: { id: r.user.id } });
      await refresh(r);
    }
    return r;
  }

  it('three eligible reporters hide a review at once; new or unverified accounts do not count', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const author = await h.signupUser({ name: 'Angry Player' });
    const rv = (await api().post(`${P}/reviews`).set(h.bearer(author)).send({ bookingId: (await played(author, g)).id, stars: 1, text: 'Awful owner, total thieves' }).expect(201)).body.review;
    const file = (who, body = {}) => api().post(`${P}/reports`).set(h.bearer(who)).send({ subjectType: 'review', subjectId: rv.id, reasonCode: 'offensive', ...body });
    expect((await file(author).expect(422)).body.code).toBe('REPORT_SELF');
    for (const n of ['New One', 'New Two', 'New Three']) await file(await reporter(n, { eligible: false })).expect(201);
    expect((await models.Review.findByPk(rv.id)).status).toBe('published');
    const a = await reporter('Verified A');
    await file(a).expect(201);
    expect((await file(a).expect(409)).body.code).toBe('REPORT_DUPLICATE');
    await file(await reporter('Verified B')).expect(201);
    await file(await reporter('Verified C')).expect(201);
    expect(await models.Review.findByPk(rv.id)).toMatchObject({ status: 'hidden', hiddenReason: 'reports' });
    await h.drainEvents();
    expect(await codesOf(author.user.id)).toContain('REVIEW_HIDDEN');
    expect(await codesOf(master.user.id)).toContain('REPORT_FLAGGED');

    // The desk groups the six reports; "no violation" restores the review.
    const staff = await staffWith(['resolve_reports']);
    const q = await api().get(`${P}/admin/reports`).set(h.bearer(staff)).expect(200);
    expect(q.body.items[0]).toMatchObject({ subjectType: 'review', subjectId: rv.id, reports: 6, eligible: 3, flagged: true });
    const subj = await api().get(`${P}/admin/reports/subjects/review/${rv.id}`).set(h.bearer(staff)).expect(200);
    expect(subj.body.actions).toEqual(['no_violation', 'content_removed']); // suspending needs manage_users
    await api().post(`${P}/admin/reports/resolve`).set(h.bearer(staff)).send({ subjectType: 'review', subjectId: rv.id, action: 'no_violation', note: 'Harsh but allowed' }).expect(200);
    expect((await models.Review.findByPk(rv.id)).status).toBe('published');
    await h.drainEvents();
    expect(await codesOf(a.user.id)).toContain('REPORT_OUTCOME');
    expect((await api().post(`${P}/admin/reports/resolve`).set(h.bearer(staff)).send({ subjectType: 'review', subjectId: rv.id, action: 'no_violation', note: 'Again' }).expect(409)).body.code).toBe('NOTHING_OPEN');
  });

  it('reporting a member: suspending needs manage_users and goes through M01', async () => {
    const target = await h.signupUser({ name: 'Scammer Account' });
    const r = await reporter('Careful Member');
    await api().post(`${P}/reports`).set(h.bearer(r)).send({ subjectType: 'user', subjectId: target.user.id, reasonCode: 'fraud', note: 'Asked me to pay outside the app' }).expect(201);
    expect((await api().post(`${P}/reports`).set(h.bearer(r)).send({ subjectType: 'ground', subjectId: target.user.id, reasonCode: 'fraud' }).expect(404)).body.code).toBe('REPORT_SUBJECT_UNKNOWN');
    const staff = await staffWith(['resolve_reports']);
    const body = { subjectType: 'user', subjectId: target.user.id, action: 'user_suspended', note: 'Off-platform payment requests' };
    expect((await api().post(`${P}/admin/reports/resolve`).set(h.bearer(staff)).send(body).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    expect((await api().post(`${P}/admin/reports/resolve`).set(h.bearer(staff)).send({ ...body, action: 'content_removed' }).expect(422)).body.code).toBe('RESOLUTION_NOT_ALLOWED');
    const ops = await staffWith(['resolve_reports', 'manage_users'], 'Ops Lead');
    await api().post(`${P}/admin/reports/resolve`).set(h.bearer(ops)).send(body).expect(200);
    expect((await models.User.findByPk(target.user.id)).status).toBe('suspended');
    expect(await models.UserSanction.count({ where: { userId: target.user.id, reasonCode: 'reported' } })).toBe(1);
    expect((await api().get(`${P}/me/reports`).set(h.bearer(r)).expect(200)).body.items[0]).toMatchObject({ status: 'resolved', resolution: 'user_suspended' });
  });
});
