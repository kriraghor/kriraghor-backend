'use strict';

/**
 * M24 gym management rules (§6), pure, at 100% branch coverage (CLAUDE.md: money and points):
 * membership dates (M24-FR-25 to FR-31, the §6.1 change example), dues (FR-32 to FR-36, §6.2), the entry
 * policy and desk flags (FR-47, FR-49, §6.8), tiers (FR-07, FR-82, FR-83), codes (FR-10, FR-33), the
 * member QR and receipt tokens (FR-37, FR-50) and import rows (FR-75).
 */
require('../env');
const crypto = require('crypto');
const r = require('../../src/modules/gym-manage/gym-manage.rules');

const sign = (text) => crypto.createHmac('sha256', 'test-secret').update(text).digest('hex');
const MEMBER = '01936f3a-0000-7000-8000-000000000001';

describe('dates (Dhaka calendar)', () => {
  it('converts instants to Dhaka dates and back; month helpers', () => {
    expect(r.dhakaDate('2026-11-02T18:00:00Z')).toBe('2026-11-03'); // 00:00 Dhaka
    expect(r.dhakaDate('2026-11-02T17:59:59Z')).toBe('2026-11-02'); // 23:59:59 Dhaka (§12.23)
    expect(r.instantOf('2026-11-03').toISOString()).toBe('2026-11-02T18:00:00.000Z');
    expect([r.addDays('2026-11-30', 1), r.daysBetween('2026-11-01', '2026-11-30'), r.monthOf('2026-11-21'), r.firstOfMonth('2026-11-21'), r.yearOf('2026-11-21')]).toEqual(['2026-12-01', 29, '2026-11', '2026-11-01', 2026]);
    expect([r.isDate('2026-02-28'), r.isDate('2026-02-30'), r.isDate('26-02-01'), r.isDate(5)]).toEqual([true, false, false, false]);
    expect(r.inWindow({ date: '2026-10-05', today: '2026-11-03', back: 30 })).toBe(true);
    expect(r.inWindow({ date: '2026-10-03', today: '2026-11-03', back: 30 })).toBe(false);
    expect(r.inWindow({ date: '2026-11-04', today: '2026-11-03' })).toBe(false);
  });
});

