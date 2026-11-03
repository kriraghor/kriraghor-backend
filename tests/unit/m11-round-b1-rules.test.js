'use strict';

// Round B1 pure rules: the pro's stats (M11-FR-52, M19 §6.3: acceptance, median reply, rating), the
// insights buckets and deltas on the Dhaka calendar, availability blocks and weekly repeats (M11-FR-05,
// M11-FR-14), the `available` check (§6.5), and profile completeness (hire and player). 100% branch
// gate on hire.rules.js and teams.rules.js (jest.config).
const r = require('../../src/modules/hire/hire.rules');
const t = require('../../src/modules/teams/teams.rules');

const at = (iso) => new Date(iso);
const MIN = 60000;
const DAY = 86400000;

describe('M11-FR-52 request stats', () => {
  const now = at('2026-10-21T00:00:00Z');
  const ago = (days, plusMin = null) => {
    const createdAt = new Date(now.getTime() - days * DAY);
    return { createdAt, decidedAt: plusMin === null ? null : new Date(createdAt.getTime() + plusMin * MIN) };
  };

  it('counts accepted (incl. lapsed, withdrawn or cancelled after acceptance), declined and expired; median reply in minutes', () => {
    const rows = [
      { status: 'accepted_unpaid', ...ago(1, 30) },
      { status: 'declined', ...ago(2, 90) },
      { status: 'expired', ...ago(3) },
      { status: 'withdrawn', ...ago(1) }, // withdrawn before any reply: counts nowhere
      { status: 'withdrawn', ...ago(1, 10) }, // withdrawn after acceptance: accepted
      { status: 'completed', ...ago(100, 5) }, // outside the window
      { status: 'pending', ...ago(0) },
    ];
    expect(r.requestStats(rows, { now, windowDays: 90 })).toEqual({ accepted: 2, declined: 1, expired: 1, acceptanceRate: 50, medianReplyMinutes: 30 });
  });

  it('rounds the rate to two decimals and the median of an even list to the minute; null with nothing asked', () => {
    const rows = [
      { status: 'confirmed', ...ago(1, 10) },
      { status: 'declined', ...ago(1, 21) },
      { status: 'expired', ...ago(1) },
    ];
    expect(r.requestStats(rows, { now, windowDays: 90 })).toMatchObject({ acceptanceRate: 33.33, medianReplyMinutes: 16 });
    expect(r.requestStats([], { now, windowDays: 90 })).toEqual({ accepted: 0, declined: 0, expired: 0, acceptanceRate: null, medianReplyMinutes: null });
    expect(r.median([3, 1, 2])).toBe(2);
    expect(r.median([])).toBeNull();
  });

  it('weights the rating by review count across profiles', () => {
    expect(r.ratingOf([{ ratingAvg: 4.5, ratingCount: 2 }, { ratingAvg: null, ratingCount: 0 }, { ratingAvg: 4, ratingCount: 1 }])).toEqual({ avg: 4.33, count: 3 });
    expect(r.ratingOf([])).toEqual({ avg: null, count: 0 });
  });
});

