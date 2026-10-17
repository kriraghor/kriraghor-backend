'use strict';

// M09 §6.1 price formula (worked examples), §6.2 limits, the v3 ৳2,000 example, the ground state
// machine (§8), review fields (FR-04), hours (FR-07) and the M02 business-document rules.
const pr = require('../../src/modules/grounds/pricing.rules');
const rules = require('../../src/modules/grounds/grounds.rules');
const kyc = require('../../src/modules/kyc/kyc.rules');

const R = { basePricePoisha: 240000, courtBaseOverrides: {}, peakFromHour: 17, peakPct: 25, weekendPct: 15, earlyToHour: 8, earlyPct: 20, advancePct: 30, seriesDiscountPct: 10, minBookingMin: 60, fullRefundHours: 24, halfRefundHours: 6, checkinGraceMin: 15 };
const at = (date, hhmm) => pr.dhakaInstant(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const MON = '2026-10-19';
const FRI = '2026-10-23';
const SAT = '2026-10-24';
const LIMITS = { baseMin: 80000, baseMax: 600000, peakMax: 60, weekendMax: 50, earlyMax: 50, advanceMin: 20, advanceMax: 50, feePct: 5, seriesMax: 25, minLengthOptions: [60, 90, 120] };

describe('M09 §6.1 price formula', () => {
  it('Dhaka wall clock: weekdays and hours of an instant', () => {
    expect(pr.dhakaParts(at(MON, '18:00'))).toEqual({ hour: 18, minute: 0, dow: 1, date: MON });
    expect(pr.dhakaParts(at(FRI, '00:30')).dow).toBe(5);
    expect(pr.dhakaParts(at(SAT, '23:30'))).toMatchObject({ hour: 23, dow: 6 });
  });

  it('worked example 1: Mon 18:00, 120 min = ৳6,000, advance ৳1,800, balance ৳4,200', () => {
    const q = pr.quote({ rules: R, courtIds: ['c1'], start: at(MON, '18:00'), minutes: 120, feePct: 5, allowFull: true });
    expect(q).toMatchObject({ price: 600000, advance: 180000, balance: 420000, rateAtStart: 300000, applied: { peak: true, early: false, weekend: false } });
  });

  it('worked example 2: Fri 16:30, 90 min crosses peak = ৳4,830 (part-peak, weekend)', () => {
    expect(pr.price(R, ['c1'], at(FRI, '16:30'), 90)).toBe(483000);
    expect(pr.advanceOf(483000, 30)).toBe(144900);
  });

  it('worked example 3: Sat 07:00, 60 min early + weekend = ৳2,208 → ৳2,210 (nearest ৳10)', () => {
    expect(pr.price(R, ['c1'], at(SAT, '07:00'), 60)).toBe(221000);
    expect(pr.advanceOf(221000, 30)).toBe(66300);
  });

  it('worked example 4: series Mon 19:00, 120 min, 10% off = ৳5,400', () => {
    expect(pr.seriesPrice(pr.price(R, ['c1'], at(MON, '19:00'), 120), 10)).toBe(540000);
  });

  it('multipliers compose in order; decimals are exact; rounding is half-up', () => {
    const r = { ...R, basePricePoisha: 100000, peakPct: 12.5, weekendPct: 0, earlyPct: 0 };
    // 1,000 × 1.125 / 2 = 562.5 per block; 2 blocks = 1,125 → ৳1,130 (half-up to ৳10)
    expect(pr.price(r, ['c'], at(MON, '18:00'), 60)).toBe(113000);
    expect(pr.hourlyRate(100000, r, 18, 1)).toBe(112500);
    expect(pr.advanceOf(113000, 33.33)).toBe(37700);
    expect(pr.seriesPrice(113000, 2.5)).toBe(110000);
  });

  it('court base overrides and combinable courts (the sum, Q62)', () => {
    const r = { ...R, courtBaseOverrides: { c2: 300000 } };
    expect(pr.courtBase(r, 'c1')).toBe(240000);
    expect(pr.courtBase(r, 'c2')).toBe(300000);
    const one = pr.price(r, ['c1'], at(MON, '12:00'), 60);
    const two = pr.price(r, ['c2'], at(MON, '12:00'), 60);
    expect(pr.price(r, ['c1', 'c2'], at(MON, '12:00'), 60)).toBe(one + two);
    expect(pr.quote({ rules: r, courtIds: ['c1', 'c2'], start: at(MON, '12:00'), minutes: 60, feePct: 5, allowFull: false }).rateAtStart).toBe(540000);
  });

  it('v3 example: ৳2,000 at 25% → ৳500 online, fee ৳100, owner ৳400 + ৳1,500 cash; paid in full → ৳1,900', () => {
    const r = { ...R, basePricePoisha: 200000, peakPct: 0, weekendPct: 0, earlyPct: 0, advancePct: 25 };
    const q = pr.quote({ rules: r, courtIds: ['c'], start: at(MON, '12:00'), minutes: 60, feePct: 5, allowFull: true });
    expect(q).toMatchObject({ price: 200000, advance: 50000, balance: 150000, fee: 10000 });
    expect(q.options).toEqual([
      { kind: 'advance', payNow: 50000, atVenue: 150000, ownerGetsOnline: 40000 },
      { kind: 'full', payNow: 200000, atVenue: 0, ownerGetsOnline: 190000 },
    ]);
    expect(pr.quote({ rules: r, courtIds: ['c'], start: at(MON, '12:00'), minutes: 60, feePct: 5, allowFull: false }).options).toHaveLength(1);
  });

  it('heatmap: 7 × 17 from a date, tones by ratio to the base', () => {
    const rows = pr.heatmap(R, { fromDate: MON });
    expect(rows).toHaveLength(7);
    expect(rows[0].cells).toHaveLength(17);
    expect(rows[0].cells[0]).toEqual({ hour: 6, rate: 192000, tone: 'low' });
    expect(rows[0].cells.find((c) => c.hour === 12)).toMatchObject({ rate: 240000, tone: 'base' });
    expect(rows[4].cells.find((c) => c.hour === 12)).toMatchObject({ rate: 276000, tone: 'high' });
    expect(rows[4].cells.find((c) => c.hour === 20)).toMatchObject({ rate: 345000, tone: 'peak' });
    expect(pr.heatmap({ ...R, courtBaseOverrides: { k: 100000 } }, { fromDate: MON, days: 1, courtId: 'k' })[0].cells[6].rate).toBe(100000);
  });
});

describe('M09 §6.2 limits (with live settings and the v3 advance ≥ fee)', () => {
  it('a valid rule set passes', () => expect(pr.validate(R, LIMITS)).toBeNull());

  it('the validation matrix', () => {
    const fields = (r) => (pr.validate({ ...R, ...r }, LIMITS) ?? []).map((e) => e.field);
    expect(fields({ basePricePoisha: 79900 })).toEqual(['basePricePoisha']);
    expect(fields({ basePricePoisha: 600100 })).toEqual(['basePricePoisha']);
    expect(fields({ basePricePoisha: 1000.5 })).toEqual(['basePricePoisha']);
    expect(fields({ courtBaseOverrides: { a: 10 } })).toEqual(['courtBaseOverrides.a']);
    expect(fields({ courtBaseOverrides: { a: 'x' } })).toEqual(['courtBaseOverrides.a']);
    expect(fields({ peakFromHour: 14 })).toEqual(['peakFromHour']);
    expect(fields({ peakFromHour: 17.5 })).toEqual(['peakFromHour']);
    expect(fields({ earlyToHour: 11 })).toEqual(['earlyToHour']);
    expect(fields({ peakPct: 61 })).toEqual(['peakPct']);
    expect(fields({ weekendPct: 51 })).toEqual(['weekendPct']);
    expect(fields({ earlyPct: -1 })).toEqual(['earlyPct']);
    expect(fields({ advancePct: 19 })).toEqual(['advancePct']);
    expect(fields({ advancePct: 51 })).toEqual(['advancePct']);
    expect(fields({ minBookingMin: 45 })).toEqual(['minBookingMin']);
    expect(fields({ fullRefundHours: 0 })).toEqual(['fullRefundHours', 'halfRefundHours']);
    expect(fields({ halfRefundHours: 24 })).toEqual(['halfRefundHours']);
    expect(fields({ halfRefundHours: 80 })).toEqual(['halfRefundHours']);
    expect(fields({ checkinGraceMin: 31 })).toEqual(['checkinGraceMin']);
    expect(fields({ seriesDiscountPct: 26 })).toEqual(['seriesDiscountPct']);
    expect(fields({ peakPct: Number.NaN })).toEqual(['peakPct']);
  });

  it('missing optional values are treated as empty', () => {
    expect(pr.validate({ ...R, courtBaseOverrides: undefined }, LIMITS)).toBeNull();
    expect(pr.validate({ ...R, courtBaseOverrides: { c2: 300000 } }, LIMITS)).toBeNull();
    expect(pr.changedKeys({ ...R, courtBaseOverrides: undefined }, { ...R, courtBaseOverrides: null })).toEqual([]);
  });

  it('v3: the advance must cover the platform fee', () => {
    const errs = pr.validate({ ...R, advancePct: 20 }, { ...LIMITS, feePct: 25 });
    expect(errs).toEqual([{ field: 'advancePct', message: 'The advance must cover the 25% platform fee' }]);
  });

  it('change history: changed keys and a human summary', () => {
    expect(pr.changedKeys(null, R)).toEqual(pr.FIELDS);
    expect(pr.changedKeys(R, { ...R, peakPct: 30, advancePct: 25 })).toEqual(['peakPct', 'advancePct']);
    expect(pr.summary(null, R)).toBe(
      'First pricing: base ৳2,400/h, court prices, peak +25% from 5pm, weekend +15%, early bird −20% before 8am, advance 30%, minimum 60 min, refunds 24h/6h, grace 15 min, regular booking −10%'
    );
    expect(pr.summary(R, { ...R, peakFromHour: 12, earlyToHour: 9 })).toBe('Updated pricing: peak +25% from 12pm, early bird −20% before 9am');
    expect(pr.summary(R, { ...R })).toBe('Updated pricing: no changes');
    expect(pr.summary(R, { ...R, peakFromHour: 18 })).toContain('from 6pm');
  });
});

describe('M09 grounds rules', () => {
  it('state machine (§8)', () => {
    expect(rules.next('submit', 'draft')).toBe('pending_review');
    expect(rules.next('submit', 'withdrawn')).toBe('pending_review');
    expect(rules.next('submit', 'live')).toBeNull();
    expect(rules.next('approve', 'pending_review')).toBe('live');
    expect(rules.next('request_changes', 'pending_review')).toBe('changes_requested');
    expect(rules.next('reject', 'pending_review')).toBe('rejected');
    expect(rules.next('withdraw', 'pending_review')).toBe('withdrawn');
    expect(rules.next('pause', 'live')).toBe('paused');
    expect(rules.next('pause', 'paused')).toBeNull();
    expect(rules.next('resume', 'paused')).toBe('live');
    expect(rules.next('suspend', 'paused')).toBe('suspended');
    expect(rules.next('restore', 'suspended')).toBe('live');
    expect(rules.next('remove', 'suspended')).toBe('removed');
    expect(rules.next('remove', 'removed')).toBeNull();
    expect(['live', 'paused', 'suspended'].every(rules.isPublished)).toBe(true);
    expect(rules.isPublished('draft')).toBe(false);
    expect(rules.isEditable('live', null)).toBe(true);
    expect(rules.isEditable('live', 'pending_review')).toBe(false);
    expect(rules.isEditable('pending_review', null)).toBe(false);
    expect(rules.EDIT_AFTER.withdrawn).toBe('draft');
  });

  it('review fields (FR-04) and the reviewer diff', () => {
    const g = { name: 'Arena', areaId: 'a', addressLine: 'Road 1', lat: 23.7, lng: 90.3, isIndoor: false };
    expect(rules.groundReviewChanges(g, { name: 'Arena', description: 'new' })).toEqual([]);
    expect(rules.groundReviewChanges(g, { name: 'Arena 2', lat: 23.8 })).toEqual(['name', 'lat']);
    const court = { name: 'C1', sportIds: ['s1', 's2'], surfaceId: 'x', sizeText: null };
    expect(rules.courtReviewChanges(court, { sportIds: ['s2', 's1'] })).toEqual([]);
    expect(rules.courtReviewChanges(court, { sportIds: ['s1'], sizeText: '40x20' })).toEqual(['sportIds', 'sizeText']);

    const working = { ...g, courts: [{ id: 'c1', name: 'C1', sportIds: ['s1'], surfaceId: 'x' }], photos: [{ id: 'p1' }, { id: 'p2' }] };
    expect(rules.reviewDiff(null, working)).toEqual({ first: true, fields: [], courts: [], photos: { added: 2, removed: 0 } });
    const snapshot = { ...g, courts: [{ id: 'c1', name: 'C1', sportIds: ['s1'], surfaceId: 'x' }, { id: 'c9', name: 'Old' }], photos: [{ id: 'p1' }, { id: 'p0' }] };
    const changed = { ...working, name: 'Arena 2', courts: [...working.courts.map((c) => ({ ...c, sizeText: 'big' })), { id: 'c2', name: 'C2' }] };
    expect(rules.reviewDiff(snapshot, changed)).toEqual({
      first: false,
      fields: [{ field: 'name', from: 'Arena', to: 'Arena 2' }],
      courts: [
        { id: 'c1', name: 'C1', change: 'changed', fields: ['sizeText'] },
        { id: 'c2', name: 'C2', change: 'added' },
        { id: 'c9', name: 'Old', change: 'retired' },
      ],
      photos: { added: 1, removed: 1 },
    });
    expect(rules.diffIsEmpty(rules.reviewDiff({ ...working }, working))).toBe(true);
    // Missing values compare as null; sports compare as sets even when one side has none.
    expect(rules.groundReviewChanges({ name: 'A' }, { addressLine: undefined, isIndoor: false })).toEqual(['isIndoor']);
    expect(rules.courtReviewChanges({ name: 'C' }, { sportIds: undefined })).toEqual([]);
    expect(rules.reviewDiff({ ...snapshot, addressLine: undefined }, { ...working, addressLine: undefined }).fields).toEqual([]);
    expect(rules.reviewDiff({ ...snapshot, isIndoor: undefined }, { ...working, isIndoor: true }).fields).toEqual([{ field: 'isIndoor', from: null, to: true }]);
    expect(rules.reviewDiff({ ...snapshot, isIndoor: true }, { ...working, isIndoor: undefined }).fields).toEqual([{ field: 'isIndoor', from: true, to: null }]);
    expect(rules.diffIsEmpty(rules.reviewDiff(null, working))).toBe(false);
  });

  it('hours (FR-07): seven days, half-hour grid inside the bookable day', () => {
    const grid = { open: '06:00', close: '23:00' };
    const week = Array.from({ length: 7 }, (_, dow) => ({ dow, isClosed: false, openTime: '06:00', closeTime: '23:00' }));
    expect(rules.hoursBlock(week, grid)).toBeNull();
    expect(rules.hoursBlock(week.slice(0, 6), grid)).toEqual([{ field: 'hours', message: 'Give all seven weekdays (closed days too)' }]);
    const bad = [...week];
    bad[0] = { dow: 0, isClosed: false, openTime: '06:15', closeTime: '23:00' };
    bad[1] = { dow: 1, isClosed: false, openTime: '05:00', closeTime: '23:00' };
    bad[2] = { dow: 2, isClosed: false, openTime: '18:00', closeTime: '17:00' };
    bad[3] = { dow: 3, isClosed: true };
    bad[4] = { dow: 4, isClosed: false, openTime: 'x', closeTime: '23:00' };
    bad[5] = { dow: 1, isClosed: false, openTime: '06:00', closeTime: '23:00' };
    bad[6] = { dow: 9, isClosed: true };
    expect(rules.hoursBlock(bad, grid).map((e) => e.field)).toEqual(['hours.0', 'hours.1', 'hours.2', 'hours.4', 'hours.5', 'hours.6']);
    expect(rules.hoursBlock(week.map((d) => ({ ...d, closeTime: '24:00' })), { open: '06:00', close: '24:00' })).toBeNull();
    expect(rules.hasOpenDay([{ isClosed: true }, { isClosed: false }])).toBe(true);
    expect(rules.hasOpenDay([{ isClosed: true }])).toBe(false);
  });

  it('isOpenAt: inside one day\'s hours, closing time exclusive', () => {
    const day = { isClosed: false, openTime: '17:00', closeTime: '23:00' };
    expect(rules.isOpenAt(day, 17 * 60)).toBe(true);
    expect(rules.isOpenAt(day, 22 * 60 + 30)).toBe(true);
    expect(rules.isOpenAt(day, 23 * 60)).toBe(false);
    expect(rules.isOpenAt(day, 16 * 60 + 30)).toBe(false);
    expect(rules.isOpenAt({ isClosed: true }, 18 * 60)).toBe(false);
    expect(rules.isOpenAt(undefined, 18 * 60)).toBe(false);
    expect(rules.isOpenAt({ isClosed: false, openTime: '06:00', closeTime: '24:00' }, 23 * 60 + 30)).toBe(true);
    expect(rules.toHHMM(390)).toBe('06:30');
    expect(rules.toMin('25:00')).toBeNull();
  });

  it('slugs and distances', () => {
    expect(rules.slugify('Dhanmondi Turf Arena', 'Dhanmondi')).toBe('dhanmondi-turf-arena');
    expect(rules.slugify('Kick Off', 'Mirpur')).toBe('kick-off-mirpur');
    expect(rules.slugify('মাঠ', null)).toBe('ground');
    expect(rules.distanceM({ lat: 23.7465, lng: 90.376 }, { lat: 23.7465, lng: 90.376 })).toBe(0);
    expect(rules.distanceM({ lat: 23.7465, lng: 90.376 }, { lat: 23.8069, lng: 90.3687 })).toBeGreaterThan(6000);
  });
});

describe('M02 business documents (lite, with M09)', () => {
  const schema = [
    { key: 'number', type: 'text', min: 4, max: 40, required: true },
    { key: 'expiresOn', type: 'date', future: true, required: true },
    { key: 'kind', type: 'enum', options: ['deed', 'lease'], required: false },
    { key: 'tin', type: 'digits', min: 12, max: 12 },
  ];
  it('fields follow the requirement schema', () => {
    expect(kyc.fieldsBlock(schema, { number: 'TL-12345', expiresOn: '2027-01-01', kind: 'lease' }, '2026-10-16')).toBeNull();
    expect(kyc.fieldsBlock(schema, { number: 'ab', expiresOn: '2026-10-16', kind: 'rent', tin: '12x', extra: 1 }, '2026-10-16')).toEqual([
      { field: 'fields.extra', message: 'Not a field of this document' },
      { field: 'fields.number', message: '4 to 40 characters' },
      { field: 'fields.expiresOn', message: 'This date has passed' },
      { field: 'fields.kind', message: 'One of deed, lease' },
      { field: 'fields.tin', message: '12 to 12 digits' },
    ]);
    expect(kyc.fieldsBlock(schema, { expiresOn: 'soon' }, '2026-10-16')).toEqual([
      { field: 'fields.number', message: 'Required' },
      { field: 'fields.expiresOn', message: 'A date as YYYY-MM-DD' },
    ]);
    expect(kyc.fieldsBlock([{ key: 'x', type: 'text' }], { x: 'y'.repeat(121) }, '2026-10-16')).toEqual([{ field: 'fields.x', message: '1 to 120 characters' }]);
    expect(kyc.fieldsBlock([{ key: 'x', type: 'digits' }], { x: '1' }, '2026-10-16')).toBeNull();
    expect(kyc.fieldsBlock([{ key: 'x', type: 'digits' }], { x: 'a' }, '2026-10-16')).toEqual([{ field: 'fields.x', message: '1 to 120 digits' }]);
    expect(kyc.fieldsBlock(schema, undefined, '2026-10-16').map((e) => e.field)).toEqual(['fields.number', 'fields.expiresOn']);
  });
  it('checks, role moves, completeness and the badge', () => {
    expect(kyc.businessChecks({ reusedFiles: 0, expiresOn: '2027-01-01', today: '2026-10-16' }).map((c) => [c.key, c.ok])).toEqual([['file_type', true], ['file_reused', true], ['not_expired', true]]);
    expect(kyc.businessChecks({ reusedFiles: 2, expiresOn: null, today: '2026-10-16' })).toHaveLength(2);
    expect(kyc.businessChecks({ reusedFiles: 0, expiresOn: '2026-10-01', today: '2026-10-16' })[2].ok).toBe(false);
    expect(kyc.businessMove('submitted', 'applied')).toBe('in_review');
    expect(kyc.businessMove('changes_requested', 'in_review')).toBe('changes_requested');
    expect(kyc.businessMove('rejected', 'active')).toBeNull();
    expect(kyc.businessMove('approved', 'in_review')).toBeNull();
    const reqs = [{ docType: 'trade_license', required: 'always' }, { docType: 'deed_or_lease', required: 'always' }, { docType: 'tin', required: 'optional' }, { derivedKey: 'x', required: 'always' }];
    expect(kyc.roleComplete(reqs, ['trade_license'])).toBe(false);
    expect(kyc.roleComplete(reqs, ['trade_license', 'deed_or_lease'])).toBe(true);
    expect(kyc.roleBadge([{ required: 'always', status: 'approved' }, { required: 'optional', status: 'missing' }])).toBe('fully_verified');
    expect(kyc.roleBadge([{ required: 'always', status: 'approved' }, { required: 'optional', status: 'in_review' }])).toBe('documents_in_review');
  });
});
