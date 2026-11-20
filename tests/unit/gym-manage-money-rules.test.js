'use strict';

/**
 * M24 prompt 2 rules (§6.3, §6.5, §6.6, §6.9), pure, at 100% branch coverage with the prompt 1 file:
 * the provider charge (M24-FR-43), effective fees and overrides (FR-94), invoices and the November
 * worked example (FR-82 to FR-88), dunning (FR-86), the reminder schedule (FR-55, FR-56), online fee
 * checks, captures, refunds and payment-link tokens (FR-40 to FR-44), reports (FR-71).
 */
require('../env');
const crypto = require('crypto');
const r = require('../../src/modules/gym-manage/gym-manage.rules');

const sign = (text) => crypto.createHmac('sha256', 'test-secret').update(text).digest('hex');

describe('months', () => {
  it('counts and moves months, last days, the month before (invoices and reports in arrears)', () => {
    expect(r.monthsBetween('2026-08-01', '2026-11-01')).toBe(3);
    expect(r.monthsBetween('2026-11-15', '2027-01-01')).toBe(2);
    expect(r.addMonths('2026-12-15', 1)).toBe('2027-01-01');
    expect(r.addMonths('2027-01-31', -1)).toBe('2026-12-01');
    expect(r.lastOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(r.daysInMonth('2028-02-03')).toBe(29);
    expect(r.previousMonth('2027-01-01')).toEqual({ start: '2026-12-01', end: '2026-12-31', month: '2026-12' });
  });
});

describe('provider charge (§6.3, M24-FR-43)', () => {
  const bpsMap = { bkash: 200, nagad: 200, card: 250 };
  it('the worked example: ৳1,500 by bKash at 200 bps → ৳30', () => {
    expect(r.providerCharge({ amount: 150000, method: 'bkash', passthrough: true, bpsMap })).toEqual({ bps: 200, charge: 3000 });
  });
  it('rounds half up; card rate; an unknown method uses the highest rate; pass-through off is 0', () => {
    expect(r.providerCharge({ amount: 199, method: 'card', passthrough: true, bpsMap })).toEqual({ bps: 250, charge: 5 });
    expect(r.providerCharge({ amount: 10000, method: 'other', passthrough: true, bpsMap })).toEqual({ bps: 250, charge: 250 });
    expect(r.providerCharge({ amount: 10000, method: 'bkash', passthrough: false, bpsMap })).toEqual({ bps: 0, charge: 0 });
    expect(r.providerCharge({ amount: 10000, method: 'bkash', passthrough: true })).toEqual({ bps: 0, charge: 0 });
  });
});

describe('effective fee and overrides (§6.5, M24-FR-94)', () => {
  const at = new Date('2026-11-10T00:00:00Z');
  const o = (scopeType, scopeId, value, extra = {}) => ({ id: `${scopeType}-${value}`, key: 'fees.gym_referral_poisha', scopeType, scopeId, value: String(value), status: 'active', validFrom: '2026-11-01T00:00:00Z', validTo: null, ...extra });
  const setting = { value: 20000, version: 3 };
  it('gym beats owner beats setting', () => {
    const overrides = [o('owner', 'own', 15000), o('gym', 'g1', 10000)];
    expect(r.effectiveFee({ key: 'fees.gym_referral_poisha', gymId: 'g1', ownerId: 'own', at, overrides, setting })).toMatchObject({ value: 10000, source: 'gym_override', overrideId: 'gym-10000', settingVersion: null });
    expect(r.effectiveFee({ key: 'fees.gym_referral_poisha', gymId: 'g2', ownerId: 'own', at, overrides, setting })).toMatchObject({ value: 15000, source: 'owner_override' });
    expect(r.effectiveFee({ key: 'fees.gym_referral_poisha', ownerId: 'own', at, overrides, setting })).toMatchObject({ value: 15000, source: 'owner_override' });
    expect(r.effectiveFee({ key: 'fees.gym_referral_poisha', gymId: 'g1', ownerId: 'other', at, overrides: [], setting })).toEqual({ value: 20000, source: 'setting', overrideId: null, settingVersion: 3, validTo: null });
    expect(r.effectiveFee({ key: 'fees.gym_referral_poisha', ownerId: 'other', at, setting }).source).toBe('setting');
  });
  it('window edges: valid_from inclusive, valid_to exclusive; ended rows and other keys never apply', () => {
    const edge = [o('owner', 'own', 1, { validFrom: '2026-11-10T00:00:00Z', validTo: '2026-12-01T00:00:00Z' })];
    expect(r.effectiveFee({ key: 'fees.gym_referral_poisha', ownerId: 'own', at, overrides: edge, setting })).toMatchObject({ source: 'owner_override', validTo: '2026-12-01T00:00:00Z' });
    expect(r.overrideActive(edge[0], new Date('2026-12-01T00:00:00Z'))).toBe(false);
    expect(r.overrideActive(edge[0], new Date('2026-11-09T23:59:59Z'))).toBe(false);
    expect(r.overrideActive({ ...edge[0], status: 'ended' }, at)).toBe(false);
    expect(r.effectiveFee({ key: 'fees.gym_pct', ownerId: 'own', at, overrides: edge, setting: { value: 5, version: 1 } }).source).toBe('setting');
  });
  it('bounds', () => {
    expect(r.overrideBlock({ value: 100001, min: 0, max: 100000 })).toBe('GYM_OVERRIDE_OUT_OF_BOUNDS');
    expect(r.overrideBlock({ value: -1, min: 0, max: 100000 })).toBe('GYM_OVERRIDE_OUT_OF_BOUNDS');
    expect(r.overrideBlock({ value: 0, min: 0, max: 100000 })).toBeNull();
  });
});

describe('the owner subscription and invoices (§6.6, M24-FR-82 to FR-88)', () => {
  const cfg = { freeMax: 30, basicMax: 100, standardMax: 300, proMinGyms: 3 };
  const prices = { basic: 79900, standard: 150000, pro: 250000 };
  const base = { periodStart: '2026-11-01', periodEnd: '2026-11-30', prices, startedOn: '2026-01-10', vat: { enabled: false, pct: 15 } };
  it('fit tier and billed tier (the higher of the chosen and the fitting tier, G18, G20)', () => {
    expect(r.ownerFitTier({ peak: 142, gymsWithMembers: 1, cfg })).toBe('standard');
    expect(r.ownerFitTier({ peak: 10, gymsWithMembers: 3, cfg })).toBe('pro');
    expect(r.billedTier({ monthMaxTier: 'basic', fit: 'standard' })).toBe('standard');
    expect(r.billedTier({ monthMaxTier: 'pro', fit: 'free' })).toBe('pro');
  });
  it('M24-FR-84 the November worked example: Standard ৳1,500 − founding 25% + 2 referrals of ৳200 = ৳1,525', () => {
    const fit = r.ownerFitTier({ peak: 142, gymsWithMembers: 1, cfg });
    const inv = r.invoiceLines({ ...base, tier: r.billedTier({ monthMaxTier: 'basic', fit }), founding: { partner: true, paidTierSince: '2026-08-01', freeMonths: 2, discountMonths: 12, discountPct: 25 }, referrals: [{ amount: 20000 }, { amount: 20000 }] });
    expect(inv.lines.map((l) => [l.kind, l.quantity, l.unitPoisha, l.amountPoisha])).toEqual([
      ['tier', 1, 150000, 150000],
      ['founding_discount', 1, -37500, -37500],
      ['referral', 2, 20000, 40000],
    ]);
    expect(inv).toMatchObject({ subtotal: 152500, vat: 0, total: 152500 });
  });
  it('first month prorated; founding free months; VAT when enabled; referrals grouped by amount', () => {
    const first = r.invoiceLines({ ...base, startedOn: '2026-11-16', tier: 'basic' });
    expect(first.lines.map((l) => [l.kind, l.amountPoisha])).toEqual([
      ['tier', 79900],
      ['proration', 39950 - 79900],
    ]);
    expect(first.total).toBe(39950);
    const free = r.invoiceLines({ ...base, tier: 'basic', founding: { partner: true, paidTierSince: '2026-10-01', freeMonths: 2, discountMonths: 12, discountPct: 25 } });
    expect(free.total).toBe(0);
    const vat = r.invoiceLines({ ...base, tier: 'basic', vat: { enabled: true, pct: 15 }, referrals: [{ amount: 15000 }, { amount: 20000 }] });
    expect(vat.lines.map((l) => [l.kind, l.quantity, l.amountPoisha])).toEqual([
      ['tier', 1, 79900],
      ['referral', 1, 20000],
      ['referral', 1, 15000],
      ['vat', 1, 17235],
    ]);
    expect(vat).toMatchObject({ subtotal: 114900, vat: 17235, total: 132135 });
  });
  it('free tier with no referrals → nothing to invoice; founding past its months, not yet started, or not a partner bills in full', () => {
    expect(r.invoiceLines({ ...base, tier: 'free' })).toEqual({ lines: [], subtotal: 0, vat: 0, total: 0 });
    expect(r.invoiceLines({ ...base, tier: 'free', referrals: [{ amount: 20000 }] }).total).toBe(20000);
    expect(r.invoiceLines({ ...base, tier: 'basic', founding: { partner: true, paidTierSince: '2025-01-01', freeMonths: 2, discountMonths: 12, discountPct: 25 } }).total).toBe(79900);
    expect(r.invoiceLines({ ...base, tier: 'basic', founding: { partner: true, paidTierSince: '2026-08-01', freeMonths: 2, discountMonths: 12, discountPct: 0 } }).total).toBe(79900);
    expect(r.invoiceLines({ ...base, tier: 'basic', founding: { partner: true, paidTierSince: '2026-12-01', freeMonths: 2, discountMonths: 12, discountPct: 25 } }).total).toBe(79900);
    expect(r.invoiceLines({ ...base, tier: 'basic', founding: { partner: false, paidTierSince: '2026-11-01', freeMonths: 2, discountMonths: 0, discountPct: 0 } }).total).toBe(79900);
    expect(r.invoiceLines({ ...base, tier: 'basic', founding: { partner: true, paidTierSince: null, freeMonths: 2, discountMonths: 0, discountPct: 0 } }).total).toBe(79900);
    expect(r.invoiceLines({ ...base, startedOn: '2026-12-02', tier: 'basic' }).total).toBe(79900);
  });
  it('founding month index and window (M24-FR-88)', () => {
    expect(r.foundingMonthIndex({ paidTierSince: '2026-08-15', periodStart: '2026-11-01' })).toBe(4);
    expect(r.foundingWindow({ foundingPartner: true, paidTierSince: '2026-10-01', freeMonths: 2, discountMonths: 12 })).toEqual({ freeUntil: '2026-11-30', discountUntil: '2027-11-30' });
    expect(r.foundingWindow({ foundingPartner: true, paidTierSince: '2026-10-01', freeMonths: 0, discountMonths: 0 })).toEqual({ freeUntil: null, discountUntil: null });
    expect(r.foundingWindow({ foundingPartner: false, paidTierSince: '2026-10-01', freeMonths: 2, discountMonths: 12 })).toEqual({ freeUntil: null, discountUntil: null });
    expect(r.foundingWindow({ foundingPartner: true, paidTierSince: null, freeMonths: 2, discountMonths: 12 })).toEqual({ freeUntil: null, discountUntil: null });
  });
});

describe('dunning (M24-FR-86, §8.6, §8.7)', () => {
  const { dueOn, dueAt } = r.invoiceDue({ issuedOn: '2026-12-01', dueDays: 7 });
  it('due on the 8th; overdue from the start of the 9th (Dhaka); restricted after the grace days', () => {
    expect(dueOn).toBe('2026-12-08');
    expect(dueAt.toISOString()).toBe('2026-12-08T18:00:00.000Z');
    expect(r.restrictOn({ dueAt, graceDays: 7 })).toBe('2026-12-15');
    expect(r.pastGrace({ dueAt, graceDays: 7, now: new Date('2026-12-15T17:59:59Z') })).toBe(false);
    expect(r.pastGrace({ dueAt, graceDays: 7, now: new Date('2026-12-15T18:00:00Z') })).toBe(true);
  });
  it('reminders 3 days before and on the due date', () => {
    expect(r.invoiceReminderKey({ dueAt, today: '2026-12-04' })).toBeNull();
    expect(r.invoiceReminderKey({ dueAt, today: '2026-12-05' })).toBe('d-3');
    expect(r.invoiceReminderKey({ dueAt, today: '2026-12-07' })).toBe('d-3');
    expect(r.invoiceReminderKey({ dueAt, today: '2026-12-08' })).toBe('d0');
    expect(r.invoiceReminderKey({ dueAt, today: '2026-12-09' })).toBeNull();
  });
  it('the subscription follows its invoices', () => {
    const now = new Date('2026-12-20T00:00:00Z');
    expect(r.subscriptionStatus({ status: 'closed', invoices: [{ status: 'overdue', dueAt }], now, graceDays: 7 })).toBe('closed');
    expect(r.subscriptionStatus({ status: 'active', invoices: [{ status: 'overdue', dueAt }], now, graceDays: 7 })).toBe('restricted');
    expect(r.subscriptionStatus({ status: 'active', invoices: [{ status: 'overdue', dueAt }], now, graceDays: 30 })).toBe('past_due');
    expect(r.subscriptionStatus({ status: 'restricted', invoices: [{ status: 'issued', dueAt }], now, graceDays: 7 })).toBe('active');
  });
});

describe('reminder schedule (§6.9, M24-FR-55, FR-56)', () => {
  it('renewal due, ends today, expired and overdue keys on their day only', () => {
    expect(r.reminderKey('renewal_due', { today: '2026-11-27', endsOn: '2026-11-30', renewalDays: [7, 3, 1] })).toBe('d-3');
    expect(r.reminderKey('renewal_due', { today: '2026-11-28', endsOn: '2026-11-30', renewalDays: [7, 3, 1] })).toBeNull();
    expect(r.reminderKey('renewal_due', { today: '2026-11-28' })).toBeNull();
    expect(r.reminderKey('ends_today', { today: '2026-11-30', endsOn: '2026-11-30' })).toBe('d0');
    expect(r.reminderKey('ends_today', { today: '2026-11-29', endsOn: '2026-11-30' })).toBeNull();
    expect(r.reminderKey('expired', { today: '2026-12-01', endsOn: '2026-11-30' })).toBe('d+1');
    expect(r.reminderKey('expired', { today: '2026-12-02', endsOn: '2026-11-30' })).toBeNull();
    expect(r.reminderKey('expired', { today: '2026-12-02' })).toBeNull();
    expect(r.reminderKey('overdue', { today: '2026-11-06', dueOn: '2026-11-03', overdueDays: [3, 7] })).toBe('d+3');
    expect(r.reminderKey('overdue', { today: '2026-11-07', dueOn: '2026-11-03', overdueDays: [3, 7] })).toBeNull();
    expect(r.reminderKey('overdue', { today: '2026-11-07', overdueDays: [3] })).toBeNull();
    expect(r.reminderKey('overdue', { today: '2026-11-07' })).toBeNull();
  });
  it('the morning summary time in Dhaka (M24-FR-60)', () => {
    expect(r.timeReached({ now: new Date('2026-11-03T01:59:00Z'), time: '08:00' })).toBe(false);
    expect(r.timeReached({ now: new Date('2026-11-03T02:00:00Z'), time: '08:00' })).toBe(true);
  });
});

describe('online fees (§5.5, M24-FR-40 to FR-44)', () => {
  it('who may take fees online: role, tier, restricted (or a suspended gym)', () => {
    const ok = { ownerRoleActive: true, hasOnlineFees: true, restricted: false, gymSuspended: false };
    expect(r.onlineFeesBlock(ok)).toBeNull();
    expect(r.onlineFeesBlock({ ...ok, ownerRoleActive: false })).toBe('role');
    expect(r.onlineFeesBlock({ ...ok, hasOnlineFees: false })).toBe('tier');
    expect(r.onlineFeesBlock({ ...ok, restricted: true })).toBe('restricted');
    expect(r.onlineFeesBlock({ ...ok, gymSuspended: true })).toBe('restricted');
  });
  it('link amount: up to the outstanding, all of it by default', () => {
    expect(r.linkAmount({ status: 'unpaid', outstanding: 250000 })).toEqual({ amount: 250000 });
    expect(r.linkAmount({ requested: 100000, status: 'partial', outstanding: 250000 })).toEqual({ amount: 100000 });
    expect(r.linkAmount({ requested: 250001, status: 'unpaid', outstanding: 250000 })).toEqual({ block: 'GYM_PAYMENT_EXCEEDS_DUE' });
    expect(r.linkAmount({ requested: 0, status: 'unpaid', outstanding: 250000 })).toEqual({ block: 'GYM_PAYMENT_EXCEEDS_DUE' });
    expect(r.linkAmount({ status: 'paid', outstanding: 0 })).toEqual({ block: 'GYM_DUE_STATE' });
    expect(r.linkAmount({ status: 'unpaid', outstanding: 0 })).toEqual({ block: 'GYM_DUE_STATE' });
  });
  it('capture: recorded while the due needs it (an expired link too), refunded otherwise (M24-FR-42)', () => {
    expect(r.captureDecision({ dueStatus: 'unpaid', outstanding: 150000, amount: 150000, linkStatus: 'open' })).toBe('record');
    expect(r.captureDecision({ dueStatus: 'partial', outstanding: 150000, amount: 100000, linkStatus: 'expired' })).toBe('record');
    expect(r.captureDecision({ dueStatus: 'paid', outstanding: 0, amount: 150000, linkStatus: 'open' })).toBe('refund');
    expect(r.captureDecision({ dueStatus: 'partial', outstanding: 50000, amount: 150000, linkStatus: 'open' })).toBe('refund');
    expect(r.captureDecision({ dueStatus: 'unpaid', outstanding: 150000, amount: 150000, linkStatus: 'cancelled' })).toBe('refund');
  });
  it('owner refunds: from the hold before release, once, up to what is left (M24-FR-44)', () => {
    const now = new Date('2026-11-03T00:00:00Z');
    const link = { releaseAt: '2026-11-04T00:00:00Z', releasedAt: null, amountPoisha: 150000, refundedPoisha: 0 };
    expect(r.refundBlock({ link, now, amount: 150000, alreadyRefunded: false })).toBeNull();
    expect(r.refundBlock({ link, now: new Date('2026-11-04T00:00:00Z'), amount: 1, alreadyRefunded: false })).toBe('GYM_REFUND_WINDOW_CLOSED');
    expect(r.refundBlock({ link: { ...link, releasedAt: now }, now, amount: 1, alreadyRefunded: false })).toBe('GYM_REFUND_WINDOW_CLOSED');
    expect(r.refundBlock({ link: { ...link, releaseAt: null }, now, amount: 1, alreadyRefunded: false })).toBe('GYM_REFUND_WINDOW_CLOSED');
    expect(r.refundBlock({ link, now, amount: 1, alreadyRefunded: true })).toBe('GYM_PAYMENT_NOT_REVERSIBLE');
    expect(r.refundBlock({ link, now, amount: 150001, alreadyRefunded: false })).toBe('GYM_REFUND_EXCEEDS_PAID');
    expect(r.refundBlock({ link, now, amount: 0, alreadyRefunded: false })).toBe('GYM_REFUND_EXCEEDS_PAID');
  });
  it('payment-link tokens: HMAC domain gym-pay, tampering refused (M24-FR-40)', () => {
    const linkId = '01936f3a-0000-7000-8000-0000000000aa';
    const t = r.payLinkToken({ linkId, nonce: 'Xk2abcdEFGH_-123' }, sign);
    expect(t).toMatch(/^v1\./);
    expect(r.parsePayLinkToken(t, { sign })).toEqual({ linkId, nonce: 'Xk2abcdEFGH_-123' });
    expect(r.parsePayLinkToken(t.replace('Xk2', 'Xk3'), { sign })).toBeNull();
    expect(r.parsePayLinkToken('v1.x.y.z', { sign })).toBeNull();
    expect(r.parsePayLinkToken(null, { sign })).toBeNull();
    expect(r.parsePayLinkToken(r.receiptToken(linkId, sign), { sign })).toBeNull();
  });
  it('first names only on the public link page (M24-FR-41)', () => {
    expect(r.firstName('Rafiq Hasan')).toBe('Rafiq');
    expect(r.firstName(null)).toBe('');
  });
});

describe('reports (§5.9, M24-FR-71)', () => {
  it('churn and periods', () => {
    expect(r.churn({ left: 3, activeAtStart: 120 })).toBe(0.025);
    expect(r.churn({ left: 3, activeAtStart: 0 })).toBeNull();
    expect(r.reportPeriod({ month: '2026-02', today: '2026-11-03' })).toEqual({ from: '2026-02-01', to: '2026-02-28', month: '2026-02' });
    expect(r.reportPeriod({ today: '2026-11-03' })).toEqual({ from: '2026-11-01', to: '2026-11-03', month: null });
    expect(r.reportPeriod({ from: '2026-10-01', to: '2026-10-15', today: '2026-11-03' })).toEqual({ from: '2026-10-01', to: '2026-10-15', month: null });
  });

  it('compares a period with the one before (M24-FR-154)', () => {
    // This month so far: the month before over the same days.
    expect(r.previousPeriod({ from: '2026-11-01', to: '2026-11-30', month: '2026-11' }, '2026-11-20')).toEqual({ from: '2026-10-01', to: '2026-10-20', month: '2026-10' });
    // A past month: the whole month before, clamped to its end.
    expect(r.previousPeriod({ from: '2026-03-01', to: '2026-03-31', month: '2026-03' }, '2026-11-20')).toEqual({ from: '2026-02-01', to: '2026-02-28', month: '2026-02' });
    // A month that has not started: its first day against the month before's first day.
    expect(r.previousPeriod({ from: '2026-12-01', to: '2026-12-31', month: '2026-12' }, '2026-11-20')).toEqual({ from: '2026-11-01', to: '2026-11-01', month: '2026-11' });
    // A range: the same number of days just before.
    expect(r.previousPeriod({ from: '2026-11-14', to: '2026-11-20', month: null }, '2026-11-20')).toEqual({ from: '2026-11-07', to: '2026-11-13', month: null });
    expect(r.previousPeriod({ from: '2026-11-14', to: '2026-11-25', month: null }, '2026-11-20')).toEqual({ from: '2026-11-07', to: '2026-11-13', month: null });
  });

  it('fills every day of a trend, zeros for the gaps (M24-FR-153)', () => {
    expect(r.fillDays('2026-11-18', '2026-11-20', [{ date: '2026-11-19', checkIns: 4, collectedPoisha: '150000' }], ['checkIns', 'collectedPoisha'])).toEqual([
      { date: '2026-11-18', checkIns: 0, collectedPoisha: 0 },
      { date: '2026-11-19', checkIns: 4, collectedPoisha: 150000 },
      { date: '2026-11-20', checkIns: 0, collectedPoisha: 0 },
    ]);
    expect(r.fillDays('2026-11-21', '2026-11-20', [], ['checkIns'])).toEqual([]);
    expect(r.fillDays('2026-11-20', '2026-11-20', [{ date: '2026-11-20' }], ['checkIns'])).toEqual([{ date: '2026-11-20', checkIns: 0 }]);
  });
});

// M27 round 1: renewal reminders at 7, 3 and 1 days; BMI; VAT inside a receipt.
describe('M27 additions to the gym-manage rules', () => {
  const r2 = require('../../src/modules/gym-manage/gym-manage.rules');
  it('renewal reminders on each listed day before the end (M27-FR-29)', () => {
    const o = { endsOn: '2026-11-30', renewalDays: [7, 3, 1] };
    expect(r2.reminderKey('renewal_due', { today: '2026-11-23', ...o })).toBe('d-7');
    expect(r2.reminderKey('renewal_due', { today: '2026-11-29', ...o })).toBe('d-1');
    expect(r2.reminderKey('renewal_due', { today: '2026-11-25', ...o })).toBeNull();
  });
  it('BMI with its band, null without height or weight (M27-FR-30)', () => {
    expect(r2.bmiOf({ heightCm: 175, weightKg: 70 })).toEqual({ value: 22.9, band: 'normal' });
    expect(r2.bmiOf({ heightCm: 170, weightKg: 50 })).toEqual({ value: 17.3, band: 'under' });
    expect(r2.bmiOf({ heightCm: 170, weightKg: 80 })).toEqual({ value: 27.7, band: 'over' });
    expect(r2.bmiOf({ heightCm: 160, weightKg: 90 })).toEqual({ value: 35.2, band: 'obese' });
    expect(r2.bmiOf({ heightCm: null, weightKg: 70 })).toBeNull();
    expect(r2.bmiOf({ heightCm: 175 })).toBeNull();
  });
  it('VAT inside an amount (M27-FR-28)', () => {
    expect(r2.vatPart(115000, 1500)).toEqual({ vat: 15000, net: 100000 });
    expect(r2.vatPart(115000, null)).toEqual({ vat: 0, net: 115000 });
  });
});

describe('M27 round 2: visit length (M27-FR-40)', () => {
  const r = require('../../src/modules/gym-manage/gym-manage.rules');
  it('whole minutes, never negative', () => {
    expect(r.visitMinutes('2026-11-07T10:00:00Z', '2026-11-07T11:29:59Z')).toBe(89);
    expect(r.visitMinutes('2026-11-07T10:00:00Z', '2026-11-07T09:59:00Z')).toBe(0);
  });
});
