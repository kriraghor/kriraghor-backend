'use strict';

// M23 big events end to end: an event over M21 tournaments with link checks; qualifiers finalised put
// their top N into an invite-only final; only qualified or invited entries enter (one place, used once,
// given back on withdraw); disqualification and staff revoke; places missed when the final closes;
// squads bring enough of their qualified players; follows with paged in-app alerts and a cooldown;
// streams (embeds), sponsors, banner, polls (one vote, final), the feed, realtime pings and cancel rules.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const realtime = require('../../src/common/realtime');
const f = require('../fixtures/market');
const es = require('../fixtures/esports');
const jobs = require('../../src/modules/esports-events/events.jobs');

const { api, P, models } = h;

let master;
let reviewer;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  reviewer = await f.staffWith(master, ['approve_listings']);
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const admin = (method, path) => api()[method](`${P}/admin/esports/events${path}`).set(h.bearer(master));
const codesOf = async (userId, code) => models.Notification.count({ where: { userId, code } });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('banner')]);

/** A published Kriraghor tournament (drafted by the master, approved by the reviewer). */
async function tournament(opts) {
  const t = (await api().post(`${P}/admin/esports/tournaments`).set(h.bearer(master)).send(await es.tournamentBody(opts)).expect(201)).body;
  await api().post(`${P}/admin/esports/tournaments/${t.id}/submit`).set(h.bearer(master)).expect(200);
  await h.drainEvents();
  await f.review(reviewer, 'esports_tournament', t.id);
  return t;
}

/** Fill, play (placements in the order given), post, close disputes and finalise. */
async function play(t, people, { squads = null } = {}) {
  if (squads) {
    await es.openRegistration(t.id);
    for (const s of squads) {
      const r = await api().post(`${P}/esports/tournaments/${t.id}/registrations`).set(h.bearer(s.captain)).set('Idempotency-Key', f.uniq('reg')).send({ squadId: s.id, players: s.players.map((p) => p.profileId) }).expect(201);
      s.reg = r.body.registration;
    }
    await es.closeRegistration(t.id);
    await es.openCheckin(t.id);
    for (const s of squads) for (const p of s.players) await api().post(`${P}/me/esports/registrations/${s.reg.id}/check-in`).set(h.bearer(p)).expect(200);
  } else await es.fill(t.id, people);
  await es.startMatches(t.id);
  const [m] = await es.matchesOf(t.id);
  const entries = squads ?? people;
  const rows = entries.map((e, i) => ({ registrationId: e.reg.id, placement: i + 1, kills: [] }));
  await api().put(`${P}/admin/esports/matches/${m.id}/results`).set(h.bearer(master)).send({ rows }).expect(200);
  await api().post(`${P}/admin/esports/matches/${m.id}/results/post`).set(h.bearer(master)).expect(200);
  await es.closeDisputes(t.id);
  await api().post(`${P}/admin/esports/tournaments/${t.id}/finalise`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'esports.money')).expect(200);
  await h.drainEvents();
}

const register = (who, t, body) => api().post(`${P}/esports/tournaments/${t.id}/registrations`).set(h.bearer(who)).set('Idempotency-Key', f.uniq('reg')).send(body);
const eventBody = (o = {}) => ({ titleEn: 'Kriraghor FF Championship 2026', titleBn: 'ক্রীড়াঘর এফএফ চ্যাম্পিয়নশিপ ২০২৬', startsAt: new Date(Date.now() - 3600000).toISOString(), endsAt: new Date(Date.now() + 2 * 86400000).toISOString(), featured: true, ...o });

