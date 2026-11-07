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
