'use strict';

// M19-FR-33: the staff review figures' pure rules (100% branches).
const r = require('../../src/modules/analytics/reviews.rules');

describe('M19 review figures rules', () => {
  // 25 Nov 2026 14:30 in Dhaka (08:30 UTC), a Wednesday.
  const now = new Date('2026-11-25T08:30:00Z');

  it('dayStart: a Dhaka day starts at 18:00 UTC the day before', () => {
    expect(r.dayStart('2026-11-25').toISOString()).toBe('2026-11-24T18:00:00.000Z');
  });

  it('windows: today from Dhaka midnight, the same weekday last week up to the same time, the window and the one before', () => {
    const w = r.windows(now, 30);
    expect(w.today).toEqual({ from: new Date('2026-11-24T18:00:00Z'), to: now });
    expect(w.lastWeek).toEqual({ from: new Date('2026-11-17T18:00:00Z'), to: new Date('2026-11-18T08:30:00Z') });
    expect(w.window.firstDay).toBe('2026-10-27');
    expect(w.window.lastDay).toBe('2026-11-25');
    expect(w.window.from).toEqual(new Date('2026-10-26T18:00:00Z'));
    expect(w.before).toEqual({ from: new Date('2026-09-26T18:00:00Z'), to: new Date('2026-10-26T18:00:00Z') });
  });

  it('approvalRate: approved of every decision, three places; null with none', () => {
    expect(r.approvalRate({ approved: 2, changes_requested: 1, rejected: 0 })).toBe(0.667);
    expect(r.approvalRate({ rejected: 4 })).toBe(0);
    expect(r.approvalRate({})).toBeNull();
    expect(r.approvalRate()).toBeNull();
  });

  it('fillDecisionDays: every day of the window, zeros where nothing was decided', () => {
    const out = r.fillDecisionDays([{ day: '2026-11-24', approved: 2, rejected: 1 }, { day: '2026-11-25', changes_requested: 3 }], '2026-11-23', '2026-11-25');
    expect(out).toEqual([
      { day: '2026-11-23', approved: 0, changesRequested: 0, rejected: 0 },
      { day: '2026-11-24', approved: 2, changesRequested: 0, rejected: 1 },
      { day: '2026-11-25', approved: 0, changesRequested: 3, rejected: 0 },
    ]);
  });

  it('reasonsWithLabels: the label in the page language, the code when unknown, most used first then by code', () => {
    const labels = [
      { code: 'blurry', labelEn: 'Photo is blurry', labelBn: 'ছবি ঝাপসা' },
      { code: 'mismatch', labelEn: 'Name does not match', labelBn: 'নাম মেলেনি' },
    ];
    const counts = [
      { code: 'mismatch', count: 2 },
      { code: 'blurry', count: 5 },
      { code: 'zzz', count: 2 },
    ];
    expect(r.reasonsWithLabels(counts, labels, 'en')).toEqual([
      { code: 'blurry', label: 'Photo is blurry', count: 5 },
      { code: 'mismatch', label: 'Name does not match', count: 2 },
      { code: 'zzz', label: 'zzz', count: 2 },
    ]);
    expect(r.reasonsWithLabels([{ code: 'blurry', count: 1 }], labels, 'bn')[0].label).toBe('ছবি ঝাপসা');
  });

  it('tiles: today against last week in percent, the median in percent, the rate in points; nulls when nothing to compare', () => {
    const t = r.tiles({ waiting: { inQueue: 7, overdue: 2 }, today: 6, lastWeek: 4, median: 90, medianBefore: 120, rate: 0.8, rateBefore: 0.75 });
    expect(t).toEqual({
      waiting: { value: 7, delta: null, note: { overdue: 2 } },
      reviewedToday: { value: 6, delta: 50, note: { lastWeek: 4 } },
      medianMinutes: { value: 90, delta: -25 },
      approvalRate: { value: 0.8, delta: 5 },
    });
    const empty = r.tiles({ waiting: { inQueue: 0, overdue: 0 }, today: 0, lastWeek: 0, median: null, medianBefore: 30, rate: null, rateBefore: null });
    expect(empty.reviewedToday.delta).toBeNull();
    expect(empty.medianMinutes).toEqual({ value: null, delta: null });
    expect(empty.approvalRate).toEqual({ value: null, delta: null });
    expect(r.tiles({ waiting: { inQueue: 0, overdue: 0 }, today: 1, lastWeek: 1, median: 30, medianBefore: null, rate: 1, rateBefore: 1 }).medianMinutes.delta).toBeNull();
  });
});