describe('§6.1 memberships', () => {
  it('ends_on = starts_on + days − 1 + frozen days; status and days left by date (FR-25)', () => {
    expect(r.endsOn({ startsOn: '2026-11-01', days: 30 })).toBe('2026-11-30');
    expect(r.endsOn({ startsOn: '2026-11-01', days: 30, frozenDays: 5 })).toBe('2026-12-05');
    expect(r.statusByDate({ startsOn: '2026-11-05', endsOn: '2026-12-04', today: '2026-11-03' })).toBe('upcoming');
    expect(r.statusByDate({ startsOn: '2026-10-01', endsOn: '2026-10-30', today: '2026-11-03' })).toBe('expired');
    expect(r.statusByDate({ startsOn: '2026-11-03', endsOn: '2026-12-02', today: '2026-11-03' })).toBe('active');
    expect(r.daysLeft({ startsOn: '2026-11-03', endsOn: '2026-12-02', today: '2026-11-03' })).toBe(30);
    expect(r.daysLeft({ startsOn: '2026-11-10', endsOn: '2026-11-19', today: '2026-11-03' })).toBe(10);
    expect(r.daysLeft({ startsOn: '2026-10-01', endsOn: '2026-10-30', today: '2026-11-03' })).toBe(0);
  });

  it('renewal: continuous within the grace, else the chosen date (never past) (FR-27)', () => {
    // 3 days after the end with grace 7 → continuous; 10 days after → starts on the renewal date.
    expect(r.renewStart({ today: '2026-12-03', oldEndsOn: '2026-11-30', graceDays: 7 })).toEqual({ startsOn: '2026-12-01', continuous: true });
    expect(r.renewStart({ today: '2026-12-10', oldEndsOn: '2026-11-30', graceDays: 7 })).toEqual({ startsOn: '2026-12-10', continuous: false });
    expect(r.renewStart({ today: '2026-12-10', oldEndsOn: '2026-11-30', graceDays: 7, chosen: '2026-12-15' })).toEqual({ startsOn: '2026-12-15', continuous: false });
    expect(r.renewStart({ today: '2026-12-10', oldEndsOn: '2026-11-30', graceDays: 7, chosen: '2026-12-01' })).toEqual({ block: 'GYM_DATE_OUT_OF_RANGE' });
    expect(r.overlaps({ startsOn: '2026-11-01', endsOn: '2026-11-30' }, { startsOn: '2026-11-30', endsOn: '2026-12-29' })).toBe(true);
    expect(r.overlaps({ startsOn: '2026-11-01', endsOn: '2026-11-30' }, { startsOn: '2026-12-01', endsOn: '2026-12-30' })).toBe(false);
  });

  const ms = (over = {}) => ({ status: 'active', startsOn: '2026-11-01', endsOn: '2026-11-30', frozenDays: 0, freezesCount: 0, ...over });
  const limits = { maxDays: 30, maxCount: 2 };

  it('freeze: inside the membership, from today, the end moves by the frozen days (FR-28)', () => {
    expect(r.freezePlan({ membership: ms(), fromOn: '2026-11-10', toOn: '2026-11-19', today: '2026-11-10', ...limits })).toEqual({ days: 10, endsOn: '2026-12-10', startsNow: true });
    expect(r.freezePlan({ membership: ms({ status: 'frozen' }), fromOn: '2026-11-25', toOn: '2026-11-26', today: '2026-11-10', freezes: [{ status: 'active', fromOn: '2026-11-10', toOn: '2026-11-12' }], ...limits })).toMatchObject({ days: 2, startsNow: false });
  });
  it('freeze refusals: state, dates, overlap, days and count limits', () => {
    expect(r.freezePlan({ membership: ms({ status: 'upcoming' }), fromOn: '2026-11-10', toOn: '2026-11-12', today: '2026-11-10', ...limits })).toEqual({ block: 'GYM_MEMBERSHIP_STATE', meta: { reason: 'not_active' } });
    expect(r.freezePlan({ membership: ms(), fromOn: '2026-11-09', toOn: '2026-11-12', today: '2026-11-10', ...limits }).block).toBe('GYM_DATE_OUT_OF_RANGE');
    expect(r.freezePlan({ membership: ms(), fromOn: '2026-11-12', toOn: '2026-11-11', today: '2026-11-10', ...limits }).block).toBe('GYM_DATE_OUT_OF_RANGE');
    expect(r.freezePlan({ membership: ms(), fromOn: '2026-12-01', toOn: '2026-12-02', today: '2026-11-10', ...limits }).block).toBe('GYM_DATE_OUT_OF_RANGE');
    expect(r.freezePlan({ membership: ms(), fromOn: '2026-11-11', toOn: '2026-11-12', today: '2026-11-10', freezes: [{ status: 'scheduled', fromOn: '2026-11-12', toOn: '2026-11-14' }], ...limits })).toEqual({ block: 'GYM_MEMBERSHIP_STATE', meta: { reason: 'freeze_overlap' } });
    expect(r.freezePlan({ membership: ms(), fromOn: '2026-11-11', toOn: '2026-11-12', today: '2026-11-10', freezes: [{ status: 'done', fromOn: '2026-11-11', toOn: '2026-11-12' }], ...limits }).days).toBe(2);
    // 31 frozen days with a 30-day limit → GYM_FREEZE_LIMIT.
    expect(r.freezePlan({ membership: ms({ endsOn: '2026-12-30' }), fromOn: '2026-11-10', toOn: '2026-12-10', today: '2026-11-10', ...limits })).toEqual({ block: 'GYM_FREEZE_LIMIT', meta: { limit: 'days', max: 30, used: 0 } });
    expect(r.freezePlan({ membership: ms({ freezesCount: 2 }), fromOn: '2026-11-10', toOn: '2026-11-11', today: '2026-11-10', ...limits })).toEqual({ block: 'GYM_FREEZE_LIMIT', meta: { limit: 'count', max: 2, used: 2 } });
  });
  it('unfreeze early gives back the unused days; a scheduled freeze is cancelled whole', () => {
    expect(r.unfreezePlan({ freeze: { status: 'active', fromOn: '2026-11-10', toOn: '2026-11-19' }, today: '2026-11-15' })).toEqual({ endedEarlyOn: '2026-11-15', giveBack: 5 });
    expect(r.unfreezePlan({ freeze: { status: 'active', fromOn: '2026-11-10', toOn: '2026-11-19' }, today: '2026-11-09' })).toEqual({ endedEarlyOn: '2026-11-10', giveBack: 10 });
    expect(r.unfreezePlan({ freeze: { status: 'scheduled', fromOn: '2026-11-20', toOn: '2026-11-24' }, today: '2026-11-15' })).toEqual({ cancel: true, giveBack: 5 });
    expect(r.unfreezePlan({ freeze: { status: 'active', fromOn: '2026-11-10', toOn: '2026-11-19' }, today: '2026-11-20' })).toEqual({ block: 'GYM_MEMBERSHIP_STATE' });
    expect(r.unfreezePlan({ freeze: { status: 'done', fromOn: '2026-11-10', toOn: '2026-11-19' }, today: '2026-11-15' })).toEqual({ block: 'GYM_MEMBERSHIP_STATE' });
  });

  it('change credit: the §6.1 example (FR-29)', () => {
    // 30-day ৳2,500 from 1 Nov, fully paid, changed to a 90-day ৳6,500 package on 21 Nov.
    const credit = r.changeCredit({ days: 30, endsOn: '2026-11-30', paid: 250000, changeOn: '2026-11-21' });
    expect(credit).toEqual({ remaining: 10, total: 30, credit: 83333 });
    expect(r.changeDue({ price: 650000, credit: credit.credit })).toBe(566667);
    // Half up, frozen days in the total, never negative.
    expect(r.changeCredit({ days: 30, frozenDays: 10, endsOn: '2026-12-10', paid: 100000, changeOn: '2026-12-11' })).toEqual({ remaining: 0, total: 40, credit: 0 });
    expect(r.changeCredit({ days: 3, endsOn: '2026-11-03', paid: 100, changeOn: '2026-11-02' }).credit).toBe(67);
    expect(r.changeDue({ price: 1000, admissionFee: 0, discount: 0, credit: 5000 })).toBe(0);
  });

  it('a due is price + admission − discount (FR-32: ৳2,500 + ৳1,000 − ৳500 = ৳3,000)', () => {
    expect(r.dueAmount({ price: 250000, admissionFee: 100000, discount: 50000 })).toBe(300000);
    expect(r.dueAmount({ price: 250000 })).toBe(250000);
  });

  it('member status follows the running membership (§8.1)', () => {
    expect(r.memberStatus({ current: null, status: 'left' })).toBe('left');
    expect(r.memberStatus({ current: { status: 'active' }, status: 'removed' })).toBe('removed');
    expect(r.memberStatus({ current: { status: 'active' }, status: 'new' })).toBe('active');
    expect(r.memberStatus({ current: { status: 'frozen' }, status: 'active' })).toBe('frozen');
    expect(r.memberStatus({ current: null, status: 'new' })).toBe('new');
    expect(r.memberStatus({ current: null, status: 'active' })).toBe('expired');
  });
});

