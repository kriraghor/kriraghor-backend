'use strict';

// M27 gym operations, round 1: pure rules at 100% branch coverage (jest.config): the drawer, sale totals,
// what can be sold, low-stock and expiry alerts, locker fees, dates and states, profit and loss, VAT.
const r = require('../../src/modules/gym-ops/gym-ops.rules');

describe('M27 gym-ops rules', () => {
  it('lists the methods, categories, sizes and default expense categories', () => {
    expect(r.EXPENSE_METHODS).toContain('bank');
    expect(r.SALE_METHODS).not.toContain('bank');
    expect(r.PRODUCT_CATEGORIES).toContain('supplement');
    expect(r.LOCKER_SIZES).toEqual(['small', 'medium', 'large']);
    expect(r.DEFAULT_CATEGORIES.map((c) => c.key)).toEqual(['rent', 'electricity', 'salaries', 'equipment_repair', 'internet', 'cleaning', 'marketing', 'stock', 'other']);
  });

  it('dates: days add and count across months (M27-FR-03)', () => {
    expect(r.addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(r.addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(r.daysBetween('2026-11-01', '2026-11-30')).toBe(29);
  });

  it('amounts within bounds, whole poisha only (M27-FR-02)', () => {
    expect(r.amountBlock(100, { max: 1000 })).toBeNull();
    expect(r.amountBlock(0, { max: 1000 })).toBe('GYM_AMOUNT_OUT_OF_RANGE');
    expect(r.amountBlock(0, { min: 0, max: 1000 })).toBeNull();
    expect(r.amountBlock(1001, { max: 1000 })).toBe('GYM_AMOUNT_OUT_OF_RANGE');
    expect(r.amountBlock(10.5, { max: 1000 })).toBe('GYM_AMOUNT_OUT_OF_RANGE');
  });

  it('past dates: today back to the backdate window, never the future (M27-FR-03)', () => {
    const o = { today: '2026-11-20', backdateDays: 30 };
    expect(r.pastDateBlock('2026-11-20', o)).toBeNull();
    expect(r.pastDateBlock('2026-10-21', o)).toBeNull();
    expect(r.pastDateBlock('2026-10-20', o)).toBe('GYM_DATE_OUT_OF_RANGE');
    expect(r.pastDateBlock('2026-11-21', o)).toBe('GYM_DATE_OUT_OF_RANGE');
  });

  it('the drawer: expected = float + cash fees + cash sales − drawer expenses; the difference when closing (M27-FR-07, FR-08)', () => {
    const expected = r.drawerExpected({ opening: 100000, cashFees: 500000, cashSales: 120000, drawerExpenses: 30000 });
    expect(expected).toBe(690000);
    expect(r.drawerClose({ expected, counted: 690000 })).toEqual({ expected, counted: 690000, difference: 0, balanced: true, short: false });
    expect(r.drawerClose({ expected, counted: 680000 })).toMatchObject({ difference: -10000, balanced: false, short: true });
    expect(r.drawerClose({ expected, counted: 700000 })).toMatchObject({ difference: 10000, balanced: false, short: false });
  });

  it('a sale: total and the cost of the goods where it is known (M27-FR-17)', () => {
    expect(r.saleTotals([{ qty: 2, unitPrice: 50000, unitCost: 35000 }, { qty: 1, unitPrice: 8000, unitCost: null }, { qty: 3, unitPrice: 1000 }])).toEqual({ total: 111000, cost: 70000 });
    expect(r.saleTotals([])).toEqual({ total: 0, cost: 0 });
  });

  it('what can be sold: active, not expired, enough stock (M27-FR-18)', () => {
    const p = { status: 'active', expiresOn: '2026-12-31', stockQty: 5 };
    expect(r.sellBlock(p, { qty: 5, today: '2026-11-20' })).toBeNull();
    expect(r.sellBlock({ ...p, status: 'retired' }, { qty: 1, today: '2026-11-20' })).toBe('GYM_PRODUCT_UNAVAILABLE');
    expect(r.sellBlock({ ...p, expiresOn: '2026-11-19' }, { qty: 1, today: '2026-11-20' })).toBe('GYM_PRODUCT_EXPIRED');
    expect(r.sellBlock({ ...p, expiresOn: null }, { qty: 6, today: '2026-11-20' })).toBe('GYM_STOCK_SHORT');
  });

  it('low stock: alert once on the way down, armed again above the level (M27-FR-14)', () => {
    expect(r.lowStockChange({ before: 6, after: 5, reorderLevel: 5, alerted: false })).toBe('alert');
    expect(r.lowStockChange({ before: 5, after: 4, reorderLevel: 5, alerted: true })).toBeNull();
    expect(r.lowStockChange({ before: 4, after: 4, reorderLevel: 5, alerted: false })).toBeNull();
    expect(r.lowStockChange({ before: 3, after: 4, reorderLevel: 5, alerted: false })).toBeNull();
    expect(r.lowStockChange({ before: 4, after: 9, reorderLevel: 5, alerted: true })).toBe('rearm');
    expect(r.lowStockChange({ before: 1, after: 0, reorderLevel: 0, alerted: false })).toBeNull();
    expect(r.lowStockChange({ before: 1, after: 0, reorderLevel: 0, alerted: true })).toBe('rearm');
  });

  it('expiry alert: within the window, once per date, only stock that is there (M27-FR-15)', () => {
    const p = { expiresOn: '2026-12-10', status: 'active', stockQty: 3, expiryAlertedOn: null };
    const o = { today: '2026-11-20', alertDays: 30 };
    expect(r.expiryAlertDue(p, o)).toBe(true);
    expect(r.expiryAlertDue({ ...p, expiresOn: '2027-01-30' }, o)).toBe(false);
    expect(r.expiryAlertDue({ ...p, expiryAlertedOn: '2026-12-10' }, o)).toBe(false);
    expect(r.expiryAlertDue({ ...p, expiresOn: null }, o)).toBe(false);
    expect(r.expiryAlertDue({ ...p, status: 'retired' }, o)).toBe(false);
    expect(r.expiryAlertDue({ ...p, stockQty: 0 }, o)).toBe(false);
  });

  it('locker fee: the monthly fee per started 30 days; rental dates (M27-FR-23)', () => {
    expect(r.rentalFee({ monthlyFee: 30000, startsOn: '2026-11-01', endsOn: '2026-11-30' })).toBe(30000);
    expect(r.rentalFee({ monthlyFee: 30000, startsOn: '2026-11-01', endsOn: '2026-12-01' })).toBe(60000);
    const o = { today: '2026-11-20', backdateDays: 30, maxDays: 366 };
    expect(r.rentalBlock({ startsOn: '2026-11-20', endsOn: '2026-12-19', ...o })).toBeNull();
    expect(r.rentalBlock({ startsOn: '2026-10-01', endsOn: '2026-12-19', ...o })).toBe('GYM_DATE_OUT_OF_RANGE');
    expect(r.rentalBlock({ startsOn: '2026-11-20', endsOn: '2026-11-19', ...o })).toBe('GYM_DATE_OUT_OF_RANGE');
    expect(r.rentalBlock({ startsOn: '2026-11-20', endsOn: '2027-12-19', ...o })).toBe('GYM_DATE_OUT_OF_RANGE');
  });

  it('the locker grid states (M27-FR-22)', () => {
    const l = { status: 'available' };
    expect(r.lockerState({ status: 'out_of_service' }, null, '2026-11-20')).toBe('out_of_service');
    expect(r.lockerState(l, null, '2026-11-20')).toBe('free');
    expect(r.lockerState(l, { endsOn: '2026-11-19', paidSaleId: 'x' }, '2026-11-20')).toBe('overdue');
    expect(r.lockerState(l, { endsOn: '2026-11-30', paidSaleId: null }, '2026-11-20')).toBe('unpaid');
    expect(r.lockerState(l, { endsOn: '2026-11-30', paidSaleId: 'x' }, '2026-11-20')).toBe('taken');
  });

  it('profit and loss: fees less the provider charge, sales, cost of goods, expenses (M27-FR-27)', () => {
    const out = r.profitAndLoss({
      counterFees: 1000000,
      onlineFees: 200000,
      providerCharge: 4000,
      posSales: 150000,
      lockerFees: 30000,
      goodsCost: 90000,
      expenses: [
        { categoryId: 'a', name: 'Rent', amount: 500000 },
        { categoryId: 'b', name: 'Electricity', amount: 80000 },
      ],
    });
    expect(out).toEqual({
      income: { fees: 1196000, posSales: 150000, lockerFees: 30000, total: 1376000 },
      goodsCost: 90000,
      gross: 1286000,
      expenses: { total: 580000, byCategory: expect.any(Array) },
      net: 706000,
    });
    expect(r.profitAndLoss({ counterFees: 0, onlineFees: 0, providerCharge: 0, posSales: 0, lockerFees: 0, goodsCost: 0, expenses: [] }).net).toBe(0);
  });

  it('the period before: the calendar month before, or the same length just before (M27-FR-27)', () => {
    expect(r.previousPeriod('2026-11-01', '2026-11-30')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(r.previousPeriod('2026-11-01', '2026-11-07')).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(r.previousPeriod('2026-03-01', '2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(r.previousPeriod('2026-03-01', '2026-03-30')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(r.previousPeriod('2027-01-01', '2027-01-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(r.previousPeriod('2026-11-20', '2026-11-20')).toEqual({ from: '2026-11-19', to: '2026-11-19' });
    expect(r.previousPeriod('2026-10-01', '2026-11-30')).toEqual({ from: '2026-08-01', to: '2026-09-30' });
  });

  it('VAT inside a VAT-inclusive amount, rounded half up (M27-FR-28)', () => {
    expect(r.vatPart(115000, 1500)).toEqual({ bps: 1500, vat: 15000, net: 100000 });
    expect(r.vatPart(100000, 1500)).toEqual({ bps: 1500, vat: 13043, net: 86957 });
    expect(r.vatPart(100000, null)).toBeNull();
    expect(r.vatPart(100000, 0)).toBeNull();
  });
});

describe('M27 gym-ops rules, round 2', () => {
  it('session times in Dhaka (UTC+6) and dates ahead (M27-FR-47)', () => {
    const w = r.sessionWindow('2026-11-10', '06:30', 60);
    expect(w.startsAt.toISOString()).toBe('2026-11-10T00:30:00.000Z');
    expect(w.endsAt.toISOString()).toBe('2026-11-10T01:30:00.000Z');
    expect(r.dowOf('2026-11-08')).toBe(0);
    expect(r.datesAhead('2026-11-07', 2, 1)).toEqual(['2026-11-09', '2026-11-16']);
    expect(r.datesAhead('2026-11-07', 1, 6)).toEqual(['2026-11-07']);
  });

  it('bookings, the waitlist, when a session takes bookings (M27-FR-48, FR-49)', () => {
    expect(r.bookingOutcome({ booked: 9, waitlisted: 0, capacity: 10, waitlistMax: 2 })).toBe('booked');
    expect(r.bookingOutcome({ booked: 10, waitlisted: 1, capacity: 10, waitlistMax: 2 })).toBe('waitlisted');
    expect(r.bookingOutcome({ booked: 10, waitlisted: 2, capacity: 10, waitlistMax: 2 })).toBeNull();
    const startsAt = new Date('2026-11-10T00:30:00Z');
    expect(r.sessionBookBlock({ status: 'scheduled', startsAt, now: new Date('2026-11-10T00:00:00Z') })).toBeNull();
    expect(r.sessionBookBlock({ status: 'scheduled', startsAt, now: startsAt })).toBe('GYM_CLASS_STARTED');
    expect(r.sessionBookBlock({ status: 'cancelled', startsAt, now: new Date(0) })).toBe('GYM_CLASS_SESSION_STATE');
  });

  it('cancelling: members until the cutoff, the desk until the start (M27-FR-50)', () => {
    const startsAt = new Date('2026-11-10T00:30:00Z');
    const at = (iso) => new Date(iso);
    expect(r.cancelBlock({ source: 'member', now: at('2026-11-09T23:30:00Z'), startsAt, cutoffMinutes: 60 })).toBeNull();
    expect(r.cancelBlock({ source: 'member', now: at('2026-11-09T23:31:00Z'), startsAt, cutoffMinutes: 60 })).toBe('GYM_CLASS_CANCEL_CLOSED');
    expect(r.cancelBlock({ source: 'desk', now: at('2026-11-10T00:30:00Z'), startsAt, cutoffMinutes: 60 })).toBeNull();
    expect(r.cancelBlock({ source: 'desk', now: at('2026-11-10T00:31:00Z'), startsAt, cutoffMinutes: 60 })).toBe('GYM_CLASS_CANCEL_CLOSED');
  });

  it('the class reminder, once, inside the window (M27-FR-53)', () => {
    const startsAt = new Date('2026-11-10T01:00:00Z');
    expect(r.classReminderDue({ startsAt, now: new Date('2026-11-10T00:10:00Z'), minutes: 60, remindedAt: null })).toBe(true);
    expect(r.classReminderDue({ startsAt, now: new Date('2026-11-09T23:59:00Z'), minutes: 60, remindedAt: null })).toBe(false);
    expect(r.classReminderDue({ startsAt, now: new Date('2026-11-10T01:00:00Z'), minutes: 60, remindedAt: null })).toBe(false);
    expect(r.classReminderDue({ startsAt, now: new Date('2026-11-10T00:10:00Z'), minutes: 60, remindedAt: new Date() })).toBe(false);
  });

  it('streak bonus: once per full run of days in a row (M27-FR-56)', () => {
    const run = (n, end = '2026-11-07') => Array.from({ length: n }, (_, i) => r.addDays(end, i - n + 1));
    expect(r.streakBonusDue(run(7), '2026-11-07', 7)).toBe(true);
    expect(r.streakBonusDue(run(6), '2026-11-07', 7)).toBe(false);
    expect(r.streakBonusDue(run(8), '2026-11-07', 7)).toBe(false);
    expect(r.streakBonusDue(run(14), '2026-11-07', 7)).toBe(true);
    expect(r.streakBonusDue(run(7, '2026-11-06'), '2026-11-07', 7)).toBe(false);
  });

  it('points: expiry first in first out, redeeming (M27-FR-59, FR-60)', () => {
    expect(r.pointsToExpire({ earnedDue: 100, consumed: 30 })).toBe(70);
    expect(r.pointsToExpire({ earnedDue: 100, consumed: 130 })).toBe(0);
    expect(r.redeemBlock({ balance: 100, reward: { status: 'active', points: 100 } })).toBeNull();
    expect(r.redeemBlock({ balance: 99, reward: { status: 'active', points: 100 } })).toBe('GYM_POINTS_SHORT');
    expect(r.redeemBlock({ balance: 999, reward: { status: 'retired', points: 100 } })).toBe('GYM_REWARD_UNAVAILABLE');
    expect(r.redeemBlock({ balance: 999, reward: null })).toBe('GYM_REWARD_UNAVAILABLE');
  });

  it('notice segments (M27-FR-62)', () => {
    const o = { daysMax: 365 };
    expect(r.segmentBlock({ kind: 'active' }, o)).toBeNull();
    expect(r.segmentBlock({ kind: 'expiring', days: 7 }, o)).toBeNull();
    expect(r.segmentBlock({ kind: 'expired', days: 0 }, o)).toBe('GYM_NOTICE_SEGMENT');
    expect(r.segmentBlock({ kind: 'not_seen', days: 400 }, o)).toBe('GYM_NOTICE_SEGMENT');
    expect(r.segmentBlock({ kind: 'not_seen', days: 1.5 }, o)).toBe('GYM_NOTICE_SEGMENT');
    expect(r.segmentBlock({ kind: 'package', packageId: 'p' }, o)).toBeNull();
    expect(r.segmentBlock({ kind: 'package' }, o)).toBe('GYM_NOTICE_SEGMENT');
    expect(r.segmentBlock({ kind: 'class', classId: 'c' }, o)).toBeNull();
    expect(r.segmentBlock({ kind: 'class' }, o)).toBe('GYM_NOTICE_SEGMENT');
    expect(r.segmentBlock({ kind: 'everyone' }, o)).toBe('GYM_NOTICE_SEGMENT');
  });
});

// M27 round 3: staff attendance, payroll and equipment (M27-FR-72 to FR-86).
describe('M27 gym-ops rules, round 3', () => {
  it('shifts: a day and a start before the end (M27-FR-72)', () => {
    expect(r.shiftBlock({ dow: 1, startTime: '06:00', endTime: '14:00' })).toBeNull();
    expect(r.shiftBlock({ dow: 7, startTime: '06:00', endTime: '14:00' })).toBe('GYM_SHIFT_TIMES');
    expect(r.shiftBlock({ dow: 1.5, startTime: '06:00', endTime: '14:00' })).toBe('GYM_SHIFT_TIMES');
    expect(r.shiftBlock({ dow: -1, startTime: '06:00', endTime: '14:00' })).toBe('GYM_SHIFT_TIMES');
    expect(r.shiftBlock({ dow: 1, startTime: '6:00', endTime: '14:00' })).toBe('GYM_SHIFT_TIMES');
    expect(r.shiftBlock({ dow: 1, startTime: '06:00' })).toBe('GYM_SHIFT_TIMES');
    expect(r.shiftBlock({ dow: 1, endTime: '06:00' })).toBe('GYM_SHIFT_TIMES');
    expect(r.shiftBlock({ dow: 1, startTime: '14:00', endTime: '14:00' })).toBe('GYM_SHIFT_TIMES');
    expect(r.shiftBlock({ dow: 1, startTime: '22:00', endTime: '06:00' })).toBe('GYM_SHIFT_TIMES');
  });

  it('clocking toggles; intervals pair ins and outs; auto-closed ones count no time (M27-FR-73, FR-75)', () => {
    expect(r.nextClockKind(null)).toBe('in');
    expect(r.nextClockKind({ kind: 'out' })).toBe('in');
    expect(r.nextClockKind({ kind: 'in' })).toBe('out');
    const t = (kind, hhmm, method = 'desk') => ({ kind, at: `2026-11-09T${hhmm}:00.000Z`, method });
    const rows = [t('out', '00:10'), t('in', '01:00'), t('out', '03:30'), t('in', '04:00'), t('in', '05:00'), t('out', '06:00', 'auto'), t('in', '07:00')];
    const iv = r.clockIntervals(rows);
    expect(iv).toEqual([
      { inAt: rows[1].at, outAt: rows[2].at, auto: false },
      { inAt: rows[3].at, outAt: null, auto: false },
      { inAt: rows[4].at, outAt: rows[5].at, auto: true },
      { inAt: rows[6].at, outAt: null, auto: false },
    ]);
    expect(r.workedMinutes(iv)).toBe(150);
    expect(r.clockIntervals(rows.slice(1, 3))).toEqual([{ inAt: rows[1].at, outAt: rows[2].at, auto: false }]);
    expect(r.workedMinutes([{ inAt: rows[2].at, outAt: rows[1].at, auto: false }])).toBe(0);
    expect(r.dhakaMinutes('2026-11-09T01:15:00Z')).toBe(7 * 60 + 15);
  });

  it('late and missed shifts over a period (M27-FR-74)', () => {
    // 9 Nov 2026 is a Monday (dow 1); shifts at 07:00 Dhaka (01:00 UTC).
    const shifts = [
      { dow: 1, startTime: '07:00' },
      { dow: 2, startTime: '07:00' },
      { dow: 3, startTime: '07:00' },
      { dow: 4, startTime: '07:00' },
    ];
    const times = [
      { kind: 'in', localDate: '2026-11-09', at: '2026-11-09T01:20:00Z' }, // 07:20, late with a 10-minute grace
      { kind: 'in', localDate: '2026-11-09', at: '2026-11-09T01:05:00Z' }, // an earlier one on the same day wins: on time
      { kind: 'out', localDate: '2026-11-10', at: '2026-11-10T09:00:00Z' },
      { kind: 'in', localDate: '2026-11-10', at: '2026-11-10T01:30:00Z' }, // 07:30, late
      { kind: 'in', localDate: '2026-11-10', at: '2026-11-10T05:00:00Z' }, // a later one the same day changes nothing
    ];
    // 11 Nov has no clock-in: missed. 12 Nov is today: neither.
    expect(r.shiftMarks({ shifts, times, from: '2026-11-09', to: '2026-11-15', today: '2026-11-12', graceMinutes: 10 })).toEqual({ late: 1, missed: 1 });
    expect(r.shiftMarks({ shifts, times: times.slice(0, 1), from: '2026-11-09', to: '2026-11-09', today: '2026-11-20', graceMinutes: 30 })).toEqual({ late: 0, missed: 0 });
  });

  it('payroll months, commissions, terms and lines (M27-FR-76 to FR-80)', () => {
    expect(r.periodRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(r.periodBlock('2026-11', '2026-11-09')).toBeNull();
    expect(r.periodBlock('2026-12', '2026-11-09')).toBe('GYM_PAYROLL_PERIOD');
    expect(r.periodBlock('2026-13', '2026-11-09')).toBe('GYM_PAYROLL_PERIOD');
    expect(r.periodBlock(undefined, '2026-11-09')).toBe('GYM_PAYROLL_PERIOD');
    expect(r.commissionOf(12345, 1000)).toBe(1235); // 1234.5 rounds half up
    expect(r.commissionOf(12344, 1000)).toBe(1234);
    const lim = { salaryMax: 5000000, commissionMax: 5000 };
    expect(r.payTermsBlock({ basePoisha: 1500000, ptCommissionBps: 1000, salesCommissionBps: 500 }, lim)).toBeNull();
    expect(r.payTermsBlock({ basePoisha: 6000000, ptCommissionBps: 0, salesCommissionBps: 0 }, lim)).toBe('GYM_AMOUNT_OUT_OF_RANGE');
    expect(r.payTermsBlock({ basePoisha: -1, ptCommissionBps: 0, salesCommissionBps: 0 }, lim)).toBe('GYM_AMOUNT_OUT_OF_RANGE');
    expect(r.payTermsBlock({ basePoisha: 1.5, ptCommissionBps: 0, salesCommissionBps: 0 }, lim)).toBe('GYM_AMOUNT_OUT_OF_RANGE');
    expect(r.payTermsBlock({ basePoisha: 0, ptCommissionBps: 6000, salesCommissionBps: 0 }, lim)).toBe('GYM_COMMISSION_OUT_OF_RANGE');
    expect(r.payTermsBlock({ basePoisha: 0, ptCommissionBps: 0, salesCommissionBps: -1 }, lim)).toBe('GYM_COMMISSION_OUT_OF_RANGE');
    expect(r.payTermsBlock({ basePoisha: 0, ptCommissionBps: 0, salesCommissionBps: 0.5 }, lim)).toBe('GYM_COMMISSION_OUT_OF_RANGE');
    // Worked example: base 15,000 taka, 10% of 20,000 PT fees, 5% of 9,000 sales, 500 bonus, 200 deduction.
    const line = r.payrollLine({ basePoisha: 1500000, ptCommissionBps: 1000, salesCommissionBps: 500, ptBasePoisha: 2000000, salesBasePoisha: 900000, bonusPoisha: 50000, deductionPoisha: 20000 });
    expect(line).toMatchObject({ ptCommissionPoisha: 200000, salesCommissionPoisha: 45000, netPoisha: 1775000 });
    expect(r.payrollLine({ basePoisha: 100, ptCommissionBps: 0, salesCommissionBps: 0, ptBasePoisha: 0, salesBasePoisha: 0 }).netPoisha).toBe(100);
    expect(r.lineBlock(line, { adjustMax: 100000 })).toBeNull();
    expect(r.lineBlock({ ...line, bonusPoisha: 200000 }, { adjustMax: 100000 })).toBe('GYM_AMOUNT_OUT_OF_RANGE');
    expect(r.lineBlock({ ...line, deductionPoisha: -1 }, { adjustMax: 100000 })).toBe('GYM_AMOUNT_OUT_OF_RANGE');
    expect(r.lineBlock({ bonusPoisha: 0, deductionPoisha: 0.5, netPoisha: 1 }, { adjustMax: 100000 })).toBe('GYM_AMOUNT_OUT_OF_RANGE');
    expect(r.lineBlock({ bonusPoisha: 0, deductionPoisha: 100, netPoisha: -1 }, { adjustMax: 100000 })).toBe('GYM_PAYROLL_NEGATIVE');
    expect(r.runPaid([{ status: 'paid', netPoisha: 5 }, { status: 'unpaid', netPoisha: 0 }])).toBe(true);
    expect(r.runPaid([{ status: 'paid', netPoisha: 5 }, { status: 'unpaid', netPoisha: 3 }])).toBe(false);
  });

  it('equipment: the next service date and the reminder (M27-FR-83, FR-85)', () => {
    expect(r.ASSET_CATEGORIES).toContain('cardio');
    expect(r.ASSET_STATUSES).toEqual(['working', 'needs_service', 'out_of_order', 'retired']);
    expect(r.nextServiceOn({ every: 90, lastServiceOn: '2026-11-01', boughtOn: '2026-01-01', today: '2026-11-09' })).toBe('2027-01-30');
    expect(r.nextServiceOn({ every: 30, boughtOn: '2026-11-01', today: '2026-11-09' })).toBe('2026-12-01');
    expect(r.nextServiceOn({ every: 30, today: '2026-11-09' })).toBe('2026-12-09');
    expect(r.nextServiceOn({ every: null, today: '2026-11-09' })).toBeNull();
    const o = { today: '2026-11-09', alertDays: 3 };
    expect(r.serviceAlertDue({ status: 'working', nextServiceOn: '2026-11-12', serviceAlertedOn: null }, o)).toBe(true);
    expect(r.serviceAlertDue({ status: 'working', nextServiceOn: '2026-11-13', serviceAlertedOn: null }, o)).toBe(false);
    expect(r.serviceAlertDue({ status: 'working', nextServiceOn: '2026-11-12', serviceAlertedOn: '2026-11-12' }, o)).toBe(false);
    expect(r.serviceAlertDue({ status: 'retired', nextServiceOn: '2026-11-01', serviceAlertedOn: null }, o)).toBe(false);
    expect(r.serviceAlertDue({ status: 'working', nextServiceOn: null, serviceAlertedOn: null }, o)).toBe(false);
  });
});
