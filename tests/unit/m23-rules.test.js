'use strict';

// M23 big events: pure rules (events.rules) and M21's stream parsing and embeds (streams.rules), 100%.
const R = require('../../src/modules/esports-events/events.rules');
const S = require('../../src/modules/esports/streams.rules');

const T = (o = {}) => ({ id: 't', status: 'scheduled', gameId: 'g', modeId: 'm', entryUnit: 'squad', entryPolicy: 'invite', organiserType: 'kriraghor', maxSlots: 12, minParticipants: 4, registrationClosesAt: '2026-11-10T12:00:00Z', startsAt: '2026-11-10T13:00:00Z', prizePool: { amount: 100000 }, ...o });

describe('stream links and embeds (M21-FR-29, M23)', () => {
  const yt = 'dQw4w9WgXcQ';
  const ch = 'UCabcdefghijklmnopqrstuv';
  it('parses YouTube forms into a reference', () => {
    expect(S.parseStream('youtube', `https://www.youtube.com/watch?v=${yt}`)).toEqual({ ref: `yt:v:${yt}` });
    expect(S.parseStream('youtube', `https://youtu.be/${yt}`)).toEqual({ ref: `yt:v:${yt}` });
    expect(S.parseStream('youtube', `https://www.youtube.com/live/${yt}?si=x`)).toEqual({ ref: `yt:v:${yt}` });
    expect(S.parseStream('youtube', `https://m.youtube.com/embed/${yt}`)).toEqual({ ref: `yt:v:${yt}` });
    expect(S.parseStream('youtube', `https://www.youtube.com/channel/${ch}/live`)).toEqual({ ref: `yt:c:${ch}` });
    // Accepted as links, but nothing to embed.
    expect(S.parseStream('youtube', 'https://www.youtube.com/@kriraghor/live')).toEqual({ ref: null });
    expect(S.parseStream('youtube', 'https://www.youtube.com/watch?v=short')).toEqual({ ref: null });
    expect(S.parseStream('youtube', 'https://www.youtube.com/watch')).toEqual({ ref: null });
    expect(S.parseStream('youtube', 'https://youtu.be/')).toEqual({ ref: null });
    expect(S.parseStream('youtube', 'https://www.youtube.com/live/')).toEqual({ ref: null });
    expect(S.parseStream('youtube', `https://www.youtube.com/channel/${ch}`)).toEqual({ ref: null });
    expect(S.parseStream('youtube', 'https://www.youtube.com/channel/')).toEqual({ ref: null });
  });
  it('parses Facebook forms; fb.watch, TikTok and other are links only', () => {
    expect(S.parseStream('facebook', 'https://www.facebook.com/watch/?v=1234567890')).toEqual({ ref: 'fb:watch:1234567890' });
    expect(S.parseStream('facebook', 'https://www.facebook.com/watch/')).toEqual({ ref: null });
    expect(S.parseStream('facebook', 'https://www.facebook.com/kriraghor/videos/1234567890/')).toEqual({ ref: 'fb:kriraghor/1234567890' });
    expect(S.parseStream('facebook', 'https://m.facebook.com/kriraghor/videos/grand-final/1234567890')).toEqual({ ref: 'fb:kriraghor/1234567890' });
    expect(S.parseStream('facebook', 'https://www.facebook.com/kriraghor/videos/grand-final')).toEqual({ ref: null });
    expect(S.parseStream('facebook', 'https://www.facebook.com/kriraghor/videos/')).toEqual({ ref: null });
    expect(S.parseStream('facebook', 'https://www.facebook.com/bad page/videos/1234567890')).toEqual({ ref: null });
    expect(S.parseStream('facebook', 'https://www.facebook.com/kriraghor')).toEqual({ ref: null });
    expect(S.parseStream('facebook', 'https://fb.watch/abc')).toEqual({ ref: null });
    expect(S.parseStream('tiktok', 'https://www.tiktok.com/@kriraghor/live')).toEqual({ ref: null });
    expect(S.parseStream('other', 'https://example.org/live')).toEqual({ ref: null });
  });
  it('refuses http, credentials, wrong hosts, unknown platforms and garbage', () => {
    for (const [p, u] of [
      ['youtube', `http://www.youtube.com/watch?v=${yt}`],
      ['youtube', `https://user:pw@www.youtube.com/watch?v=${yt}`],
      ['youtube', `https://evil.example/watch?v=${yt}`],
      ['twitch', 'https://www.twitch.tv/x'],
      ['facebook', 'not a url'],
    ])
      expect(S.parseStream(p, u)).toEqual({ error: 'STREAM_URL_INVALID' });
  });
  it('builds player URLs from references only', () => {
    expect(S.embedFor(`yt:v:${yt}`)).toBe(`https://www.youtube-nocookie.com/embed/${yt}`);
    expect(S.embedFor(`yt:c:${ch}`)).toBe(`https://www.youtube-nocookie.com/embed/live_stream?channel=${ch}`);
    expect(S.embedFor('fb:watch:1234567890')).toBe(`https://www.facebook.com/plugins/video.php?href=${encodeURIComponent('https://www.facebook.com/watch/?v=1234567890')}&show_text=false`);
    expect(S.embedFor('fb:kriraghor/1234567890')).toBe(`https://www.facebook.com/plugins/video.php?href=${encodeURIComponent('https://www.facebook.com/kriraghor/videos/1234567890/')}&show_text=false`);
    for (const bad of [null, '', 'yt:v:bad', 'yt:c:bad', 'yt:x:abc', 'fb:watch:12', 'fb:kriraghor/12', 'fb:bad page/1234567890', 'fb', 'tt:x:y', 'fb:a:b:c'])
      expect(S.embedFor(bad)).toBeNull();
  });
});