describe('§6.2 dues and payments', () => {
  it('status for every payment, reversal and waiver order (FR-36: waive ৳500 of ৳3,000 with ৳1,000 paid → ৳1,500 partial)', () => {
    expect(r.dueState({ amount: 300000, paid: 100000, waived: 50000 })).toEqual({ outstanding: 150000, status: 'partial' });
    expect(r.dueState({ amount: 300000, paid: 0, waived: 0 })).toEqual({ outstanding: 300000, status: 'unpaid' });
    expect(r.dueState({ amount: 300000, paid: 300000, waived: 0 })).toEqual({ outstanding: 0, status: 'paid' });
    expect(r.dueState({ amount: 300000, paid: 0, waived: 300000 })).toEqual({ outstanding: 0, status: 'waived' });
    expect(r.dueState({ amount: 300000, paid: 200000, waived: 100000 })).toEqual({ outstanding: 0, status: 'paid' });
    expect(r.dueState({ amount: 300000, paid: 0, waived: 0, voided: true })).toEqual({ outstanding: 0, status: 'void' });
    expect(r.dueState({ amount: 100, paid: 200, waived: 0 }).outstanding).toBe(0);
  });
  it('overdue only for unpaid or partial dues after due_on (FR-39)', () => {
    expect(r.isOverdue({ status: 'unpaid', dueOn: '2026-11-02', today: '2026-11-03' })).toBe(true);
    expect(r.isOverdue({ status: 'partial', dueOn: '2026-11-03', today: '2026-11-03' })).toBe(false);
    expect(r.isOverdue({ status: 'paid', dueOn: '2026-11-01', today: '2026-11-03' })).toBe(false);
  });
  it('a payment is from the minimum to the outstanding of an open due (FR-33)', () => {
    expect(r.paymentBlock({ status: 'unpaid', outstanding: 300000, amount: 300000, min: 100 })).toBeNull();
    expect(r.paymentBlock({ status: 'partial', outstanding: 300000, amount: 300001, min: 100 })).toBe('GYM_PAYMENT_EXCEEDS_DUE');
    expect(r.paymentBlock({ status: 'unpaid', outstanding: 300000, amount: 99, min: 100 })).toBe('GYM_PAYMENT_EXCEEDS_DUE');
    expect(r.paymentBlock({ status: 'paid', outstanding: 0, amount: 100, min: 100 })).toBe('GYM_DUE_STATE');
    expect(r.paymentBlock({ status: 'unpaid', outstanding: 0, amount: 100, min: 100 })).toBe('GYM_DUE_STATE');
  });
  it('a reversal once per counter payment, never a reversal or an online payment (FR-35)', () => {
    expect(r.reversalBlock({ payment: { amountPoisha: 100, method: 'cash' }, alreadyReversed: false })).toBeNull();
    expect(r.reversalBlock({ payment: { amountPoisha: 100, method: 'cash' }, alreadyReversed: true })).toBe('GYM_PAYMENT_NOT_REVERSIBLE');
    expect(r.reversalBlock({ payment: { amountPoisha: -100, method: 'cash' }, alreadyReversed: false })).toBe('GYM_PAYMENT_NOT_REVERSIBLE');
    expect(r.reversalBlock({ payment: { amountPoisha: 100, method: 'online' }, alreadyReversed: false })).toBe('GYM_PAYMENT_NOT_REVERSIBLE');
  });
});