describe('M23 events, qualifiers and the invite-only final', () => {
  it('links with checks; qualifiers fill the final; only qualified entries enter; withdraw, disqualify, invite, revoke, missed', async () => {
    const q1 = await tournament({ fee: 0, maxSlots: 4, min: 2, prizes: [20000, 10000] });
    const q2 = await tournament({ fee: 0, maxSlots: 4, min: 2, prizes: [20000, 10000] });
    const late = await tournament({ fee: 0, startsInHours: 9 });
    const fin = await tournament({ fee: 0, maxSlots: 5, min: 2, prizes: [100000, 50000], startsInHours: 10, entryPolicy: 'invite' });
    const open = await tournament({ fee: 0, startsInHours: 10 });
    expect(fin).toMatchObject({ entryPolicy: 'invite' });
    // The entry policy is locked after publish.
    expect((await api().patch(`${P}/admin/esports/tournaments/${fin.id}`).set(h.bearer(master)).send({ entryPolicy: 'open' }).expect(409)).body.code).toBe('ESPORTS_PRIZE_TABLE_LOCKED');

    const e = (await admin('post', '').send(eventBody()).expect(201)).body;
    expect(e).toMatchObject({ status: 'draft', phase: 'draft', accentHex: '#f2a33a' });
    expect((await admin('post', '').send(eventBody({ endsAt: new Date(Date.now() - 7200000).toISOString() })).expect(422)).body.code).toBe('EVENT_DATES_INVALID');
    expect((await admin('post', `/${e.id}/publish`).expect(409)).body.code).toBe('EVENT_NOT_PUBLISHABLE');
    const stage = (t, role, o = {}) => ({ tournamentId: t.id, role, labelEn: role === 'final' ? 'Grand final' : 'Qualifier', labelBn: role === 'final' ? 'গ্র্যান্ড ফাইনাল' : 'কোয়ালিফায়ার', ...o });
    const q = (t, n = 2) => stage(t, 'qualifier', { qualifyCount: n, finalTournamentId: fin.id });
    const put = (stages) => admin('put', `/${e.id}/stages`).send({ stages });
    expect((await put([stage(open, 'final'), stage(q1, 'qualifier', { qualifyCount: 2, finalTournamentId: open.id })]).expect(422)).body.code).toBe('EVENT_FINAL_NOT_INVITE');
    expect((await put([stage(fin, 'final'), q(q1, 3), q(q2, 3)]).expect(422)).body.code).toBe('EVENT_FINAL_SLOTS');
    expect((await put([stage(fin, 'final'), q(late)]).expect(422)).body.code).toBe('EVENT_QUALIFY_GAP');
    expect((await put([stage(fin, 'final'), q(q1), q(q1)]).expect(422)).body.code).toBe('EVENT_STAGES_INVALID');
    await put([stage(fin, 'final'), q(q1), q(q2)]).expect(200);
    await admin('post', `/${e.id}/publish`).expect(200);
    // Another event cannot take the same tournament.
    const other = (await admin('post', '').send(eventBody({ titleEn: 'Another cup' })).expect(201)).body;
    expect((await admin('put', `/${other.id}/stages`).send({ stages: [stage(fin, 'final')] }).expect(409)).body.code).toBe('EVENT_TOURNAMENT_IN_OTHER_EVENT');

    const b = (await api().get(`${P}/esports/events/${e.slug}`).expect(200)).body;
    expect(b.event).toMatchObject({ status: 'published', phase: 'live', prizeTotal: { amount: 30000 + 30000 + 150000 } });
    expect(b.stages.map((s) => s.role)).toEqual(['final', 'qualifier', 'qualifier']);
    expect(b.stages[0].tournament).toMatchObject({ entryPolicy: 'invite' });
    // Drafts are not public; the list shows the published one.
    await api().get(`${P}/esports/events/${other.slug}`).expect(404);
    expect((await api().get(`${P}/esports/events`).expect(200)).body.items.map((x) => x.id)).toEqual([e.id]);
    expect((await api().get(`${P}/esports/events?tournamentId=${q1.id}`).expect(200)).body.items.map((x) => x.id)).toEqual([e.id]);
    expect((await api().get(`${P}/esports/events?tournamentId=${late.id}`).expect(200)).body.items).toEqual([]);

    const ppl = [];
    for (const n of ['Ana', 'Bijoy', 'Chandni', 'Dipu', 'Emon', 'Faria', 'Gias']) ppl.push(await es.player(reviewer, `${n} Player`));
    const [a, bj, ch, d, em, fa, gi] = ppl;
    await play(q1, [a, bj, ch]);
    await play(q2, [d, em, fa]);
    let quals = (await admin('get', `/${e.id}/qualifications`).expect(200)).body.items;
    expect(quals.map((x) => [x.rank, x.status, x.entry.kind])).toEqual([
      [1, 'qualified', 'player'],
      [1, 'qualified', 'player'],
      [2, 'qualified', 'player'],
      [2, 'qualified', 'player'],
    ]);
    expect(await codesOf(a.user.id, 'ESPORTS_EVENT_QUALIFIED')).toBe(1);
    expect(await codesOf(ch.user.id, 'ESPORTS_EVENT_QUALIFIED')).toBe(0);
    const feed = (await api().get(`${P}/esports/events/${e.id}/feed`).expect(200)).body.items.map((i) => i.kind);
    expect(feed).toEqual(expect.arrayContaining(['qualified', 'tournament_finalised']));

    // Disqualified after qualifying: that place is withdrawn (no pass-down).
    await api().post(`${P}/admin/esports/registrations/${em.reg.id}/disqualify`).set(h.bearer(master)).send({ reasonCode: 'cheating', note: 'Emulator in a mobile lobby' }).expect(200);
    await h.drainEvents();
    expect(await codesOf(em.user.id, 'ESPORTS_EVENT_QUALIFICATION_REVOKED')).toBe(1);

    // The final: only qualified entries; one place used once; a withdrawal gives it back.
    await es.openRegistration(fin.id);
    expect((await register(ch, fin, { players: [ch.profileId] }).expect(403)).body.code).toBe('EVENT_NOT_QUALIFIED');
    const entered = (await register(a, fin, { players: [a.profileId] }).expect(201)).body.registration;
    expect(entered.status).toBe('confirmed');
    expect(await models.EsportsEventQualification.findOne({ where: { userId: a.user.id } })).toMatchObject({ status: 'entered', finalRegistrationId: entered.id });
    await api().post(`${P}/me/esports/registrations/${entered.id}/withdraw`).set(h.bearer(a)).expect(200);
    await h.drainEvents();
    expect((await models.EsportsEventQualification.findOne({ where: { userId: a.user.id } })).status).toBe('qualified');
    await register(a, fin, { players: [a.profileId] }).expect(201);

    // Staff: invite a wildcard (a verified player), revoke an unused place.
    expect((await admin('post', `/${e.id}/qualifications`).send({ finalTournamentId: fin.id, squadId: '00000000-0000-4000-8000-000000000000', reason: 'Wildcard for the final' }).expect(422)).body.code).toBe('EVENT_INVITE_INVALID');
    const inv = (await admin('post', `/${e.id}/qualifications`).send({ finalTournamentId: fin.id, userId: gi.user.id, reason: 'Wildcard for the final' }).expect(201)).body;
    expect(inv).toMatchObject({ status: 'invited', rank: null });
    expect((await admin('post', `/${e.id}/qualifications`).send({ finalTournamentId: fin.id, userId: gi.user.id, reason: 'Wildcard again' }).expect(409)).body.code).toBe('EVENT_ALREADY_QUALIFIED');
    await register(gi, fin, { players: [gi.profileId] }).expect(201);
    const bq = await models.EsportsEventQualification.findOne({ where: { userId: bj.user.id } });
    await admin('post', `/${e.id}/qualifications/${bq.id}/revoke`).send({ reason: 'Account shared with another player' }).expect(200);
    expect((await register(bj, fin, { players: [bj.profileId] }).expect(403)).body.code).toBe('EVENT_NOT_QUALIFIED');
    const entQ = await models.EsportsEventQualification.findOne({ where: { userId: a.user.id } });
    expect((await admin('post', `/${e.id}/qualifications/${entQ.id}/revoke`).send({ reason: 'Already entered, cannot' }).expect(409)).body.code).toBe('EVENT_QUALIFICATION_STATE');

    // Registration closes: D's unused place is missed; staff hear about it.
    await es.closeRegistration(fin.id);
    expect((await jobs.tick()).missed).toBe(1);
    await h.drainEvents();
    expect((await models.EsportsEventQualification.findOne({ where: { userId: d.user.id } })).status).toBe('missed');
    expect(await codesOf(master.user.id, 'ESPORTS_EVENT_QUALIFICATION_MISSED')).toBe(1);
    quals = (await api().get(`${P}/esports/events/${e.slug}`).expect(200)).body.qualifications;
    expect(quals.map((x) => x.status).sort()).toEqual(['entered', 'entered', 'missed']);

    // Cancelling the event is refused while a tournament runs; never cancels tournaments.
    await es.openCheckin(fin.id);
    await es.startMatches(fin.id);
    expect((await admin('post', `/${e.id}/cancel`).send({ reason: 'Venue power cut' }).expect(409)).body.code).toBe('EVENT_TOURNAMENT_RUNNING');
  }, 120000);

  it('a squad final: the captain enters with enough of the players who qualified', async () => {
    const q = await tournament({ fee: 0, modeKey: 'squad', maxSlots: 4, min: 2, prizes: [20000] });
    const fin = await tournament({ fee: 0, modeKey: 'squad', maxSlots: 4, min: 1, prizes: [100000], startsInHours: 10, entryPolicy: 'invite' });
    const e = (await admin('post', '').send(eventBody()).expect(201)).body;
    await admin('put', `/${e.id}/stages`)
      .send({ stages: [{ tournamentId: fin.id, role: 'final', labelEn: 'Final', labelBn: 'ফাইনাল' }, { tournamentId: q.id, role: 'qualifier', labelEn: 'Qualifier', labelBn: 'কোয়ালিফায়ার', qualifyCount: 1, finalTournamentId: fin.id }] })
      .expect(200);
    await admin('post', `/${e.id}/publish`).expect(200);
    const ff = await es.game('free_fire');
    const squads = [];
    for (const label of ['Alpha', 'Bravo']) {
      const players = [];
      for (let i = 0; i < 4; i += 1) players.push(await es.player(reviewer, `${label} P${i}`));
      const sq = (await api().post(`${P}/me/esports/squads`).set(h.bearer(players[0])).send({ gameId: ff.id, name: `Team ${label}`, tag: label.slice(0, 3).toUpperCase() }).expect(201)).body;
      for (const m of players.slice(1)) await api().post(`${P}/me/esports/squads/join`).set(h.bearer(m)).send({ code: sq.inviteCode }).expect(200);
      squads.push({ id: sq.id, inviteCode: sq.inviteCode, captain: players[0], players });
    }
    await play(q, null, { squads });
    const [alpha, bravo] = squads;
    expect((await models.EsportsEventQualification.findAll({ where: { finalTournamentId: fin.id } })).map((x) => [x.squadId, x.players.length])).toEqual([[alpha.id, 4]]);
    await es.openRegistration(fin.id);
    expect((await register(bravo.captain, fin, { squadId: bravo.id, players: bravo.players.map((p) => p.profileId) }).expect(403)).body.code).toBe('EVENT_NOT_QUALIFIED');
    // A new player joins Alpha. With 4 core players required, 3 of the 4 who qualified is refused;
    // at the default (3) the same line-up enters.
    const newbie = await es.player(reviewer, 'New One');
    await api().post(`${P}/me/esports/squads/join`).set(h.bearer(newbie)).send({ code: alpha.inviteCode }).expect(200);
    const lineup = { squadId: alpha.id, players: [alpha.players[0], alpha.players[1], alpha.players[2], newbie].map((p) => p.profileId) };
    await h.setSettingForTest('esports_events.min_core_players', 4);
    expect((await register(alpha.captain, fin, lineup).expect(422)).body).toMatchObject({ code: 'EVENT_CORE_PLAYERS' });
    await h.setSettingForTest('esports_events.min_core_players', 3);
    const ok = await register(alpha.captain, fin, lineup).expect(201);
    expect(ok.body.registration.status).toBe('confirmed');
    expect((await models.EsportsEventQualification.findOne({ where: { squadId: alpha.id } })).status).toBe('entered');
  }, 120000);
});

