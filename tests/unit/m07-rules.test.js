'use strict';

// M07 payout rules, 100% branch coverage (CLAUDE.md money code): items and the net formula (FR-03,
// FR-04, §6.2), holds (FR-06, FR-14), approval (FR-07, §6.3), the state machine (§8), retries (FR-10)
// and the Asia/Dhaka schedules (FR-05, §6.1).
const R = require('../../src/modules/payouts/payouts.rules');

const at = (iso) => new Date(iso);
const payout = (over = {}) => ({ id: 'p1', payeeId: 'payee', status: 'scheduled', amount: 9500, accountId: 'a1', failureCode: null, rules: { threshold: 5000000 }, ...over });

describe('M07 state machine (§8)', () => {
  it('allows only the drawn transitions', () => {
    expect(R.canTransition('scheduled', 'processing')).toBe(true);
    expect(R.canTransition('needs_approval', 'processing')).toBe(true);
    expect(R.canTransition('on_hold', 'scheduled')).toBe(true);
    expect(R.canTransition('processing', 'paid')).toBe(true);
    expect(R.canTransition('processing', 'failed')).toBe(true);
    expect(R.canTransition('failed', 'processing')).toBe(true);
    expect(R.canTransition('failed', 'cancelled')).toBe(true);
    expect(R.canTransition('paid', 'failed')).toBe(false);
    expect(R.canTransition('cancelled', 'scheduled')).toBe(false);
    expect(R.canTransition('processing', 'cancelled')).toBe(false);
    expect(R.canTransition('nope', 'paid')).toBe(false);
    expect(R.OPEN).toEqual(['scheduled', 'needs_approval', 'on_hold']);
  });
});

describe('M07 payout accounts (§4.1)', () => {
  it('normalises Bangladeshi wallet numbers', () => {
    expect(R.normaliseWallet('01712345678')).toBe('01712345678');
    expect(R.normaliseWallet('+880 1712-345678')).toBe('01712345678');
    expect(R.normaliseWallet('8801912345678')).toBe('01912345678');
    expect(R.normaliseWallet('01212345678')).toBeNull(); // 012 is not a mobile prefix
    expect(R.normaliseWallet('0171234567')).toBeNull();
    expect(R.normaliseWallet(undefined)).toBeNull();
  });

  it('masks to the last four digits only', () => {
    expect(R.maskAccount('bkash', '5678')).toBe('bKash ••• 5678');
    expect(R.maskAccount('nagad', '0001')).toBe('Nagad ••• 0001');
    expect(R.maskAccount('rocket', '1111')).toBe('rocket ••• 1111');
  });
});