describe('§6.8 entry policy and the desk card', () => {
  const running = { status: 'active', endsOn: '2026-12-02', visitLimit: null };
  it('reasons and decisions per policy (FR-49)', () => {
    expect(r.entryDecision({ current: running, hadMembership: true, overdue: false, policy: 'block' })).toEqual({ reasons: [], decision: 'allow' });
    expect(r.entryDecision({ current: null, hadMembership: true, overdue: false, policy: 'warn' })).toEqual({ reasons: ['expired'], decision: 'warn' });
    expect(r.entryDecision({ current: null, hadMembership: false, overdue: true, policy: 'block' })).toEqual({ reasons: ['none', 'unpaid'], decision: 'block' });
    expect(r.entryDecision({ current: { ...running, status: 'frozen' }, hadMembership: true, overdue: false, policy: 'allow' })).toEqual({ reasons: ['frozen'], decision: 'allow' });
    expect(r.entryDecision({ current: { ...running, visitLimit: 12 }, hadMembership: true, overdue: false, visits: 12, policy: 'warn' })).toEqual({ reasons: ['visit_limit'], decision: 'warn' });
    expect(r.entryDecision({ current: { ...running, visitLimit: 12 }, hadMembership: true, overdue: false, policy: 'warn' })).toEqual({ reasons: [], decision: 'allow' });
  });
  it('flags: expired, frozen, unpaid, expiring, visitLimitReached (FR-47)', () => {
    expect(r.deskFlags({ current: running, hadMembership: true, overdue: false, today: '2026-11-03' })).toEqual([]);
    expect(r.deskFlags({ current: { ...running, status: 'frozen', endsOn: '2026-11-08', visitLimit: 2 }, hadMembership: true, overdue: true, visits: 2, today: '2026-11-03' })).toEqual(['frozen', 'unpaid', 'expiring', 'visitLimitReached']);
    expect(r.deskFlags({ current: null, hadMembership: true, overdue: false, today: '2026-11-03' })).toEqual(['expired']);
    expect(r.deskFlags({ current: null, hadMembership: false, overdue: false, today: '2026-11-03' })).toEqual([]);
  });
});