describe('M19 §6.3 Pro insights: buckets, windows, deltas', () => {
  it('7 Dhaka weeks from Monday (default) or Sunday, the period so far and the same days one period earlier', () => {
    const p = r.periodBuckets('7w', '2026-10-21');
    expect(p.buckets).toHaveLength(7);
    expect(p.buckets[0]).toEqual({ key: '2026-09-07', from: '2026-09-07', to: '2026-09-14' });
    expect(p.buckets[6]).toEqual({ key: '2026-10-19', from: '2026-10-19', to: '2026-10-26' });
    expect(p).toMatchObject({ from: '2026-09-07', to: '2026-10-26', current: { from: '2026-09-07', to: '2026-10-22' }, previous: { from: '2026-07-20', to: '2026-09-03' } });
    expect(r.periodBuckets('7w', '2026-10-21', 'sun').buckets[6].from).toBe('2026-10-18');
    expect(r.periodBuckets('qtr', '2026-10-21').buckets).toHaveLength(13);
  });

  it('12 months for a year, compared with the same days a year earlier', () => {
    const p = r.periodBuckets('yr', '2026-10-21');
    expect(p.buckets).toHaveLength(12);
    expect(p.buckets[0]).toEqual({ key: '2025-11', from: '2025-11-01', to: '2025-12-01' });
    expect(p.buckets[11]).toEqual({ key: '2026-10', from: '2026-10-01', to: '2026-11-01' });
    expect(p).toMatchObject({ current: { from: '2025-11-01', to: '2026-10-22' }, previous: { from: '2024-11-01', to: '2025-10-22' } });
  });

  it('sums day rows into buckets and windows; the buckets add up to the period total', () => {
    const p = r.periodBuckets('7w', '2026-10-21');
    const rows = [
      { day: '2026-10-20', amount: 405000 },
      { day: '2026-10-08', amount: 101250 },
      { day: '2026-09-01', amount: 100 },
    ];
    const buckets = r.bucketize(rows, p.buckets);
    expect(buckets[6]).toEqual({ key: '2026-10-19', from: '2026-10-19', amount: 405000 });
    expect(buckets[4].amount).toBe(101250);
    expect(buckets.reduce((n, b) => n + b.amount, 0)).toBe(r.sumDays(rows, p.current));
    expect(r.sumDays(rows, p.previous)).toBe(100);
  });

  it('deltas in percent with one decimal, null against nothing', () => {
    expect(r.delta(110, 100)).toBe(10);
    expect(r.delta(50, 150)).toBe(-66.7);
    expect(r.delta(5, 0)).toBeNull();
  });

  it('releasing soon: net, count and the next release', () => {
    expect(r.releasingSoon([{ net: 100, releaseAt: '2026-10-22T00:00:00Z' }, { net: 50, releaseAt: at('2026-10-21T12:00:00Z') }, { net: 5, releaseAt: null }])).toEqual({ net: 155, count: 3, nextAt: at('2026-10-21T12:00:00Z') });
    expect(r.releasingSoon([])).toEqual({ net: 0, count: 0, nextAt: null });
  });

  it('who hires you: most jobs first, ties by name, at most the limit', () => {
    const team1 = { key: 'team:1', label: 'Dhanmondi XI' };
    const solo = { key: 'individual', label: 'Individual' };
    const team2 = { key: 'team:2', label: 'Abahani' };
    expect(r.rankHirers([solo, team1, team2, team1, solo], 2)).toEqual([
      { ...team1, jobs: 2 },
      { ...solo, jobs: 2 },
    ]);
  });
});

