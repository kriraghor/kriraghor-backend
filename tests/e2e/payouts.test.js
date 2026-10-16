'use strict';

// M07 payouts, step 1: payout accounts (FR-01, FR-02), batches from the ledger (FR-03 to FR-05),
// holds (FR-06, FR-13), release and four-eyes approval (FR-07), manual disbursement with an audited
// reveal, paid / failed / retry / cancel (FR-08, FR-10), refund payouts (FR-15), the payee views
// (FR-16) and the ledger after every step (payout_clearing invariant).
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const ledger = require('../../src/modules/payments/ledger.service');
const invariants = require('../../src/modules/payments/invariants.service');
const events = require('../../src/modules/events/events.service');
const payouts = require('../../src/modules/payouts/payouts.service');
const holds = require('../../src/modules/payouts/holds.service');
const { uuid7 } = require('../../src/common/uuid7');

const { api, P, models } = h;

let master;
let payer;
let payee;
const WALLET = '01712345678';

beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  payer = await h.signupUser({ name: 'Fahim Rahman' });
  payee = await h.signupUser({ name: 'Nusrat Jahan' });
  // A ৳100 test charge nets ৳95; the ৳100 minimum (FR-04) has its own test below.
  await h.setSettingForTest('payouts.min_amount_poisha', 1000);
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

let seq = 0;
const key = (p = 'k') => `${p}-${Date.now()}-${(seq += 1)}`;
const codesOf = async (userId) => (await models.Notification.findAll({ where: { userId }, order: [['createdAt', 'ASC']] })).map((n) => n.code);
const payable = (userId) => ledger.balance(`payable:user:${userId}`);

/** A ৳{amount/100} test charge paid by the payer and released from escrow to the payee (5% fee). */
async function earn(amount = 10000, to = payee) {
  const r = await api().post(`${P}/admin/payments/test-charges`).set(h.bearer(master)).set('Idempotency-Key', key('tc')).send({ payerId: payer.user.id, payeeId: to.user.id, amount }).expect(201);
  await h.payWithSimulator(payer, r.body.payment.id);
  const hold = await models.EscrowHold.findOne({ where: { paymentId: r.body.payment.id } });
  await api().post(`${P}/admin/escrow/${hold.id}/release`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'escrow.manage')).send({ reason: 'Delivered' }).expect(200);
  return { paymentId: r.body.payment.id, hold };
}

/** The payee adds a wallet (code to the registered phone); expects `status`. Returns the response. */
async function addAccount(member, { accountNo = WALLET, accountName = 'Nusrat Jahan', type = 'bkash' } = {}, status = 201) {
  await h.allowResend(member.phone);
  await api().post(`${P}/me/payout-accounts/otp`).set(h.bearer(member)).expect(202);
  return api().post(`${P}/me/payout-accounts`).set(h.bearer(member)).send({ type, accountNo, accountName, code: h.lastCode(member.phone) }).expect(status);
}

const verifyAccount = (who, id, body = { note: 'Name matches the NID' }) => api().post(`${P}/admin/payout-accounts/${id}/verify`).set(h.bearer(who)).send(body);

/** A verified account for a member. */
async function verifiedAccount(member = payee, opts) {
  const a = await addAccount(member, opts);
  await verifyAccount(master, a.body.id).expect(200);
  return a.body;
}

let emp = 0;
async function staffWith(permissions) {
  emp += 1;
  const member = await h.signupUser({ name: 'Tanvir Ahmed' });
  const token = await h.stepUp(master, 'staff.write');
  await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: member.user.id, employeeId: `KG-P-${emp}`, permissions }).expect(201);
  return h.signInStaff(member.phone, member.user.id);
}

