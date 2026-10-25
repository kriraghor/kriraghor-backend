'use strict';

// M20 Gym step 1 end to end: the gym_owner role and its documents (M02), a gym reviewed on the
// Moderation desk (FR-01, FR-02), passes bought into escrow (FR-03, FR-04), the front desk (FR-05:
// token, backup code, once a day, two scans at once), cancellation and expiry (FR-06, FR-07, Q110),
// capacity, trainer monthly plans and subscriptions (v3: cancel window, renewal in grace, lapse,
// monthly release, an M17 case), the staff desk and the gates.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const g = require('../fixtures/gym');
const ledger = require('../../src/modules/payments/ledger.service');
const gymJobs = require('../../src/modules/gym/gym.jobs');
const rules = require('../../src/modules/gym/gym.rules');
const config = require('../../src/config');

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

const payable = (who) => ledger.balance(`payable:user:${who.user.id}`);
const buy = (who, packageId, validFrom, status = 201) => api().post(`${P}/gym/passes`).set(h.bearer(who)).set('Idempotency-Key', key('gp')).send({ packageId, validFrom }).expect(status);
const pkg = (gym, kind) => gym.packages.find((p) => p.kind === kind).id;
const redeem = (owner, gymId, body) => api().post(`${P}/me/gyms/${gymId}/redemptions`).set(h.bearer(owner)).send(body);

/** A paid pass; returns the holder's view with its token and backup code. */
async function paidPass(who, gym, kind, validFrom) {
  const r = await buy(who, pkg(gym, kind), validFrom);
  await h.payWithSimulator(who, r.body.payment.id);
  await h.drainEvents();
  return (await api().get(`${P}/me/passes/${r.body.pass.code}`).set(h.bearer(who)).expect(200)).body.pass;
}

