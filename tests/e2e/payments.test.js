'use strict';

// M06 payments: intents, attempts, server-side verification, IPN, return, expiry and polling, through
// the SSLCommerz simulator (M06-FR-01 to FR-07, §8 payment states, §12 edge cases 1–4).
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const config = require('../../src/config');
const ledger = require('../../src/modules/payments/ledger.service');
const payments = require('../../src/modules/payments/payments.service');

const { api, P, models } = h;

let master;
let payer;
let payee;

beforeAll(async () => {
  await h.resetDb();
});
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  payer = await h.signupUser({ name: 'Fahim Rahman' });
  payee = await h.signupUser({ name: 'Nusrat Jahan' });
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

let keySeq = 0;
const key = (prefix = 'k') => `${prefix}-${Date.now()}-${(keySeq += 1)}`;

/** The supertest request (chain .expect on it). */
function testCharge(amount = 10000, { idem = key('tc'), payerId = payer.user.id, payeeId = payee.user.id } = {}) {
  return api().post(`${P}/admin/payments/test-charges`).set(h.bearer(master)).set('Idempotency-Key', idem).send({ payerId, payeeId, amount, title: 'Phase 2 test charge' });
}
const charge = async (amount) => (await testCharge(amount).expect(201)).body.payment;
const notificationsOf = (userId) => models.Notification.findAll({ where: { userId }, order: [['createdAt', 'ASC']] });
const txnCount = (kind) => models.LedgerTransaction.count({ where: { kind } });