describe('M23 late qualifiers and cancelled finals', () => {
  it('a qualifier finalised after the final closed: places missed (staff told); a cancelled final revokes them', async () => {
    const q = await tournament({ fee: 0, maxSlots: 4, min: 2, prizes: [20000] });
    const fin = await tournament({ fee: 0, maxSlots: 4, min: 1, prizes: [100000], startsInHours: 10, entryPolicy: 'invite' });
    const e = (await admin('post', '').send(eventBody()).expect(201)).body;
    await admin('put', `/${e.id}/stages`)
      .send({ stages: [{ tournamentId: fin.id, role: 'final', labelEn: 'Final', labelBn: 'ফাইনাল' }, { tournamentId: q.id, role: 'qualifier', labelEn: 'Qualifier', labelBn: 'কোয়ালিফায়ার', qualifyCount: 2, finalTournamentId: fin.id }] })
      .expect(200);
    await admin('post', `/${e.id}/publish`).expect(200);
    // A wildcard enters and the final closes before the qualifier is played.
    const w = await es.player(reviewer, 'Wild Card');
    await admin('post', `/${e.id}/qualifications`).send({ finalTournamentId: fin.id, userId: w.user.id, reason: 'Invited pro player' }).expect(201);
    await es.openRegistration(fin.id);
    await register(w, fin, { players: [w.profileId] }).expect(201);
    await es.closeRegistration(fin.id);
    expect((await models.EsportsTournament.findByPk(fin.id)).status).toBe('registration_closed');
    const ppl = [await es.player(reviewer, 'Late One'), await es.player(reviewer, 'Late Two'), await es.player(reviewer, 'Late Three')];
    await play(q, ppl);
    const rows = await models.EsportsEventQualification.findAll({ where: { finalTournamentId: fin.id, sourceTournamentId: q.id } });
    expect(rows.map((r) => r.status)).toEqual(['missed', 'missed']);
    expect(await codesOf(master.user.id, 'ESPORTS_EVENT_QUALIFICATION_MISSED')).toBe(2);
    expect(await codesOf(ppl[0].user.id, 'ESPORTS_EVENT_QUALIFIED')).toBe(0);
    // Staff cancel the final: its entries are refunded (the used place reopens) and every place is revoked.
    await api().post(`${P}/admin/esports/tournaments/${fin.id}/cancel`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'esports.money')).send({ reason: 'Server outage at the venue' }).expect(200);
    await h.drainEvents();
    const after = await models.EsportsEventQualification.findAll({ where: { finalTournamentId: fin.id }, order: [['createdAt', 'ASC']] });
    expect(after.map((r) => r.status)).toEqual(['revoked', 'revoked', 'revoked']);
    const kinds = (await api().get(`${P}/esports/events/${e.id}/feed`).expect(200)).body.items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['tournament_cancelled', 'qualified', 'tournament_finalised']));
  }, 120000);
});