describe('events.rules', () => {
  const now = new Date('2026-11-10T12:30:00Z');
  it('works out the phase', () => {
    const e = { status: 'published', startsAt: '2026-11-10T10:00:00Z', endsAt: '2026-11-11T10:00:00Z' };
    expect(R.phase({ ...e, status: 'draft' }, [], now)).toBe('draft');
    expect(R.phase({ ...e, status: 'cancelled' }, [], now)).toBe('cancelled');
    expect(R.phase({ ...e, startsAt: '2026-11-12T00:00:00Z', endsAt: '2026-11-13T00:00:00Z' }, [{ status: 'live' }], now)).toBe('live');
    expect(R.phase({ ...e, startsAt: '2026-11-12T00:00:00Z', endsAt: '2026-11-13T00:00:00Z' }, [{ status: 'scheduled' }], now)).toBe('upcoming');
    expect(R.phase({ ...e, endsAt: '2026-11-10T11:00:00Z' }, [], now)).toBe('ended');
    expect(R.phase(e, [], now)).toBe('live');
    expect(['live', 'upcoming', 'ended']).toContain(R.phase(e, []));
  });
  it('checks event fields', () => {
    expect(R.eventBlock({ startsAt: '2026-11-10', endsAt: '2026-11-09' })).toBe('EVENT_DATES_INVALID');
    expect(R.eventBlock({ startsAt: '2026-11-10', endsAt: '2026-11-11', accentHex: '#FFF' })).toBe('EVENT_ACCENT_INVALID');
    expect(R.eventBlock({ startsAt: '2026-11-10', endsAt: '2026-11-11', accentHex: '#f2a33a' })).toBeNull();
    expect(R.eventBlock({ startsAt: '2026-11-10', endsAt: '2026-11-11' })).toBeNull();
  });
  it('checks the stage list', () => {
    const f = { tournamentId: 'f', role: 'final' };
    const q = (id, o = {}) => ({ tournamentId: id, role: 'qualifier', finalTournamentId: 'f', qualifyCount: 4, ...o });
    expect(R.stagesBlock([f, q('a'), q('b')], 16)).toBeNull();
    expect(R.stagesBlock([f, q('a')], 1)).toBe('EVENT_STAGES_INVALID');
    expect(R.stagesBlock([f, q('a'), q('a')], 16)).toBe('EVENT_STAGES_INVALID');
    expect(R.stagesBlock([f, q('a', { finalTournamentId: 'x' })], 16)).toBe('EVENT_STAGES_INVALID');
    expect(R.stagesBlock([f, q('a', { qualifyCount: 0 })], 16)).toBe('EVENT_STAGES_INVALID');
    expect(R.stagesBlock([{ ...f, qualifyCount: 3 }], 16)).toBe('EVENT_STAGES_INVALID');
    expect(R.stagesBlock([{ ...f, finalTournamentId: 'a' }], 16)).toBe('EVENT_STAGES_INVALID');
  });
  it('checks a final against its qualifiers', () => {
    const q = (o = {}) => T({ id: 'q', entryPolicy: 'open', startsAt: '2026-11-10T09:00:00Z', qualifyCount: 4, ...o });
    expect(R.linkBlock(T(), [q(), q()], 90)).toBeNull();
    expect(R.linkBlock(T(), [], 90)).toBeNull();
    expect(R.linkBlock(T({ entryPolicy: 'open' }), [q()], 90)).toBe('EVENT_FINAL_NOT_INVITE');
    expect(R.linkBlock(T({ entryPolicy: 'open' }), [], 90)).toBeNull();
    expect(R.linkBlock(T({ organiserType: 'organisation' }), [q()], 90)).toBe('EVENT_TOURNAMENT_NOT_OURS');
    expect(R.linkBlock(T({ status: 'finalised' }), [q()], 90)).toBe('EVENT_TOURNAMENT_STATE');
    expect(R.linkBlock(T(), [q({ organiserType: 'organisation' })], 90)).toBe('EVENT_TOURNAMENT_NOT_OURS');
    expect(R.linkBlock(T(), [q({ gameId: 'x' })], 90)).toBe('EVENT_LINK_MISMATCH');
    expect(R.linkBlock(T(), [q({ modeId: 'x' })], 90)).toBe('EVENT_LINK_MISMATCH');
    expect(R.linkBlock(T(), [q({ entryUnit: 'player' })], 90)).toBe('EVENT_LINK_MISMATCH');
    expect(R.linkBlock(T(), [q({ startsAt: '2026-11-10T11:00:00Z' })], 90)).toBe('EVENT_QUALIFY_GAP');
    expect(R.linkBlock(T({ maxSlots: 7 }), [q(), q()], 90)).toBe('EVENT_FINAL_SLOTS');
    expect(R.linkBlock(T({ minParticipants: 9 }), [q(), q()], 90)).toBe('EVENT_FINAL_MIN');
  });
  it('takes the top N, skipping disqualified entries and those already in the final', () => {
    const row = (rank, o = {}) => ({ rank, registrationId: `r${rank}`, squadId: `s${rank}`, registrantUserId: `u${rank}`, status: 'checked_in', playerUserIds: [], ...o });
    const cut = R.qualifyCut([row(3), row(1), row(2, { status: 'disqualified' }), row(4), row(5)], 2, new Set(['s:s3']));
    expect(cut.map((r) => r.rank)).toEqual([1, 4]);
    expect(R.qualifyCut([row(1, { squadId: null }), row(2, { squadId: null })], 1).map((r) => r.registrantUserId)).toEqual(['u1']);
    expect(R.qualifyCut([row(1)], 3)).toHaveLength(1);
    expect(R.entryKey({ squadId: 's', userId: null })).toBe('s:s');
    expect(R.entryKey({ squadId: null, userId: 'u' })).toBe('u:u');
  });
  it('asks a squad to bring enough of its qualified players', () => {
    expect(R.coreBlock([], ['a'], 3)).toBeNull();
    expect(R.coreBlock(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'x'], 3)).toBeNull();
    expect(R.coreBlock(['a', 'b', 'c', 'd'], ['a', 'b', 'x', 'y'], 3)).toBe('EVENT_CORE_PLAYERS');
    expect(R.coreBlock(['a', 'b'], ['a', 'b', 'x', 'y'], 3)).toBeNull();
  });
  it('times alerts and reminders', () => {
    expect(R.cooldownOver(null, now, 60)).toBe(true);
    expect(R.cooldownOver('2026-11-10T12:00:00Z', now, 60)).toBe(false);
    expect(R.cooldownOver('2026-11-10T11:30:00Z', now, 60)).toBe(true);
    expect(R.finalReminderDue('2026-11-10T12:50:00Z', now, 30)).toBe(true);
    expect(R.finalReminderDue('2026-11-10T13:30:00Z', now, 30)).toBe(false);
    expect(R.finalReminderDue('2026-11-10T12:00:00Z', now, 30)).toBe(false);
  });
  it('checks polls and votes, and counts them to 100%', () => {
    const o = (l) => ({ labelEn: l });
    expect(R.pollOptionsBlock([o('A'), o('B')], 6)).toBeNull();
    expect(R.pollOptionsBlock([o('A')], 6)).toBe('POLL_OPTIONS_INVALID');
    expect(R.pollOptionsBlock([o('A'), o('B'), o('C')], 2)).toBe('POLL_OPTIONS_INVALID');
    expect(R.pollOptionsBlock([o('A'), o(' a ')], 6)).toBe('POLL_OPTIONS_INVALID');
    const poll = { status: 'open', closesAt: null };
    expect(R.voteBlock(poll, 'x', ['x', 'y'], now)).toBeNull();
    expect(R.voteBlock({ ...poll, status: 'closed' }, 'x', ['x'], now)).toBe('POLL_CLOSED');
    expect(R.voteBlock({ ...poll, closesAt: '2026-11-10T12:00:00Z' }, 'x', ['x'], now)).toBe('POLL_CLOSED');
    expect(R.voteBlock({ ...poll, closesAt: '2026-11-10T13:00:00Z' }, 'z', ['x'], now)).toBe('POLL_OPTION_UNKNOWN');
    expect(R.pollTotals(['a', 'b'], new Map())).toEqual({ total: 0, items: [{ optionId: 'a', votes: 0, pct: 0 }, { optionId: 'b', votes: 0, pct: 0 }] });
    const t = R.pollTotals(['a', 'b', 'c'], new Map([['a', 1], ['b', 1], ['c', 1]]));
    expect(t.total).toBe(3);
    expect(t.items.reduce((s, i) => s + i.pct, 0)).toBe(100);
    expect(R.pollTotals(['a', 'b'], new Map([['a', 3], ['b', 1]])).items.map((i) => i.pct)).toEqual([75, 25]);
    expect(R.pollTotals(['a', 'b', 'c'], new Map([['a', 2]])).items.map((i) => i.pct)).toEqual([100, 0, 0]);
  });
  it('sums prizes, guards cancel, checks links and slugs', () => {
    expect(R.prizeTotal([T(), T({ status: 'cancelled' }), T({ prizePool: { amount: 50000 } })])).toBe(150000);
    expect(R.cancelBlock([T({ status: 'live' })])).toBe('EVENT_TOURNAMENT_RUNNING');
    expect(R.cancelBlock([T({ status: 'finalised' })])).toBeNull();
    expect(R.httpsUrl('https://sponsor.example/x')).toBe(true);
    expect(R.httpsUrl('http://sponsor.example')).toBe(false);
    expect(R.httpsUrl('https://a:b@sponsor.example')).toBe(false);
    expect(R.httpsUrl('nope')).toBe(false);
    expect(R.slugify('Kriraghor FF Championship 2026!', 'abc123')).toBe('kriraghor-ff-championship-2026-abc123');
    expect(R.slugify('!!!', 'abc123')).toBe('abc123');
  });
});
