'use strict';

// M06 money after capture: refunds (FR-08, FR-09, FR-10), escrow release, freeze and pool settlement
// (FR-13, FR-14, M21 §6.5), the ledger's database guards (FR-11, FR-12), invariants (FR-19),
// reconciliation (FR-18), the permission matrix and concurrency (no double-spend).
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const ledger = require('../../src/modules/payments/ledger.service');
const payments = require('../../src/modules/payments/payments.service');
const escrow = require('../../src/modules/payments/escrow.service');
const invariants = require('../../src/modules/payments/invariants.service');
const reconciliation = require('../../src/modules/payments/reconciliation.service');
const { uuid7 } = require('../../src/common/uuid7');

const { api, P, models } = h;

let master;
let payer;
let payee;

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

let seq = 0;
const key = (p = 'k') => `${p}-${Date.now()}-${(seq += 1)}`;
const notificationsOf = (userId) => models.Notification.findAll({ where: { userId }, order: [['createdAt', 'ASC']] });

async function paidCharge(amount = 10000) {
  const r = await api().post(`${P}/admin/payments/test-charges`).set(h.bearer(master)).set('Idempotency-Key', key('tc')).send({ payerId: payer.user.id, payeeId: payee.user.id, amount }).expect(201);
  await h.payWithSimulator(payer, r.body.payment.id);
  const p = await models.Payment.findByPk(r.body.payment.id);
  expect(p.status).toBe('succeeded');
  return { payment: p, hold: await models.EscrowHold.findOne({ where: { paymentId: p.id } }) };
}

let emp = 0;
async function staffWith(permissions) {
  emp += 1;
  const member = await h.signupUser({ name: 'Tanvir Ahmed' });
  const token = await h.stepUp(master, 'staff.write');
  await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: member.user.id, employeeId: `KG-F-${emp}`, permissions }).expect(201);
  return h.signInStaff(member.phone, member.user.id);
}

const refund = (who, body, idem = key('rf')) => api().post(`${P}/admin/refunds`).set(h.bearer(who)).set('Idempotency-Key', idem).send(body);