describe('§3.5 tiers and §6.6 fit', () => {
  const map = { attendance: 'basic', reports: 'standard', multi_gym: 'pro' };
  const lim = { freeMax: 30, basicMax: 100, standardMax: 300 };
  it('features by tier from feature_min_tiers (FR-07); an unknown feature needs Pro', () => {
    expect(r.hasFeature('free', 'attendance', map)).toBe(false);
    expect(r.hasFeature('basic', 'attendance', map)).toBe(true);
    expect(r.minTierOf(map, 'plans')).toBe('pro');
    expect(r.minTierOf(undefined, 'plans')).toBe('pro');
    expect(r.featuresOf('standard', map)).toMatchObject({ attendance: true, reports: true, multi_gym: false, plans: false });
    expect([r.tierRank('free'), r.tierRank('pro'), r.higherTier('basic', 'standard'), r.higherTier('pro', 'basic')]).toEqual([0, 3, 'standard', 'pro']);
  });
  it('the tier that fits a count, and its limit (FR-83, G7)', () => {
    expect([r.fitTier(30, lim), r.fitTier(31, lim), r.fitTier(142, lim), r.fitTier(301, lim)]).toEqual(['free', 'basic', 'standard', 'pro']);
    expect([r.tierLimit('free', lim), r.tierLimit('basic', lim), r.tierLimit('standard', lim), r.tierLimit('pro', lim)]).toEqual([30, 100, 300, null]);
  });
  it('choosing a tier keeps the month’s highest (FR-82: Standard on the 10th, Basic on the 20th → billed Standard)', () => {
    expect(r.chooseTier({ monthOf: '2026-11-01', monthMaxTier: 'standard', today: '2026-11-20', tier: 'basic' })).toEqual({ chosenTier: 'basic', monthOf: '2026-11-01', monthMaxTier: 'standard' });
    expect(r.chooseTier({ monthOf: '2026-10-01', monthMaxTier: 'standard', today: '2026-11-20', tier: 'basic' })).toEqual({ chosenTier: 'basic', monthOf: '2026-11-01', monthMaxTier: 'basic' });
  });
});

describe('codes (FR-10, FR-33)', () => {
  it('member codes and yearly receipt numbers', () => {
    expect(r.memberCode('IY', 42)).toBe('IY-0042');
    expect(r.memberCode('IY', 12345)).toBe('IY-12345');
    expect(r.receiptNo('IY', 2026, 318)).toBe('IY-R26-000318');
    expect(r.nextReceipt({ receiptYear: 2026, receiptSeq: 41, year: 2026 })).toEqual({ receiptYear: 2026, receiptSeq: 42 });
    expect(r.nextReceipt({ receiptYear: 2026, receiptSeq: 41, year: 2027 })).toEqual({ receiptYear: 2027, receiptSeq: 1 });
    expect([r.SHORT_CODE.test('IY'), r.SHORT_CODE.test('IRONYD'), r.SHORT_CODE.test('I'), r.SHORT_CODE.test('iy')]).toEqual([true, true, false, false]);
  });
});

describe('tokens (FR-37, FR-50)', () => {
  const seconds = 60;
  const now = Date.parse('2026-11-03T01:42:10Z');
  it('the member QR: current or previous window, no personal data, domain gym-member:', () => {
    const w = r.windowOf(now, seconds);
    const token = r.memberToken({ memberId: MEMBER, window: w }, sign);
    expect(token).toMatch(new RegExp(`^v1\\.gm\\.${MEMBER}\\.${w}\\.[0-9a-f]{32}$`));
    expect(r.looksLikeMemberToken(token)).toBe(true);
    expect(r.looksLikeMemberToken(null)).toBe(false);
    expect(r.parseMemberToken(token, { sign, nowMs: now, seconds })).toEqual({ memberId: MEMBER });
    expect(r.parseMemberToken(token, { sign, nowMs: now + seconds * 1000, seconds })).toEqual({ memberId: MEMBER });
    // A token from two windows ago is refused.
    expect(r.parseMemberToken(token, { sign, nowMs: now + 2 * seconds * 1000, seconds })).toBeNull();
    expect(r.parseMemberToken(token.replace(/.$/, (ch) => (ch === 'a' ? 'b' : 'a')), { sign, nowMs: now, seconds })).toBeNull();
    expect(r.parseMemberToken(`v1.gm.${MEMBER}.${w}.${sign(`gym-receipt:${MEMBER}`).slice(0, 32)}`, { sign, nowMs: now, seconds })).toBeNull();
    for (const bad of ['', 'v1.gm.x.1.y', `v2.gm.${MEMBER}.${w}.${'a'.repeat(32)}`, `v1.gx.${MEMBER}.${w}.${'a'.repeat(32)}`, `v1.gm.${MEMBER}.abc.${'a'.repeat(32)}`, `v1.gm.${MEMBER}.${w}.zz`, undefined]) {
      expect(r.parseMemberToken(bad, { sign, nowMs: now, seconds })).toBeNull();
    }
    expect(r.memberTokenExpiry(w, seconds).getTime()).toBe((w + 1) * seconds * 1000);
  });
  it('the receipt link: domain gym-receipt:, no expiry; another receipt’s signature fails', () => {
    const token = r.receiptToken(MEMBER, sign);
    expect(r.parseReceiptToken(token, { sign })).toEqual({ feePaymentId: MEMBER });
    const other = r.receiptToken('01936f3a-0000-7000-8000-000000000002', sign);
    expect(r.parseReceiptToken(`v1.${MEMBER}.${other.split('.')[2]}`, { sign })).toBeNull();
    for (const bad of ['v1.x.y', 'v2.a.b', `v1.${MEMBER}`, null]) expect(r.parseReceiptToken(bad, { sign })).toBeNull();
  });
});