describe('M20 gym', () => {
  it('owner role and documents, review, the public gym page (FR-01, FR-02)', async () => {
    const plain = await h.signupUser({ name: 'Nadia Islam' });
    expect((await api().get(`${P}/me/gyms`).set(h.bearer(plain)).expect(403)).body.code).toBe('KYC_REQUIRED');
    const owner = await g.gymOwner(docsReviewer);
    const draft = (await api().post(`${P}/me/gyms`).set(h.bearer(owner)).send({ name: 'Iron Yard Banani', areaId: await f.areaId('banani'), addressLine: 'House 9, Road 11, Banani' }).expect(201)).body;
    expect(draft).toMatchObject({ status: 'draft', limits: { dayMin: 10000, dayMax: 300000, minPhotos: 3 } });
    const incomplete = await api().post(`${P}/me/gyms/${draft.id}/submit`).set(h.bearer(owner)).expect(422);
    expect(incomplete.body.code).toBe('GYM_INCOMPLETE');
    expect(incomplete.body.errors.map((e) => e.field)).toEqual(['photos', 'hours', 'packages']);
    await api().put(`${P}/me/gyms/${draft.id}/packages`).set(h.bearer(owner)).send({ packages: [{ kind: 'day', title: 'Day', price: 500 }] }).expect(422);
    await api().put(`${P}/me/gyms/${draft.id}/hours`).set(h.bearer(owner)).send({ hours: [{ dow: 1, openTime: '06:00', closeTime: '05:00' }] }).expect(422);

    const ready = await g.readyGym(owner, { name: 'Pulse Fitness', area: 'dhanmondi', hours: [...g.ALL_DAY.filter((x) => x.dow !== 5), { dow: 5, openTime: '08:00', closeTime: '10:00', womenOnly: true }] });
    await api().post(`${P}/me/gyms/${ready.id}/submit`).set(h.bearer(owner)).expect(200);
    await h.drainEvents();
    const sub = await models.Submission.findOne({ where: { kind: 'gym', subjectId: ready.id } });
    const checks = (await api().post(`${P}/admin/submissions/${sub.id}/claim`).set(h.bearer(reviewer)).expect(200)).body.checks;
    expect(checks.map((c) => [c.key, c.result]).sort()).toEqual([
      ['hours_valid', 'pass'],
      ['name_unique_in_area', 'pass'],
      ['owner_kyc_approved', 'pass'],
      ['packages_valid', 'pass'],
      ['photos_min', 'pass'],
    ]);
    const rubric = await models.ReviewRubric.findByPk(sub.rubricId);
    await api().put(`${P}/admin/submissions/${sub.id}/ticks`).set(h.bearer(reviewer)).send({ ticks: rubric.items.map((i) => i.key) }).expect(200);
    await api().post(`${P}/admin/submissions/${sub.id}/decide`).set(h.bearer(reviewer)).set('Idempotency-Key', key('dec')).send({ decision: 'approve' }).expect(200);
    await h.drainEvents();
    const page = (await api().get(`${P}/gym/gyms/${ready.slug}`).expect(200)).body;
    expect(page).toMatchObject({ name: 'Pulse Fitness', dayPrice: 40000, monthPrice: 450000, quarterPrice: 1200000, womenOnlyHours: true, taking: true });
    expect(page.photos).toHaveLength(3);
    expect((await api().get(`${P}/gym/gyms?sort=price`).expect(200)).body.items.map((x) => x.slug)).toEqual([ready.slug]);
    expect(await models.Notification.count({ where: { userId: owner.user.id, code: 'GYM_LIVE' } })).toBe(1);
    // M24-FR-103: the owner's links open the gym app (gym.kriraghor.com).
    expect((await models.Notification.findOne({ where: { userId: owner.user.id, code: 'GYM_LIVE' } })).link).toBe(`${config.apps.gym}/manage/${ready.id}/edit`);

    // An edit of a live gym waits for review; the public keeps the live copy.
    await api().patch(`${P}/me/gyms/${ready.id}`).set(h.bearer(owner)).send({ name: 'Pulse Fitness Dhanmondi' }).expect(200);
    expect((await api().get(`${P}/gym/gyms/${ready.slug}`).expect(200)).body.name).toBe('Pulse Fitness');
    expect((await api().get(`${P}/me/gyms/${ready.id}`).set(h.bearer(owner)).expect(200)).body).toMatchObject({ status: 'live', editStatus: 'draft' });

    // Changes requested on the edit: the notification and the owner's to-do link to the gym app (M24-FR-103).
    await api().post(`${P}/me/gyms/${ready.id}/submit`).set(h.bearer(owner)).expect(200);
    await h.drainEvents();
    await f.review(reviewer, 'gym', ready.id, 'request_changes', { reasonCode: 'photos_unclear' });
    expect((await models.Notification.findOne({ where: { userId: owner.user.id, code: 'GYM_CHANGES_REQUESTED' } })).link).toBe(`${config.apps.gym}/manage/${ready.id}/edit`);
    const todo = (await api().get(`${P}/me/dashboard/actions?role=gym_owner`).set(h.bearer(owner)).expect(200)).body.items;
    expect(todo).toEqual([expect.objectContaining({ key: 'gym_changes_requested', count: 1, href: `${config.apps.gym}/manage` })]);
  });

  it('a day pass: paid, shown as a QR, admitted once by token; the owner gets ৳380 (FR-03 to FR-05)', async () => {
    const owner = await g.gymOwner(docsReviewer);
    const gym = await g.liveGym(owner, reviewer);
    const member = await h.signupUser({ name: 'Fahim Rahman' });
    await buy(member, pkg(gym, 'day'), g.inDays(9), 422);
    const r = await buy(member, pkg(gym, 'day'), g.today());
    expect(r.body.pass).toMatchObject({ status: 'pending_payment', kind: 'day', validFrom: g.today(), token: null, backupCode: null, money: { price: 40000 } });
    expect(r.body.payment.payUrl).toMatch(/\/pay\//);
    await h.payWithSimulator(member, r.body.payment.id);
    await h.drainEvents();
    const pass = (await api().get(`${P}/me/passes/${r.body.pass.code}`).set(h.bearer(member)).expect(200)).body.pass;
    expect(pass.status).toBe('active');
    expect(pass.token).toMatch(/^v1\./);
    expect(pass.backupCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(await models.Notification.count({ where: { userId: member.user.id, code: 'GYM_PASS_READY' } })).toBe(1);
    // M24-FR-103: the pass opens in the gym app.
    expect((await models.Notification.findOne({ where: { userId: member.user.id, code: 'GYM_PASS_READY' } })).link).toBe(`${config.apps.gym}/me/passes/${pass.code}`);

    const other = await g.gymOwner(docsReviewer, 'Lift Lab');
    const otherGym = await g.liveGym(other, reviewer, { name: 'Lift Lab Uttara', area: 'uttara' });
    expect((await redeem(other, otherGym.id, { token: pass.token })).body.code).toBe('PASS_WRONG_GYM');
    expect((await redeem(owner, gym.id, { token: `${pass.token.slice(0, -1)}${pass.token.endsWith('0') ? '1' : '0'}` })).body.code).toBe('INVALID_PASS_TOKEN');
    const admitted = await redeem(owner, gym.id, { token: pass.token }).expect(201);
    expect(admitted.body).toMatchObject({ passCode: pass.code, kind: 'day', status: 'redeemed', holder: { displayName: 'Fahim Rahman' }, released: 38000 });
    // A used day pass no longer answers to its code as a pass, but the desk hears when it was used.
    const again = await redeem(owner, gym.id, { code: pass.backupCode.toLowerCase() }).expect(409);
    expect(again.body).toMatchObject({ code: 'PASS_ALREADY_REDEEMED', at: admitted.body.redeemedAt });
    expect((await redeem(owner, gym.id, { code: 'ZZZZZZ' })).body.code).toBe('INVALID_PASS_TOKEN');
    expect((await redeem(owner, gym.id, { token: pass.token })).body).toMatchObject({ code: 'PASS_ALREADY_REDEEMED' });
    expect(await payable(owner)).toBe(38000);
    expect(await ledger.balance('fee_revenue:gym')).toBe(2000);
    expect((await api().get(`${P}/me/gyms/${gym.id}/redemptions`).set(h.bearer(owner)).expect(200)).body.items).toHaveLength(1);
    expect((await api().get(`${P}/me/passes/${pass.code}`).set(h.bearer(member)).expect(200)).body.pass).toMatchObject({ status: 'redeemed', token: null, backupCode: null });
  });

  it('two scans at once admit one; a month pass is once a day and pays the gym at its first use', async () => {
    const owner = await g.gymOwner(docsReviewer);
    const gym = await g.liveGym(owner, reviewer);
    const member = await h.signupUser({ name: 'Tanvir Ahmed' });
    const pass = await paidPass(member, gym, 'month', g.today());
    const [a, b] = await Promise.all([redeem(owner, gym.id, { token: pass.token }), redeem(owner, gym.id, { code: pass.backupCode })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((a.status === 409 ? a : b).body.code).toBe('PASS_ALREADY_REDEEMED');
    expect(await payable(owner)).toBe(427500);
    expect(await models.PassRedemption.count({ where: { passId: pass.id } })).toBe(1);
    expect((await api().get(`${P}/me/passes/${pass.code}`).set(h.bearer(member)).expect(200)).body.pass).toMatchObject({ status: 'active', can: { cancel: false } });
    expect((await api().post(`${P}/me/passes/${pass.id}/cancel`).set(h.bearer(member)).expect(409)).body.code).toBe('PASS_NOT_REFUNDABLE');
    // Tomorrow it admits again without paying twice.
    await models.PassRedemption.sequelize.query('ALTER TABLE pass_redemptions DISABLE TRIGGER trg_pass_redemptions_append_only');
    await models.PassRedemption.update({ redeemedOn: g.inDays(-1) }, { where: { passId: pass.id } });
    await models.PassRedemption.sequelize.query('ALTER TABLE pass_redemptions ENABLE TRIGGER trg_pass_redemptions_append_only');
    await redeem(owner, gym.id, { code: pass.backupCode }).expect(201);
    expect(await payable(owner)).toBe(427500);
  });

  it('cancel before the date refunds in full; an unused day pass pays the gym at closing (FR-06, Q110)', async () => {
    const owner = await g.gymOwner(docsReviewer);
    const gym = await g.liveGym(owner, reviewer);
    const member = await h.signupUser({ name: 'Rafi Ahmed' });
    const tomorrow = await paidPass(member, gym, 'day', g.inDays(1));
    const cancelled = await api().post(`${P}/me/passes/${tomorrow.id}/cancel`).set(h.bearer(member)).expect(200);
    expect(cancelled.body.pass).toMatchObject({ status: 'refunded', money: { refunded: 40000 } });
    const todayPass = await paidPass(member, gym, 'day', g.today());
    expect((await api().post(`${P}/me/passes/${todayPass.id}/cancel`).set(h.bearer(member)).expect(409)).body.code).toBe('PASS_NOT_REFUNDABLE');
    expect((await gymJobs.tick(new Date())).expired).toBe(0);
    const out = await gymJobs.tick(rules.instantOf(g.inDays(1), 1));
    expect(out.expired).toBe(1);
    expect(await models.GymPass.findByPk(todayPass.id)).toMatchObject({ status: 'expired', closeReason: 'unused', releasedPoisha: 40000 });
    expect(await payable(owner)).toBe(38000);
    // A month pass unused before its first day refunds in full.
    const month = await paidPass(member, gym, 'month', g.inDays(2));
    await api().post(`${P}/me/passes/${month.id}/cancel`).set(h.bearer(member)).expect(200);
    // Unpaid passes void after the payment window.
    const unpaid = await buy(member, pkg(gym, 'day'), g.inDays(3));
    expect((await gymJobs.tick(new Date(Date.now() + 60 * 60000))).voided).toBe(1);
    expect((await models.GymPass.findByPk(unpaid.body.pass.id)).status).toBe('void');
  });

  it('daily capacity counts day passes per date', async () => {
    const owner = await g.gymOwner(docsReviewer);
    const gym = await g.liveGym(owner, reviewer, { capacity: 1 });
    const a = await h.signupUser({ name: 'Mitu Akter' });
    const b = await h.signupUser({ name: 'Shila Rahman' });
    await buy(a, pkg(gym, 'day'), g.inDays(2));
    expect((await buy(b, pkg(gym, 'day'), g.inDays(2), 409)).body.code).toBe('PASS_CAPACITY_FULL');
    await buy(b, pkg(gym, 'day'), g.inDays(3));
  });

  it('a trainer’s monthly plan: subscribe, cancel in 3 days, renewal in grace, monthly release, lapse (v3)', async () => {
    const { pro: sabbir, profile } = await g.trainer({ docsReviewer, reviewer });
    expect((await api().post(`${P}/pro/trainer-plans`).set(h.bearer(sabbir)).send({ profileId: profile.id, title: 'Strength 12', price: 50000, whereKind: 'online' }).expect(422)).body.errors[0].field).toBe('price');
    const plan = (await api().post(`${P}/pro/trainer-plans`).set(h.bearer(sabbir)).send({ profileId: profile.id, title: 'Strength 12', sessionsPerMonth: 12, price: 600000, whereKind: 'online' }).expect(201)).body;
    expect((await api().get(`${P}/gym/trainers`).expect(200)).body.items[0]).toMatchObject({ id: profile.id, planFrom: 600000, plans: 1 });
    expect((await api().post(`${P}/gym/subscriptions`).set(h.bearer(sabbir)).set('Idempotency-Key', key('ts')).send({ planId: plan.id, startDate: g.today() }).expect(422)).body.code).toBe('OWN_PLAN');

    const member = await h.signupUser({ name: 'Arif Hasan' });
    const subscribe = async () => {
      const s = (await api().post(`${P}/gym/subscriptions`).set(h.bearer(member)).set('Idempotency-Key', key('ts')).send({ planId: plan.id, startDate: g.today() }).expect(201)).body;
      await h.payWithSimulator(member, s.payment.id);
      await h.drainEvents();
      return (await api().get(`${P}/me/subscriptions/${s.code}`).set(h.bearer(member)).expect(200)).body;
    };
    const first = await subscribe();
    expect(first).toMatchObject({ status: 'active', phase: 'active', current: { seq: 1, status: 'paid', periodStart: g.today() }, can: { refundOnCancel: true } });
    const cancelled = (await api().post(`${P}/me/subscriptions/${first.id}/cancel`).set(h.bearer(member)).expect(200)).body;
    expect(cancelled).toMatchObject({ status: 'cancelled', renew: false });
    expect((await models.TrainerSubscriptionPeriod.findOne({ where: { subscriptionId: first.id } })).refundedPoisha).toBe(600000);

    const s = await subscribe();
    await g.shiftSubscription(s.id, 3); // the month ends in 3 days: renewal opens (5-day notice)
    expect((await gymJobs.tick(new Date())).renewalsDue).toBe(1);
    await h.drainEvents();
    expect(await models.Notification.count({ where: { userId: member.user.id, code: 'TRAINER_SUB_RENEWAL_DUE' } })).toBe(1);
    expect((await models.Notification.findOne({ where: { userId: member.user.id, code: 'TRAINER_SUB_RENEWAL_DUE' } })).link).toBe(`${config.apps.gym}/me/subscriptions`);
    // The member's to-do opens the gym app too (M24-FR-103).
    expect((await api().get(`${P}/me/dashboard/actions`).set(h.bearer(member)).expect(200)).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'trainer_renewals_due', href: `${config.apps.gym}/me/subscriptions` })]));
    await g.shiftSubscription(s.id, -2); // two days after the end: in grace
    let view = (await api().get(`${P}/me/subscriptions/${s.id}`).set(h.bearer(member)).expect(200)).body;
    expect(view).toMatchObject({ phase: 'grace', next: { seq: 2, status: 'pending_payment' } });
    view = (await api().post(`${P}/me/subscriptions/${s.id}/renew`).set(h.bearer(member)).expect(200)).body;
    await h.payWithSimulator(member, view.payment.id);
    await h.drainEvents();
    view = (await api().get(`${P}/me/subscriptions/${s.id}`).set(h.bearer(member)).expect(200)).body;
    expect(view).toMatchObject({ status: 'active', current: { seq: 2, status: 'paid' }, paidThrough: rules.addDays(g.inDays(-2), 30) });
    expect(view.current.periodStart).toBe(g.inDays(-1)); // back to back

    // Month 1 ended more than a day ago: released to the trainer minus 5%.
    expect((await gymJobs.tick(new Date())).released).toBe(1);
    expect(await payable(sabbir)).toBe(570000);
    expect((await api().get(`${P}/pro/subscriptions`).set(h.bearer(sabbir)).expect(200)).body.items[0]).toMatchObject({ code: s.code, role: 'trainer' });

    // A month not renewed by the end of the grace days lapses.
    await g.shiftSubscription(s.id, -4);
    expect((await gymJobs.tick(new Date())).lapsed).toBe(1);
    expect((await models.TrainerSubscription.findByPk(s.id)).status).toBe('lapsed');
    // TRAINER_SUB_LAPSED links per recipient: the member to the gym app, the trainer to their kriraghor.com desk.
    await h.drainEvents();
    const lapsedLink = async (who) => (await models.Notification.findOne({ where: { userId: who.user.id, code: 'TRAINER_SUB_LAPSED' } })).link;
    expect(await lapsedLink(member)).toBe(`${config.apps.gym}/me/subscriptions`);
    expect(await lapsedLink(sabbir)).toBe(`${config.apps.web}/pro/subscriptions`);
  });

  it('a problem with a trainer month is an M17 case: the money waits, staff decide (v3)', async () => {
    const { pro: sabbir, profile } = await g.trainer({ docsReviewer, reviewer });
    const plan = (await api().post(`${P}/pro/trainer-plans`).set(h.bearer(sabbir)).send({ profileId: profile.id, title: 'Strength 12', price: 600000, whereKind: 'online' }).expect(201)).body;
    const member = await h.signupUser({ name: 'Arif Hasan' });
    const s = (await api().post(`${P}/gym/subscriptions`).set(h.bearer(member)).set('Idempotency-Key', key('ts')).send({ planId: plan.id, startDate: g.today() }).expect(201)).body;
    await h.payWithSimulator(member, s.payment.id);
    await h.drainEvents();
    const opened = await api().post(`${P}/me/subscriptions/${s.id}/problem`).set(h.bearer(member)).set('Idempotency-Key', key('pb')).send({ statement: 'The trainer missed every session this month' }).expect(201);
    expect(opened.body.dispute).toMatchObject({ money: true, held: 600000, policyKey: 'gym.service_problem' });
    const period = await models.TrainerSubscriptionPeriod.findOne({ where: { subscriptionId: s.id } });
    expect(period.status).toBe('disputed');
    expect((await models.EscrowHold.findOne({ where: { paymentId: period.paymentId } })).status).toBe('frozen');
    await g.shiftSubscription(s.id, -5);
    expect((await gymJobs.tick(new Date())).released).toBe(0);
    const staff = await f.staffWith(master, ['resolve_reports', 'refund_small']);
    const code = opened.body.dispute.code;
    await api().post(`${P}/me/disputes/${code}/respond`).set(h.bearer(sabbir)).send({ text: 'We trained twice; the member cancelled the rest' }).expect(200);
    const claimed = await api().post(`${P}/admin/disputes/${code}/claim`).set(h.bearer(staff)).expect(200);
    expect(claimed.body.source).toMatchObject({ kind: 'trainer_subscription', title: 'Strength 12' });
    await api().post(`${P}/admin/disputes/${code}/decide`).set(h.bearer(staff)).set('Idempotency-Key', key('dec')).send({ outcome: 'half', reason: 'Two of twelve sessions happened', version: claimed.body.dispute.version }).expect(200);
    expect(await models.TrainerSubscriptionPeriod.findByPk(period.id)).toMatchObject({ status: 'released', refundedPoisha: 300000, releasedPoisha: 300000 });
    expect(await payable(sabbir)).toBe(285000);
  });

  it('staff: a pass with its escrow, a platform cancel with step-up, suspend a gym; gates', async () => {
    const owner = await g.gymOwner(docsReviewer);
    const gym = await g.liveGym(owner, reviewer);
    const member = await h.signupUser({ name: 'Fahim Rahman' });
    const pass = await paidPass(member, gym, 'day', g.inDays(1));
    const seen = (await api().get(`${P}/admin/gym/passes/${pass.code}`).set(h.bearer(reviewer)).expect(200)).body;
    expect(seen).toMatchObject({ code: pass.code, token: null, backupCode: null, escrow: { held: 40000, status: 'holding' } });
    await api().post(`${P}/admin/gym/passes/${pass.code}/cancel`).set(h.bearer(reviewer)).send({ reason: 'The gym closed for repairs' }).expect(403);
    const done = await api().post(`${P}/admin/gym/passes/${pass.code}/cancel`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'escrow.manage')).send({ reason: 'The gym closed for repairs' }).expect(200);
    expect(done.body).toMatchObject({ status: 'refunded', money: { refunded: 40000 } });
    const mod = await f.staffWith(master, ['manage_users']);
    await api().post(`${P}/admin/gym/gyms/${gym.id}/suspend`).set(h.bearer(mod)).send({ reason: 'Fake photos reported' }).expect(200);
    // The Moderation desk panel reads one gym's working copy.
    expect((await api().get(`${P}/admin/gym/gyms/${gym.id}`).set(h.bearer(reviewer)).expect(200)).body).toMatchObject({ id: gym.id, status: 'suspended', ownerId: owner.user.id, packages: expect.any(Array) });
    await api().get(`${P}/admin/gym/gyms/${member.user.id}`).set(h.bearer(reviewer)).expect(404);
    expect((await buy(member, pkg(gym, 'day'), g.inDays(1), 409)).body.code).toBe('GYM_NOT_AVAILABLE');
    await api().get(`${P}/gym/gyms/${gym.slug}`).expect(404);
    await api().post(`${P}/admin/gym/gyms/${gym.id}/restore`).set(h.bearer(master)).send({ reason: 'Photos checked on site' }).expect(200);
    // Gates: buying needs a verified phone; listing needs the gym_owner role.
    expect((await api().get(`${P}/me/gate?action=buy_gym_pass`).set(h.bearer(member)).expect(200)).body.allowed).toBe(true);
    expect((await api().get(`${P}/me/gate?action=list_gym`).set(h.bearer(member)).expect(200)).body).toMatchObject({ allowed: false });
  });
});
