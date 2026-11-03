'use strict';

// M26 tournament feed rules: dates, contact details in public text, what each status allows, expiry.
const r = require('../../src/modules/tournament-posts/tournament-posts.rules');

const TODAY = '2026-11-03';
const post = { startDate: '2026-11-20', endDate: '2026-11-22', registrationDeadline: '2026-11-15' };

describe('dates (M26-FR-03)', () => {
  it('accepts a sensible schedule', () => {
    expect(r.datesBlock(post, TODAY, { isNew: true })).toBeNull();
    expect(r.datesBlock({ ...post, endDate: null }, TODAY, { isNew: true })).toBeNull();
    expect(r.datesBlock({ ...post, registrationDeadline: post.startDate, endDate: post.startDate }, TODAY, { isNew: true })).toBeNull();
    expect(r.datesBlock({ ...post, startDate: TODAY, registrationDeadline: TODAY, endDate: null }, TODAY, { isNew: true })).toBeNull();
  });
  it('refuses a start in the past on a new post or when the start changes', () => {
    const past = { ...post, startDate: '2026-11-02', registrationDeadline: '2026-11-01', endDate: null };
    expect(r.datesBlock(past, TODAY, { isNew: true })).toBe('TOURNAMENT_POST_DATE_PAST');
    expect(r.datesBlock(past, TODAY, { startChanged: true })).toBe('TOURNAMENT_POST_DATE_PAST');
  });
  it('lets an edit keep a start that has since passed', () => {
    expect(r.datesBlock({ ...post, startDate: '2026-11-02', registrationDeadline: '2026-11-01', endDate: null }, TODAY)).toBeNull();
  });
  it('refuses a deadline after the start, and an end before it', () => {
    expect(r.datesBlock({ ...post, registrationDeadline: '2026-11-21' }, TODAY)).toBe('TOURNAMENT_POST_DEADLINE_AFTER_START');
    expect(r.datesBlock({ ...post, endDate: '2026-11-19' }, TODAY)).toBe('TOURNAMENT_POST_END_BEFORE_START');
  });
});

describe('contact details stay out of public text (M26-FR-04)', () => {
  it('finds the first public field holding one', () => {
    expect(r.contactField({ title: 'Mirpur Futsal Cup', description: 'Eight teams, call 01712345678' })).toBe('description');
    expect(r.contactField({ title: 'Mail cup@example.com', description: 'Eight teams' })).toBe('title');
    expect(r.contactField({ venueName: 'See www.turf.com', organiserName: 'Rafi' })).toBe('venueName');
    expect(r.contactField({ rules: 'Book at turfbd.net' })).toBe('rules');
  });
  it('leaves ordinary text and missing fields alone', () => {
    expect(r.contactField({ title: 'Mirpur Futsal Cup 2026', description: 'Eight teams, 5 a side, from 4 pm', rules: null, address: undefined })).toBeNull();
  });
  it('does not treat the map link as public text: it has its own rule', () => {
    expect(r.PUBLIC_TEXT).not.toContain('mapLink');
  });
});

describe('the map link', () => {
  it('takes Google Maps addresses only', () => {
    expect(r.mapLinkOk(null)).toBe(true);
    expect(r.mapLinkOk('')).toBe(true);
    expect(r.mapLinkOk('https://maps.app.goo.gl/abc')).toBe(true);
    expect(r.mapLinkOk('https://goo.gl/maps/abc')).toBe(true);
    expect(r.mapLinkOk('https://www.google.com/maps/place/Mirpur')).toBe(true);
    expect(r.mapLinkOk('https://google.com/maps/place/Mirpur')).toBe(true);
  });
  it('refuses everything else', () => {
    expect(r.mapLinkOk('https://www.google.com/search?q=x')).toBe(false);
    expect(r.mapLinkOk('https://example.com/maps')).toBe(false);
    expect(r.mapLinkOk('http://maps.app.goo.gl/abc')).toBe(false);
    expect(r.mapLinkOk('not a link')).toBe(false);
  });
});