describe('refunds (FR-08, FR-09, FR-10)', () => {
  it('staff within the limit: approved, sent to the gateway, confirmed, ledger cleared', async () => {
    const { payment, hold } = await paidCharge(10000);
    const clerk = await staffWith(['refund_small']);
    const r = await refund(clerk, { paymentId: payment.id, amount: 3000, reasonCode: 'customer_request', reasonText: 'Changed plans' }).expect(201);
    expect(r.body).toMatchObject({ status: 'approved', source: 'escrow', kind: 'manual', initiatorKind: 'staff', amount: 3000 });
    expect(await ledger.balance('refund_clearing')).toBe(3000);
    expect((await hold.reload()).refundedPoisha).toBe(3000);

    const ran = await h.drainPaymentJobs();
    expect(ran.filter((j) => j.name === 'refunds.process').map((j) => j.result.status)).toEqual(['processing', 'processing', 'succeeded']);
    expect(await models.Refund.findByPk(r.body.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(await payment.reload()).toMatchObject({ status: 'partially_refunded', refundedPoisha: 3000 });
    expect(await ledger.balance('refund_clearing')).toBe(0);
    expect(await ledger.balance('escrow:test_charge')).toBe(7000);
    expect(await ledger.balance('provider_clearing:sslcommerz')).toBe(-7000);

    await h.drainEvents();
    expect((await notificationsOf(payer.user.id)).map((n) => n.code)).toEqual(['PAY_SUCCEEDED', 'REFUND_INITIATED', 'REFUND_SUCCEEDED']);
    expect((await notificationsOf(payer.user.id))[2].body).toBe('৳30 refunded to bKash ••• 4321.');
    expect(await models.AuditLog.findOne({ where: { action: 'refund.requested' } })).toMatchObject({ entityCode: payment.code });

    // The same key replays; Σ refunds can never pass the capture.
    const replay = await refund(clerk, { paymentId: payment.id, amount: 3000, reasonCode: 'customer_request', reasonText: 'Changed plans' }, r.headers['x-request-id']).expect(201);
    expect(replay.body.id).not.toBe(r.body.id); // a different key is a new refund…
    const over = await refund(master, { paymentId: payment.id, amount: 5000, reasonCode: 'customer_request' }).expect(422);
    expect(over.body).toMatchObject({ code: 'REFUND_EXCEEDS_CAPTURED', refundable: 4000 });
  });

  it('escalates above the staff limit, per refund and per payment; a master approves with step-up', async () => {
    await h.setSettingForTest('refunds.staff_limit_poisha', 2000);
    const { payment } = await paidCharge(10000);
    const clerk = await staffWith(['refund_small']);
    await refund(clerk, { paymentId: payment.id, amount: 1500, reasonCode: 'customer_request' }).expect(201);
    const second = await refund(clerk, { paymentId: payment.id, amount: 1000, reasonCode: 'customer_request', reasonText: 'Second leg' }).expect(202);
    expect(second.body).toMatchObject({ status: 'pending_master', recommended: 1000 });
    const big = await refund(clerk, { paymentId: payment.id, amount: 2500, reasonCode: 'dispute_upheld' }).expect(202);
    expect(h.events.recorded().filter((e) => e.name === 'refund.escalated')).toHaveLength(2);

    await h.drainEvents();
    const [esc] = await notificationsOf(master.userId);
    expect(esc).toMatchObject({ code: 'REFUND_ESCALATED', title: 'Refund waiting for approval' });
    expect(esc.body).toBe(`Tanvir Ahmed asks to refund ৳10 on ${payment.code} (Second leg).`);

    const queue = await api().get(`${P}/admin/refunds?status=pending_master`).set(h.bearer(master)).expect(200);
    expect(queue.body.items.map((x) => x.amount).sort()).toEqual([1000, 2500]);
    expect(queue.body.items[0].payment.code).toBe(payment.code);

    const noStep = await api().post(`${P}/admin/refunds/${second.body.id}/approve`).set(h.bearer(master)).send({}).expect(403);
    expect(noStep.body.code).toBe('STEP_UP_REQUIRED');
    await api().post(`${P}/admin/refunds/${second.body.id}/approve`).set(h.bearer(clerk)).set('X-Step-Up', 'x').send({}).expect(403);
    const ok = await api().post(`${P}/admin/refunds/${second.body.id}/approve`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'refund.large')).send({ note: 'Agreed' }).expect(200);
    expect(ok.body).toMatchObject({ status: 'approved', approvedBy: master.userId, decisionNote: 'Agreed' });
    const rej = await api().post(`${P}/admin/refunds/${big.body.id}/reject`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'refund.large')).send({ note: 'Not upheld' }).expect(200);
    expect(rej.body.status).toBe('rejected');
    const again = await api().post(`${P}/admin/refunds/${big.body.id}/approve`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'refund.large')).send({}).expect(409);
    expect(again.body.code).toBe('REFUND_NOT_PENDING');
    expect(await models.AuditLog.count({ where: { action: ['refund.approved', 'refund.rejected'] } })).toBe(2);

    // A master above the limit confirms with step-up.
    const masterNoStep = await refund(master, { paymentId: payment.id, amount: 2100, reasonCode: 'goodwill_gesture' }).expect(403);
    expect(masterNoStep.body.code).toBe('STEP_UP_REQUIRED');
    const masterOk = await api().post(`${P}/admin/refunds`).set(h.bearer(master)).set('Idempotency-Key', key()).set('X-Step-Up', await h.stepUp(master, 'refund.large')).send({ paymentId: payment.id, amount: 2100, reasonCode: 'goodwill_gesture' }).expect(201);
    expect(masterOk.body).toMatchObject({ status: 'approved', initiatorKind: 'master' });
  });

  it('after release only a master can refund, as goodwill; frozen holds refuse refunds', async () => {
    const { payment, hold } = await paidCharge(10000);
    await escrow.releaseManually({ id: master.userId, isMaster: true }, hold.id, { reason: 'Delivered' });
    const clerk = await staffWith(['refund_small']);
    const staffTry = await refund(clerk, { paymentId: payment.id, amount: 1000, reasonCode: 'customer_request', goodwill: true }).expect(422);
    expect(staffTry.body.code).toBe('REFUND_EXCEEDS_HELD');
    const gw = await refund(master, { paymentId: payment.id, amount: 1000, reasonCode: 'goodwill_gesture', goodwill: true }).expect(201);
    expect(gw.body).toMatchObject({ source: 'goodwill', kind: 'goodwill' });
    expect(await ledger.balance('goodwill_expense')).toBe(-1000); // expense: debit balance

    const second = await paidCharge(5000);
    await escrow.freeze({ id: master.userId }, second.hold.id, { reason: 'dispute_opened' });
    const frozen = await refund(master, { paymentId: second.payment.id, amount: 100, reasonCode: 'customer_request' }).expect(409);
    expect(frozen.body.code).toBe('ESCROW_FROZEN');

    const notPaid = await api().post(`${P}/admin/payments/test-charges`).set(h.bearer(master)).set('Idempotency-Key', key()).send({ payerId: payer.user.id, payeeId: payee.user.id, amount: 100 }).expect(201);
    expect((await refund(master, { paymentId: notPaid.body.payment.id, amount: 100, reasonCode: 'customer_request' }).expect(409)).body.code).toBe('PAYMENT_NOT_REFUNDABLE');
  });

  it('gateway refusals retry, then need manual payment (FR-10)', async () => {
    const { payment } = await paidCharge(4000);
    await h.simulator.failNextRefunds(3);
    const r = await refund(master, { paymentId: payment.id, amount: 4000, reasonCode: 'customer_request' }).expect(201);
    const ran = await h.drainPaymentJobs();
    expect(ran.filter((j) => j.name === 'refunds.process').map((j) => j.result.status)).toEqual(['failed', 'failed', 'manual_required']);
    expect(await models.Refund.findByPk(r.body.id)).toMatchObject({ status: 'manual_required', attempts: 3, lastError: 'REFUND_REFUSED' });
    expect(await ledger.balance('refund_clearing')).toBe(4000); // owed to the payer until M07 pays it
    expect(h.events.recorded().map((e) => e.name)).toEqual(expect.arrayContaining(['refund.failed', 'refund.manual_required']));
    await h.drainEvents();
    expect((await notificationsOf(payer.user.id)).map((n) => n.code)).toContain('REFUND_MANUAL');
    expect((await notificationsOf(master.userId)).map((n) => n.code)).toContain('REFUND_MANUAL_STAFF');
  });

  it('two refunds racing for the same money: only one fits (no double-spend)', async () => {
    const { payment } = await paidCharge(10000);
    const [a, b] = await Promise.all([
      refund(master, { paymentId: payment.id, amount: 6000, reasonCode: 'customer_request' }),
      refund(master, { paymentId: payment.id, amount: 6000, reasonCode: 'customer_request' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect(await models.Refund.count({ where: { paymentId: payment.id } })).toBe(1);
  });
});

describe('escrow (FR-13, FR-14, §8)', () => {
  it('a master releases with step-up: payee credited net, platform fee posted, everyone told', async () => {
    const { hold } = await paidCharge(10000);
    const body = { reason: 'Test charge delivered' };
    expect((await api().post(`${P}/admin/escrow/${hold.id}/release`).set(h.bearer(master)).send(body).expect(403)).body.code).toBe('STEP_UP_REQUIRED');
    const clerk = await staffWith(['view_payouts', 'release_payouts']);
    expect((await api().post(`${P}/admin/escrow/${hold.id}/release`).set(h.bearer(clerk)).send(body).expect(403)).body.code).toBe('MASTER_REQUIRED');

    const r = await api().post(`${P}/admin/escrow/${hold.id}/release`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'escrow.manage')).send(body).expect(200);
    expect(r.body).toMatchObject({ gross: 10000, fee: 500, net: 9500, hold: { status: 'released', released: 10000, feeTaken: 500, available: 0 } });
    expect(await ledger.balance(`payable:user:${payee.user.id}`)).toBe(9500);
    expect(await ledger.balance('fee_revenue:test')).toBe(500);
    expect(await ledger.balance('escrow:test_charge')).toBe(0);
    const audit = await models.AuditLog.findOne({ where: { action: 'escrow.released_manually' } });
    expect(audit).toMatchObject({ severity: 'critical', stepUp: true, reason: 'Test charge delivered' });

    await h.drainEvents();
    const [n] = await notificationsOf(payee.user.id);
    expect(n).toMatchObject({ code: 'ESCROW_RELEASED', title: 'Money released' });
    expect(n.body).toBe('৳95 from Kriraghor test charge is in your balance and goes out with your next payout (fee ৳5).');
    expect((await notificationsOf(master.userId)).map((x) => x.code)).not.toContain('AUDIT_CRITICAL'); // the actor is not alerted

    const twice = await api().post(`${P}/admin/escrow/${hold.id}/release`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'escrow.manage')).send(body).expect(409);
    expect(twice.body.code).toBe('ESCROW_CLOSED');
    const tb = await api().get(`${P}/admin/ledger/trial-balance`).set(h.bearer(clerk)).expect(200);
    expect(tb.body.difference).toBe(0);
  });

  it('partial releases take the fee per tranche; freeze stops everything until unfrozen', async () => {
    const { hold } = await paidCharge(10000);
    const actor = { id: master.userId };
    const first = await escrow.releaseManually(actor, hold.id, { amount: 3333, reason: 'Tranche 1' });
    expect(first).toMatchObject({ gross: 3333, fee: 167, net: 3166, hold: { status: 'partially_released' } });

    const freeze = await api().post(`${P}/admin/escrow/${hold.id}/freeze`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'escrow.manage')).send({ reason: 'Dispute opened' }).expect(200);
    expect(freeze.body).toMatchObject({ status: 'frozen', frozenReason: 'Dispute opened' });
    await expect(escrow.releaseManually(actor, hold.id, { reason: 'x' })).rejects.toMatchObject({ code: 'ESCROW_FROZEN' });
    await expect(escrow.freeze(actor, hold.id, { reason: 'again' })).rejects.toMatchObject({ code: 'ESCROW_NOT_OPEN' });
    await h.drainEvents();
    expect((await notificationsOf(payee.user.id)).map((n) => n.code)).toEqual(['ESCROW_RELEASED', 'ESCROW_FROZEN']);

    const un = await api().post(`${P}/admin/escrow/${hold.id}/unfreeze`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'escrow.manage')).send({ reason: 'Dispute closed' }).expect(200);
    expect(un.body.status).toBe('partially_released');
    await expect(escrow.unfreeze(actor, hold.id, { reason: 'x' })).rejects.toMatchObject({ code: 'ESCROW_NOT_FROZEN' });
    const rest = await escrow.releaseManually(actor, hold.id, { reason: 'Tranche 2' });
    expect(rest).toMatchObject({ gross: 6667, fee: 333, net: 6334, hold: { status: 'released', feeTaken: 500 } });
    expect(await ledger.balance(`payable:user:${payee.user.id}`)).toBe(9500);

    const list = await api().get(`${P}/admin/escrow?status=released`).set(h.bearer(master)).expect(200);
    expect(list.body.items.map((x) => x.id)).toEqual([hold.id]);
    expect((await api().get(`${P}/admin/escrow/${hold.id}`).set(h.bearer(master)).expect(200)).body.releaseCount).toBeUndefined();
  });

  it('delay rules release on time through the job (§10 escrow.release-due)', async () => {
    const p = await payments.createIntent({
      purpose: 'test_charge',
      purposeId: uuid7(),
      payerId: payer.user.id,
      payeeId: payee.user.id,
      amount: 2000,
      title: 'Delayed release',
      releaseRule: { type: 'delay', hours: 48 },
      idempotencyKey: 'delay-1',
    });
    await h.payWithSimulator(payer, p.id);
    const hold = await models.EscrowHold.findOne({ where: { paymentId: p.id } });
    expect(new Date(hold.releaseAt) - Date.now()).toBeGreaterThan(47 * 3600 * 1000);
    expect(await escrow.releaseDue()).toEqual({ due: 0, released: 0 });
    await hold.update({ releaseAt: new Date(Date.now() - 1000) });
    expect(await escrow.releaseDue()).toEqual({ due: 1, released: 1 });
    expect(await hold.reload()).toMatchObject({ status: 'released', releaseAt: null });
  });

  it('two masters releasing at once: one ledger posting (no double-spend)', async () => {
    const { hold } = await paidCharge(10000);
    const b = await h.createSecondMaster();
    const [r1, r2] = await Promise.all([
      api().post(`${P}/admin/escrow/${hold.id}/release`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'escrow.manage')).send({ reason: 'Delivered' }),
      api().post(`${P}/admin/escrow/${hold.id}/release`).set(h.bearer(b)).set('X-Step-Up', await h.stepUp(b, 'escrow.manage')).send({ reason: 'Delivered' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await models.LedgerTransaction.count({ where: { kind: 'escrow.release_manual' } })).toBe(1);
    expect(await ledger.balance(`payable:user:${payee.user.id}`)).toBe(9500);
  });

  it('settles an esports pool: prizes, subsidy and fee in one posting (M21 §6.5, FR-25)', async () => {
    // M06 on its own: these entries have no M21 registration, so stand in for M21's capture hook
    // (which would reject them). The full M21 flow is tested in esports.test.js.
    const purposes = require('../../src/modules/payments/payments.purposes');
    purposes.register('esports_entry', { onCaptured: () => 'accept' });
    const tournament = uuid7();
    const players = [payer, payee, await h.signupUser()];
    for (const [i, pl] of players.entries()) {
      const p = await payments.createIntent({ purpose: 'esports_entry', purposeId: uuid7(), payerId: pl.user.id, groupRef: tournament, amount: 10000, title: 'Weekly Free Fire', idempotencyKey: `entry-${i}` });
      await h.payWithSimulator(pl, p.id);
    }
    const holds = await models.EscrowHold.findAll({ where: { groupRef: tournament } });
    expect(holds.map((x) => [x.payeeId, x.feeBps, x.feeSettingKey])).toEqual([[null, 0, 'none'], [null, 0, 'none'], [null, 0, 'none']]);
    await expect(escrow.releaseManually({ id: master.userId }, holds[0].id, { reason: 'x' })).rejects.toMatchObject({ code: 'ESCROW_POOLED' });

    const prizes = [
      { payeeId: payer.user.id, amount: 15000 },
      { payeeId: payee.user.id, amount: 6000 },
    ];
    const s = await escrow.settlePool({ purpose: 'esports_entry', groupRef: tournament, prizes });
    expect(s).toMatchObject({ collected: 30000, paid: 21000, subsidy: 0, fee: 9000 });
    expect(await ledger.balance('fee_revenue:esports')).toBe(9000);
    expect(await ledger.balance(`payable:user:${payer.user.id}`)).toBe(15000);
    expect(await ledger.balance('escrow:esports_entry')).toBe(0);
    expect((await escrow.settlePool({ purpose: 'esports_entry', groupRef: tournament, prizes })).existing).toBe(true);
    expect(await models.LedgerTransaction.count({ where: { kind: 'escrow.pool_settle' } })).toBe(1);

    // Guaranteed prizes: one entry of ৳100 against ৳150 of prizes → ৳50 subsidy.
    const small = uuid7();
    const p = await payments.createIntent({ purpose: 'esports_entry', purposeId: uuid7(), payerId: payer.user.id, groupRef: small, amount: 10000, title: 'Daily', idempotencyKey: 'entry-small' });
    await h.payWithSimulator(payer, p.id);
    const s2 = await escrow.settlePool({ purpose: 'esports_entry', groupRef: small, prizes: [{ payeeId: payee.user.id, amount: 15000 }] });
    expect(s2).toMatchObject({ collected: 10000, paid: 15000, subsidy: 5000, fee: 0 });
    expect(await ledger.balance('prize_subsidy_expense')).toBe(-5000);
    expect((await invariants.check()).ok).toBe(true);
    await expect(escrow.settlePool({ purpose: 'test_charge', groupRef: small, prizes: [] })).rejects.toThrow(/not pooled/);
    expect(await escrow.settlePool({ purpose: 'esports_entry', groupRef: uuid7(), prizes: [] })).toMatchObject({ transactionId: null });
  });
});

describe('the ledger guards itself (FR-11, FR-12, FR-19)', () => {
  it('refuses unbalanced, sealed, edited and deleted rows in the database', async () => {
    const { payment } = await paidCharge(1000);
    const [acc] = await models.LedgerAccount.findAll({ limit: 1 });
    const q = (sql, replacements) => models.sequelize.query(sql, { replacements });
    // The balance is checked by a deferred constraint trigger, so the COMMIT is what fails.
    const txn = uuid7();
    const unbalanced = models.sequelize.transaction(async (transaction) => {
      await models.LedgerTransaction.create({ id: txn, kind: 'test', refType: 'payment', refId: payment.id, idempotencyKey: 'bad', totalPoisha: 100, entryCount: 2 }, { transaction });
      await models.LedgerEntry.create({ txnId: txn, accountId: acc.id, debitPoisha: 100 }, { transaction });
      await models.LedgerEntry.create({ txnId: txn, accountId: acc.id, creditPoisha: 90 }, { transaction });
    });
    await expect(unbalanced).rejects.toThrow(/unbalanced/);
    expect(await models.LedgerTransaction.findByPk(txn)).toBeNull();
    // Entries with no transaction header are refused too (deferred foreign key).
    await expect(q('INSERT INTO ledger_entries (txn_id, account_id, debit_poisha, credit_poisha) VALUES (?, ?, 1, 0)', [uuid7(), acc.id])).rejects.toThrow(/without a posted transaction|foreign key/);
    const posted = await models.LedgerTransaction.findOne();
    await expect(q('INSERT INTO ledger_entries (txn_id, account_id, debit_poisha, credit_poisha) VALUES (?, ?, 1, 0)', [posted.id, acc.id])).rejects.toThrow(/already posted/);
    await expect(q('UPDATE ledger_entries SET debit_poisha = 1 WHERE txn_id = ?', [posted.id])).rejects.toThrow(/append-only/);
    await expect(q('DELETE FROM ledger_transactions WHERE id = ?', [posted.id])).rejects.toThrow(/append-only/);
    await expect(q('UPDATE ledger_accounts SET code = ? WHERE id = ?', ['x', acc.id])).rejects.toThrow(/append-only/);
    await expect(q('INSERT INTO ledger_entries (txn_id, account_id, debit_poisha, credit_poisha) VALUES (?, ?, 5, 5)', [uuid7(), acc.id])).rejects.toThrow(/ck_ledger_entries_sides/);
    await expect(posted.update({ memo: 'x' })).rejects.toThrow(/append-only/);
  });

  it('never lets escrow or a payee balance go below zero; reversals mirror', async () => {
    const { payment, hold } = await paidCharge(1000);
    const over = models.sequelize.transaction((transaction) =>
      ledger.post({ kind: 'test', refType: 'payment', refId: payment.id, idempotencyKey: 'over', lines: [{ account: 'escrow:test_charge', debit: 1001, holdId: hold.id }, { account: 'suspense', credit: 1001 }] }, { transaction })
    );
    await expect(over).rejects.toMatchObject({ code: 'LEDGER_INSUFFICIENT_BALANCE' });
    const unbalanced = models.sequelize.transaction((transaction) =>
      ledger.post({ kind: 'test', refType: 'payment', refId: payment.id, idempotencyKey: 'ub', lines: [{ account: 'suspense', debit: 1 }, { account: 'refund_clearing', credit: 2 }] }, { transaction })
    );
    await expect(unbalanced).rejects.toMatchObject({ code: 'LEDGER_UNBALANCED' });
    await expect(ledger.post({ kind: 'x', refType: 'x', refId: payment.id, idempotencyKey: 'x', lines: [] }, {})).rejects.toThrow(/inside a transaction/);

    const capture = await models.LedgerTransaction.findOne({ where: { kind: 'payment.capture' } });
    const rev = await models.sequelize.transaction((transaction) => ledger.reverse(capture.id, { idempotencyKey: 'rev-1', memo: 'Test reversal' }, { transaction }));
    expect(rev.existing).toBe(false);
    expect(await ledger.balance('escrow:test_charge')).toBe(0);
    const t = await api().get(`${P}/admin/ledger/transactions/${rev.id}`).set(h.bearer(master)).expect(200);
    expect(t.body).toMatchObject({ kind: 'reversal', reversesTxnId: capture.id, total: 1000 });
    await expect(models.sequelize.transaction((transaction) => ledger.reverse(uuid7(), { idempotencyKey: 'rev-2' }, { transaction }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('nightly invariants pass, then catch injected drift and alert finance (FR-19)', async () => {
    const { hold } = await paidCharge(2000);
    const clerk = await staffWith(['view_payouts']);
    const ok = await api().get(`${P}/admin/ledger/invariants`).set(h.bearer(clerk)).expect(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.checks.map((c) => c.name)).toEqual(['trial_balance', 'no_orphan_entries', 'escrow_matches_holds', 'holds_match_ledger', 'no_negative', 'payout_clearing_matches', 'gym_dues_paid_match', 'gym_dues_status_match', 'gym_fee_released_has_release', 'gym_sms_balance_not_negative']); // M07, then M24 (§7.2)

    await models.sequelize.query('UPDATE escrow_holds SET held_poisha = 2500 WHERE id = ?', { replacements: [hold.id] });
    await h.setSettingForTest('payments.clearing_alert_days', 1);
    await models.sequelize.query('UPDATE ledger_transactions SET memo = memo WHERE 1 = 0'); // (append-only; aged entries are simulated below)
    const bad = await invariants.check();
    expect(bad.ok).toBe(false);
    expect(bad.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['escrow_matches_holds', 'holds_match_ledger']);
    expect(bad.checks.find((c) => c.name === 'clearing_age').ok).toBe(true);
    await h.drainEvents();
    const alert = (await notificationsOf(clerk.userId)).find((n) => n.code === 'LEDGER_INVARIANT_FAILED');
    expect(alert.body).toBe('Failed checks: escrow_matches_holds, holds_match_ledger. Look at the Finance desk now.');
  });
});

describe('reconciliation (FR-18)', () => {
  const today = () => new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10);

  it('matches, heals a missed capture, flags a wrong amount, and keeps one run per day', async () => {
    const good = await paidCharge(3000);
    const missed = await api().post(`${P}/admin/payments/test-charges`).set(h.bearer(master)).set('Idempotency-Key', key()).send({ payerId: payer.user.id, payeeId: payee.user.id, amount: 2000 }).expect(201);
    const a = await api().post(`${P}/payments/${missed.body.payment.id}/attempts`).set(h.bearer(payer)).set('Idempotency-Key', key()).send({ method: 'bkash' }).expect(201);
    await h.simulator.pay(a.body.redirectUrl.split('/').pop(), 'success_no_ipn'); // no IPN, no return…
    h.paymentJobs.takeTestJobs(); // …and no poll
    const wrong = await api().post(`${P}/admin/payments/test-charges`).set(h.bearer(master)).set('Idempotency-Key', key()).send({ payerId: payer.user.id, payeeId: payee.user.id, amount: 5000 }).expect(201);
    await h.payWithSimulator(payer, wrong.body.payment.id, { outcome: 'wrong_amount' });
    await refund(master, { paymentId: good.payment.id, amount: 1000, reasonCode: 'customer_request' }).expect(201);
    await h.drainPaymentJobs();

    const run = await api().post(`${P}/admin/reconciliation/runs`).set(h.bearer(master)).send({ businessDate: today() }).expect(201);
    expect(run.body).toMatchObject({ status: 'completed', totals: { matched: 3, autoHealed: 1, exceptions: 1 } }); // capture, refund, mismatch refund
    expect((await models.Payment.findByPk(missed.body.payment.id)).status).toBe('succeeded');
    const items = await api().get(`${P}/admin/reconciliation/runs/${run.body.id}/items`).set(h.bearer(master)).expect(200);
    expect(items.body.items.map((i) => [i.type, i.resolution]).sort()).toEqual(
      [['amount_mismatch', null], ['matched', null], ['matched', null], ['matched', null], ['missing_internal', 'auto_healed']].sort()
    );
    const open = await api().get(`${P}/admin/reconciliation/runs/${run.body.id}/items?open=true`).set(h.bearer(master)).expect(200);
    expect(open.body.items.map((i) => i.type)).toEqual(['amount_mismatch']);

    await h.drainEvents();
    const alert = (await notificationsOf(master.userId)).find((n) => n.code === 'RECON_EXCEPTION');
    expect(alert.body).toBe(`1 exception(s) in the reconciliation for ${today()}.`);

    const resolved = await api().post(`${P}/admin/reconciliation/items/${open.body.items[0].id}/resolve`).set(h.bearer(master)).send({ resolution: 'resolved', note: 'Refunded in full automatically' }).expect(200);
    expect(resolved.body).toMatchObject({ resolution: 'resolved', resolvedBy: master.userId });
    await api().post(`${P}/admin/reconciliation/items/${open.body.items[0].id}/resolve`).set(h.bearer(master)).send({ resolution: 'resolved', note: 'Again' }).expect(409);
    expect((await api().post(`${P}/admin/reconciliation/runs`).set(h.bearer(master)).send({ businessDate: today() }).expect(409)).body.code).toBe('RECON_RUN_EXISTS');
    expect((await reconciliation.run({ businessDate: today() })).id).toBe(run.body.id); // the job just returns it
    const runs = await api().get(`${P}/admin/reconciliation/runs`).set(h.bearer(master)).expect(200);
    expect(runs.body.items).toHaveLength(1);
    expect(reconciliation.dayBounds('2026-10-19').start.toISOString()).toBe('2026-10-18T18:00:00.000Z');
    expect(reconciliation.previousBusinessDay(new Date('2026-10-19T19:00:00Z'))).toBe('2026-10-19');
  });
});

describe('permissions (role × endpoint)', () => {
  it('members, staff without view_payouts, finance staff and masters see what they should', async () => {
    await paidCharge(1000);
    const member = await h.signupUser();
    const support = await staffWith(['manage_users']);
    const finance = await staffWith(['view_payouts']);
    const reads = ['/admin/payments', '/admin/refunds', '/admin/ledger/accounts', '/admin/ledger/trial-balance', '/admin/escrow', '/admin/reconciliation/runs'];
    for (const path of reads) {
      expect((await api().get(`${P}${path}`).set(h.bearer(member)).expect(401)).body.code).toBe('TOKEN_AUDIENCE_INVALID');
      expect((await api().get(`${P}${path}`).set(h.bearer(support)).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
      await api().get(`${P}${path}`).set(h.bearer(finance)).expect(200);
      await api().get(`${P}${path}`).set(h.bearer(master)).expect(200);
    }
    const accounts = await api().get(`${P}/admin/ledger/accounts?code=escrow`).set(h.bearer(finance)).expect(200);
    expect(accounts.body.items).toEqual([expect.objectContaining({ code: 'escrow:test_charge', type: 'liability', balance: 1000, entries: 1 })]);
    const entries = await api().get(`${P}/admin/ledger/accounts/${accounts.body.items[0].id}/entries`).set(h.bearer(finance)).expect(200);
    expect(entries.body.items).toEqual([expect.objectContaining({ kind: 'payment.capture', credit: 1000, debit: 0 })]);
    // Finance staff can read but not move money or run reconciliation; support cannot refund.
    expect((await api().post(`${P}/admin/reconciliation/runs`).set(h.bearer(finance)).send({}).expect(403)).body.code).toBe('MASTER_REQUIRED');
    expect((await refund(support, { paymentId: (await models.Payment.findOne()).id, amount: 100, reasonCode: 'customer_request' }).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    expect((await api().post(`${P}/admin/payments/test-charges`).set(h.bearer(finance)).set('Idempotency-Key', key()).send({ payerId: payer.user.id, payeeId: payee.user.id, amount: 100 }).expect(403)).body.code).toBe('MASTER_REQUIRED');
    await api().get(`${P}/me/payments`).set(h.bearer(finance)).expect(401);
  });
});
