'use strict';

// M11 Hire step 1 end to end: the M03 taxonomy, a pro's credential (M02, per hire role) and profile
// review (M05, FR-10 to FR-13), the directory (FR-01 to FR-07), a request quoted on the server
// (FR-20, FR-21), accept with the checks and the clash guard (FR-22 to FR-25), one payment split
// into a hold per job (M06), messages masked before payment, match day (FR-30 to FR-34), confirm
// and auto-release (v3), cancellation fees (§6.6), pro withdrawal, a no-show as an M17 dispute,
// expiry and lapse, and M07's daily payout.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const x = require('../fixtures/hire');
const ledger = require('../../src/modules/payments/ledger.service');
const payouts = require('../../src/modules/payouts/payouts.service');
const hireJobs = require('../../src/modules/hire/hire.jobs');

const { api, P, models } = h;

let master;
let reviewer;
let docsReviewer;
let seq = 0;
const key = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  reviewer = await f.staffWith(master, ['approve_listings']);
  docsReviewer = await f.staffWith(master, ['approve_documents']);
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const send = async (who, body) => api().post(`${P}/hire/requests`).set(h.bearer(who)).set('Idempotency-Key', key('hr')).send(body);
const pro = (who, path, body) => api().post(`${P}/pro/${path}`).set(h.bearer(who)).send(body ?? {});
const me = (who, path, body) => api().post(`${P}/me/${path}`).set(h.bearer(who)).send(body ?? {});
const payable = (who) => ledger.balance(`payable:user:${who.user.id}`);
const codesOf = async (userId) => (await models.Notification.findAll({ where: { userId } })).map((n) => n.code);

/** A confirmed request: sent, accepted and paid. Returns { manager, request, job }. */
async function confirmed(profile, proUser, { days = 4, manager } = {}) {
  const m = manager ?? (await h.signupUser({ name: 'Rafi Ahmed' }));
  const r = await send(m, await x.matchRequest(profile.id, [x.at1930(days)]));
  expect(r.status).toBe(201);
  const accepted = await pro(proUser, `requests/${r.body.request.id}/accept`).expect(200);
  await h.payWithSimulator(m, accepted.body.request.paymentId ?? r.body.request.paymentId ?? (await models.HireRequest.findByPk(r.body.request.id)).paymentId);
  await h.drainEvents();
  const request = await models.HireRequest.findByPk(r.body.request.id);
  const job = await models.HireJob.findOne({ where: { requestId: request.id } });
  return { manager: m, request, job };
}

