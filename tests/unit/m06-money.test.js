'use strict';

// M06 money code, 100% branch coverage (CLAUDE.md): common/money, ledger rules (chart of accounts and
// posting builders), escrow hold rules and refund rules (M06-FR-08, FR-09, FR-12, FR-13, §6.3, §6.5).
const money = require('../../src/common/money');
const L = require('../../src/modules/payments/ledger.rules');
const ER = require('../../src/modules/payments/escrow.rules');
const RR = require('../../src/modules/payments/refunds.rules');

const total = (lines, side) => lines.reduce((s, l) => s + (l[side] ?? 0), 0);
const balanced = (lines) => total(lines, 'debit') === total(lines, 'credit');

describe('common/money', () => {
  it('checks poisha amounts', () => {
    expect(money.assertPoisha(0)).toBe(0);
    for (const bad of [-1, 1.5, '100', NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => money.assertPoisha(bad)).toThrow(TypeError);
    expect(money.toPoisha('12345')).toBe(12345);
    expect(money.toPoisha(7)).toBe(7);
    expect(money.toPoisha(null)).toBe(0);
    expect(money.toPoisha(undefined)).toBe(0);
    expect(() => money.toPoisha('-5')).toThrow(TypeError);
  });

  it('turns percent settings into basis points', () => {
    expect(money.pctToBps(5)).toBe(500);
    expect(money.pctToBps(2.5)).toBe(250);
    expect(money.pctToBps(0)).toBe(0);
    for (const bad of [-1, 101, '5', Infinity]) expect(() => money.pctToBps(bad)).toThrow(TypeError);
  });

  it('rounds fees half-up (FR-13) and keeps the residue with the payee', () => {
    expect(money.feeOf(10000, 500)).toBe(500);
    expect(money.feeOf(105, 500)).toBe(5); // 5.25 → 5
    expect(money.feeOf(110, 500)).toBe(6); // 5.5 → 6 (half up)
    expect(money.feeOf(0, 500)).toBe(0);
    expect(money.feeOf(Number.MAX_SAFE_INTEGER, 10000)).toBe(Number.MAX_SAFE_INTEGER); // BigInt inside: no overflow
    expect(() => money.feeOf(100, 10001)).toThrow(TypeError);
    expect(() => money.feeOf(100, 1.5)).toThrow(TypeError);
    expect(() => money.feeOf(-1, 500)).toThrow(TypeError);
    const { fee, net } = money.splitFee(200000, 500); // v3 worked example: ৳2,000 at 5% = ৳100
    expect([fee, net]).toEqual([10000, 190000]);
  });

  it('splits evenly and by percentage; remainders go to the first share', () => {
    expect(money.splitEven(1000, 3)).toEqual([334, 333, 333]);
    expect(money.splitEven(900, 3)).toEqual([300, 300, 300]);
    expect(() => money.splitEven(100, 0)).toThrow(TypeError);
    expect(money.splitByPct(1001, [50, 30, 20])).toEqual([501, 300, 200]);
    for (const bad of [[], [50, 49], [50.5, 49.5], [-10, 110]]) expect(() => money.splitByPct(100, bad)).toThrow(TypeError);
    expect(money.sum([1, 2, 3])).toBe(6);
  });

  it('formats taka in EN and BN, and converts gateway amounts without floats', () => {
    expect(money.format(210000)).toBe('৳2,100');
    expect(money.format(12345678)).toBe('৳1,23,456.78');
    expect(money.format(5, 'bn')).toBe('৳০.০৫');
    expect(money.format(-150)).toBe('−৳1.50');
    expect(money.money(500)).toEqual({ amount: 500, currency: 'BDT' });
    expect(money.toTakaString(10050)).toBe('100.50');
    expect(money.toTakaString(7)).toBe('0.07');
    expect(money.fromTakaString('100.00')).toBe(10000);
    expect(money.fromTakaString('12.5')).toBe(1250);
    expect(money.fromTakaString(' 7 ')).toBe(700);
    expect(money.fromTakaString(99.99)).toBe(9999);
    for (const bad of ['1,000', '-5', 'abc', '', null, {}]) expect(() => money.fromTakaString(bad)).toThrow(TypeError);
  });
});

describe('ledger rules (§6.2, FR-12)', () => {
  it('knows the chart of accounts', () => {
    expect(L.accountType('escrow:test_charge')).toBe('liability');
    expect(L.accountType('payable:user:0190a0b1-0000-7000-8000-000000000001')).toBe('liability');
    expect(L.accountType('provider_clearing:sslcommerz')).toBe('asset');
    expect(L.accountType('fee_revenue:esports')).toBe('revenue');
    expect(L.accountType('prize_subsidy_expense')).toBe('expense');
    for (const bad of ['', 'Escrow:x', 'unknown:x', 'escrow::x', 42, `escrow:${'a'.repeat(130)}`]) expect(() => L.accountType(bad)).toThrow(TypeError);
    expect(L.isGuarded('escrow:x')).toBe(true);
    expect(L.isGuarded('payable:user:u')).toBe(true);
    expect(L.isGuarded('fee_revenue:x')).toBe(false);
    expect(L.ownerOf('payable:user:abc')).toBe('abc');
    expect(L.ownerOf('escrow:x')).toBeNull();
    expect(L.verticalOf('fee_revenue:grounds')).toBe('grounds');
    expect(L.verticalOf('suspense')).toBeNull();
  });

  it('validates lines: two or more, one positive side each, balanced', () => {
    expect(L.validateLines([{ account: 'suspense', debit: 5 }, { account: 'refund_clearing', credit: 5 }])).toBe(5);
    expect(() => L.validateLines([{ account: 'suspense', debit: 5 }])).toThrow(L.LedgerError);
    expect(() => L.validateLines('x')).toThrow(L.LedgerError);
    expect(() => L.validateLines([{ account: 'suspense', debit: 5, credit: 5 }, { account: 'refund_clearing', credit: 5 }])).toThrow(/exactly one/);
    expect(() => L.validateLines([{ account: 'suspense' }, { account: 'refund_clearing', credit: 5 }])).toThrow(/exactly one/);
    expect(() => L.validateLines([{ account: 'suspense', debit: 5 }, { account: 'refund_clearing', credit: 4 }])).toThrow(/Unbalanced/);
    expect(() => L.validateLines([{ account: 'suspense', debit: -5 }, { account: 'refund_clearing', credit: -5 }])).toThrow(TypeError);
  });

  it('nets by account and mirrors for reversals', () => {
    const lines = [
      { account: 'escrow:x', debit: 100, holdId: 'h' },
      { account: 'payable:user:u', credit: 95 },
      { account: 'fee_revenue:test', credit: 5 },
      { account: 'escrow:x', credit: 10 },
    ];
    expect(Object.fromEntries(L.netByAccount(lines))).toEqual({ 'escrow:x': -90, 'payable:user:u': 95, 'fee_revenue:test': 5 });
    const m = L.mirror(lines);
    expect(m[0]).toEqual({ account: 'escrow:x', holdId: 'h', credit: 100 });
    expect(m[1]).toEqual({ account: 'payable:user:u', holdId: undefined, debit: 95 });
    expect([total(m, 'debit'), total(m, 'credit')]).toEqual([total(lines, 'credit'), total(lines, 'debit')]);
  });

  it('captures a split payment with one escrow credit per hold (M13 basket)', () => {
    const cap = L.captureSplitLines({ provider: 'sslcommerz', escrowAccount: 'escrow:market_order', holds: [{ holdId: 'a', amount: 528000 }, { holdId: 'b', amount: 131500 }] });
    expect(cap).toEqual([
      { account: 'provider_clearing:sslcommerz', debit: 659500 },
      { account: 'escrow:market_order', credit: 528000, holdId: 'a' },
      { account: 'escrow:market_order', credit: 131500, holdId: 'b' },
    ]);
    expect(balanced(cap)).toBe(true);
    expect(() => L.validateLines(cap)).not.toThrow();
  });

  it('builds balanced postings for capture, release, refund and mismatch (§6.3)', () => {
    const cap = L.captureLines({ provider: 'sslcommerz', escrowAccount: 'escrow:test_charge', amount: 10000, holdId: 'h1' });
    expect(cap).toEqual([
      { account: 'provider_clearing:sslcommerz', debit: 10000 },
      { account: 'escrow:test_charge', credit: 10000, holdId: 'h1' },
    ]);
    const rel = L.releaseLines({ escrowAccount: 'escrow:test_charge', holdId: 'h1', payeeId: 'p', vertical: 'test', gross: 10000, fee: 500 });
    expect(rel).toEqual([
      { account: 'escrow:test_charge', debit: 10000, holdId: 'h1' },
      { account: 'payable:user:p', credit: 9500 },
      { account: 'fee_revenue:test', credit: 500 },
    ]);
    expect(L.releaseLines({ escrowAccount: 'escrow:e', holdId: 'h', payeeId: 'p', vertical: 'v', gross: 100, fee: 0 })).toHaveLength(2);
    expect(L.releaseLines({ escrowAccount: 'escrow:e', holdId: 'h', payeeId: 'p', vertical: 'v', gross: 100, fee: 100 })).toEqual([
      { account: 'escrow:e', debit: 100, holdId: 'h' },
      { account: 'fee_revenue:v', credit: 100 },
    ]);
    expect(() => L.releaseLines({ escrowAccount: 'escrow:e', holdId: 'h', payeeId: 'p', vertical: 'v', gross: 100, fee: 101 })).toThrow(L.LedgerError);
    // M24 §6.3 (M24-FR-43, FR-45): ৳1,500 by bKash at 200 bps → ৳30 to provider_fee_expense, ৳1,470 to the owner, no fee_revenue.
    expect(L.releaseLines({ escrowAccount: 'escrow:gym_membership_fee', holdId: 'h', payeeId: 'o', vertical: 'gym_fee', gross: 150000, fee: 0, providerCharge: 3000 })).toEqual([
      { account: 'escrow:gym_membership_fee', debit: 150000, holdId: 'h' },
      { account: 'payable:user:o', credit: 147000 },
      { account: 'provider_fee_expense', credit: 3000 },
    ]);
    expect(L.releaseLines({ escrowAccount: 'escrow:e', holdId: 'h', payeeId: 'p', vertical: 'v', gross: 100, fee: 10, providerCharge: 90 })).toEqual([
      { account: 'escrow:e', debit: 100, holdId: 'h' },
      { account: 'fee_revenue:v', credit: 10 },
      { account: 'provider_fee_expense', credit: 90 },
    ]);
    expect(() => L.releaseLines({ escrowAccount: 'escrow:e', holdId: 'h', payeeId: 'p', vertical: 'v', gross: 100, fee: 10, providerCharge: 91 })).toThrow(L.LedgerError);
    expect(() => L.releaseLines({ escrowAccount: 'escrow:e', holdId: 'h', payeeId: 'p', vertical: 'v', gross: 100, fee: 0, providerCharge: -1 })).toThrow(TypeError);
    // M10: a ৳600 extension paid at the venue owes 5% = ৳30 (3000 poisha).
    expect(L.feeReceivableLines({ payeeId: 'o', vertical: 'grounds', amount: 3000 })).toEqual([
      { account: 'fee_receivable:user:o', debit: 3000 },
      { account: 'fee_revenue:grounds', credit: 3000 },
    ]);
    for (const bad of [0, -1, 1.5]) expect(() => L.feeReceivableLines({ payeeId: 'o', vertical: 'grounds', amount: bad })).toThrow(L.LedgerError);
    expect(L.refundReserveLines({ source: 'escrow', escrowAccount: 'escrow:e', holdId: 'h', amount: 7 })).toEqual([
      { account: 'escrow:e', debit: 7, holdId: 'h' },
      { account: 'refund_clearing', credit: 7 },
    ]);
    expect(L.refundReserveLines({ source: 'goodwill', escrowAccount: 'escrow:e', holdId: 'h', amount: 7 })[0]).toEqual({ account: 'goodwill_expense', debit: 7 });
    expect(L.refundReserveLines({ source: 'suspense', escrowAccount: 'escrow:e', amount: 7 })[0]).toEqual({ account: 'suspense', debit: 7 });
    expect(() => L.refundReserveLines({ source: 'cash', amount: 7 })).toThrow(L.LedgerError);
    expect(L.refundSettleLines({ provider: 'sslcommerz', amount: 7 })).toEqual([
      { account: 'refund_clearing', debit: 7 },
      { account: 'provider_clearing:sslcommerz', credit: 7 },
    ]);
    expect(balanced(L.mismatchLines({ provider: 'sslcommerz', amount: 9900 }))).toBe(true);
  });

  it('settles an esports pool with and without a shortfall (M21 §6.5, FR-25)', () => {
    // M21 worked example: prizes ৳1,000 / ৳600 / ৳300 and kills ৳200, entries collected ৳4,000.
    const holds = [1, 2, 3, 4].map((i) => ({ id: `h${i}`, available: 100000 }));
    const prizes = [
      { payeeId: 'w1', amount: 100000 },
      { payeeId: 'w2', amount: 60000 },
      { payeeId: 'w3', amount: 30000 },
      { payeeId: 'k1', amount: 20000 },
    ];
    const s = L.poolSettlement({ escrowAccount: 'escrow:esports_entry', vertical: 'esports', holds, prizes });
    expect([s.collected, s.paid, s.subsidy, s.remainder]).toEqual([400000, 210000, 0, 190000]);
    expect(balanced(s.lines)).toBe(true);
    expect(s.lines.find((l) => l.account === 'fee_revenue:esports').credit).toBe(190000);
    expect(s.feeByHold).toEqual([100000, 90000, 0, 0]);

    // Guaranteed prizes: collected ৳1,500 < prizes ৳2,100 → ৳600 subsidy, no fee.
    const short = L.poolSettlement({ escrowAccount: 'escrow:esports_entry', vertical: 'esports', holds: [{ id: 'a', available: 150000 }, { id: 'b', available: 0 }], prizes });
    expect([short.subsidy, short.remainder]).toEqual([60000, 0]);
    expect(short.lines.find((l) => l.account === 'prize_subsidy_expense').debit).toBe(60000);
    expect(short.lines.some((l) => l.holdId === 'b')).toBe(false); // empty holds post nothing
    expect(balanced(short.lines)).toBe(true);

    expect(() => L.poolSettlement({ escrowAccount: 'escrow:e', vertical: 'esports', holds, prizes: [{ payeeId: 'w', amount: 0 }] })).toThrow(L.LedgerError);
    expect(L.allocate(5, [{ available: 3 }, { available: 3 }])).toEqual([3, 2]);
  });
});

describe('escrow rules (§8, FR-13, FR-14)', () => {
  const hold = (over = {}) => ({ status: 'holding', payeeId: 'p', heldPoisha: 10000, releasedPoisha: 0, refundedPoisha: 0, feeBps: 500, ...over });

  it('blocks releases that are not allowed', () => {
    expect(ER.releaseBlock(hold())).toBeNull();
    expect(ER.releaseBlock(hold({ status: 'frozen' }))).toBe('ESCROW_FROZEN');
    expect(ER.releaseBlock(hold({ status: 'released' }))).toBe('ESCROW_CLOSED');
    expect(ER.releaseBlock(hold({ payeeId: null }))).toBe('ESCROW_POOLED');
    expect(ER.releaseBlock(hold({ status: 'partially_released', releasedPoisha: 6000, refundedPoisha: 4000 }))).toBe('ESCROW_EMPTY');
  });

  it('computes tranche fees on the released amount', () => {
    expect(ER.release(hold())).toEqual({ gross: 10000, fee: 500, net: 9500 });
    expect(ER.release(hold(), 3333)).toEqual({ gross: 3333, fee: 167, net: 3166 });
    for (const bad of [0, 10001, 1.5]) expect(() => ER.release(hold(), bad)).toThrow(RangeError);
  });

  it('takes the fee on an explicit base (M10 v3: fee on the full booking value)', () => {
    // ৳2,000 booking, ৳500 advance held: fee 5% × ৳2,000 = ৳100, owner ৳400.
    const h = hold({ heldPoisha: 50000 });
    expect(ER.release(h, 50000, 200000)).toEqual({ gross: 50000, fee: 10000, net: 40000 });
    expect(ER.release(h, 50000, 0)).toEqual({ gross: 50000, fee: 0, net: 50000 });
    expect(() => ER.release(h, 50000, 1100000)).toThrow(RangeError);
    for (const bad of [-1, 2.5]) expect(() => ER.release(h, 50000, bad)).toThrow(RangeError);
  });

  it('moves through the hold statuses', () => {
    const h = hold();
    expect(ER.statusAfter(h, { released: 0, refunded: 0 })).toBe('holding');
    expect(ER.statusAfter(h, { released: 4000, refunded: 0 })).toBe('partially_released');
    expect(ER.statusAfter(h, { released: 10000, refunded: 0 })).toBe('released');
    expect(ER.statusAfter(h, { released: 0, refunded: 10000 })).toBe('refunded');
    expect(ER.statusAfter(h, { released: 6000, refunded: 4000 })).toBe('closed');
    expect(ER.statusAfter(h, { released: 0, refunded: 3000 })).toBe('holding');
  });

  it('schedules delay-rule releases from the capture time', () => {
    expect(ER.releaseAt({ type: 'delay', hours: 48 }, '2026-10-19T00:00:00Z').toISOString()).toBe('2026-10-21T00:00:00.000Z');
    expect(ER.releaseAt({ type: 'manual' }, new Date())).toBeNull();
    expect(ER.releaseAt(undefined, new Date())).toBeNull();
  });
});

describe('refund rules (FR-08, FR-09, §6.5)', () => {
  it('bounds refunds by what was captured minus live refunds', () => {
    const rs = [
      { status: 'succeeded', amount: 3000 },
      { status: 'pending_master', amount: 2000 },
      { status: 'rejected', amount: 9999 },
      { status: 'manual_required', amount: 1000 },
    ];
    expect(RR.refundable(10000, rs)).toBe(4000);
    expect(RR.refundable(1000, rs)).toBe(0);
  });

  it('applies the staff cap per refund and per payment', () => {
    const limit = 1000000;
    expect(RR.authority({ actorKind: 'system', amount: 5e7, staffTotal: 0, limit })).toBe('approved');
    expect(RR.authority({ actorKind: 'master', amount: 5e7, staffTotal: 0, limit })).toBe('approved');
    expect(RR.authority({ actorKind: 'staff', amount: 1000000, staffTotal: 0, limit })).toBe('approved');
    expect(RR.authority({ actorKind: 'staff', amount: 1000001, staffTotal: 0, limit })).toBe('pending_master');
    expect(RR.authority({ actorKind: 'staff', amount: 600000, staffTotal: 500000, limit })).toBe('pending_master');
    expect(() => RR.authority({ actorKind: 'robot', amount: 1, staffTotal: 0, limit })).toThrow(TypeError);
  });

  it('picks where refund money comes from', () => {
    expect(RR.source({ kind: 'amount_mismatch', holdAvailable: 0, amount: 5, actorKind: 'system' })).toBe('suspense');
    expect(RR.source({ kind: 'manual', holdAvailable: 10, amount: 5, actorKind: 'staff' })).toBe('escrow');
    expect(RR.source({ kind: 'goodwill', holdAvailable: 0, amount: 5, actorKind: 'master' })).toBe('goodwill');
    expect(RR.source({ kind: 'goodwill', holdAvailable: 0, amount: 5, actorKind: 'staff' })).toBeNull();
    expect(RR.source({ kind: 'manual', holdAvailable: 0, amount: 5, actorKind: 'master' })).toBeNull();
  });

  it('sets the payment status after refunds and spaces retries', () => {
    expect(RR.paymentStatusAfterRefund({ status: 'succeeded', captured: 100, refunded: 100 })).toBe('refunded');
    expect(RR.paymentStatusAfterRefund({ status: 'succeeded', captured: 100, refunded: 40 })).toBe('partially_refunded');
    expect(RR.paymentStatusAfterRefund({ status: 'succeeded', captured: 100, refunded: 0 })).toBe('succeeded');
    expect(RR.paymentStatusAfterRefund({ status: 'failed', captured: 100, refunded: 100 })).toBe('failed');
    expect([RR.retryDelay(0), RR.retryDelay(1), RR.retryDelay(2), RR.retryDelay(3), RR.retryDelay(9)]).toEqual([60000, 60000, 600000, 3600000, 3600000]);
  });
});