describe('test charges and intents (FR-01, FR-07)', () => {
  it('creates a payment with a code, an expiry and the fee snapshotted at creation', async () => {
    const r = await testCharge(10000).expect(201);
    expect(r.body.payment).toMatchObject({ amount: 10000, status: 'initiated', purpose: 'test_charge', title: 'Phase 2 test charge', captured: 0, refunded: 0 });
    expect(r.body.payment.code).toMatch(/^PAY-\d{2}-000001$/);
    expect(r.body.payUrl).toBe(`${config.apps.web}/pay/${r.body.payment.id}`);
    const row = await models.Payment.findByPk(r.body.payment.id);
    expect(row.escrow).toMatchObject({ payeeId: payee.user.id, releaseRule: { type: 'manual' }, fee: { feeBps: 500, settingKey: 'payments.test_charge_fee_pct', settingsVersion: 1 } });
    expect(new Date(row.expiresAt) - new Date(row.createdAt)).toBeGreaterThanOrEqual(10 * 60000 - 1000);
    const second = await charge(5000);
    expect(second.code).toMatch(/-000002$/);
    const log = await models.AuditLog.findOne({ where: { action: 'payment.test_charge_created' } });
    expect(log).toMatchObject({ entityCode: r.body.payment.code });
  });

  it('replays the same Idempotency-Key and refuses it for a different body', async () => {
    const idem = key('same');
    const a = await testCharge(10000, { idem }).expect(201);
    const b = await testCharge(10000, { idem }).expect(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.payment.id).toBe(a.body.payment.id);
    expect((await testCharge(9000, { idem }).expect(422)).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const none = await api().post(`${P}/admin/payments/test-charges`).set(h.bearer(master)).send({ payerId: payer.user.id, payeeId: payee.user.id, amount: 100 }).expect(400);
    expect(none.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const bad = await api().post(`${P}/admin/payments/test-charges`).set(h.bearer(master)).set('Idempotency-Key', 'no').send({ payerId: payer.user.id, payeeId: payee.user.id, amount: 100 }).expect(400);
    expect(bad.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(await models.Payment.count()).toBe(1);
  });

  it('refuses staff payers, unknown payees, too much, and environments without test charges', async () => {
    expect((await testCharge(100, { payerId: master.userId }).expect(422)).body.code).toBe('PAYER_INVALID');
    expect((await testCharge(100, { payeeId: '0190a0b1-0000-7000-8000-000000000001' }).expect(422)).body.code).toBe('PAYEE_INVALID');
    expect((await testCharge(100001).expect(422)).body.code).toBe('TEST_CHARGE_TOO_LARGE');
    config.payments.testCharges = false;
    try {
      expect((await testCharge(100).expect(403)).body.code).toBe('TEST_CHARGES_DISABLED');
    } finally {
      config.payments.testCharges = true;
    }
    const cfg = await api().get(`${P}/admin/payments/config`).set(h.bearer(master)).expect(200);
    expect(cfg.body).toEqual({ testCharges: true, simulator: true, provider: 'sslcommerz', testChargeMax: 100000 });
  });

  it('createIntent is idempotent per payer and key, and checks its input', async () => {
    const base = { purpose: 'test_charge', purposeId: '0190a0b1-0000-7000-8000-0000000000aa', payerId: payer.user.id, payeeId: payee.user.id, amount: 500, title: 'x', idempotencyKey: 'svc-1' };
    const a = await payments.createIntent(base);
    expect((await payments.createIntent(base)).id).toBe(a.id);
    await expect(payments.createIntent({ ...base, amount: 600 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(payments.createIntent({ ...base, amount: 0, idempotencyKey: 'svc-2' })).rejects.toMatchObject({ code: 'AMOUNT_INVALID' });
    await expect(payments.createIntent({ ...base, payeeId: null, idempotencyKey: 'svc-3' })).rejects.toThrow(/needs a payee/);
    await expect(payments.createIntent({ ...base, purpose: 'nope', idempotencyKey: 'svc-4' })).rejects.toThrow(/Unknown payment purpose/);
  });
});

describe('paying through the gateway (FR-02 to FR-06)', () => {
  it('captures into escrow: IPN verified by the validation API, ledger posted, payer notified', async () => {
    const p = await charge(10000);
    const other = await h.signupUser();
    await api().get(`${P}/payments/${p.id}`).set(h.bearer(other)).expect(404);
    const view = await api().get(`${P}/payments/${p.id}`).set(h.bearer(payer)).expect(200);
    expect(view.body).toMatchObject({ status: 'initiated', methods: ['bkash', 'nagad', 'card'] });

    const { attempt, returnTo } = await h.payWithSimulator(payer, p.id, { method: 'bkash' });
    expect(attempt.redirectUrl).toMatch(/^http:\/\/api\.test\/dev\/sslcommerz\/pay\/SIM/);
    expect(returnTo).toBe(`${config.apps.web}/pay/${p.id}/result`);

    const after = await api().get(`${P}/payments/${p.id}`).set(h.bearer(payer)).expect(200);
    expect(after.body).toMatchObject({ status: 'succeeded', captured: 10000, method: 'bkash', methodDisplay: 'bKash ••• 4321' });
    const hold = await models.EscrowHold.findOne({ where: { paymentId: p.id } });
    expect(hold).toMatchObject({ status: 'holding', heldPoisha: 10000, payeeId: payee.user.id, feeBps: 500, vertical: 'test' });
    expect(await ledger.balance('escrow:test_charge')).toBe(10000);
    expect(await ledger.balance('provider_clearing:sslcommerz')).toBe(-10000); // an asset: debit balance
    expect(await txnCount('payment.capture')).toBe(1);
    expect(await models.ProviderWebhookEvent.count({ where: { signatureOk: true, result: 'paid' } })).toBe(1);
    // The stored IPN keeps no customer contact details.
    const raw = (await models.ProviderWebhookEvent.findOne()).raw;
    expect(Object.keys(raw)).not.toEqual(expect.arrayContaining(['card_no']));
    expect(raw).toMatchObject({ status: 'VALID', tran_id: attempt.attemptId });

    const names = h.events.recorded().map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['payment.succeeded', 'escrow.held', 'ledger.transaction_posted']));
    await h.drainEvents();
    const [n] = await notificationsOf(payer.user.id);
    expect(n).toMatchObject({ code: 'PAY_SUCCEEDED', category: 'money', title: 'Payment received', link: '/me/payments' });
    expect(n.body).toBe(`৳100 paid for Phase 2 test charge. Ref ${p.code}.`);
    expect(h.sms.lastTo(h.e164(payer.phone)).text).toContain('৳100 paid for Phase 2 test charge');

    // A paid payment cannot be paid again.
    const again = await api().post(`${P}/payments/${p.id}/attempts`).set(h.bearer(payer)).set('Idempotency-Key', key()).send({ method: 'card' }).expect(409);
    expect(again.body.code).toBe('PAYMENT_ALREADY_SUCCEEDED');
  });

  it('a replayed IPN is a no-op, and IPN racing the return captures once (FR-04, §12 #1)', async () => {
    const p = await charge(8000);
    let ipn;
    h.simulator.setIpnSender((_url, body) => {
      ipn = body;
    });
    try {
      const a = await api().post(`${P}/payments/${p.id}/attempts`).set(h.bearer(payer)).set('Idempotency-Key', key()).send({ method: 'card' }).expect(201);
      const back = new URL(await h.simulator.pay(a.body.redirectUrl.split('/').pop(), 'success'));
      const [ret, hook] = await Promise.all([
        api().get(`${P}/payments/return/sslcommerz${back.search}`),
        api().post(`${P}/webhooks/sslcommerz`).type('form').send(ipn),
      ]);
      expect(ret.status).toBe(303);
      expect(hook.status).toBe(200);
      const replay = await api().post(`${P}/webhooks/sslcommerz`).type('form').send(ipn).expect(200);
      expect(replay.body).toEqual({ result: 'duplicate' });
    } finally {
      h.simulator.setIpnSender((_url, body) => api().post(`${P}/webhooks/sslcommerz`).type('form').send(body).then((r) => r.status));
    }
    expect(await txnCount('payment.capture')).toBe(1);
    expect(await models.EscrowHold.count()).toBe(1);
    expect((await models.Payment.findByPk(p.id)).methodDisplay).toBe('Card ••• 0667');
  });

  it('refuses an IPN with a bad signature and changes nothing', async () => {
    const p = await charge(5000);
    let ipn;
    h.simulator.setIpnSender((_url, body) => {
      ipn = body;
    });
    try {
      const a = await api().post(`${P}/payments/${p.id}/attempts`).set(h.bearer(payer)).set('Idempotency-Key', key()).send({ method: 'nagad' }).expect(201);
      await h.simulator.pay(a.body.redirectUrl.split('/').pop(), 'success');
    } finally {
      h.simulator.setIpnSender((_url, body) => api().post(`${P}/webhooks/sslcommerz`).type('form').send(body).then((r) => r.status));
    }
    const forged = await api().post(`${P}/webhooks/sslcommerz`).type('form').send({ ...ipn, amount: '1.00' }).expect(401);
    expect(forged.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(await models.ProviderWebhookEvent.findOne({ where: { signatureOk: false } })).toMatchObject({ result: 'bad_signature' });
    expect((await models.Payment.findByPk(p.id)).status).toBe('pending');
    // An IPN for a transaction we never started is stored and acknowledged.
    const unknown = await api().post(`${P}/webhooks/sslcommerz`).type('form').send({ tran_id: 'nope', status: 'FAILED' }).expect(401);
    expect(unknown.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('with no IPN the return verifies; with neither, polling captures (FR-03, §10)', async () => {
    const p = await charge(4000);
    await h.payWithSimulator(payer, p.id, { outcome: 'success_no_ipn' });
    expect((await models.Payment.findByPk(p.id)).status).toBe('succeeded');
    expect(await models.ProviderWebhookEvent.count()).toBe(0);

    const q = await charge(4000);
    const a = await api().post(`${P}/payments/${q.id}/attempts`).set(h.bearer(payer)).set('Idempotency-Key', key()).send({ method: 'bkash' }).expect(201);
    await h.simulator.pay(a.body.redirectUrl.split('/').pop(), 'success_no_ipn');
    expect((await models.Payment.findByPk(q.id)).status).toBe('pending');
    const polls = await h.drainPaymentJobs();
    expect(polls.map((j) => j.name)).toEqual(expect.arrayContaining(['payments.poll-attempt']));
    expect((await models.Payment.findByPk(q.id)).status).toBe('succeeded');
    // The payer's result page can also ask: verify returns the server's answer.
    const v = await api().post(`${P}/payments/${q.id}/verify`).set(h.bearer(payer)).expect(200);
    expect(v.body.status).toBe('succeeded');
  });

  it('a declined or cancelled attempt fails the payment; a new attempt can still pay it', async () => {
    const p = await charge(3000);
    await h.payWithSimulator(payer, p.id, { outcome: 'fail' });
    expect((await models.Payment.findByPk(p.id)).status).toBe('failed');
    await h.drainEvents();
    expect((await notificationsOf(payer.user.id)).map((n) => n.code)).toEqual(['PAY_FAILED']);

    await h.payWithSimulator(payer, p.id, { outcome: 'cancel' });
    expect((await models.Payment.findByPk(p.id)).status).toBe('failed');
    await h.payWithSimulator(payer, p.id, { method: 'card' });
    const row = await models.Payment.findByPk(p.id, { include: ['attempts'] });
    expect(row.status).toBe('succeeded');
    expect(row.attempts.map((x) => x.status).sort()).toEqual(['cancelled', 'failed', 'succeeded']);
  });

  it('a new attempt replaces an unfinished one (one in flight, FR-02)', async () => {
    const p = await charge(3000);
    const a1 = await api().post(`${P}/payments/${p.id}/attempts`).set(h.bearer(payer)).set('Idempotency-Key', key()).send({ method: 'bkash' }).expect(201);
    const a2 = await api().post(`${P}/payments/${p.id}/attempts`).set(h.bearer(payer)).set('Idempotency-Key', key()).send({ method: 'card' }).expect(201);
    const rows = await models.PaymentAttempt.findAll({ where: { paymentId: p.id } });
    expect(rows.find((r) => r.id === a1.body.attemptId).status).toBe('cancelled');
    expect(rows.find((r) => r.id === a2.body.attemptId).status).toBe('in_flight');
    // If the replaced attempt is paid after all, its IPN still captures.
    await h.simulator.pay(a1.body.redirectUrl.split('/').pop(), 'success');
    expect((await models.Payment.findByPk(p.id)).status).toBe('succeeded');
  });

  it('wrong amount: never succeeds, money waits in suspense and is refunded in full (§12 #3)', async () => {
    const p = await charge(10000);
    await h.payWithSimulator(payer, p.id, { outcome: 'wrong_amount' });
    const row = await models.Payment.findByPk(p.id);
    expect(row).toMatchObject({ status: 'failed', capturedPoisha: 9900 });
    expect(await models.EscrowHold.count()).toBe(0);
    const refund = await models.Refund.findOne({ where: { paymentId: p.id } });
    expect(refund).toMatchObject({ kind: 'amount_mismatch', source: 'suspense', status: 'approved', amountPoisha: 9900, initiatorKind: 'system' });
    await h.drainPaymentJobs();
    expect((await refund.reload()).status).toBe('succeeded');
    expect((await row.reload()).toJSON()).toMatchObject({ status: 'failed', refundedPoisha: 9900 });
    for (const code of ['suspense', 'refund_clearing', 'provider_clearing:sslcommerz']) expect(await ledger.balance(code)).toBe(0);
  });

  it('late capture: accepted by the gateway after expiry, refunded automatically (FR-05, §12 #2)', async () => {
    const p = await charge(6000);
    const a = await api().post(`${P}/payments/${p.id}/attempts`).set(h.bearer(payer)).set('Idempotency-Key', key()).send({ method: 'bkash' }).expect(201);
    await models.Payment.update({ expiresAt: new Date(Date.now() - 60 * 60000) }, { where: { id: p.id } });
    await h.simulator.pay(a.body.redirectUrl.split('/').pop(), 'success');
    const succeeded = h.events.recorded().find((e) => e.name === 'payment.succeeded');
    expect(succeeded.payload).toMatchObject({ late: true, accepted: false });
    expect(await models.Refund.findOne({ where: { paymentId: p.id } })).toMatchObject({ kind: 'late_capture', status: 'approved', amountPoisha: 6000 });
    await h.drainPaymentJobs();
    expect(await models.Payment.findByPk(p.id)).toMatchObject({ status: 'refunded', refundedPoisha: 6000 });
    expect(await models.EscrowHold.findOne({ where: { paymentId: p.id } })).toMatchObject({ status: 'refunded', refundedPoisha: 6000 });
    await h.drainEvents();
    // No "payment received" for a rejected capture: the payer hears about the refund.
    expect((await notificationsOf(payer.user.id)).map((n) => n.code)).toEqual(['REFUND_INITIATED', 'REFUND_SUCCEEDED']);
  });

  it('expires unpaid intents, but asks the gateway first (§10 payments.expire-intents)', async () => {
    const idle = await charge(1000);
    const paidLate = await charge(2000);
    const a = await api().post(`${P}/payments/${paidLate.id}/attempts`).set(h.bearer(payer)).set('Idempotency-Key', key()).send({ method: 'bkash' }).expect(201);
    await h.simulator.pay(a.body.redirectUrl.split('/').pop(), 'success_no_ipn');
    const past = new Date(Date.now() - 60 * 60000);
    await models.Payment.update({ expiresAt: past }, { where: { id: [idle.id, paidLate.id] } });

    const res = await payments.expireIntents();
    expect(res).toEqual({ due: 2, expired: 1 });
    expect((await models.Payment.findByPk(idle.id)).status).toBe('expired');
    expect((await models.Payment.findByPk(paidLate.id)).status).toBe('succeeded'); // captured, then refunded as late
    expect(h.events.recorded().filter((e) => e.name === 'payment.expired')).toHaveLength(1);
    const expired = await api().post(`${P}/payments/${idle.id}/attempts`).set(h.bearer(payer)).set('Idempotency-Key', key()).send({ method: 'bkash' }).expect(410);
    expect(expired.body.code).toBe('PAYMENT_EXPIRED');
    expect(await payments.expireIntents()).toEqual({ due: 0, expired: 0 });
  });

  it('reports the gateway as unavailable when it refuses a session', async () => {
    const p = await charge(1000);
    const adapter = require('../../src/providers/payments/sslcommerz');
    adapter.setTransport({ ...h.simulator.transport, postForm: async () => ({ status: 'FAILED', failedreason: 'Store Credential Error Or Store is De-active' }) });
    try {
      const r = await api().post(`${P}/payments/${p.id}/attempts`).set(h.bearer(payer)).set('Idempotency-Key', key()).send({ method: 'bkash' }).expect(503);
      expect(r.body.code).toBe('PROVIDER_UNAVAILABLE');
    } finally {
      adapter.setTransport(h.simulator.transport);
    }
    expect((await models.PaymentAttempt.findOne({ where: { paymentId: p.id } })).failureCode).toBe('PROVIDER_REFUSED');
  });
});

describe('payer and finance views', () => {
  it('lists my payments with refunds, and gives finance the full picture', async () => {
    const p = await charge(10000);
    await h.payWithSimulator(payer, p.id);
    await charge(500);
    const mine = await api().get(`${P}/me/payments`).set(h.bearer(payer)).expect(200);
    expect(mine.body.items.map((x) => x.amount)).toEqual([500, 10000]);
    const page = await api().get(`${P}/me/payments?limit=1`).set(h.bearer(payer)).expect(200);
    expect(page.body.nextCursor).toBeTruthy();
    expect((await api().get(`${P}/me/payments?cursor=${page.body.nextCursor}`).set(h.bearer(payer)).expect(200)).body.items).toHaveLength(1);

    const list = await api().get(`${P}/admin/payments?status=succeeded`).set(h.bearer(master)).expect(200);
    expect(list.body.items).toEqual([expect.objectContaining({ id: p.id, payer: { id: payer.user.id, name: 'Fahim Rahman' }, payee: { id: payee.user.id, name: 'Nusrat Jahan' } })]);
    expect((await api().get(`${P}/admin/payments?code=${p.code.toLowerCase()}`).set(h.bearer(master)).expect(200)).body.items).toHaveLength(1);
    const detail = await api().get(`${P}/admin/payments/${p.id}`).set(h.bearer(master)).expect(200);
    expect(detail.body.attempts).toEqual([expect.objectContaining({ status: 'succeeded', method: 'bkash' })]);
    expect(detail.body.hold).toMatchObject({ status: 'holding', available: 10000 });
    expect(detail.body.ledger.map((t) => t.kind)).toEqual(['payment.capture']);
    expect(await payments.getRefundable(p.id)).toBe(10000);
    await api().get(`${P}/admin/payments/0190a0b1-0000-7000-8000-000000000009`).set(h.bearer(master)).expect(404);
  });
});