describe('M07 items and amounts (§6.2, FR-03, FR-04)', () => {
  it('turns a payable credit into an item with the release fee, and a debit into a negative item', () => {
    expect(R.itemValues({ credit: 9500, fee: 500 })).toEqual({ gross: 10000, fee: 500, providerCharge: 0, net: 9500 });
    expect(R.itemValues({ credit: 15000 })).toEqual({ gross: 15000, fee: 0, providerCharge: 0, net: 15000 });
    expect(R.itemValues({ debit: 2000 })).toEqual({ gross: 0, fee: 0, providerCharge: 0, net: -2000 });
    // M24-FR-46: an online gym fee of ৳1,500 by bKash: ৳30 provider charge, ৳1,470 net, no platform fee.
    expect(R.itemValues({ credit: 147000, providerCharge: 3000 })).toEqual({ gross: 150000, fee: 0, providerCharge: 3000, net: 147000 });
    expect(R.itemValues({ debit: 500, providerCharge: 30 })).toEqual({ gross: 0, fee: 0, providerCharge: 0, net: -500 });
    expect(() => R.itemValues({ credit: 1, providerCharge: -1 })).toThrow(TypeError);
    expect(() => R.itemValues({})).toThrow(TypeError);
    expect(() => R.itemValues({ credit: 1, debit: 1 })).toThrow(TypeError);
    expect(() => R.itemValues({ credit: -1 })).toThrow(TypeError);
  });

  it('matches the ground owner worked example: Σ net ৳3,634, netting ৳480 → ৳3,154', () => {
    const items = [
      { gross: 210000, fee: 35000, net: 175000 },
      { gross: 144000, fee: 24000, net: 120000 },
      { gross: 72000, fee: 3600, net: 68400 },
    ];
    expect(R.totals(items, { feeReceivable: 48000 })).toEqual({ gross: 426000, deductions: 62600, net: 363400, netting: 48000, adjustments: 0, amount: 315400 });
  });

  it('counts the provider charge as a deduction (M24-FR-46)', () => {
    const items = [{ gross: 150000, fee: 0, providerCharge: 3000, net: 147000 }, { gross: 10000, fee: 500, net: 9500 }];
    expect(R.totals(items)).toEqual({ gross: 160000, deductions: 3500, net: 156500, netting: 0, adjustments: 0, amount: 156500 });
  });

  it('nets at most what the items bring in, and never a negative receivable', () => {
    const items = [{ gross: 10000, fee: 0, net: 10000 }];
    expect(R.totals(items, { feeReceivable: 50000 }).netting).toBe(10000);
    expect(R.totals(items, { feeReceivable: 50000 }).amount).toBe(0);
    expect(R.totals(items, { feeReceivable: -10 }).netting).toBe(0);
    expect(R.totals(items).amount).toBe(10000);
    expect(R.totals(items, { adjustments: 250 }).amount).toBe(10250);
    const debited = [{ gross: 5000, fee: 0, net: 5000 }, { gross: 0, fee: 0, net: -8000 }];
    expect(R.totals(debited, { feeReceivable: 100 })).toMatchObject({ net: -3000, netting: 0, amount: -3000 });
    expect(R.totals([])).toMatchObject({ gross: 0, amount: 0 });
  });

  it('skips amounts that are not positive or below the minimum (৳100)', () => {
    expect(R.belowMinimum(0, 0)).toBe(true);
    expect(R.belowMinimum(-5, 0)).toBe(true);
    expect(R.belowMinimum(9999, 10000)).toBe(true);
    expect(R.belowMinimum(10000, 10000)).toBe(false);
    expect(R.belowMinimum(1, 0)).toBe(false);
  });
});

describe('M07 holds (§6.4, FR-06, FR-14)', () => {
  const now = at('2026-10-20T04:00:00Z');
  const holds = [
    { scope: 'payee', type: 'manual', liftedAt: null, until: null },
    { scope: 'payee', type: 'account_change', liftedAt: null, until: at('2026-10-20T03:00:00Z') }, // expired
    { scope: 'payee', type: 'manual', liftedAt: at('2026-10-19T00:00:00Z'), until: null }, // lifted
    { scope: 'payout', type: 'manual', payoutId: 'p1', liftedAt: null, until: at('2026-10-21T00:00:00Z') },
    { scope: 'payout', type: 'manual', payoutId: 'p2', liftedAt: null, until: null },
    { scope: 'item_source', type: 'dispute', sourceType: 'escrow_hold', sourceId: 'h1', liftedAt: null, until: null },
  ];

  it('knows which holds are still active', () => {
    expect(R.isActive(holds[0], now)).toBe(true);
    expect(R.isActive(holds[1], now)).toBe(false);
    expect(R.isActive(holds[2], now)).toBe(false);
    expect(R.isActive(holds[3], now)).toBe(true);
  });

  it('blocks the whole payout for payee holds and holds on that payout only', () => {
    expect(R.blockingHolds(holds, now, 'p1')).toHaveLength(2);
    expect(R.blockingHolds(holds, now)).toHaveLength(1);
    expect(R.blockingHolds(holds.slice(1), now, 'p3')).toHaveLength(0);
  });

  it('keeps only the disputed source out (item-level)', () => {
    expect(R.itemHeld({ sourceType: 'escrow_hold', sourceId: 'h1' }, holds, now)).toBe(true);
    expect(R.itemHeld({ sourceType: 'escrow_hold', sourceId: 'h2' }, holds, now)).toBe(false);
    expect(R.itemHeld({ sourceType: 'pool', sourceId: 'h1' }, holds, now)).toBe(false);
  });
});

