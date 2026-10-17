'use strict';

// M18 Risk and Trust step 1 end to end:
//  - two accounts try one NID: a critical flag on the desk and masters alerted, but nothing is frozen
//    without a person (Q101); the desk's RBAC (Q100);
//  - a master freezes payouts (an M07 risk_freeze hold, step-up risk.manage) and undoes it; staff ask
//    for documents (M02) which the member's next submission fulfils; an overdue request raises its flag;
//    clear snoozes a flag and undo reopens it; staff suspend for up to 30 days, masters ban; every undo
//    is a new row (FR-06 to FR-11);
//  - a shared payout wallet; velocity breaches through the VelocityGuard; a threshold change through an
//    M03 change request re-evaluates (FR-02, FR-03, FR-12);
//  - owner and booker reliability from bookings and a lost dispute (§6.3, Q102).
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const runtime = require('../../src/jobs/runtime');
const riskJobs = require('../../src/modules/risk/risk.jobs');
const risk = require('../../src/modules/risk/risk.nightly');
const velocity = require('../../src/common/velocity');
const requests = require('../../src/modules/kyc/requests.service');
const { owner, liveGround, moveTo, refresh } = require('../fixtures/bookings');

const { api, P, models } = h;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body for tests')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png')]);
const PDF = Buffer.from('%PDF-1.7\n% test document\n');
const NID = '1990 1234 5678 9012 3';
const HALF = 30 * 60 * 1000;
let seq = 0;
const key = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

let master;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  riskJobs.takeTestJobs();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

let emp = 0;
async function staffWith(permissions, name = 'Risk Analyst') {
  emp += 1;
  const s = await h.signupUser({ name });
  await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'staff.write')).send({ userId: s.user.id, employeeId: `KG-RK-${emp}`, permissions }).expect(201);
  return h.signInStaff(s.phone, s.user.id);
}

/** What the worker would do: deliver events, run the queued risk jobs, deliver what they published. */
async function settle() {
  await h.drainEvents();
  for (const j of riskJobs.takeTestJobs()) await runtime.processJob({ name: j.name, data: j.data });
  await h.drainEvents();
}

async function submitNid(who, salt) {
  const files = {};
  for (const [slot, buf, type] of [['front', JPEG, 'image/jpeg'], ['back', PNG, 'image/png'], ['selfie', PDF, 'application/pdf']]) {
    files[slot] = (await api().post(`${P}/me/documents/files?slot=${slot}`).set(h.bearer(who)).set('Content-Type', type).send(Buffer.concat([buf, Buffer.from(salt)])).expect(201)).body.fileId;
  }
  return api().post(`${P}/me/documents`).set(h.bearer(who)).send({ docType: 'nid', fields: { number: NID, dob: '1990-05-14', legalName: 'Same Person' }, files, consent: true });
}

/** A request whose step-up token is minted first; `.expect(status)` like supertest, with the body on failure. */
const call = (build) => ({
  expect: async (status) => {
    const res = await build();
    expect({ status: res.status, body: res.body }).toMatchObject({ status });
    return res;
  },
});
const act = (who, userId, body, scope) =>
  call(async () => {
    const q = api().post(`${P}/admin/risk/accounts/${userId}/actions`).set(h.bearer(who));
    if (scope) q.set('X-Step-Up', await h.stepUp(who, scope));
    return q.send(body);
  });
const undo = (who, actionId, reason, scope) =>
  call(async () => {
    const q = api().post(`${P}/admin/risk/actions/${actionId}/undo`).set(h.bearer(who));
    if (scope) q.set('X-Step-Up', await h.stepUp(who, scope));
    return q.send({ reason });
  });
const flagOf = (userId, ruleKey) => models.RiskFlag.findOne({ where: { userId, ruleKey }, order: [['createdAt', 'DESC']] });
const codesOf = async (userId) => (await models.Notification.findAll({ where: { userId } })).map((n) => n.code);