const runDaily = (who = master) => api().post(`${P}/admin/payout-batches/run`).set(h.bearer(who)).send({ schedule: 'daily' });
// Each takes the expected status (step-up needs the staff member's second factor, so a code is minted first).
const stepped = async (who, path, status, idem) => {
  const req = api().post(`${P}${path}`).set(h.bearer(who)).set('X-Step-Up', await h.stepUp(who, 'payout.approve'));
  return (idem ? req.set('Idempotency-Key', idem) : req).expect(status);
};
const release = (who, id, status = 200, idem = key('rel')) => stepped(who, `/admin/payouts/${id}/release`, status, idem);
const approve = (who, id, status = 200) => stepped(who, `/admin/payouts/${id}/approve`, status, key('ap'));
const reveal = (who, id, status = 200) => stepped(who, `/admin/payouts/${id}/reveal`, status);
const markPaid = (who, id, reference = 'BKX9TR2Q1') => api().post(`${P}/admin/payouts/${id}/mark-paid`).set(h.bearer(who)).set('Idempotency-Key', key('mp')).send({ reference });
const onlyPayout = async (payeeId = payee.user.id) => models.Payout.findOne({ where: { payeeId }, order: [['createdAt', 'DESC']] });

describe('payout accounts (FR-01, FR-02, §4.1)', () => {
  it('adds a wallet with a code to the registered phone; numbers are encrypted and masked', async () => {
    const noCode = await api().post(`${P}/me/payout-accounts`).set(h.bearer(payee)).send({ type: 'bkash', accountNo: WALLET, accountName: 'Nusrat Jahan', code: '000000' });
    expect([400, 401]).toContain(noCode.status);
    expect((await addAccount(payee, { accountNo: '01212345678' }, 422)).body.code).toBe('PAYOUT_ACCOUNT_INVALID');

    const a = await addAccount(payee, { accountNo: '+880 1712-345678' }, 201);
    expect(a.body).toMatchObject({ type: 'bkash', masked: 'bKash ••• 5678', last4: '5678', status: 'pending_verification', accountName: 'Nusrat Jahan' });
    expect(JSON.stringify(a.body)).not.toContain(WALLET);
    const row = await models.PayoutAccount.findByPk(a.body.id);
    expect(row.accountNoEnc).not.toContain(WALLET);
    expect(row.accountNoHash).toHaveLength(64);
    const mine = await api().get(`${P}/me/payout-accounts`).set(h.bearer(payee)).expect(200);
    expect(mine.body.items.map((x) => x.status)).toEqual(['pending_verification']);

    // The payee hears about it on the registered phone; finance staff get it to review.
    await h.drainEvents();
    expect(await codesOf(payee.user.id)).toContain('PAYOUT_ACCOUNT_CHANGED');
    expect(h.sms.lastTo(h.e164(payee.phone)).text).toContain('bKash ••• 5678');
    expect(await codesOf(master.userId)).toContain('PAYOUT_ACCOUNT_REVIEW');
    const audit = await models.AuditLog.findOne({ where: { action: 'payout_account.added' } });
    expect(JSON.stringify(audit)).not.toContain(WALLET);
  });

  it('staff compare the name with the NID legal name and see wallets shared with other users', async () => {
    await models.User.update({ legalName: 'NUSRAT JAHAN' }, { where: { id: payee.user.id } });
    const mine = await addAccount(payee, {}, 201);
    await addAccount(payer, { accountName: 'Fahim Rahman' }, 201); // same wallet, another user
    const viewer = await staffWith(['view_payouts']);
    const q = await api().get(`${P}/admin/payout-accounts`).set(h.bearer(viewer)).expect(200);
    const row = q.body.items.find((x) => x.id === mine.body.id);
    expect(row).toMatchObject({ user: { legalName: 'NUSRAT JAHAN', displayName: 'Nusrat Jahan' }, sameWalletUsers: 1 });
    expect(JSON.stringify(q.body)).not.toContain(WALLET);
    // view_payouts can look, not decide.
    expect((await verifyAccount(viewer, mine.body.id).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
  });

  it('verify activates; reject tells the payee why; a decided account cannot be decided again', async () => {
    const a = await addAccount(payee, {}, 201);
    const clerk = await staffWith(['release_payouts']);
    const v = await verifyAccount(clerk, a.body.id).expect(200);
    expect(v.body).toMatchObject({ status: 'active', holdUntil: null }); // a first account has no change hold
    expect((await verifyAccount(clerk, a.body.id).expect(409)).body.code).toBe('PAYOUT_ACCOUNT_NOT_PENDING');

    const b = await addAccount(payee, { accountNo: '01812345678', type: 'nagad' }, 201);
    await api().post(`${P}/admin/payout-accounts/${b.body.id}/reject`).set(h.bearer(clerk)).send({ note: 'Name does not match the NID' }).expect(200);
    await h.drainEvents();
    expect(await codesOf(payee.user.id)).toEqual(expect.arrayContaining(['PAYOUT_ACCOUNT_VERIFIED', 'PAYOUT_ACCOUNT_REJECTED']));
    const mine = await api().get(`${P}/me/payout-accounts`).set(h.bearer(payee)).expect(200);
    expect(mine.body.items.map((x) => [x.status, x.reviewNote])).toEqual([['rejected', 'Name does not match the NID'], ['active', null]]);
  });

  it('a replacement account supersedes the old one and holds payouts for 48 hours (FR-02)', async () => {
    const first = await verifiedAccount();
    expect((await addAccount(payee, {}, 409)).body.code).toBe('PAYOUT_ACCOUNT_UNCHANGED');
    const second = await addAccount(payee, { accountNo: '01912345678' }, 201);
    const v = await verifyAccount(master, second.body.id).expect(200);
    expect(new Date(v.body.holdUntil).getTime() - Date.now()).toBeGreaterThan(47 * 3600 * 1000);
    expect((await models.PayoutAccount.findByPk(first.id)).status).toBe('superseded');
    const hold = await models.PayoutHold.findOne({ where: { payeeId: payee.user.id, type: 'account_change' } });
    expect(hold).toMatchObject({ scope: 'payee', refId: second.body.id });
  });
});

describe('payout runs (FR-03 to FR-05)', () => {
  it('turns released money into a payout with the fee from the release, once per window', async () => {
    await verifiedAccount();
    const { hold } = await earn(10000);
    expect(await payable(payee.user.id)).toBe(9500);

    const run = await runDaily().expect(201);
    expect(run.body).toMatchObject({ created: true, batch: { schedule: 'daily', status: 'ready', totals: { payouts: 1, amount: 9500 } } });
    const p = await onlyPayout();
    expect(p).toMatchObject({ status: 'scheduled', kind: 'earning', grossPoisha: 10000, deductionsPoisha: 500, amountPoisha: 9500 });
    expect(p.code).toMatch(/^PO-\d{2}-\d{6}$/);
    expect(p.rulesSnapshot).toMatchObject({ threshold: 5000000, minAmount: 1000, autoReleaseMax: 0 });
    const items = await models.PayoutItem.findAll({ where: { payoutId: p.id } });
    expect(items.map((i) => [i.sourceType, i.sourceId, i.grossPoisha, i.feePoisha, i.netPoisha])).toEqual([['escrow_hold', hold.id, 10000, 500, 9500]]);
    expect(items[0].description).toContain('PAY-');

    // The same window again is a no-op; a new window finds nothing new (the entry is used, FR-03).
    const again = await payouts.buildBatch({ schedule: 'daily', windowEnd: new Date(run.body.batch.windowEnd) });
    expect(again.created).toBe(false);
    await runDaily().expect(201);
    expect(await models.Payout.count()).toBe(1);
    await h.drainEvents();
    expect(await codesOf(payee.user.id)).toContain('PAYOUT_SCHEDULED');
  });

  it('a payee with an open payout gets nothing new until it is settled; concurrent runs make one payout', async () => {
    await earn(10000);
    const windows = [new Date(Date.now() + 1000), new Date(Date.now() + 2000)];
    await Promise.all(windows.map((windowEnd) => payouts.buildBatch({ schedule: 'daily', windowEnd })));
    expect(await models.Payout.count()).toBe(1);
    await earn(20000);
    await runDaily().expect(201);
    expect(await models.Payout.count()).toBe(1); // still the first, open
    expect(await models.PayoutItem.count()).toBe(1);
  });

  it('skips amounts below the minimum and leaves them for later (FR-04)', async () => {
    await h.setSettingForTest('payouts.min_amount_poisha', 10000);
    await earn(5000); // net ৳47.50 < ৳100
    const run = await runDaily().expect(201);
    expect(run.body.batch.totals).toMatchObject({ payouts: 0, skipped: { below_minimum: 1 } });
    await earn(10000);
    await runDaily().expect(201);
    expect((await onlyPayout()).amountPoisha).toBe(4750 + 9500);
  });

  it('runs on the schedule in Asia/Dhaka (job payouts.schedule)', async () => {
    await earn(10000);
    const tomorrow10 = new Date(Date.now() + 86400000);
    const ten = new Date(Math.floor((tomorrow10.getTime() + 6 * 3600000) / 86400000) * 86400000 + 4 * 3600000); // 10:00 Dhaka = 04:00 UTC
    expect(await payouts.runDue(new Date(ten.getTime() - 60000))).toEqual({ built: 0, due: 0 }); // 09:59
    const r = await payouts.runDue(ten);
    expect(r.built).toBeGreaterThanOrEqual(1);
    expect(await payouts.runDue(ten)).toMatchObject({ built: 0 }); // same windows
    expect(await models.Payout.count()).toBe(1);
  });

  it('nets fees the payee owes (fee receivable) before paying out (FR-04, §6.2)', async () => {
    await verifiedAccount();
    await earn(10000);
    await models.sequelize.transaction((transaction) =>
      ledger.post(
        { kind: 'test.receivable', refType: 'test', refId: uuid7(), idempotencyKey: key('fr'), lines: [{ account: `fee_receivable:user:${payee.user.id}`, debit: 2000 }, { account: 'fee_revenue:ground', credit: 2000 }] },
        { transaction }
      )
    );
    await runDaily().expect(201);
    const p = await onlyPayout();
    expect(p).toMatchObject({ nettingPoisha: 2000, amountPoisha: 7500 });
    await release(master, p.id, 200);
    expect(await ledger.balance(`fee_receivable:user:${payee.user.id}`)).toBe(0);
    expect(await payable(payee.user.id)).toBe(0);
    expect(await ledger.balance('payout_clearing')).toBe(7500);
  });

  it('keeps esports prize money out of the scheduled runs (withdraw only, v3)', async () => {
    const groupRef = uuid7();
    const payments = require('../../src/modules/payments/payments.service');
    const escrow = require('../../src/modules/payments/escrow.service');
    const intent = await payments.createIntent({ purpose: 'esports_entry', purposeId: uuid7(), groupRef, payerId: payer.user.id, amount: 20000, title: 'Free Fire weekly', idempotencyKey: key('es') });
    await h.payWithSimulator(payer, intent.id);
    await escrow.settlePool({ groupRef, purpose: 'esports_entry', prizes: [{ payeeId: payee.user.id, amount: 15000 }] });
    expect(await payable(payee.user.id)).toBe(15000);
    expect((await runDaily().expect(201)).body.batch.totals.payouts).toBe(0);
  });
});

describe('release, reveal and paid (FR-07, FR-08)', () => {
  it('staff release with step-up, reveal the number (audited), mark paid; the ledger follows', async () => {
    await verifiedAccount();
    await earn(10000);
    await runDaily().expect(201);
    const p = await onlyPayout();
    const viewer = await staffWith(['view_payouts']);
    expect((await release(viewer, p.id, 403)).body.code).toBe('PERMISSION_REQUIRED');
    const clerk = await staffWith(['release_payouts']);
    const noStep = await api().post(`${P}/admin/payouts/${p.id}/release`).set(h.bearer(clerk)).set('Idempotency-Key', key()).expect(403);
    expect(noStep.body.code).toBe('STEP_UP_REQUIRED');
    expect((await reveal(clerk, p.id, 409)).body.code).toBe('PAYOUT_REVEAL_FORBIDDEN'); // not released yet

    const idem = key('rel');
    const r = await release(clerk, p.id, 200, idem);
    expect(r.body).toMatchObject({ status: 'processing', account: { masked: 'bKash ••• 5678' }, attempts: 1 });
    const replay = await release(clerk, p.id, 200, idem);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await payable(payee.user.id)).toBe(0);
    expect(await ledger.balance('payout_clearing')).toBe(9500);

    const shown = await reveal(clerk, p.id, 200);
    expect(shown.headers['cache-control']).toBe('no-store');
    expect(shown.body).toMatchObject({ number: WALLET, type: 'bkash', accountName: 'Nusrat Jahan', amount: 9500, showForSeconds: 60 });
    expect(await models.PayoutReveal.count({ where: { payoutId: p.id, staffId: clerk.userId } })).toBe(1);
    const audit = await models.AuditLog.findOne({ where: { action: 'payout.account_revealed' } });
    expect(audit).toMatchObject({ severity: 'critical', stepUp: true, actorId: clerk.userId });
    // The number is nowhere but in that one response: not in the audit, the idempotency store or other views.
    expect(JSON.stringify(await models.AuditLog.findAll())).not.toContain(WALLET);
    expect(JSON.stringify(await models.IdempotencyKey.findAll())).not.toContain(WALLET);
    const detail = await api().get(`${P}/admin/payouts/${p.id}`).set(h.bearer(viewer)).expect(200);
    expect(JSON.stringify(detail.body)).not.toContain(WALLET);
    expect(detail.body).toMatchObject({ reveals: 1, status: 'processing' });

    const paid = await markPaid(clerk, p.id).expect(200);
    expect(paid.body).toMatchObject({ status: 'paid', providerRef: 'BKX9TR2Q1' });
    expect((await markPaid(clerk, p.id).expect(409)).body.code).toBe('INVALID_STATE');
    expect(await ledger.balance('payout_clearing')).toBe(0);
    expect(await ledger.balance('platform_bank')).toBe(9500); // credit − debit: ৳95 left the bank
    const checks = await invariants.check({ publish: false });
    expect(checks.ok).toBe(true);
    expect(checks.checks.map((c) => c.name)).toContain('payout_clearing_matches');
    await h.drainEvents();
    expect(await codesOf(payee.user.id)).toContain('PAYOUT_PAID');
    expect(h.sms.lastTo(h.e164(payee.phone)).text).toContain('bKash ••• 5678');
    expect(h.sms.lastTo(h.e164(payee.phone)).text).toContain('BKX9TR2Q1');
  });

  it('cannot release without a verified account', async () => {
    await earn(10000);
    await runDaily().expect(201);
    const p = await onlyPayout();
    expect((await release(master, p.id, 409)).body.code).toBe('PAYOUT_ACCOUNT_REQUIRED');
    await addAccount(payee, {}, 201);
    expect((await release(master, p.id, 409)).body.code).toBe('PAYOUT_ACCOUNT_REQUIRED'); // pending is not enough
  });

  it('above the threshold: two different masters approve, each with step-up (FR-07, edge case 4)', async () => {
    await h.setSettingForTest('payouts.four_eyes_threshold_poisha', 5000);
    await verifiedAccount();
    await earn(10000);
    await runDaily().expect(201);
    const p = await onlyPayout();
    expect(p.status).toBe('needs_approval');
    await h.drainEvents();
    expect(await codesOf(master.userId)).toContain('PAYOUT_NEEDS_APPROVAL');

    const clerk = await staffWith(['release_payouts']);
    expect((await release(clerk, p.id, 409)).body.code).toBe('INVALID_STATE');
    expect((await approve(clerk, p.id, 403)).body.code).toBe('MASTER_REQUIRED');
    const one = await approve(master, p.id, 200);
    expect(one.body).toMatchObject({ status: 'needs_approval', approvals: [{ step: 1, by: master.userId }] });
    expect((await approve(master, p.id, 409)).body.code).toBe('SAME_APPROVER');
    const second = await h.createSecondMaster();
    const two = await approve(second, p.id, 200);
    expect(two.body).toMatchObject({ status: 'processing', approvals: [{ step: 1 }, { step: 2, by: second.userId }] });
    expect((await approve(second, p.id, 409)).body.code).toBe('INVALID_STATE');
    expect(await models.AuditLog.count({ where: { action: 'payout.approved' } })).toBe(2);
  });

  it('the master who placed or lifted the latest manual hold cannot approve it (§3)', async () => {
    await h.setSettingForTest('payouts.four_eyes_threshold_poisha', 5000);
    await verifiedAccount();
    await earn(10000);
    await runDaily().expect(201);
    const p = await onlyPayout();
    const held = await api().post(`${P}/admin/payouts/${p.id}/hold`).set(h.bearer(master)).send({ reason: 'Checking the bank details' }).expect(200);
    expect(held.body.status).toBe('on_hold');
    const holdId = held.body.holds.find((x) => x.type === 'manual').id;
    const lifted = await api().post(`${P}/admin/payouts/${p.id}/lift-hold`).set(h.bearer(master)).send({ holdId, reason: 'Checked' }).expect(200);
    expect(lifted.body.status).toBe('needs_approval');
    expect((await approve(master, p.id, 409)).body.code).toBe('HOLD_ACTOR_CANNOT_APPROVE');
  });
});

describe('holds (FR-06, FR-13, §6.4)', () => {
  it('a manual hold stops the release; lifting it puts the payout back', async () => {
    await verifiedAccount();
    await earn(10000);
    await runDaily().expect(201);
    const p = await onlyPayout();
    const held = await api().post(`${P}/admin/payouts/${p.id}/hold`).set(h.bearer(master)).send({ reason: 'Customer complaint', scope: 'payee' }).expect(200);
    expect(held.body.status).toBe('on_hold');
    expect((await release(master, p.id, 409)).body.code).toBe('INVALID_STATE');
    const holdId = held.body.holds[0].id;
    await h.drainEvents();
    expect(await codesOf(payee.user.id)).toContain('PAYOUT_HELD');
    const lifted = await api().post(`${P}/admin/payouts/${p.id}/lift-hold`).set(h.bearer(master)).send({ holdId, reason: 'Resolved' }).expect(200);
    expect(lifted.body.status).toBe('scheduled');
    await release(master, p.id, 200);
  });

  it('a risk freeze cannot be lifted here (FR-13); timed holds expire on their own', async () => {
    await verifiedAccount();
    await earn(10000);
    await runDaily().expect(201);
    const p = await onlyPayout();
    const { hold } = await models.sequelize.transaction((transaction) =>
      holds.place({ payeeId: payee.user.id, scope: 'payee', type: 'risk_freeze', refId: uuid7(), reason: 'M18 flag' }, null, { transaction })
    );
    expect((await onlyPayout()).status).toBe('on_hold');
    const res = await api().post(`${P}/admin/payouts/${p.id}/lift-hold`).set(h.bearer(master)).send({ holdId: hold.id, reason: 'Looks fine' }).expect(409);
    expect(res.body.code).toBe('RISK_HOLD_MANAGED_IN_RISK');
    // M18 clears it through the service (§2.4); placing the same hold twice is harmless.
    expect((await models.sequelize.transaction((transaction) => holds.place({ payeeId: payee.user.id, scope: 'payee', type: 'risk_freeze', refId: hold.refId }, null, { transaction }))).created).toBe(false);
    await holds.release(hold.id, { reason: 'Cleared in M18' }, null);
    expect((await onlyPayout()).status).toBe('scheduled');

    const timed = await models.sequelize.transaction((transaction) =>
      holds.place({ payeeId: payee.user.id, scope: 'payee', type: 'account_change', refId: uuid7(), until: new Date(Date.now() + 3600000) }, null, { transaction })
    );
    expect((await onlyPayout()).status).toBe('on_hold');
    expect((await api().post(`${P}/admin/payouts/${p.id}/lift-hold`).set(h.bearer(master)).send({ holdId: timed.hold.id, reason: 'Early' }).expect(409)).body.code).toBe('HOLD_NOT_LIFTABLE');
    expect(await holds.expireDue()).toEqual({ lifted: 0 });
    expect(await holds.expireDue(new Date(Date.now() + 2 * 3600000))).toEqual({ lifted: 1 });
    expect((await onlyPayout()).status).toBe('scheduled');
  });

  it('a dispute on one source keeps only its items out of the run (FR-14)', async () => {
    await verifiedAccount();
    const a = await earn(10000);
    await earn(20000);
    await models.sequelize.transaction((transaction) =>
      holds.place({ payeeId: payee.user.id, scope: 'item_source', type: 'dispute', sourceType: 'escrow_hold', sourceId: a.hold.id, refId: uuid7() }, null, { transaction })
    );
    await runDaily().expect(201);
    expect((await onlyPayout()).amountPoisha).toBe(19000);
  });

  it('a suspended account holds payouts until it is restored (edge case 10)', async () => {
    await verifiedAccount();
    await earn(10000);
    await runDaily().expect(201);
    const sanctionId = uuid7();
    await models.sequelize.transaction((t) => events.publish(t, { name: 'user.suspended', aggregateType: 'user', aggregateId: payee.user.id, payload: { userId: payee.user.id, sanctionId, until: null } }));
    await h.drainEvents();
    expect((await onlyPayout()).status).toBe('on_hold');
    await models.sequelize.transaction((t) => events.publish(t, { name: 'user.restored', aggregateType: 'user', aggregateId: payee.user.id, payload: { userId: payee.user.id } }));
    await h.drainEvents();
    expect((await onlyPayout()).status).toBe('scheduled');
  });
});

describe('failures, retries and cancel (FR-10)', () => {
  it('a failed send returns the money; a permanent failure needs a new account, after its change hold', async () => {
    await verifiedAccount();
    await earn(10000);
    await runDaily().expect(201);
    const p = await onlyPayout();
    await release(master, p.id, 200);
    const failed = await api().post(`${P}/admin/payouts/${p.id}/mark-failed`).set(h.bearer(master)).send({ reason: 'invalid_wallet', note: 'bKash says the wallet does not exist' }).expect(200);
    expect(failed.body).toMatchObject({ status: 'failed', failureCode: 'invalid_wallet' });
    expect(await payable(payee.user.id)).toBe(9500);
    expect(await ledger.balance('payout_clearing')).toBe(0);
    await h.drainEvents();
    expect(await codesOf(payee.user.id)).toContain('PAYOUT_FAILED');

    const retry = (status) => stepped(master, `/admin/payouts/${p.id}/retry`, status);
    expect((await retry(409)).body.code).toBe('PAYOUT_ACCOUNT_UPDATE_REQUIRED');
    const fresh = await addAccount(payee, { accountNo: '01912345678' }, 201);
    await verifyAccount(master, fresh.body.id).expect(200);
    expect((await retry(409)).body.code).toBe('PAYOUT_ON_HOLD'); // the 48 h change hold
    await holds.expireDue(new Date(Date.now() + 49 * 3600000));
    const again = await retry(200);
    expect(again.body).toMatchObject({ status: 'processing', attempts: 2, account: { masked: 'bKash ••• 5678' } });
    expect(again.body.account.id).toBe(fresh.body.id);
    await markPaid(master, p.id, 'BKRETRY01').expect(200);
    expect((await invariants.check({ publish: false })).ok).toBe(true);
  });

  it('cancel returns the lines to the next run', async () => {
    await earn(10000);
    await runDaily().expect(201);
    const p = await onlyPayout();
    await api().post(`${P}/admin/payouts/${p.id}/cancel`).set(h.bearer(master)).send({ reason: 'Wrong period' }).expect(200);
    expect((await api().post(`${P}/admin/payouts/${p.id}/cancel`).set(h.bearer(master)).send({ reason: 'Again' }).expect(409)).body.code).toBe('INVALID_STATE');
    await runDaily().expect(201);
    const next = await onlyPayout();
    expect(next.id).not.toBe(p.id);
    expect(next.amountPoisha).toBe(9500);
  });
});

describe('refund payouts (FR-15, M06 manual_required)', () => {
  it('pays a refund the gateway refused to the payer’s verified account, then closes the refund', async () => {
    const r = await api().post(`${P}/admin/payments/test-charges`).set(h.bearer(master)).set('Idempotency-Key', key('tc')).send({ payerId: payer.user.id, payeeId: payee.user.id, amount: 4000 }).expect(201);
    await h.payWithSimulator(payer, r.body.payment.id);
    await h.simulator.failNextRefunds(3);
    const rf = await api().post(`${P}/admin/refunds`).set(h.bearer(master)).set('Idempotency-Key', key('rf')).send({ paymentId: r.body.payment.id, amount: 4000, reasonCode: 'customer_request' }).expect(201);
    await h.drainPaymentJobs();
    await h.drainEvents();
    const p = await onlyPayout(payer.user.id);
    expect(p).toMatchObject({ kind: 'refund', refundId: rf.body.id, amountPoisha: 4000, status: 'scheduled', nettingPoisha: 0 });
    await h.drainEvents();
    expect(await models.Payout.count({ where: { refundId: rf.body.id } })).toBe(1); // once

    expect((await release(master, p.id, 409)).body.code).toBe('PAYOUT_ACCOUNT_REQUIRED');
    await verifiedAccount(payer, { accountName: 'Fahim Rahman', accountNo: '01612345678' });
    await release(master, p.id, 200);
    expect(await ledger.balance('refund_clearing')).toBe(0);
    expect(await ledger.balance('payout_clearing')).toBe(4000);
    expect((await api().post(`${P}/admin/payouts/${p.id}/cancel`).set(h.bearer(master)).send({ reason: 'Not needed' }).expect(409)).body.code).toBe('INVALID_STATE');
    await markPaid(master, p.id, 'NGD77310').expect(200);
    expect(await models.Refund.findByPk(rf.body.id)).toMatchObject({ status: 'succeeded' });
    expect((await models.Payment.findByPk(r.body.payment.id)).status).toBe('refunded');
    expect((await invariants.check({ publish: false })).ok).toBe(true);
  });
});

describe('payee views (FR-16, §4.2) and the desk lists', () => {
  it('summary projects the next payout with the batch calculation; lists, detail and the CSV statement', async () => {
    await verifiedAccount();
    await earn(10000);
    const before = await api().get(`${P}/me/payouts/summary`).set(h.bearer(payee)).expect(200);
    expect(before.body).toMatchObject({ nextPayout: { projected: 9500, minimum: 1000 }, inPayouts: 0, account: { masked: 'bKash ••• 5678' }, feesOwed: 0 });
    expect(before.body.nextPayout.date).not.toBeNull();

    await runDaily().expect(201);
    const p = await onlyPayout();
    await release(master, p.id, 200);
    await markPaid(master, p.id).expect(200);
    const after = await api().get(`${P}/me/payouts/summary`).set(h.bearer(payee)).expect(200);
    expect(after.body).toMatchObject({ nextPayout: { projected: 0 }, paidThisMonth: 9500 });

    const list = await api().get(`${P}/me/payouts`).set(h.bearer(payee)).expect(200);
    expect(list.body.items.map((x) => [x.code, x.status, x.amount])).toEqual([[p.code, 'paid', 9500]]);
    const one = await api().get(`${P}/me/payouts/${p.id}`).set(h.bearer(payee)).expect(200);
    expect(one.body.items).toHaveLength(1);
    expect(one.body.reveals).toBeUndefined();
    await api().get(`${P}/me/payouts/${p.id}`).set(h.bearer(payer)).expect(404);

    const csv = await api().get(`${P}/me/payouts/${p.id}/statement.csv?locale=bn`).set(h.bearer(payee)).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain(p.code);
    expect(csv.text).toContain('"95.00"');
    expect(csv.text).toContain('পরিশোধিত');
    expect(csv.text).not.toContain(WALLET);

    const desk = await api().get(`${P}/admin/payouts?status=paid`).set(h.bearer(master)).expect(200);
    expect(desk.body.items.map((x) => x.payee.name)).toEqual(['Nusrat Jahan']);
    expect(desk.body.counts).toMatchObject({ paid: 1 });
    const batches = await api().get(`${P}/admin/payout-batches`).set(h.bearer(master)).expect(200);
    expect(batches.body.items[0]).toMatchObject({ schedule: 'daily', totals: { payouts: 1 } });
    const viewer = await staffWith(['view_payouts']);
    expect((await runDaily(viewer).expect(403)).body.code).toBe('MASTER_REQUIRED');
  });
});