describe('M07 approval (§6.3, FR-07, §3)', () => {
  const limits = { threshold: 5000000, autoReleaseMax: 0 };

  it('needs two masters above the threshold; exactly the threshold is not above it', () => {
    expect(R.statusFor({ amount: 5000001, ...limits, blocked: false })).toEqual({ status: 'needs_approval', autoRelease: false });
    expect(R.statusFor({ amount: 5000000, ...limits, blocked: false })).toEqual({ status: 'scheduled', autoRelease: false });
  });

  it('puts held payouts on hold first, and auto-releases only up to a positive limit', () => {
    expect(R.statusFor({ amount: 100, ...limits, blocked: true })).toEqual({ status: 'on_hold', autoRelease: false });
    expect(R.statusFor({ amount: 2000000, threshold: 5000000, autoReleaseMax: 2000000, blocked: false })).toEqual({ status: 'scheduled', autoRelease: true });
    expect(R.statusFor({ amount: 2000001, threshold: 5000000, autoReleaseMax: 2000000, blocked: false }).autoRelease).toBe(false);
  });

  it('checks the account and holds before money leaves', () => {
    const now = at('2026-10-20T04:00:00Z');
    const p = payout();
    expect(R.disburseBlock({ payout: p, account: null, holds: [], now })).toBe('PAYOUT_ACCOUNT_REQUIRED');
    expect(R.disburseBlock({ payout: p, account: { status: 'pending_verification' }, holds: [], now })).toBe('PAYOUT_ACCOUNT_UNVERIFIED');
    expect(R.disburseBlock({ payout: p, account: { status: 'active' }, holds: [{ scope: 'payee', liftedAt: null, until: null }], now })).toBe('PAYOUT_ON_HOLD');
    expect(R.disburseBlock({ payout: p, account: { status: 'active' }, holds: [], now })).toBeNull();
  });

  it('lets staff release up to the threshold, never their own payout', () => {
    expect(R.releaseBlock({ payout: payout(), actorId: 'staff' })).toBeNull();
    expect(R.releaseBlock({ payout: payout({ status: 'needs_approval' }), actorId: 'staff' })).toBe('INVALID_STATE');
    expect(R.releaseBlock({ payout: payout(), actorId: 'payee' })).toBe('SELF_PAYOUT_FORBIDDEN');
    expect(R.releaseBlock({ payout: payout({ amount: 5000001 }), actorId: 'staff' })).toBe('FOUR_EYES_REQUIRED');
  });

  it('takes two different masters, never the payee or the hold placer', () => {
    const p = payout({ status: 'needs_approval', amount: 11240000 });
    expect(R.approvalStep({ payout: p, actorId: 'm1', isMaster: false, approvals: [] })).toEqual({ error: 'MASTER_REQUIRED' });
    expect(R.approvalStep({ payout: payout(), actorId: 'm1', isMaster: true, approvals: [] })).toEqual({ error: 'INVALID_STATE' });
    expect(R.approvalStep({ payout: p, actorId: 'payee', isMaster: true, approvals: [] })).toEqual({ error: 'SELF_PAYOUT_FORBIDDEN' });
    expect(R.approvalStep({ payout: p, actorId: 'm1', isMaster: true, approvals: [] })).toEqual({ step: 1 });
    expect(R.approvalStep({ payout: p, actorId: 'm1', isMaster: true, approvals: [{ approverId: 'm1' }] })).toEqual({ error: 'SAME_APPROVER' });
    expect(R.approvalStep({ payout: p, actorId: 'm2', isMaster: true, approvals: [{ approverId: 'm1' }] })).toEqual({ step: 2 });
    expect(R.approvalStep({ payout: p, actorId: 'm2', isMaster: true, approvals: [{ approverId: 'm1' }], holdActorIds: ['m2'] })).toEqual({ error: 'HOLD_ACTOR_CANNOT_APPROVE' });
    expect(R.approvalStep({ payout: p, actorId: 'm3', isMaster: true, approvals: [{ approverId: 'm1' }, { approverId: 'm2' }] })).toEqual({ error: 'INVALID_STATE' });
  });

  it('retries transient failures, and permanent ones only after the account changed (FR-10)', () => {
    expect(R.retryBlock({ payout: payout(), account: { id: 'a1' } })).toBe('INVALID_STATE');
    expect(R.retryBlock({ payout: payout({ status: 'failed', failureCode: 'provider_error' }), account: { id: 'a1' } })).toBeNull();
    expect(R.retryBlock({ payout: payout({ status: 'failed', failureCode: 'invalid_wallet' }), account: { id: 'a1' } })).toBe('PAYOUT_ACCOUNT_UPDATE_REQUIRED');
    expect(R.retryBlock({ payout: payout({ status: 'failed', failureCode: 'invalid_wallet' }), account: null })).toBe('PAYOUT_ACCOUNT_UPDATE_REQUIRED');
    expect(R.retryBlock({ payout: payout({ status: 'failed', failureCode: 'invalid_wallet' }), account: { id: 'a2' } })).toBeNull();
    expect(R.retryBlock({ payout: payout({ status: 'failed', failureCode: 'mystery' }), account: { id: 'a1' } })).toBe('PAYOUT_ACCOUNT_UPDATE_REQUIRED');
    expect(R.FAILURE_REASONS.other.retryable).toBe(true);
  });
});