describe('M18 flags and the desk', () => {
  it('two accounts try one NID: a critical flag, masters alerted, nothing frozen; the desk RBAC', async () => {
    const a = await h.signupUser({ name: 'First Holder' });
    const b = await h.signupUser({ name: 'Second Holder' });
    await submitNid(a, 'a').then((r) => expect(r.status).toBe(201));
    await submitNid(b, 'b').then((r) => expect(r.status).toBe(201));
    await settle();
    const f = await flagOf(b.user.id, 'accounts_per_nid');
    expect(f).toMatchObject({ status: 'open', severity: 'critical', metricValue: 2, threshold: 1, ruleVersion: 1 });
    expect(f.reasonText).toContain('same NID');
    expect(await models.PayoutHold.count()).toBe(0); // Q101: a person decides every freeze
    expect(await codesOf(master.user.id)).toContain('RISK_FLAGGED');
    // The event payloads carry ids and keys only.
    expect(JSON.stringify(await models.OutboxEvent.findAll({ where: { name: ['risk.flag_raised', 'risk.action_taken'] } }))).not.toContain('1990');

    const noAccess = await staffWith(['approve_listings'], 'Listing Reviewer');
    await api().get(`${P}/admin/risk/overview`).set(h.bearer(noAccess)).expect(403);
    await api().get(`${P}/admin/risk/overview`).set(h.bearer(b)).expect(401);
    const staff = await staffWith(['manage_users']);
    const ov = await api().get(`${P}/admin/risk/overview`).set(h.bearer(staff)).expect(200);
    expect(ov.body.counts.critical).toBe(1);
    expect(ov.body.rules.find((r) => r.key === 'accounts_per_nid')).toMatchObject({ settingKey: 'risk.max_accounts_per_nid', threshold: 1, open: 1 });
    const list = await api().get(`${P}/admin/risk/flags`).set(h.bearer(staff)).expect(200);
    expect(list.body.items[0]).toMatchObject({ ruleKey: 'accounts_per_nid', user: { displayName: 'Second Holder' } });
    const acc = await api().get(`${P}/admin/risk/accounts/${b.user.id}`).set(h.bearer(staff)).expect(200);
    expect(acc.body).toMatchObject({ riskLevel: 'critical', user: { displayName: 'Second Holder' } });
    expect(JSON.stringify(acc.body)).not.toContain('1990');
  });

  it('freeze and undo; documents asked for and fulfilled; overdue raises the flag; clear, snooze and reopen', async () => {
    const m = await h.signupUser({ name: 'Flagged Member' });
    await h.setSettingForTest('risk.velocity_breaches_max', 3);
    for (let i = 0; i < 3; i += 1) await velocity.recordBreach(m.user.id, 'test');
    await settle();
    const flag = await flagOf(m.user.id, 'velocity_breaches');
    expect(flag).toMatchObject({ status: 'open', severity: 'medium', metricValue: 3 });
    const staff = await staffWith(['manage_users']);

    // Freeze: masters only, with step-up risk.manage.
    expect((await act(staff, m.user.id, { action: 'freeze_payouts', flagId: flag.id, reason: 'Checking the account activity' }, 'risk.manage').expect(403)).body.code).toBe('MASTER_REQUIRED');
    await act(master, m.user.id, { action: 'freeze_payouts', flagId: flag.id, reason: 'Checking the account activity' }).expect(403); // no step-up
    const frozen = await act(master, m.user.id, { action: 'freeze_payouts', flagId: flag.id, reason: 'Checking the account activity' }, 'risk.manage').expect(201);
    const hold = await models.PayoutHold.findOne({ where: { payeeId: m.user.id, type: 'risk_freeze' } });
    expect(hold).toMatchObject({ scope: 'payee', liftedAt: null });
    expect((await flagOf(m.user.id, 'velocity_breaches')).status).toBe('actioned');
    expect((await act(master, m.user.id, { action: 'freeze_payouts', reason: 'Checking the account again' }, 'risk.manage').expect(409)).body.code).toBe('ALREADY_FROZEN');
    await h.drainEvents();
    expect(await codesOf(m.user.id)).toContain('PAYOUTS_FROZEN');
    expect(h.sms.lastTo(h.e164(m.phone)).text).not.toContain('velocity'); // no rule detail to the payee
    // Undo: the hold is lifted; the flag goes back to open (its only action was undone).
    await undo(staff, frozen.body.id, 'Activity checked and fine', 'risk.manage').expect(403);
    await undo(master, frozen.body.id, 'Activity checked and fine', 'risk.manage').expect(201);
    expect((await hold.reload()).liftedAt).not.toBeNull();
    expect((await flagOf(m.user.id, 'velocity_breaches')).status).toBe('open');
    expect((await undo(master, frozen.body.id, 'Twice should fail', 'risk.manage').expect(409)).body.code).toBe('ACTION_ALREADY_REVERSED');
    await h.drainEvents();
    expect(await codesOf(m.user.id)).toContain('PAYOUTS_UNFROZEN');

    // Documents: staff ask; the member sees it; the next NID submission fulfils it.
    const asked = await act(staff, m.user.id, { action: 'request_documents', flagId: flag.id, reason: 'Please confirm who you are', params: { docType: 'nid' } }).expect(201);
    const mine = await api().get(`${P}/me/document-requests`).set(h.bearer(m)).expect(200);
    expect(mine.body.items[0]).toMatchObject({ docType: 'nid', status: 'open' });
    await h.drainEvents();
    expect(await codesOf(m.user.id)).toContain('DOCUMENTS_REQUESTED');
    await submitNid(m, 'm');
    await settle();
    expect((await models.DocumentRequest.findByPk(asked.body.documentRequestId ?? (await models.RiskAction.findByPk(asked.body.id)).documentRequestId)).status).toBe('fulfilled');

    // A second request goes overdue: the flag goes up one level, once.
    await act(staff, m.user.id, { action: 'request_documents', flagId: flag.id, reason: 'Please send the trade licence', params: { docType: 'trade_license' } }).expect(201);
    await models.DocumentRequest.update({ dueAt: new Date(Date.now() - 1000) }, { where: { userId: m.user.id, status: 'open' } });
    expect(await requests.markOverdue()).toBe(1);
    await settle();
    expect(await flagOf(m.user.id, 'velocity_breaches')).toMatchObject({ severity: 'high', escalated: true });
    expect(await codesOf(master.user.id)).toContain('DOCUMENTS_OVERDUE');

    // Clear: the flag closes and stays quiet while the metric does not get clearly worse; undo reopens it.
    const cleared = await act(staff, m.user.id, { action: 'clear', flagId: flag.id, reason: 'Shared office network, explained' }).expect(201);
    expect(await flagOf(m.user.id, 'velocity_breaches')).toMatchObject({ status: 'cleared', clearedValue: 3 });
    await risk.evaluate(m.user.id);
    expect((await flagOf(m.user.id, 'velocity_breaches')).status).toBe('cleared');
    await undo(staff, cleared.body.id, 'Cleared by mistake, reopening').expect(201);
    expect((await flagOf(m.user.id, 'velocity_breaches')).status).toBe('open');
    const timeline = await api().get(`${P}/admin/risk/accounts/${m.user.id}`).set(h.bearer(staff)).expect(200);
    expect(timeline.body.actions.map((x) => x.action)).toEqual(['reopen', 'clear', 'request_documents', 'request_documents', 'unfreeze_payouts', 'freeze_payouts']);
    expect(timeline.body.actions.find((x) => x.action === 'freeze_payouts')).toMatchObject({ undone: true, undoable: false });
    // risk_actions is append-only.
    await expect(models.sequelize.query('DELETE FROM risk_actions')).rejects.toThrow(/append-only/);
  });

  it('suspend (staff up to 30 days) and ban (master, step-up), each undone through M01 with source risk', async () => {
    const m = await h.signupUser({ name: 'Bad Actor' });
    const staff = await staffWith(['manage_users']);
    expect((await act(staff, m.user.id, { action: 'suspend', reason: 'Repeated abuse reports', params: { days: 31 } }).expect(422)).body.code).toBe('SUSPENSION_TOO_LONG');
    const s = await act(staff, m.user.id, { action: 'suspend', reason: 'Repeated abuse reports', params: { days: 7 } }).expect(201);
    expect((await models.User.findByPk(m.user.id)).status).toBe('suspended');
    expect(await models.UserSanction.findOne({ where: { userId: m.user.id, kind: 'suspension' } })).toMatchObject({ source: 'risk', reasonCode: 'risk_flag' });
    await undo(staff, s.body.id, 'Appeal accepted after a call').expect(201);
    expect((await models.User.findByPk(m.user.id)).status).toBe('active');

    expect((await act(staff, m.user.id, { action: 'ban', reason: 'Confirmed fraud ring member' }, 'user.ban').expect(403)).body.code).toBe('MASTER_REQUIRED');
    const b = await act(master, m.user.id, { action: 'ban', reason: 'Confirmed fraud ring member' }, 'user.ban').expect(201);
    expect((await models.User.findByPk(m.user.id)).status).toBe('banned');
    expect((await undo(staff, b.body.id, 'Wrong account banned', 'user.ban').expect(403)).body.code).toBe('MASTER_REQUIRED');
    await undo(master, b.body.id, 'Wrong account banned', 'user.ban').expect(201);
    expect((await models.User.findByPk(m.user.id)).status).toBe('active');
    expect(await models.AuditLog.count({ where: { action: 'risk.action_taken' } })).toBe(4);
  });

  it('a shared payout wallet; a threshold change through M03 re-evaluates (FR-02, FR-03, FR-12)', async () => {
    const WALLET = '01712345678';
    const a = await h.signupUser({ name: 'Wallet Owner' });
    const b = await h.signupUser({ name: 'Wallet Borrower' });
    for (const who of [a, b]) {
      await h.verifyMember(who.user.id);
      await refresh(who);
      await h.allowResend(who.phone);
      await api().post(`${P}/me/payout-accounts/otp`).set(h.bearer(who)).expect(202);
      await api().post(`${P}/me/payout-accounts`).set(h.bearer(who)).send({ type: 'bkash', accountNo: WALLET, accountName: 'Wallet Owner', code: h.lastCode(who.phone) }).expect(201);
    }
    const acc = await models.PayoutAccount.findOne({ where: { userId: a.user.id } });
    await api().post(`${P}/admin/payout-accounts/${acc.id}/verify`).set(h.bearer(master)).send({ note: 'Name matches the NID' }).expect(200);
    await settle();
    expect(await flagOf(b.user.id, 'shared_payout_account')).toMatchObject({ status: 'open', severity: 'critical' });
    expect(await flagOf(b.user.id, 'payout_account_change')).toMatchObject({ severity: 'info' });

    // The guard itself: a sliding window with retryAfter.
    expect(await velocity.hit({ name: 't', scope: b.user.id, limit: 1, windowMs: 60000 })).toMatchObject({ allowed: true });
    const refused = await velocity.hit({ name: 't', scope: b.user.id, limit: 1, windowMs: 60000 });
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThan(0);

    // Thresholds: masters only, with step-up settings.write; the change request applies and re-evaluates.
    const staff = await staffWith(['manage_users']);
    await api().post(`${P}/admin/risk/thresholds`).set(h.bearer(staff)).send({ changes: [{ key: 'risk.reports_upheld_max', to: 5 }], reason: 'Too noisy at 3' }).expect(403);
    await api()
      .post(`${P}/admin/risk/thresholds`)
      .set(h.bearer(master))
      .set('X-Step-Up', await h.stepUp(master, 'settings.write'))
      .send({ changes: [{ key: 'fees.ground_booking_pct', to: 6 }], reason: 'Not a risk key' })
      .expect(422);
    const cr = await api().post(`${P}/admin/risk/thresholds`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'settings.write')).send({ changes: [{ key: 'risk.reports_upheld_max', to: 5 }], reason: 'Too noisy at 3' }).expect(201);
    expect(cr.body).toMatchObject({ source: 'risk_desk' });
    await h.drainEvents();
    expect(riskJobs.takeTestJobs().some((j) => j.name === 'risk.reevaluate-all')).toBe(true);
    expect((await risk.everyone()).evaluated).toBeGreaterThanOrEqual(2);
  });
});