describe('import rows (FR-75)', () => {
  const packages = [
    { id: 'p-month', kind: 'month', title: 'Monthly', days: 30 },
    { id: 'p-custom', kind: 'custom', title: '45 days', days: 45 },
  ];
  const hashPhone = (p) => `h:${p}`;
  const headers = ['Name', 'Phone', 'Gender', 'Date of birth', 'Package', 'Start', 'End', 'Last payment date', 'Last payment amount', 'Amount due', 'Member code'];
  const { map } = r.headerMap(headers);
  const row = (o) => [o.name ?? 'Rafiq Hasan', o.phone ?? '01711000222', o.gender ?? '', o.dob ?? '', o.pkg ?? '', o.start ?? '', o.end ?? '', o.lastOn ?? '', o.last ?? '', o.due ?? '', o.code ?? ''];
  const check = (rows, extra = {}) => r.validateImportRows(rows, { map, packages, hashPhone, today: '2026-11-03', ...extra });

  it('maps the template headers (case, spacing, Bangla) and needs name and phone', () => {
    expect(map).toEqual({ name: 0, phone: 1, gender: 2, birthDate: 3, package: 4, startsOn: 5, endsOn: 6, lastPaidOn: 7, lastPaid: 8, amountDue: 9, memberCode: 10 });
    expect(r.headerMap(['নাম', ' Mobile_Number ', 'mobile'])).toEqual({ map: { name: 0, phone: 1 } });
    expect(r.headerMap(['Name', 'Email', null])).toEqual({ missing: ['phone'] });
  });
  it('dates and taka cells', () => {
    expect([r.parseDate('2026-11-03'), r.parseDate('3/11/2026'), r.parseDate('03-11-2026'), r.parseDate('3.11.2026'), r.parseDate(new Date('2026-11-03T00:00:00Z'))]).toEqual(['2026-11-03', '2026-11-03', '2026-11-03', '2026-11-03', '2026-11-03']);
    expect([r.parseDate(''), r.parseDate(null), r.parseDate(undefined), r.parseDate('   '), r.parseDate('31/02/2026'), r.parseDate('soon'), r.parseDate(new Date('x'))]).toEqual([null, null, null, null, undefined, undefined, undefined]);
    expect([r.parseTaka('2500'), r.parseTaka('৳2,500.5'), r.parseTaka('Tk. 1,000.25'), r.parseTaka(3500), r.parseTaka(''), r.parseTaka(null), r.parseTaka('৳'), r.parseTaka('12.345'), r.parseTaka('-5')]).toEqual([250000, 250050, 100025, 350000, null, null, null, undefined, undefined]);
  });
  it('finds a package by title or kind', () => {
    expect(r.findPackage('monthly', packages).id).toBe('p-month');
    expect(r.findPackage('MONTH', packages).id).toBe('p-month');
    expect(r.findPackage('45 days', packages).id).toBe('p-custom');
    expect(r.findPackage('custom', packages)).toBeNull();
    expect(r.findPackage('yearly', packages)).toBeNull();
  });
  it('a good row with a membership, an opening payment and a due', () => {
    const [res] = check([row({ gender: 'M', dob: '1990-05-01', pkg: 'Monthly', start: '2026-10-20', lastOn: '2026-10-20', last: '2500', due: '500', code: 'iy-0007' })]);
    expect(res).toEqual({
      n: 2,
      status: 'ok',
      errors: [],
      value: { name: 'Rafiq Hasan', phone: '+8801711000222', phoneHash: 'h:+8801711000222', gender: 'male', birthDate: '1990-05-01', memberCode: 'IY-0007', packageId: 'p-month', startsOn: '2026-10-20', endsOn: '2026-11-18', lastPaid: 250000, lastPaidOn: '2026-10-20', amountDue: 50000 },
    });
    // A phone read from a spreadsheet number cell (8801711000333.0) still normalises; no package → member only.
    expect(check([row({ phone: '8801711000333.0' })])[0]).toMatchObject({ status: 'ok', value: { phone: '+8801711000333', packageId: null, startsOn: null, endsOn: null, lastPaid: 0, amountDue: 0 } });
    expect(check([row({ pkg: 'Monthly', start: '2026-10-01', end: '2026-12-31' })])[0].value.endsOn).toBe('2026-12-31');
  });
  it('every row error', () => {
    const err = (o, extra) => check([row(o)], extra)[0].errors.map((e) => e.code);
    expect(err({ name: 'R' })).toEqual(['name_invalid']);
    expect(err({ phone: '123' })).toEqual(['phone_invalid']);
    expect(err({}, { existingHashes: new Set(['h:+8801711000222']) })).toEqual(['duplicate_phone_in_gym']);
    expect(check([row({}), row({})])[1].errors.map((e) => e.code)).toEqual(['duplicate_phone_in_file']);
    expect(err({ gender: 'x' })).toEqual(['gender_invalid']);
    expect(err({ dob: 'later' })).toEqual(['date_invalid']);
    expect(err({ dob: '2027-01-01' })).toEqual(['date_invalid']);
    expect(err({ code: 'IY 7!' })).toEqual(['code_invalid']);
    expect(err({ code: 'IY-0001' }, { existingCodes: new Set(['IY-0001']) })).toEqual(['duplicate_code_in_gym']);
    expect(check([row({ code: 'A1' }), row({ phone: '01711000999', code: 'a1' })])[1].errors.map((e) => e.code)).toEqual(['duplicate_code_in_file']);
    expect(err({ pkg: 'Yearly', start: '2026-10-01' })).toEqual(['unknown_package', 'package_required']);
    expect(err({ pkg: 'Monthly' })).toEqual(['date_required']);
    expect(err({ pkg: 'Monthly', start: 'x', end: 'y' })).toEqual(['date_invalid', 'date_invalid', 'date_required']);
    expect(err({ pkg: 'Monthly', start: '2026-10-01', end: '2026-09-01' })).toEqual(['end_before_start']);
    expect(err({ pkg: 'Monthly', start: '2026-01-01', end: '2027-06-01' })).toEqual(['too_long']);
    expect(err({ last: 'abc', due: 'x' })).toEqual(['amount_invalid', 'amount_invalid']);
    expect(err({ pkg: 'Monthly', start: '2026-10-01', last: '100' })).toEqual(['date_required']);
    expect(err({ pkg: 'Monthly', start: '2026-10-01', last: '100', lastOn: '2026-12-01' })).toEqual(['date_invalid']);
    expect(err({ start: '2026-10-01' })).toEqual(['package_required']);
    expect(err({ due: '500' })).toEqual(['package_required']);
    expect(err({ last: '500', lastOn: '2026-10-01' })).toEqual(['package_required']);
  });
  it('a file without optional columns', () => {
    const { map: slim } = r.headerMap(['name', 'phone']);
    expect(r.validateImportRows([['Nadia Islam', '01811000444']], { map: slim, packages, hashPhone, today: '2026-11-03' })[0]).toMatchObject({ status: 'ok', value: { gender: null, birthDate: null, memberCode: null } });
    expect(r.validateImportRows([[null, null]], { map: slim, packages, hashPhone, today: '2026-11-03' })[0].errors.map((e) => e.code)).toEqual(['name_invalid', 'phone_invalid']);
    expect(r.validateImportRows([['Nadia Islam']], { map: slim, packages, hashPhone, today: '2026-11-03' })[0].errors.map((e) => e.code)).toEqual(['phone_invalid']);
  });
});