describe('M07 schedules in Asia/Dhaka (§6.1, FR-05)', () => {
  const cfg = { runHour: 10, dailyEnabled: true, groundWeekday: 'thu', shopWeekday: 'thu' };

  it('reads Dhaka wall-clock time (UTC+6)', () => {
    expect(R.dhakaParts(at('2026-10-21T20:30:00Z'))).toEqual({ y: 2026, m: 9, day: 22, hour: 2, weekday: 'thu' });
    expect(R.dhakaAt(at('2026-10-22T05:00:00Z'), 10).toISOString()).toBe('2026-10-22T04:00:00.000Z');
  });

  it('is due from the run hour, daily and on the weekly days', () => {
    // Thursday 22 Oct 2026, 09:59 Dhaka: nothing yet.
    expect(R.dueSchedules(at('2026-10-22T03:59:00Z'), cfg)).toEqual([]);
    // 10:00 Dhaka: daily, ground and shop, all with the window ending at 10:00.
    const due = R.dueSchedules(at('2026-10-22T04:00:00Z'), cfg);
    expect(due.map((d) => d.schedule)).toEqual(['daily', 'ground_weekly', 'shop_weekly']);
    expect(due[0].windowEnd.toISOString()).toBe('2026-10-22T04:00:00.000Z');
    // A missed 10:00 run is caught up at 13:00, same window.
    expect(R.dueSchedules(at('2026-10-22T07:00:00Z'), cfg)[0].windowEnd.toISOString()).toBe('2026-10-22T04:00:00.000Z');
    // Wednesday: daily only; daily switched off: nothing.
    expect(R.dueSchedules(at('2026-10-21T05:00:00Z'), cfg).map((d) => d.schedule)).toEqual(['daily']);
    expect(R.dueSchedules(at('2026-10-21T05:00:00Z'), { ...cfg, dailyEnabled: false })).toEqual([]);
  });

  it('projects the next run', () => {
    expect(R.nextRun('daily', at('2026-10-21T03:00:00Z'), cfg).toISOString()).toBe('2026-10-21T04:00:00.000Z');
    expect(R.nextRun('daily', at('2026-10-21T04:00:00Z'), cfg).toISOString()).toBe('2026-10-22T04:00:00.000Z');
    expect(R.nextRun('ground_weekly', at('2026-10-22T05:00:00Z'), cfg).toISOString()).toBe('2026-10-29T04:00:00.000Z');
    expect(R.nextRun('shop_weekly', at('2026-10-21T05:00:00Z'), cfg).toISOString()).toBe('2026-10-22T04:00:00.000Z');
    expect(() => R.nextRun('ground_weekly', at('2026-10-21T05:00:00Z'), { ...cfg, groundWeekday: 'someday' })).toThrow(RangeError);
  });
});

describe('M07 statements (§4.2)', () => {
  it('writes CSV with quoted cells and no formula injection', () => {
    expect(R.csv([['Code', 'Amount'], ['PO-26-000001', 9500], ['=HYPERLINK("x")', null]])).toBe('"Code","Amount"\r\n"PO-26-000001","9500"\r\n"\'=HYPERLINK(""x"")",\r\n');
    expect(R.csvCell(undefined)).toBe('');
    expect(R.csvCell('-5')).toBe('"-5"');
    expect(R.csvCell('-20.00')).toBe('"-20.00"');
    expect(R.csvCell('-cmd')).toBe('"\'-cmd"');
  });
});