describe('M11-FR-05 availability: repeats, expansion, merge, free time', () => {
  const friday = { weekdays: [5], from: '18:00', to: '22:00' };
  const day = (d) => r.dhakaMidnight(d);

  it('reads HH:MM and the Dhaka midnight', () => {
    expect(r.hm('18:30')).toBe(1110);
    expect(r.dhakaMidnight('2026-10-21')).toEqual(at('2026-10-20T18:00:00Z'));
    expect(r.addDays('2026-10-31', 1)).toBe('2026-11-01');
  });

  it('expands a weekly repeat on the Dhaka calendar while it is valid', () => {
    const range = { from: day('2026-10-21'), to: day('2026-11-04') };
    expect(r.expandRepeat(friday, { validFrom: day('2026-10-21') }, range)).toEqual([
      { start: at('2026-10-23T12:00:00Z'), end: at('2026-10-23T16:00:00Z') },
      { start: at('2026-10-30T12:00:00Z'), end: at('2026-10-30T16:00:00Z') },
    ]);
    expect(r.expandRepeat(friday, { validFrom: day('2026-10-21'), validTo: day('2026-10-24') }, range)).toHaveLength(1);
    expect(r.expandRepeat(friday, { validFrom: day('2026-11-05'), validTo: null }, range)).toEqual([]);
    // "24:00" ends at the next Dhaka midnight (no one-minute gap).
    expect(r.expandRepeat({ ...friday, from: '22:00', to: '24:00' }, { validFrom: day('2026-10-21'), validTo: day('2026-10-24') }, range)).toEqual([{ start: at('2026-10-23T16:00:00Z'), end: at('2026-10-23T18:00:00Z') }]);
    // An occurrence after the range's end, or ending at its start, is left out; one overlapping it stays whole.
    expect(r.expandRepeat(friday, { validFrom: day('2026-10-21') }, { from: day('2026-10-23'), to: at('2026-10-23T12:00:00Z') })).toEqual([]);
    expect(r.expandRepeat(friday, { validFrom: day('2026-10-21') }, { from: at('2026-10-23T16:00:00Z'), to: at('2026-10-23T17:00:00Z') })).toEqual([]);
    expect(r.expandRepeat(friday, { validFrom: day('2026-10-21') }, { from: at('2026-10-23T14:00:00Z'), to: at('2026-10-23T15:00:00Z') })).toEqual([{ start: at('2026-10-23T12:00:00Z'), end: at('2026-10-23T16:00:00Z') }]);
  });

  it('expands stored blocks: one-off blocks in the range and repeats, sorted, reasons kept', () => {
    const range = { from: day('2026-10-21'), to: day('2026-10-28') };
    const blocks = [
      { id: 'c', start: day('2026-10-21'), end: null, repeat: friday, reason: 'League nights' },
      { id: 'a', start: at('2026-10-22T03:00:00Z'), end: at('2026-10-22T05:00:00Z'), reason: 'Exam' },
      { id: 'b', start: at('2026-11-10T03:00:00Z'), end: at('2026-11-10T05:00:00Z') },
      { id: 'd', start: at('2026-10-21T03:00:00Z'), end: at('2026-10-21T04:00:00Z') },
      { id: 'e', start: day('2026-10-21'), repeat: { weekdays: [6], from: '06:00', to: '07:00' } },
    ];
    expect(r.expandBlocks(blocks, range).map((s) => [s.blockId, s.reason, s.repeat])).toEqual([
      ['d', null, false],
      ['a', 'Exam', false],
      ['c', 'League nights', true],
      ['e', null, true],
    ]);
  });

  it('merges overlapping and touching spans; finds overlaps and free time', () => {
    const h = (x) => at(`2026-10-21T${x}:00:00Z`);
    const spans = [
      { start: h('12'), end: h('13') },
      { start: h('10'), end: h('11') },
      { start: h('10').getTime() + 30 * MIN, end: h('12') },
      { start: h('14'), end: h('15') },
    ];
    expect(r.mergeSpans(spans)).toEqual([
      { start: h('10'), end: h('13') },
      { start: h('14'), end: h('15') },
    ]);
    expect(r.overlapping(spans, h('11'), h('12'))).toHaveLength(1);
    expect(r.hasFreeTime(spans, h('10'), h('10'))).toBe(false);
    expect(r.hasFreeTime([], h('10'), h('11'))).toBe(true);
    expect(r.hasFreeTime(spans, h('10'), h('13'))).toBe(false);
    expect(r.hasFreeTime(spans, h('09'), h('10'))).toBe(true);
    expect(r.hasFreeTime(spans, h('10'), h('16'))).toBe(true);
    expect(r.hasFreeTime(spans, h('14'), h('16'))).toBe(true);
  });
});