describe('M18 reliability (§6.3, Q102)', () => {
  const slot = (n) => new Date(Math.ceil((Date.now() + 86400000) / HALF) * HALF + n * 2 * HALF).toISOString();
  async function book(m, g, n) {
    const r = await api().post(`${P}/bookings/holds`).set(h.bearer(m)).set('Idempotency-Key', key('hold')).send({ groundId: g.id, courtIds: [g.courts[0]], start: slot(n), minutes: 60, payment: 'advance' }).expect(201);
    await h.payWithSimulator(m, r.body.payment.id);
    await h.drainEvents();
    return models.Booking.findByPk(r.body.booking.id);
  }

  it('an owner: penalised cancels count, weather does not; a lost dispute counts half; a booker no-show', async () => {
    const o = await owner('Reliable Owner');
    const g = await liveGround(o);
    const m = await h.signupUser({ name: 'Regular Player' });
    await h.setSettingForTest('booking.hold_attempts_per_10min', 20);
    const bs = [];
    for (let i = 0; i < 6; i += 1) bs.push(await book(m, g, i));
    await api().post(`${P}/me/ground-bookings/${bs[0].id}/cancel`).set(h.bearer(o)).send({ reason: 'maintenance' }).expect(200);
    await api().post(`${P}/me/ground-bookings/${bs[1].id}/cancel`).set(h.bearer(o)).send({ reason: 'weather' }).expect(200);
    await settle();
    // 6 bookings, one penalised cancel: 1 − 1 ÷ max(6, 10) = 90%.
    let pub = await api().get(`${P}/trust/${o.user.id}`).expect(200);
    expect(pub.body.items).toEqual([expect.objectContaining({ kind: 'owner', score: 90, shown: true, sample: 6 })]);

    // A no-show the member contests and wins in full.
    const late = await moveTo(bs[2], new Date(Date.now() - 60 * 60000));
    await api().post(`${P}/me/ground-bookings/${late.id}/no-show`).set(h.bearer(o)).expect(200);
    const d = await api().post(`${P}/disputes`).set(h.bearer(m)).set('Idempotency-Key', key('dsp')).send({ sourceType: 'booking', sourceId: late.id, category: 'no_show_contest', statement: 'We were there on time' }).expect(201);
    await api().post(`${P}/me/disputes/${d.body.dispute.code}/respond`).set(h.bearer(o)).send({ text: 'They were late' }).expect(200);
    const staff = await staffWith(['resolve_reports', 'refund_small'], 'Dispute Staff');
    await api().post(`${P}/admin/disputes/${d.body.dispute.code}/claim`).set(h.bearer(staff)).expect(200);
    await api().post(`${P}/admin/disputes/${d.body.dispute.code}/decide`).set(h.bearer(staff)).set('Idempotency-Key', key('dec')).send({ outcome: 'all', reason: 'CCTV shows the team at the gate' }).expect(200);
    await settle();
    // Owner: 6 bookings, 1 penalised cancel + 1 lost dispute × 0.5 → 1 − 1.5 ÷ 10 = 85%.
    pub = await api().get(`${P}/trust/${o.user.id}`).expect(200);
    expect(pub.body.items[0]).toMatchObject({ kind: 'owner', score: 85 });
    // The booker's no-show was overturned in full, so it does not count; their score is not shown yet.
    const mine = await api().get(`${P}/me/trust`).set(h.bearer(m)).expect(200);
    expect(mine.body.items.find((x) => x.kind === 'booker')).toMatchObject({ score: 100, sample: 6, detail: { booker_no_show: 0 } });
    // One decided dispute, lost: with a sample of 1 the loss rate counts.
    await h.setSettingForTest('risk.dispute_min_sample', 1);
    await risk.evaluate(o.user.id);
    expect(await flagOf(o.user.id, 'dispute_loss_rate')).toMatchObject({ severity: 'high', metricValue: 100 });
    // The owner's own view.
    const own = await api().get(`${P}/me/trust`).set(h.bearer(o)).expect(200);
    expect(own.body.items.find((x) => x.kind === 'owner')).toMatchObject({ score: 85, detail: { owner_cancel: 1, owner_dispute_lost: 1 } });
  });
});
