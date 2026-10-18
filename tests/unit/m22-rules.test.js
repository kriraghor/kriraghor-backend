'use strict';

// M22 pure rules (100% branch gate): fees (M22-FR-06, FR-07), the prize fund (FR-05), contracts (§8),
// invoices (FR-08, FR-09), subdomains and colours (FR-11, FR-12); the organiser settlement in the
// M06 ledger rules (§6.2, FR-10) and M21's kill cap (Q126 for organisers).
const r = require('../../src/modules/organiser-saas/saas.rules');
const ledger = require('../../src/modules/payments/ledger.rules');
const esports = require('../../src/modules/esports/esports.rules');

describe('M22 fees and the prize fund', () => {
  it('charges the contract percent, else the setting; flat contracts are invoiced instead', () => {
    expect(r.feeBpsFor({ model: 'percentage', pct: null }, 10)).toBe(1000);
    expect(r.feeBpsFor({ model: 'percentage', pct: 7.5 }, 10)).toBe(750);
    expect(r.feeBpsFor({ model: 'flat', pct: null }, 10)).toBe(0);
  });

  it('sizes the fund at every place plus the capped kill reward', () => {
    const prizes = [{ amount: 150000 }, { amount: 100000 }, { amount: 50000 }];
    expect(r.requiredFund({ prizes, killReward: 0, maxPaidKills: null })).toBe(300000);
    expect(r.requiredFund({ prizes, killReward: 2000, maxPaidKills: 40 })).toBe(380000);
  });

  it('needs the deposit to equal the pool exactly (§6.3)', () => {
    expect(r.fundBlock({ required: 300000, deposited: 0 })).toBe('PRIZE_FUND_REQUIRED');
    expect(r.fundBlock({ required: 300000, deposited: 350000 })).toBe('PRIZE_FUND_AMOUNT_MISMATCH');
    expect(r.fundBlock({ required: 300000, deposited: 300000 })).toBeNull();
  });
});

describe('M22 contracts', () => {
  const k = (o) => ({ status: 'active', startsOn: '2026-10-01', endsOn: null, model: 'flat', billingCycle: 'monthly', flatFeePoisha: 500000, expiryNotifiedAt: null, ...o });

  it('moves only along the state machine', () => {
    expect(r.canContract('draft', 'active')).toBe(true);
    expect(r.canContract('active', 'suspended')).toBe(true);
    expect(r.canContract('suspended', 'active')).toBe(true);
    expect(r.canContract('ended', 'active')).toBe(false);
    expect(r.canContract('bogus', 'active')).toBe(false);
  });

  it('lets a tournament through only under an active, current contract (FR-01, FR-13)', () => {
    expect(r.contractBlock(null, '2026-10-18')).toBe('ORG_CONTRACT_REQUIRED');
    expect(r.contractBlock(k({ status: 'suspended' }), '2026-10-18')).toBe('ORG_CONTRACT_SUSPENDED');
    expect(r.contractBlock(k({ status: 'draft' }), '2026-10-18')).toBe('ORG_CONTRACT_REQUIRED');
    expect(r.contractBlock(k({ startsOn: '2026-11-01' }), '2026-10-18')).toBe('ORG_CONTRACT_REQUIRED');
    expect(r.contractBlock(k({ endsOn: '2026-10-17' }), '2026-10-18')).toBe('ORG_CONTRACT_REQUIRED');
    expect(r.contractBlock(k({ endsOn: '2026-10-18' }), '2026-10-18')).toBeNull();
  });

  it('ends after ends_on and reminds notice days before', () => {
    expect(r.expired(k({}), '2026-10-18')).toBe(false);
    expect(r.expired(k({ endsOn: '2026-10-17' }), '2026-10-18')).toBe(true);
    expect(r.noticeDue(k({ endsOn: '2026-10-31' }), '2026-10-18', 14)).toBe(true);
    expect(r.noticeDue(k({ endsOn: '2026-11-30' }), '2026-10-18', 14)).toBe(false);
    expect(r.noticeDue(k({ endsOn: '2026-10-31', expiryNotifiedAt: new Date() }), '2026-10-18', 14)).toBe(false);
    expect(r.noticeDue(k({ endsOn: '2026-10-10' }), '2026-10-18', 14)).toBe(false);
    expect(r.noticeDue(k({}), '2026-10-18', 14)).toBe(false);
  });
});