describe('M11-FR-14 calendar saves', () => {
  const now = at('2026-10-21T06:00:00Z'); // 12:00 Dhaka
  const today = r.dhakaMidnight('2026-10-21');
  const range = { from: today, to: r.dhakaMidnight('2026-11-04') };
  const block = (s, e) => ({ start: at(s), end: at(e) });
  const errs = (over) => r.blockErrors({ range, blocks: [], now, horizonDays: 60, ...over }).map((e) => `${e.field}: ${e.message}`);

  it('sets the horizon at 00:00 Dhaka after the last whole day', () => {
    expect(r.horizonEnd(now, 60)).toEqual(at('2026-12-20T18:00:00Z'));
  });

  it('accepts blocks inside the range, apart, and repeats within the horizon', () => {
    const blocks = [block('2026-10-23T12:00:00Z', '2026-10-23T16:00:00Z'), block('2026-10-22T03:00:00Z', '2026-10-22T05:00:00Z')];
    const repeats = [{ weekdays: [5], from: '18:00', to: '22:00' }, { weekdays: [1], from: '06:00', to: '08:00', until: '2026-12-20' }];
    expect(errs({ blocks, repeats })).toEqual([]);
  });

  it('refuses a backwards or past range, one beyond the horizon, bad blocks, overlaps and bad repeats', () => {
    expect(errs({ range: { from: range.to, to: range.from } })).toEqual(['to: The range must end after it starts']);
    expect(errs({ range: { from: new Date(today.getTime() - DAY), to: range.to } })).toEqual(['from: Past days cannot be changed']);
    expect(errs({ range: { from: today, to: r.dhakaMidnight('2026-12-22') } })).toEqual(['to: At most 60 days ahead']);
    expect(errs({ blocks: [block('2026-10-23T16:00:00Z', '2026-10-23T12:00:00Z')] })).toEqual(['blocks[0]: A block must end after it starts']);
    expect(errs({ blocks: [block('2026-11-05T12:00:00Z', '2026-11-05T16:00:00Z')] })).toEqual(['blocks[0]: Keep blocks inside the range']);
    expect(errs({ blocks: [block('2026-10-20T12:00:00Z', '2026-10-20T16:00:00Z')] })).toEqual(['blocks[0]: Keep blocks inside the range']);
    expect(errs({ blocks: [block('2026-10-23T14:00:00Z', '2026-10-23T18:00:00Z'), block('2026-10-23T12:00:00Z', '2026-10-23T16:00:00Z')] })).toEqual(['blocks[0]: Blocks overlap']);
    expect(errs({ repeats: [{ weekdays: [5], from: '22:00', to: '18:00' }, { weekdays: [5], from: '18:00', to: '22:00', until: '2026-12-21' }] })).toEqual([
      'repeats[0]: A repeat must end after it starts, the same day',
      'repeats[1]: At most 60 days ahead',
    ]);
  });

  it('plans a replace: drop what is not wanted, add what is new (once)', () => {
    expect(r.replacePlan([{ k: 1 }, { k: 2 }], [{ k: 2 }, { k: 3 }, { k: 3 }], (x) => x.k)).toEqual({ remove: [{ k: 1 }], add: [{ k: 3 }] });
  });

  it('adds the `available` check: a request over blocked time fails it (§6.5)', () => {
    const base = { role: { requiresCredential: false, policeCheckForU16: false }, experienceLevel: 'pro', credential: null, policeUntil: null, jobs: [{ start: at('2026-10-25T13:30:00Z'), u16: false }], clashes: [], perDay: {}, maxPerDay: 2, now, leadMin: 120 };
    expect(r.checks(base).find((c) => c.key === 'available')).toEqual({ key: 'available', ok: true });
    expect(r.checks({ ...base, blocked: [{ start: 'x' }] }).filter((c) => !c.ok).map((c) => c.key)).toEqual(['available']);
  });
});

describe('Round B1 completeness', () => {
  const full = { photo: true, rateCard: true, credentialApplies: true, credential: true, policeClearance: true, availability: true, payoutAccount: true };

  it('scores a hire profile: every step, police clearance only for under-16 work, credential only where it applies', () => {
    const done = r.completeness({ headline: 'BCB umpire', bio: 'x'.repeat(60), worksWithU16: true }, full, { bioMinChars: 60 });
    expect(done.score).toBe(100);
    expect(done.steps.map((s) => s.key)).toEqual(['photo', 'headline', 'bio', 'rateCard', 'credential', 'policeClearance', 'availability', 'payoutAccount']);
    const empty = r.completeness({ headline: '  ', bio: null, worksWithU16: false }, {}, { bioMinChars: 60 });
    expect(empty).toEqual({ score: 0, steps: ['photo', 'headline', 'bio', 'rateCard', 'availability', 'payoutAccount'].map((key) => ({ key, done: false })) });
    expect(r.completeness({ headline: 'Coach', bio: 'Short bio', worksWithU16: false }, { photo: true, rateCard: true }, { bioMinChars: 60 }).score).toBe(50);
    expect(r.scoreOf([])).toEqual({ score: 100, steps: [] });
  });

  it('scores a player profile: sports with positions, bio, esports UID, NID', () => {
    const p = { sports: [{ sportKey: 'cricket', positions: ['batter'] }], bio: 'Opening bat' };
    expect(t.playerCompleteness(p, { esportsUid: true, nid: true }).score).toBe(100);
    expect(t.playerCompleteness({ sports: [], bio: null }, {})).toEqual({ score: 0, steps: ['sports', 'bio', 'esportsUid', 'nid'].map((key) => ({ key, done: false })) });
    expect(t.playerCompleteness({ sports: [{ sportKey: 'cricket' }], bio: ' ' }, { nid: true }).score).toBe(25);
  });
});