describe('what each status allows (M26-FR-08, FR-09)', () => {
  it.each([
    ['open', { edit: true, comment: true, close: true, remove: true, restore: false, visible: true, thread: true, message: true }],
    ['closed', { edit: false, comment: false, close: false, remove: true, restore: false, visible: true, thread: false, message: true }],
    ['expired', { edit: false, comment: false, close: false, remove: true, restore: false, visible: true, thread: false, message: true }],
    ['removed', { edit: false, comment: false, close: false, remove: false, restore: true, visible: false, thread: false, message: false }],
  ])('%s', (status, want) => {
    expect({
      edit: r.canEdit(status),
      comment: r.canComment(status),
      close: r.canClose(status),
      remove: r.canRemove(status),
      restore: r.canRestore(status),
      visible: r.isVisible(status),
      thread: r.canOpenThread(status),
      message: r.canMessage(status),
    }).toEqual(want);
  });
  it('a restored post goes back to what it was', () => {
    expect(r.restoredStatus({ statusBeforeRemoval: 'closed' })).toBe('closed');
    expect(r.restoredStatus({ statusBeforeRemoval: 'expired' })).toBe('expired');
    expect(r.restoredStatus({ statusBeforeRemoval: 'open' })).toBe('open');
  });
  it('falls back to open when nothing usable was kept', () => {
    expect(r.restoredStatus({ statusBeforeRemoval: null })).toBe('open');
    expect(r.restoredStatus({ statusBeforeRemoval: 'removed' })).toBe('open');
  });
});

describe('registration and expiry', () => {
  it('registration stays open through the deadline day', () => {
    expect(r.registrationOpen({ status: 'open', registrationDeadline: TODAY }, TODAY)).toBe(true);
    expect(r.registrationOpen({ status: 'open', registrationDeadline: '2026-11-02' }, TODAY)).toBe(false);
    expect(r.registrationOpen({ status: 'closed', registrationDeadline: '2026-12-01' }, TODAY)).toBe(false);
  });
  it('expires the setting\'s days after the last day, using the start when there is no end', () => {
    const open = { status: 'open', startDate: '2026-10-01', endDate: '2026-10-27' };
    expect(r.expiryDue(open, TODAY, 7)).toBe(false); // 27 Oct + 7 = 3 Nov: still today
    expect(r.expiryDue(open, '2026-11-04', 7)).toBe(true);
    expect(r.expiryDue({ status: 'open', startDate: '2026-10-27', endDate: null }, '2026-11-04', 7)).toBe(true);
    expect(r.expiryDue({ ...open, status: 'closed' }, '2026-12-01', 7)).toBe(false);
  });
  it('dates are Dhaka calendar dates', () => {
    expect(r.dhakaDate('2026-11-02T18:30:00.000Z')).toBe('2026-11-03');
    expect(r.dhakaDate('2026-11-02T17:59:00.000Z')).toBe('2026-11-02');
    expect(r.addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(r.addDays('2026-11-01', -1)).toBe('2026-10-31');
  });
});

describe('threads, slugs and the fee filter', () => {
  const t = { organiserId: 'a', playerId: 'b' };
  it('knows the two people', () => {
    expect(r.otherParty(t, 'a')).toBe('b');
    expect(r.otherParty(t, 'b')).toBe('a');
    expect(r.isParty(t, 'a')).toBe(true);
    expect(r.isParty(t, 'b')).toBe(true);
    expect(r.isParty(t, 'c')).toBe(false);
  });
  it('makes a unique slug, with a word for Bangla titles', () => {
    const id = '01a19c28-f75c-7c8c-9e1c-40d197268976';
    expect(r.slugOf('Mirpur Futsal Cup!', id)).toBe('mirpur-futsal-cup-97268976');
    expect(r.slugOf('মিরপুর কাপ', id)).toBe('tournament-97268976');
  });
  it('reads free and paid; anything else is no filter', () => {
    expect(r.feeWhere('free')).toEqual({ eq: 0 });
    expect(r.feeWhere('paid')).toEqual({ gt: 0 });
    expect(r.feeWhere(undefined)).toBeNull();
  });
});