describe('M11 hire', () => {
  it('taxonomy, a credential per role, profile review and the directory (FR-01 to FR-13)', async () => {
    const tax = (await api().get(`${P}/hire/taxonomy`).expect(200)).body.items;
    expect(tax.map((c) => c.code)).toEqual(['01', '02', '03', '04', '05', '06']);
    expect(tax.flatMap((c) => c.roles)).toHaveLength(24);
    expect(tax.find((c) => c.key === 'officials').roles.find((r) => r.key === 'cricket_umpire')).toMatchObject({ formatPriced: true, requiresCredential: true, forRole: 'pro' });

    // No credential yet: the M05 check fails, so the desk cannot approve.
    const p0 = await x.applicant('pro', 'No Credential');
    const draft = await api().post(`${P}/pro/profiles`).set(h.bearer(p0)).send({ roleKey: 'cricket_umpire', headline: 'Club umpire, weekends', experienceLevel: 'semi_pro', baseAreaId: await f.areaId('dhanmondi') }).expect(201);
    expect((await pro(p0, `profiles/${draft.body.id}/submit`).expect(409)).body.code).toBe('RATE_CARD_REQUIRED');
    const tooCheap = { ...x.UMPIRE_CARD, items: [{ unit: 'match', format: 'T20', rate: 1000 }] };
    expect((await api().put(`${P}/pro/profiles/${draft.body.id}/rate-card`).set(h.bearer(p0)).send(tooCheap).expect(422)).body.errors[0].field).toBe('items[0]');
    await api().put(`${P}/pro/profiles/${draft.body.id}/rate-card`).set(h.bearer(p0)).send(x.UMPIRE_CARD).expect(200);
    await pro(p0, `profiles/${draft.body.id}/submit`).expect(200);
    await h.drainEvents();
    const sub = await models.Submission.findOne({ where: { kind: 'hire_profile', subjectId: draft.body.id } });
    await api().post(`${P}/admin/submissions/${sub.id}/claim`).set(h.bearer(reviewer)).expect(200);
    const checks = (await api().get(`${P}/admin/submissions/${sub.id}`).set(h.bearer(reviewer)).expect(200)).body.checks;
    expect(checks.find((c) => c.key === 'credential_covers')).toMatchObject({ result: 'fail' });

    // With a BCB Level 2 credential (pro) the semi-pro profile is approved; the pro role turns active.
    const { pro: kamrul, profile } = await x.liveProfile({ docsReviewer, reviewer });
    expect(profile).toMatchObject({ status: 'live', liveVersion: 1, rateCard: { version: 1, items: expect.any(Array) } });
    expect((await models.UserRole.findOne({ where: { userId: kamrul.user.id, role: 'pro' } })).status).toBe('active');
    expect(await codesOf(kamrul.user.id)).toContain('HIRE_PROFILE_LIVE');

    const list = (await api().get(`${P}/hire/profiles?category=officials&unit=match&sort=rate`).expect(200)).body;
    expect(list.items.map((p) => p.slug)).toEqual([profile.slug]);
    expect(list.items[0]).toMatchObject({ rateFrom: 250000, rateUnit: 'match', experienceLevel: 'semi_pro', role: { key: 'cricket_umpire' } });
    expect(list.counts.officials).toBe(1);
    const pageBody = (await api().get(`${P}/hire/profiles/${profile.slug}`).expect(200)).body;
    expect(pageBody).toMatchObject({ credential: { level: 'pro', labelEn: 'BCB Level 2', verified: true }, taking: true, busy: [] });
    expect(JSON.stringify(pageBody)).not.toMatch(/017\d{8}/);

    const quote = (await api().post(`${P}/hire/profiles/${profile.id}/quote`).send(await x.matchRequest(profile.id, [x.at1930(4)])).expect(200)).body;
    expect(quote).toMatchObject({ total: 450000, lines: [{ zone: 'north', lines: [{ key: 'base', amount: 350000 }, { key: 'night', amount: 70000 }, { key: 'travel_north', amount: 30000 }] }] });
  });

  it('request → accept (one wins a clash) → one payment, a hold per job → masked messages → match day → confirm pays ৳4,050', async () => {
    const { pro: kamrul, profile } = await x.liveProfile({ docsReviewer, reviewer });
    const m1 = await h.signupUser({ name: 'Rafi Ahmed' });
    const m2 = await h.signupUser({ name: 'Nadia Islam' });
    expect((await send(kamrul, await x.matchRequest(profile.id, [x.at1930(4)]))).body.code).toBe('OWN_PROFILE');

    const r1 = await send(m1, await x.matchRequest(profile.id, [x.at1930(4), x.at1930(5)]));
    expect(r1.status).toBe(201);
    expect(r1.body.request).toMatchObject({ status: 'pending', money: { total: 900000, fee: null }, other: { phone: null } });
    expect((await send(m1, await x.matchRequest(profile.id, [x.at1930(4)]))).body.code).toBe('DUPLICATE_REQUEST');
    const r2 = await send(m2, await x.matchRequest(profile.id, [x.at1930(4)]));
    expect(r2.status).toBe(201);
    await h.drainEvents();
    expect(await codesOf(kamrul.user.id)).toContain('HIRE_REQUEST_NEW');

    const mine = (await api().get(`${P}/pro/requests?status=pending`).set(h.bearer(kamrul)).expect(200)).body.items;
    expect(mine).toHaveLength(2);
    expect(mine[0].checks.every((c) => c.ok)).toBe(true);
    expect(mine[0].request.money).toMatchObject({ fee: expect.any(Number), net: expect.any(Number) });

    // Accept the first; the second now clashes (the time and the travel buffer are taken).
    const a1 = await pro(kamrul, `requests/${r1.body.request.id}/accept`).expect(200);
    expect(a1.body.request).toMatchObject({ status: 'accepted_unpaid', jobs: [{ status: 'reserved' }, { status: 'reserved' }] });
    const a2 = await pro(kamrul, `requests/${r2.body.request.id}/accept`).expect(422);
    expect(a2.body).toMatchObject({ code: 'CHECKS_FAILED', errors: [{ field: 'free' }] });

    // Messages: no phone numbers before payment.
    expect((await me(m1, `hire-requests/${r1.body.request.id}/messages`, { body: 'Call me on 01711 000 111' }).expect(422)).body.code).toBe('CONTACT_NOT_ALLOWED');
    await me(m1, `hire-requests/${r1.body.request.id}/messages`, { body: 'Toss at 7:15, please come 30 minutes early' }).expect(201);
    await me(kamrul, `hire-requests/${r1.body.request.id}/messages`, { body: 'Done, see you there' }).expect(201);
    const thread = (await api().get(`${P}/me/hire-requests/${r1.body.request.id}/messages`).set(h.bearer(m1)).expect(200)).body;
    expect(thread).toMatchObject({ contactAllowed: false, items: [{ mine: true }, { mine: false }] });

    // Pay: one payment, two holds (one per job, payee the pro).
    const paymentId = (await models.HireRequest.findByPk(r1.body.request.id)).paymentId;
    await h.payWithSimulator(m1, paymentId);
    await h.drainEvents();
    const holds = await models.EscrowHold.findAll({ where: { paymentId } });
    expect(holds.map((hd) => [hd.heldPoisha, hd.payeeId, hd.purpose])).toEqual([
      [450000, kamrul.user.id, 'hire'],
      [450000, kamrul.user.id, 'hire'],
    ]);
    const paid = (await api().get(`${P}/me/hire-requests/${r1.body.request.code}`).set(h.bearer(m1)).expect(200)).body.request;
    expect(paid).toMatchObject({ status: 'confirmed', jobs: [{ status: 'scheduled' }, { status: 'scheduled' }] });
    expect(paid.other.phone).toMatch(/^\+8801/);
    expect(await codesOf(m1.user.id)).toEqual(expect.arrayContaining(['HIRE_ACCEPTED_PAY', 'HIRE_CONFIRMED', 'HIRE_MESSAGE']));

    // Match day: too early, check in (late after −30 min), start, complete; the manager confirms.
    const job = await models.HireJob.findOne({ where: { requestId: r1.body.request.id }, order: [['startAt', 'ASC']] });
    expect((await pro(kamrul, `jobs/${job.id}/check-in`).expect(409)).body.code).toBe('TOO_EARLY');
    await x.moveJob(job.id, 20);
    expect((await pro(kamrul, `jobs/${job.id}/check-in`).expect(200)).body).toMatchObject({ status: 'checked_in', late: true });
    expect((await pro(kamrul, `jobs/${job.id}/start`).expect(409)).body.code).toBe('TOO_EARLY');
    await x.moveJob(job.id, 10);
    await pro(kamrul, `jobs/${job.id}/start`).expect(200);
    const done = (await pro(kamrul, `jobs/${job.id}/complete`, { result: 'Dhanmondi XI won by 6 wickets' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'completed_marked', releaseAt: expect.any(String) });
    expect((await me(kamrul, `hire-jobs/${job.id}/confirm`).expect(404)).body.code).toBe('NOT_A_PARTY');
    await me(m1, `hire-jobs/${job.id}/confirm`).expect(200);
    await h.drainEvents();
    // ৳4,500 less 10% (৳450): ৳4,050 to the pro's payable.
    expect(await payable(kamrul)).toBe(405000);
    expect(await ledger.balance('fee_revenue:hire')).toBe(45000);
    expect(await codesOf(kamrul.user.id)).toContain('JOB_PAID');

    // M07: the daily run pays it out.
    await payouts.buildBatch({ schedule: 'daily', windowEnd: new Date(Date.now() + 1000) });
    expect(await models.Payout.findOne({ where: { payeeId: kamrul.user.id } })).toMatchObject({ amountPoisha: 405000 });
  });

  it('cancellation fees by time left, pro withdrawal and the auto-release (§6.6, FR-51, v3)', async () => {
    const { pro: kamrul, profile } = await x.liveProfile({ docsReviewer, reviewer });
    // Cancelled 30 h before: 25% to the pro (less 10%), 75% back.
    const one = await confirmed(profile, kamrul);
    await x.moveJob(one.job.id, 30 * 60);
    const preview = (await api().get(`${P}/me/hire-jobs/${one.job.id}/cancel-preview`).set(h.bearer(one.manager)).expect(200)).body;
    expect(preview).toMatchObject({ tier: 'mid', pct: 25, cancelFee: 112500, refund: 337500, proGets: 101250 });
    await me(one.manager, `hire-jobs/${one.job.id}/cancel`).expect(200);
    expect(await models.HireJob.findByPk(one.job.id)).toMatchObject({ status: 'cancelled', refundedPoisha: 337500, releasedPoisha: 112500, cancelFeePoisha: 112500 });
    expect(await payable(kamrul)).toBe(101250);
    expect((await models.HireRequest.findByPk(one.request.id)).status).toBe('cancelled');

    // The pro withdraws: 100% back.
    const two = await confirmed(profile, kamrul, { days: 6 });
    await pro(kamrul, `jobs/${two.job.id}/withdraw`, { reason: 'injury' }).expect(200);
    expect(await models.HireJob.findByPk(two.job.id)).toMatchObject({ status: 'withdrawn', refundedPoisha: 450000 });
    expect((await models.HireRequest.findByPk(two.request.id)).status).toBe('cancelled');

    // Marked complete and not confirmed: released after 48 h.
    const three = await confirmed(profile, kamrul, { days: 8 });
    await x.moveJob(three.job.id, 5);
    await pro(kamrul, `jobs/${three.job.id}/check-in`).expect(200);
    await pro(kamrul, `jobs/${three.job.id}/complete`, { note: 'Umpired the full match' }).expect(200);
    const marked = await models.HireJob.findByPk(three.job.id);
    expect((await hireJobs.tick(new Date(marked.releaseAt.getTime() - 1000))).released).toBe(0);
    expect((await hireJobs.tick(new Date(marked.releaseAt.getTime() + 1000))).released).toBe(1);
    expect(await models.HireJob.findByPk(three.job.id)).toMatchObject({ status: 'released', releasedBy: 'auto' });
    expect(await payable(kamrul)).toBe(101250 + 405000);
  });

  it('a no-show is an M17 dispute: the hold freezes; staff refund all (FR-35)', async () => {
    const { pro: kamrul, profile } = await x.liveProfile({ docsReviewer, reviewer });
    const { manager, request, job } = await confirmed(profile, kamrul);
    expect((await me(manager, `hire-jobs/${job.id}/no-show`, { statement: 'The umpire never came to the ground' }).set('Idempotency-Key', key('ns')).expect(409)).body.code).toBe('DISPUTE_NOT_ELIGIBLE');
    await x.moveJob(job.id, -61);
    const opened = await api().post(`${P}/me/hire-jobs/${job.id}/no-show`).set(h.bearer(manager)).set('Idempotency-Key', key('ns')).send({ statement: 'The umpire never came to the ground' }).expect(201);
    const code = opened.body.dispute.code;
    expect(opened.body.dispute).toMatchObject({ status: 'awaiting_response', money: true, held: 450000, policyKey: 'hire.no_show' });
    expect((await models.HireJob.findByPk(job.id)).status).toBe('disputed');
    expect((await models.EscrowHold.findOne({ where: { paymentId: request.paymentId, splitRef: job.id } })).status).toBe('frozen');
    await api().post(`${P}/me/disputes/${code}/respond`).set(h.bearer(kamrul)).send({ text: 'My bike broke down on the way, sorry' }).expect(200);
    const staff = await f.staffWith(master, ['resolve_reports', 'refund_small']);
    const claimed = await api().post(`${P}/admin/disputes/${code}/claim`).set(h.bearer(staff)).expect(200);
    expect(claimed.body.source).toMatchObject({ kind: 'hire_job', code: job.code });
    await api()
      .post(`${P}/admin/disputes/${code}/decide`)
      .set(h.bearer(staff))
      .set('Idempotency-Key', key('dec'))
      .send({ outcome: 'all', reason: 'No check-in and the pro agrees', version: claimed.body.dispute.version })
      .expect(200);
    expect(await models.HireJob.findByPk(job.id)).toMatchObject({ status: 'refunded', refundedPoisha: 450000 });
    expect((await models.HireRequest.findByPk(request.id)).status).toBe('cancelled');
    expect(await payable(kamrul)).toBe(0);
  });

  it('expiry, lapse and a late capture refunded; staff view and platform cancel', async () => {
    const { pro: kamrul, profile } = await x.liveProfile({ docsReviewer, reviewer });
    const m = await h.signupUser({ name: 'Rafi Ahmed' });

    const ignored = await send(m, await x.matchRequest(profile.id, [x.at1930(4)]));
    const row = await models.HireRequest.findByPk(ignored.body.request.id);
    expect((await hireJobs.tick(new Date(row.replyBy.getTime() + 1000))).expired).toBe(1);
    expect((await models.HireRequest.findByPk(row.id)).status).toBe('expired');

    const unpaid = await send(m, await x.matchRequest(profile.id, [x.at1930(5)]));
    await pro(kamrul, `requests/${unpaid.body.request.id}/accept`).expect(200);
    const u = await models.HireRequest.findByPk(unpaid.body.request.id);
    const attempt = await api().post(`${P}/payments/${u.paymentId}/attempts`).set(h.bearer(m)).set('Idempotency-Key', key('att')).send({ method: 'bkash' }).expect(201);
    expect((await hireJobs.tick(new Date(u.payBy.getTime() + 60 * 60000))).lapsed).toBe(1);
    expect(await models.HireJob.findOne({ where: { requestId: u.id } })).toMatchObject({ status: 'void' });
    await h.simulator.pay(attempt.body.redirectUrl.split('/').pop(), 'success');
    await h.drainEvents();
    expect(await models.Refund.count({ where: { paymentId: u.paymentId, kind: 'late_capture' } })).toBe(1);

    const { request, job } = await confirmed(profile, kamrul, { days: 7, manager: m });
    const plain = await f.staffWith(master, ['approve_documents']);
    await api().get(`${P}/admin/hire/requests`).set(h.bearer(plain)).expect(403);
    const one = (await api().get(`${P}/admin/hire/requests/${job.code}`).set(h.bearer(reviewer)).expect(200)).body;
    expect(one).toMatchObject({ code: request.code, jobs: [{ code: job.code, escrow: { held: 450000, status: 'holding' } }] });
    expect(JSON.stringify(one)).not.toMatch(/\+8801/);
    expect((await api().get(`${P}/admin/hire/requests/${request.code.toLowerCase()}`).set(h.bearer(reviewer)).expect(200)).body.id).toBe(request.id);
    expect((await api().get(`${P}/admin/hire/requests?code=${job.code}`).set(h.bearer(reviewer)).expect(200)).body.items.map((i) => i.code)).toEqual([request.code]);
    await api().post(`${P}/admin/hire/jobs/${job.id}/cancel`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'escrow.manage')).send({ reason: 'The ground closed for the day' }).expect(200);
    expect(await models.HireJob.findByPk(job.id)).toMatchObject({ status: 'cancelled', cancelledBy: 'staff', refundedPoisha: 450000 });
  });

  it('the apps read what is open now, staff read a profile, and the catalogue edits the taxonomy (M03)', async () => {
    const { pro: kamrul, profile } = await x.liveProfile({ docsReviewer, reviewer });
    const { manager, request } = await confirmed(profile, kamrul);
    const asHirer = (await api().get(`${P}/me/hire-requests/${request.code}`).set(h.bearer(manager)).expect(200)).body;
    expect(asHirer.request.jobs[0].can).toEqual({ confirm: false, cancel: true, noShow: false, problem: false });
    const jobs = (await api().get(`${P}/pro/jobs`).set(h.bearer(kamrul)).expect(200)).body.items;
    expect(jobs[0]).toMatchObject({ requestCode: request.code, can: { checkIn: false, start: false, complete: false, withdraw: true } });

    const seen = (await api().get(`${P}/admin/hire/profiles/${profile.id}`).set(h.bearer(reviewer)).expect(200)).body;
    expect(seen).toMatchObject({ id: profile.id, owner: { id: kamrul.user.id, displayName: 'Kamrul Hasan' }, credential: { level: 'pro' }, baseArea: { nameEn: 'Dhanmondi' }, rateCard: { version: 1 } });
    expect((await api().get(`${P}/admin/hire/profiles?status=live`).set(h.bearer(reviewer)).expect(200)).body.items[0].owner.displayName).toBe('Kamrul Hasan');
    await api().get(`${P}/admin/hire/profiles/${request.id}`).set(h.bearer(reviewer)).expect(404);

    const officials = (await api().get(`${P}/admin/catalog/hire-categories`).set(h.bearer(master)).expect(200)).body.items.find((c) => c.key === 'officials');
    const body = { key: 'line_judge', nameEn: 'Line Judge', nameBn: 'লাইন জাজ', categoryId: officials.id, sportKeys: ['badminton'], allowedUnits: ['match'], baseHourlyPoisha: 25000, credentialTiers: [{ level: 'amateur', labelEn: 'Club', labelBn: 'ক্লাব' }] };
    const bad = await api().post(`${P}/admin/catalog/hire-roles`).set(h.bearer(master)).send({ ...body, formatPriced: true, formats: [] }).expect(422);
    expect(bad.body.errors[0].field).toBe('formats');
    const made = (await api().post(`${P}/admin/catalog/hire-roles`).set(h.bearer(master)).send(body).expect(201)).body;
    await api().patch(`${P}/admin/catalog/hire-roles/${made.id}`).set(h.bearer(master)).send({ baseHourlyPoisha: 30000 }).expect(200);
    const tax = (await api().get(`${P}/hire/taxonomy`).expect(200)).body.items;
    expect(tax.find((c) => c.key === 'officials').roles.find((r) => r.key === 'line_judge')).toMatchObject({ baseHourlyPoisha: 30000, forRole: 'pro' });
  });
});