describe('M23 viewers: follows, alerts, streams, sponsors, polls', () => {
  it('pages alerts to followers with a cooldown, embeds streams, runs a poll and the feed', async () => {
    const t = await tournament({ fee: 0 });
    const e = (await admin('post', '').send(eventBody()).expect(201)).body;
    await admin('put', `/${e.id}/stages`).send({ stages: [{ tournamentId: t.id, role: 'final', labelEn: 'Show final', labelBn: 'শো ফাইনাল' }] }).expect(200);
    // A final need not be invite-only when nothing feeds it.
    const fan = await h.signupUser({ name: 'Fan One' });
    await api().post(`${P}/esports/events/${e.id}/follow`).set(h.bearer(fan)).expect(404); // not published yet
    await admin('post', `/${e.id}/publish`).expect(200);
    expect((await api().post(`${P}/esports/events/${e.id}/follow`).set(h.bearer(fan)).expect(200)).body).toEqual({ following: true, followers: 1 });
    // 120 more followers: pages of 50.
    await h.setSettingForTest('esports_events.fanout_batch', 50);
    const crowd = [];
    for (let i = 0; i < 120; i += 1) crowd.push(await models.User.create({ phone: `+88019${String(40000000 + i)}`, phoneVerifiedAt: new Date(), displayName: `Viewer ${i}` }));
    await models.EsportsEventFollow.bulkCreate(crowd.map((u) => ({ eventId: e.id, userId: u.id })));
    const quitter = crowd[0];
    await models.EsportsEventFollow.update({ status: 'removed' }, { where: { eventId: e.id, userId: quitter.id } });

    // Streams: a bad link is refused; a live YouTube link embeds and alerts once (cooldown).
    expect((await admin('put', `/${e.id}/streams`).send({ streams: [{ platform: 'youtube', url: 'http://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Main' }] }).expect(422)).body.code).toBe('STREAM_URL_INVALID');
    realtime.clearEmitted();
    const live = (await admin('put', `/${e.id}/streams`).send({ streams: [{ platform: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Main stage', isLive: true }, { platform: 'tiktok', url: 'https://www.tiktok.com/@kriraghor/live', title: 'TikTok' }] }).expect(200)).body;
    expect(live.items.map((s) => s.embedUrl)).toEqual(['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', null]);
    expect(realtime.emitted().some((x) => x.room === `esports_event:${e.id}` && x.name === 'esports_event.stream_changed')).toBe(true);
    await h.drainEvents();
    const alert = await models.EsportsEventAlert.findOne({ where: { eventId: e.id, kind: 'stream_live' } });
    expect(alert).toMatchObject({ followerCount: 120, pages: 3 });
    expect(await models.Notification.count({ where: { code: 'ESPORTS_EVENT_STREAM_LIVE' } })).toBe(120);
    expect(await codesOf(fan.user.id, 'ESPORTS_EVENT_STREAM_LIVE')).toBe(1);
    expect(await codesOf(quitter.id, 'ESPORTS_EVENT_STREAM_LIVE')).toBe(0);
    // Another stream goes live within the cooldown: a feed item, no second alert.
    await admin('put', `/${e.id}/streams`).send({ streams: [{ platform: 'facebook', url: 'https://www.facebook.com/kriraghor/videos/1234567890/', title: 'Backup', isLive: true }] }).expect(200);
    // M21: a tournament stream turning live also reaches the event.
    await api().put(`${P}/admin/esports/tournaments/${t.id}/streams`).set(h.bearer(master)).send({ streams: [{ platform: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Lobby cam', isLive: true }] }).expect(200);
    await h.drainEvents();
    expect(await models.EsportsEventAlert.count({ where: { eventId: e.id, kind: 'stream_live' } })).toBe(1);
    const page = (await api().get(`${P}/esports/events/${e.slug}`).expect(200)).body;
    expect(page.feed.items.filter((i) => i.kind === 'stream_live')).toHaveLength(3);
    expect(page.streams.map((s) => [s.source, Boolean(s.embedUrl)])).toEqual([
      ['event', true],
      ['tournament', true],
    ]);
    expect((await api().get(`${P}/esports/tournaments/${t.slug}`).expect(200)).body.streams[0].embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');

    // The tick: the event started (once), the final reminder (once).
    await models.EsportsTournament.update({ registrationOpensAt: new Date(Date.now() - 3600000), registrationClosesAt: new Date(Date.now() + 5 * 60000), startsAt: new Date(Date.now() + 10 * 60000) }, { where: { id: t.id } });
    const first = await jobs.tick();
    expect(first).toMatchObject({ started: 1, finalSoon: 1 });
    expect(await jobs.tick()).toMatchObject({ started: 0, finalSoon: 0 });
    await h.drainEvents();
    expect(await codesOf(fan.user.id, 'ESPORTS_EVENT_STARTED')).toBe(1);
    expect(await codesOf(fan.user.id, 'ESPORTS_EVENT_FINAL_SOON')).toBe(1);

    // Sponsors and banner.
    expect((await admin('post', `/${e.id}/sponsors`).send({ name: 'Walton', tier: 'title', url: 'http://walton.example' }).expect(422)).body.code).toBe('SPONSOR_URL_INVALID');
    const sp = (await admin('post', `/${e.id}/sponsors`).send({ name: 'Walton', tier: 'title', url: 'https://walton.example' }).expect(201)).body;
    await admin('post', `/${e.id}/sponsors`).send({ name: 'Grameenphone', tier: 'gold' }).expect(201);
    await admin('post', `/${e.id}/sponsors/${sp.id}/logo`).set('Content-Type', 'image/png').send(JPEG).expect(415);
    expect((await admin('post', `/${e.id}/sponsors/${sp.id}/logo`).set('Content-Type', 'image/jpeg').send(JPEG).expect(200)).body.logoUrl).toEqual(expect.any(String));
    expect((await admin('post', `/${e.id}/banner`).set('Content-Type', 'image/jpeg').send(JPEG).expect(200)).body.bannerUrl).toEqual(expect.any(String));
    await admin('post', `/${e.id}/sponsors/${sp.id}/remove`).expect(200);
    expect((await api().get(`${P}/esports/events/${e.slug}`).expect(200)).body.sponsors.map((s) => s.name)).toEqual(['Grameenphone']);

    // A poll: drafts hidden, one vote each (final), totals only, closed polls refuse votes.
    expect((await admin('post', `/${e.id}/polls`).send({ questionEn: 'Who wins the final?', questionBn: 'ফাইনালে কে জিতবে?', options: [{ labelEn: 'Alpha', labelBn: 'আলফা' }, { labelEn: 'alpha', labelBn: 'আলফা' }] }).expect(422)).body.code).toBe('POLL_OPTIONS_INVALID');
    const poll = (await admin('post', `/${e.id}/polls`).send({ questionEn: 'Who wins the final?', questionBn: 'ফাইনালে কে জিতবে?', options: [{ labelEn: 'Alpha', labelBn: 'আলফা' }, { labelEn: 'Bravo', labelBn: 'ব্রাভো' }] }).expect(201)).body;
    expect((await api().get(`${P}/esports/events/${e.slug}`).expect(200)).body.polls).toHaveLength(0);
    const vote = (who, optionId) => api().post(`${P}/esports/events/${e.id}/polls/${poll.id}/vote`).set(h.bearer(who)).send({ optionId });
    expect((await vote(fan, poll.options[0].id).expect(409)).body.code).toBe('POLL_CLOSED');
    await admin('post', `/${e.id}/polls/${poll.id}/open`).expect(200);
    const fan2 = await h.signupUser({ name: 'Fan Two' });
    await vote(fan, poll.options[0].id).expect(200);
    const v2 = (await vote(fan2, poll.options[1].id).expect(200)).body;
    expect(v2).toMatchObject({ myVote: poll.options[1].id, results: { total: 2 } });
    expect((await vote(fan, poll.options[1].id).expect(409)).body.code).toBe('POLL_ALREADY_VOTED');
    expect((await vote(fan2, '00000000-0000-4000-8000-000000000000').expect(422)).body.code).toBe('POLL_OPTION_UNKNOWN');
    expect((await api().get(`${P}/esports/events/${e.id}/me`).set(h.bearer(fan)).expect(200)).body).toEqual({ following: true, votes: { [poll.id]: poll.options[0].id } });
    await admin('post', `/${e.id}/polls/${poll.id}/close`).expect(200);
    expect((await vote(await h.signupUser({ name: 'Late Fan' }), poll.options[0].id).expect(409)).body.code).toBe('POLL_CLOSED');
    const pub = (await api().get(`${P}/esports/events/${e.slug}`).expect(200)).body.polls[0];
    expect(pub.results.items.map((i) => i.pct)).toEqual([50, 50]);
    expect(JSON.stringify(pub)).not.toContain(fan.user.id);

    // Announcement, unfollow, my events; the event cancelled (its tournament stays).
    await admin('post', `/${e.id}/feed`).send({ textEn: 'The final starts in 10 minutes', textBn: 'ফাইনাল ১০ মিনিটে শুরু' }).expect(201);
    expect((await api().get(`${P}/me/esports/events`).set(h.bearer(fan)).expect(200)).body.items.map((x) => x.id)).toEqual([e.id]);
    expect((await api().post(`${P}/esports/events/${e.id}/unfollow`).set(h.bearer(fan)).expect(200)).body.following).toBe(false);
    await admin('post', `/${e.id}/cancel`).send({ reason: 'Moved to next month' }).expect(200);
    expect((await api().get(`${P}/esports/events/${e.slug}`).expect(200)).body.event).toMatchObject({ status: 'cancelled', phase: 'cancelled', cancelReason: 'Moved to next month' });
    expect((await models.EsportsTournament.findByPk(t.id)).status).not.toBe('cancelled');
    expect((await admin('post', `/${e.id}/cancel`).send({ reason: 'Again please' }).expect(409)).body.code).toBe('EVENT_STATE');
  });
});