describe('M22 invoices', () => {
  const k = (o) => ({ status: 'active', startsOn: '2026-10-01', endsOn: null, model: 'flat', billingCycle: 'monthly', flatFeePoisha: 500000, ...o });

  it('bills calendar months and quarters (Dhaka dates)', () => {
    expect(r.periodOf('monthly', '2026-02-14')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(r.periodOf('quarterly', '2026-11-03')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(r.periodOf('quarterly', '2026-01-31')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(r.periodOf('per_tournament', '2026-10-18')).toBeNull();
    expect(r.addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('owes an invoice only for an active flat contract that has started and not ended', () => {
    expect(r.invoiceDue(k({}), '2026-10-18')).toEqual({ periodStart: '2026-10-01', periodEnd: '2026-10-31', subtotal: 500000 });
    expect(r.invoiceDue(k({ model: 'percentage' }), '2026-10-18')).toBeNull();
    expect(r.invoiceDue(k({ status: 'suspended' }), '2026-10-18')).toBeNull();
    expect(r.invoiceDue(k({ startsOn: '2026-11-01' }), '2026-10-18')).toBeNull();
    expect(r.invoiceDue(k({ endsOn: '2026-10-01' }), '2026-10-18')).toBeNull();
    expect(r.invoiceDue(k({ billingCycle: 'per_tournament' }), '2026-10-18')).toBeNull();
  });

  it('adds VAT only when switched on (Q136)', () => {
    expect(r.invoiceAmounts(500000, { vatEnabled: false, vatPct: 15 })).toEqual({ subtotal: 500000, vat: 0, total: 500000 });
    expect(r.invoiceAmounts(500000, { vatEnabled: true, vatPct: 15 })).toEqual({ subtotal: 500000, vat: 75000, total: 575000 });
  });

  it('turns overdue after the due date and blocks submits after the grace days (FR-09, Q134)', () => {
    const now = new Date('2026-10-18T06:00:00Z');
    expect(r.overdue({ status: 'issued', dueAt: new Date('2026-10-18T05:00:00Z') }, now)).toBe(true);
    expect(r.overdue({ status: 'issued', dueAt: new Date('2026-10-19T05:00:00Z') }, now)).toBe(false);
    expect(r.overdue({ status: 'paid', dueAt: new Date('2026-10-01T05:00:00Z') }, now)).toBe(false);
    const due = (d, status = 'overdue') => ({ status, dueAt: new Date(d) });
    expect(r.publishBlocked([due('2026-10-03T06:00:00Z')], now, 14)).toBe(true);
    expect(r.publishBlocked([due('2026-10-05T06:00:00Z')], now, 14)).toBe(false);
    expect(r.publishBlocked([due('2026-09-01T06:00:00Z', 'paid')], now, 14)).toBe(false);
    expect(r.publishBlocked([], now, 14)).toBe(false);
  });
});

describe('M22 branding', () => {
  const reserved = ['www', 'admin', 'esports'];

  it('validates subdomains (FR-12)', () => {
    expect(r.subdomainBlock('dhaka-clutch', reserved)).toBeNull();
    expect(r.subdomainBlock('ab', reserved)).toBe('SUBDOMAIN_INVALID');
    expect(r.subdomainBlock('-dhaka', reserved)).toBe('SUBDOMAIN_INVALID');
    expect(r.subdomainBlock('dhaka--clutch', reserved)).toBe('SUBDOMAIN_INVALID');
    expect(r.subdomainBlock(null, reserved)).toBe('SUBDOMAIN_INVALID');
    expect(r.subdomainBlock('admin', reserved)).toBe('SUBDOMAIN_RESERVED');
  });

  it('checks WCAG AA contrast (FR-11)', () => {
    expect(r.contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(r.brandingBlock({ primaryHex: '#0b7a4b', accentHex: '#f2a33a' })).toBeNull();
    expect(r.brandingBlock({ primaryHex: '#c8f53c', accentHex: '#f2a33a' })).toBe('BRAND_PRIMARY_CONTRAST');
    expect(r.brandingBlock({ primaryHex: '#0b7a4b', accentHex: '#1a1b18' })).toBe('BRAND_ACCENT_CONTRAST');
  });
});

describe('M22 organiser settlement (M06 ledger rules, §6.2)', () => {
  const base = { entryAccount: 'escrow:esports_entry', fundAccount: 'escrow:esports_prize_fund', vertical: 'esports_saas', organiserId: 'org-owner' };
  const entries = (n, each) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, available: each }));

  it('settles the worked example: ৳480 fee, ৳4,320 to the organiser, prizes from the fund, both pools at zero', () => {
    const s = ledger.organiserSettlement({ ...base, entryHolds: entries(12, 40000), fundHolds: [{ id: 'f1', available: 300000 }], prizes: [{ payeeId: 'a', amount: 150000 }, { payeeId: 'b', amount: 100000 }, { payeeId: 'c', amount: 50000 }], feeBps: 1000 });
    expect(s).toMatchObject({ collected: 480000, funded: 300000, paid: 300000, fee: 48000, net: 432000, fundReturn: 0 });
    expect(ledger.validateLines(s.prizeLines)).toBe(300000);
    expect(ledger.validateLines(s.organiserLines)).toBe(480000);
    expect(s.organiserLines.find((l) => l.account === 'payable:user:org-owner').credit).toBe(432000);
    expect(s.feeByHold.reduce((a, b) => a + b, 0)).toBe(48000);
  });

  it('returns the unused fund (unpaid places, capped kills) to the organiser, never subsidising', () => {
    const s = ledger.organiserSettlement({ ...base, entryHolds: entries(2, 40000), fundHolds: [{ id: 'f1', available: 200000 }, { id: 'f2', available: 180000 }], prizes: [{ payeeId: 'a', amount: 250000 }], feeBps: 0 });
    expect(s).toMatchObject({ fee: 0, fundReturn: 130000 });
    expect(s.prizeLines.filter((l) => l.debit).map((l) => [l.holdId, l.debit])).toEqual([
      ['f1', 200000],
      ['f2', 50000],
    ]);
    expect(s.organiserLines.find((l) => l.account === 'payable:user:org-owner').credit).toBe(80000 + 130000);
    expect(s.organiserLines.some((l) => l.account.startsWith('fee_revenue'))).toBe(false);
    expect(() => ledger.organiserSettlement({ ...base, entryHolds: [], fundHolds: [{ id: 'f1', available: 100 }], prizes: [{ payeeId: 'a', amount: 200 }], feeBps: 0 })).toThrow('The prizes exceed the prize fund');
    expect(() => ledger.organiserSettlement({ ...base, entryHolds: [], fundHolds: [{ id: 'f1', available: 100 }], prizes: [{ payeeId: 'a', amount: 0 }], feeBps: 0 })).toThrow('more than zero');
  });

  it('returns a cancelled tournament\'s fund; nothing to post when there is nothing', () => {
    const cancelled = ledger.organiserSettlement({ ...base, entryHolds: [{ id: 'e0', available: 0 }], fundHolds: [{ id: 'f1', available: 300000 }], prizes: [], feeBps: 1000 });
    expect(cancelled.prizeLines).toEqual([]);
    expect(ledger.validateLines(cancelled.organiserLines)).toBe(300000);
    const empty = ledger.organiserSettlement({ ...base, entryHolds: [], fundHolds: [], prizes: [], feeBps: 1000 });
    expect([empty.prizeLines, empty.organiserLines]).toEqual([[], []]);
    // A 100% fee leaves nothing for the organiser from the entries.
    const all = ledger.organiserSettlement({ ...base, entryHolds: entries(1, 40000), fundHolds: [], prizes: [], feeBps: 10000 });
    expect(all.organiserLines.some((l) => l.account === 'payable:user:org-owner')).toBe(false);
  });

  it('collects an invoice hold straight to revenue', () => {
    expect(ledger.revenueLines({ escrowAccount: 'escrow:fee_invoice', holdId: 'h', vertical: 'esports_saas', amount: 500000 })).toEqual([
      { account: 'escrow:fee_invoice', debit: 500000, holdId: 'h' },
      { account: 'fee_revenue:esports_saas', credit: 500000 },
    ]);
    expect(() => ledger.revenueLines({ escrowAccount: 'escrow:fee_invoice', holdId: 'h', vertical: 'esports_saas', amount: 0 })).toThrow('Nothing to collect');
  });
});

describe('M21 kill cap for organisers', () => {
  it('pays the full reward within the cap, else the capped total over every kill (rounded down)', () => {
    expect(esports.cappedKillReward(2000, 30, null)).toBe(2000);
    expect(esports.cappedKillReward(2000, 30, 40)).toBe(2000);
    expect(esports.cappedKillReward(2000, 50, 40)).toBe(1600);
    expect(esports.cappedKillReward(1000, 30, 20)).toBe(666);
  });
});
