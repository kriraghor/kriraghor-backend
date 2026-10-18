'use strict';

// M14 tournaments step 1 with M15 lite results: the organiser console, registrations and money,
// fixtures, results and standings (M14-FR-04 to FR-25, M15-FR-09/10/11/16, M16-FR-06/07/08).
const h = require('../helpers');
const f = require('../fixtures/market');
const tf = require('../fixtures/tournaments');
const { closeAllRedis } = require('../../src/common/redis');

const { api, P, models } = h;

let master;
let reviewer;
let owner;
let org;

beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  reviewer = await f.staffWith(master, ['approve_listings', 'approve_documents']);
  ({ owner, org } = await tf.sportsOrg(reviewer));
});

afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const consoleGet = (path) => api().get(`${P}/org/${org.id}/sports${path}`).set(h.bearer(owner));
const consolePost = (path, body = {}) => api().post(`${P}/org/${org.id}/sports${path}`).set(h.bearer(owner)).send(body);

describe('M14 a paid league from draft to completion', () => {
  it('review, registration with escrow, reserve list, draw, fixtures, results, both tranches and the hub', async () => {
    const t = await tf.approved(owner, org.id, reviewer);
    expect(t.status).toBe('registration_open');
    expect(t.feeBps).toBe(500);
    expect(t.releasePct).toBe(50);

    // Four captains register and pay; a fifth goes to the reserve list.
    const caps = [];
    for (const name of ['Rafi Ahmed', 'Sakib Hasan', 'Nabil Khan', 'Tamim Iqbal']) caps.push(await tf.captain(name));
    for (const c of caps) expect((await tf.register(c, t.id)).status).toBe('pending_approval');
    const fifth = await tf.captain('Mushfiq Rahim');
    expect((await tf.register(fifth, t.id)).status).toBe('reserve');

    // The organiser approves the four (the roster is ready: one NID-verified player each).
    const regs = (await consoleGet(`/tournaments/${t.id}/registrations?status=pending_approval`).expect(200)).body.items;
    expect(regs).toHaveLength(4);
    expect(regs[0].roster).toMatchObject({ total: 1, eligible: 1, ready: true });
    for (const r of regs) await consolePost(`/registrations/${r.id}/approve`).expect(200);

    // Close registration: the reserve team lapses; the draw (random, seed published) and fixtures.
    await consolePost(`/tournaments/${t.id}/registration/close`).expect(200);
    expect((await api().get(`${P}/me/registrations`).set(h.bearer(fifth)).expect(200)).body.items[0].status).toBe('lapsed');
    const preview = (await consolePost(`/tournaments/${t.id}/draw`, { seeding: 'random' }).expect(200)).body;
    expect(preview).toMatchObject({ seeding: 'random', teams: 4, matchCount: 6 });
    const drawn = (await consolePost(`/tournaments/${t.id}/draw/confirm`, { seeding: 'random' }).expect(200)).body.draw;
    expect(drawn.seed).toMatch(/^[0-9a-f]{32}$/);
    const dry = (await consolePost(`/tournaments/${t.id}/fixtures/generate`, { dryRun: true, schedule: { weekdays: [0, 1, 2, 3, 4, 5, 6], slots: ['17:00', '19:00'] } }).expect(200)).body;
    expect(dry).toMatchObject({ dryRun: true, matchCount: 6, unscheduled: [] });
    expect(await models.Match.count({ where: { tournamentId: t.id } })).toBe(0);
    await consolePost(`/tournaments/${t.id}/fixtures/generate`, { schedule: { weekdays: [0, 1, 2, 3, 4, 5, 6], slots: ['17:00', '19:00'] } }).expect(200);
    await consolePost(`/tournaments/${t.id}/fixtures/publish`).expect(200);
    await h.drainEvents();
    expect(await models.Notification.count({ where: { userId: caps[0].user.id, code: 'FIXTURES_PUBLISHED' } })).toBe(1);

    // Results: a team that loses every match; the first result releases tranche 1 (50% − 5%).
    const fixtures = (await consoleGet(`/tournaments/${t.id}/fixtures`).expect(200)).body.matches;
    expect(fixtures).toHaveLength(6);
    const weakest = caps[3].team.id;
    const scoreFor = (m) => (m.teamB.team.id === weakest ? { sets: [[21, 10], [21, 12]] } : m.teamA.team.id === weakest ? { sets: [[10, 21], [12, 21]] } : { sets: [[21, 19], [19, 21], [21, 17]] });
    const payable = `payable:user:${owner.user.id}`;
    await api().put(`${P}/org/${org.id}/sports/matches/${fixtures[0].id}/result`).set(h.bearer(owner)).send(scoreFor(fixtures[0])).expect(200);
    await h.drainEvents();
    expect(await tf.balance(payable)).toBe(4 * (900000 - 45000)); // ৳34,200
    let hub = (await api().get(`${P}/tournaments/${t.slug}`).expect(200)).body;
    expect(hub.status).toBe('live');
    expect(hub.rulesLockedAt).not.toBeNull();
    for (const m of fixtures.slice(1)) await api().put(`${P}/org/${org.id}/sports/matches/${m.id}/result`).set(h.bearer(owner)).send(scoreFor(m)).expect(200);
    await h.drainEvents();

    // Completion releases the rest: each team's ৳18,000 less 5% → ৳17,100; ৳3,600 fee in all.
    expect(await tf.balance(payable)).toBe(4 * (1800000 - 90000));
    hub = (await api().get(`${P}/tournaments/${t.slug}`).expect(200)).body;
    expect(hub.status).toBe('completed');
    const table = hub.standings[0].rows;
    expect(table).toHaveLength(4);
    expect(table[3]).toMatchObject({ teamId: weakest, points: 0, played: 3, position: 4 });
    expect(table.reduce((s, r) => s + r.played, 0)).toBe(12);
    expect(JSON.stringify(hub)).not.toMatch(/gender|"dob"|phone/i);
    const money = (await consoleGet(`/tournaments/${t.id}/overview`).expect(200)).body.money;
    expect(money).toMatchObject({ collected: 7200000, released: 7200000, held: 0, fees: 360000 });
  }, 240000);
});

describe('M14 registrations: the refund table and the reserve list (§6.9, FR-12/13)', () => {
  it('reject 100%, withdraw before close 100%, an offer taken, an offer lapsed, withdraw after close 50%', async () => {
    const t = await tf.approved(owner, org.id, reviewer, { minTeams: 2, maxTeams: 2 });
    const [a, b, c, d, e] = [await tf.captain('Rafi Ahmed'), await tf.captain('Sakib Hasan'), await tf.captain('Nabil Khan'), await tf.captain('Tamim Iqbal'), await tf.captain('Liton Das')];
    const ra = await tf.register(a, t.id);
    const rb = await tf.register(b, t.id);
    expect((await tf.register(c, t.id)).status).toBe('reserve');
    expect((await tf.register(d, t.id)).status).toBe('reserve');

    // Rejected: a full refund; the place is offered to the first reserve team.
    const rej = (await consolePost(`/registrations/${ra.id}/reject`, { reason: 'Squad name is offensive' }).expect(200)).body;
    expect(rej).toMatchObject({ status: 'rejected', refunded: 1800000 });
    await h.drainEvents();
    const offered = (await api().get(`${P}/me/registrations`).set(h.bearer(c)).expect(200)).body.items[0];
    expect(offered.status).toBe('offered');
    expect(await models.Notification.count({ where: { userId: c.user.id, code: 'RESERVE_OFFERED' } })).toBe(1);
    const taken = (await api().post(`${P}/me/registrations/${offered.id}/accept-offer`).set(h.bearer(c)).set('Idempotency-Key', f.uniq('offer')).expect(200)).body;
    expect(taken.status).toBe('pending_payment');
    await h.payWithSimulator(c, taken.payment.id);
    await h.drainPaymentJobs();
    await h.drainEvents();

    // Withdrawn before close: a full refund; the next reserve team is offered and lets it lapse.
    const wb = (await api().post(`${P}/me/registrations/${rb.id}/withdraw`).set(h.bearer(b)).expect(200)).body;
    expect(wb).toMatchObject({ status: 'withdrawn', refundedPoisha: 1800000 });
    expect((await api().get(`${P}/me/registrations`).set(h.bearer(d)).expect(200)).body.items[0].status).toBe('offered');
    await require('../../src/modules/tournaments/registrations.service').expireHolds(new Date(Date.now() + 25 * 3600000));
    expect((await api().get(`${P}/me/registrations`).set(h.bearer(d)).expect(200)).body.items[0].status).toBe('lapsed');
    const re = await tf.register(e, t.id);
    expect(re.status).toBe('pending_approval');

    // Withdrawn after close: half back (tournament.withdraw_refund_after_close_pct).
    const regs = (await consoleGet(`/tournaments/${t.id}/registrations?status=pending_approval`).expect(200)).body.items;
    for (const r of regs) await consolePost(`/registrations/${r.id}/approve`).expect(200);
    await consolePost(`/tournaments/${t.id}/registration/close`).expect(200);
    const late = (await api().post(`${P}/me/registrations/${re.id}/withdraw`).set(h.bearer(e)).expect(200)).body;
    expect(late).toMatchObject({ status: 'withdrawn', refundedPoisha: 900000 });
    // Twice is refused; a decision on an ended registration too.
    await api().post(`${P}/me/registrations/${re.id}/withdraw`).set(h.bearer(e)).expect(409);
    await consolePost(`/registrations/${ra.id}/approve`).expect(409);
  }, 240000);
});

describe('M14 groups and knockout: placeholders, the cross-over, amendments (§6.4, §6.7, M15-FR-16)', () => {
  it('2 groups of 4, top two through, third place; a free tournament', async () => {
    const t = await tf.approved(owner, org.id, reviewer, { sportKey: 'table_tennis', format: 'groups_knockout', minTeams: 8, maxTeams: 8, entryFeePoisha: 0, formatConfig: { groupCount: 2, qualifiersPerGroup: 2, thirdPlace: true } });
    const caps = [];
    for (let i = 1; i <= 8; i += 1) caps.push(await tf.captain(`Player${i} Seed`, { sportKey: 'table_tennis' }));
    for (const c of caps) expect((await tf.register(c, t.id)).status).toBe('pending_approval');
    const regs = (await consoleGet(`/tournaments/${t.id}/registrations?status=pending_approval`).expect(200)).body.items;
    for (const c of caps) await consolePost(`/registrations/${regs.find((r) => r.team.id === c.team.id).id}/approve`).expect(200);
    await consolePost(`/tournaments/${t.id}/registration/close`).expect(200);
    await consolePost(`/tournaments/${t.id}/draw/confirm`, { seeding: 'registration_order' }).expect(200);
    await consolePost(`/tournaments/${t.id}/fixtures/generate`, {}).expect(200);
    await consolePost(`/tournaments/${t.id}/fixtures/publish`).expect(200);
    const seed = new Map(caps.map((c, i) => [c.team.id, i + 1]));
    const fx = (await consoleGet(`/tournaments/${t.id}/fixtures`).expect(200)).body;
    expect(fx.draw.stages[0].groups.map((g) => g.teams.map((x) => seed.get(x.id)))).toEqual([
      [1, 4, 5, 8],
      [2, 3, 6, 7],
    ]);
    const play = (m, winner) => {
      const aWins = m.teamA.team.id === winner;
      const sets = aWins ? [[11, 5], [11, 6], [11, 7]] : [[5, 11], [6, 11], [7, 11]];
      return api().put(`${P}/org/${org.id}/sports/matches/${m.id}/result`).set(h.bearer(owner)).send({ sets });
    };
    // In the groups the better seed always wins.
    const groupMatches = fx.matches.filter((m) => m.groupId);
    expect(groupMatches).toHaveLength(12);
    for (const m of groupMatches) await play(m, seed.get(m.teamA.team.id) < seed.get(m.teamB.team.id) ? m.teamA.team.id : m.teamB.team.id).expect(200);
    let ko = (await consoleGet(`/tournaments/${t.id}/fixtures`).expect(200)).body.matches.filter((m) => !m.groupId);
    const semis = ko.filter((m) => m.roundName === 'semi_final');
    // A1 v B2 (seed 1 v seed 3) and B1 v A2 (seed 2 v seed 4).
    expect(semis.map((m) => [seed.get(m.teamA.team.id), seed.get(m.teamB.team.id)])).toEqual([
      [1, 3],
      [2, 4],
    ]);
    // An amendment in the groups is fine while no knockout match has a result…
    const gm = groupMatches[0];
    const sameWinner = seed.get(gm.teamA.team.id) < seed.get(gm.teamB.team.id) ? [[11, 9], [11, 9], [11, 9]] : [[9, 11], [9, 11], [9, 11]];
    await api().post(`${P}/org/${org.id}/sports/matches/${gm.id}/result/amend`).set(h.bearer(owner)).send({ sets: sameWinner, reason: 'Wrong points typed' }).expect(200);
    // …and refused once a match that depends on it has one.
    await play(semis[0], semis[0].teamA.team.id).expect(200);
    await api().post(`${P}/org/${org.id}/sports/matches/${gm.id}/result/amend`).set(h.bearer(owner)).send({ sets: sameWinner, reason: 'Again, sorry' }).expect(409);
    await play(semis[1], semis[1].teamB.team.id).expect(200);
    ko = (await consoleGet(`/tournaments/${t.id}/fixtures`).expect(200)).body.matches.filter((m) => !m.groupId);
    const third = ko.find((m) => m.roundName === 'third_place');
    const final = ko.find((m) => m.roundName === 'final');
    expect([seed.get(third.teamA.team.id), seed.get(third.teamB.team.id)]).toEqual([3, 2]);
    expect([seed.get(final.teamA.team.id), seed.get(final.teamB.team.id)]).toEqual([1, 4]);
    // A knockout match needs a finished score; a walkover gives it to one side.
    await api().put(`${P}/org/${org.id}/sports/matches/${third.id}/result`).set(h.bearer(owner)).send({ sets: [[11, 5]] }).expect(422);
    await api().post(`${P}/org/${org.id}/sports/matches/${third.id}/walkover`).set(h.bearer(owner)).send({ winnerTeamId: third.teamB.team.id, reason: 'Did not turn up' }).expect(200);
    await play(final, final.teamA.team.id).expect(200);
    await h.drainEvents();
    const hub = (await api().get(`${P}/tournaments/${t.slug}`).expect(200)).body;
    expect(hub.status).toBe('completed');
    expect(hub.standings.map((x) => x.group)).toEqual(['A', 'B']);
    expect(hub.standings[0].rows[0]).toMatchObject({ points: 6, position: 1 });
  }, 300000);
});

describe('M14 squads and eligibility (M16-FR-06/07/08)', () => {
  it('one team per player, women-only needs a recorded gender, the NID gate', async () => {
    const t = await tf.approved(owner, org.id, reviewer, { entryFeePoisha: 0, eligibility: { gender: 'women' }, minTeams: 2, maxTeams: 4 });
    const a = await tf.captain('Rumana Akter', { extra: 1 });
    const b = await tf.captain('Jahanara Alam');
    // A player on two teams can only be on one squad in a tournament.
    const shared = a.members[0];
    const inv = await api().post(`${P}/teams/${b.team.id}/invites`).set(h.bearer(b)).send({ phone: shared.phone }).expect(201);
    await h.drainEvents();
    await api().post(`${P}/me/team-invites/${inv.body.invite.id}/accept`).set(h.bearer(shared)).expect(200);
    const ra = await tf.register(a, t.id, { roster: [a.user.id, shared.user.id] });
    const clash = await api().post(`${P}/tournaments/${t.id}/registrations`).set(h.bearer(b)).set('Idempotency-Key', f.uniq('reg')).send({ teamId: b.team.id, rosterUserIds: [b.user.id, shared.user.id], acceptRules: true }).expect(409);
    expect(clash.body.code).toBe('PLAYER_IN_OTHER_TEAM');
    await api().post(`${P}/tournaments/${t.id}/registrations`).set(h.bearer(b)).set('Idempotency-Key', f.uniq('reg')).send({ teamId: b.team.id, rosterUserIds: [b.user.id, a.user.id], acceptRules: true }).expect(422);
    // No gender recorded: the squad is not ready; after the players record it, it is.
    const r = (await consoleGet(`/tournaments/${t.id}/registrations`).expect(200)).body.items.find((x) => x.id === ra.id);
    expect(r.roster).toMatchObject({ total: 2, eligible: 0, ready: false });
    expect(JSON.stringify(r)).not.toMatch(/gender|dob/i);
    expect((await consolePost(`/registrations/${ra.id}/approve`).expect(409)).body.code).toBe('ROSTER_NOT_READY');
    for (const who of [a, shared]) await api().put(`${P}/me/gender`).set(h.bearer(who)).send({ gender: 'female' }).expect(200);
    await h.drainEvents();
    expect(await models.EligibilityCheck.count({ where: { tournamentId: t.id, checkKey: 'gender', status: 'pass' } })).toBe(2);
    await consolePost(`/registrations/${ra.id}/approve`).expect(200);
    // The NID gate: a captain without a verified NID cannot enter.
    const c = await tf.captain('Sultana Kamal', { verify: false });
    const gated = await api().post(`${P}/tournaments/${t.id}/registrations`).set(h.bearer(c)).set('Idempotency-Key', f.uniq('reg')).send({ teamId: c.team.id, rosterUserIds: [c.user.id], acceptRules: true }).expect(403);
    expect(gated.body.code).toMatch(/KYC|ROLE/);
  }, 240000);
});

describe('M14 the console: guards, states and money on cancel', () => {
  it('kinds, incomplete drafts, public visibility, a stale edit, rules unlock, cancel after the first result', async () => {
    // A draft is not public, and cannot be submitted without a venue.
    const d = await tf.draft(owner, org.id, { venues: [] });
    expect((await consolePost(`/tournaments/${d.id}/submit`).expect(422)).body.checks).toContain('venue_present');
    await api().get(`${P}/tournaments/${d.slug}`).expect(404);
    expect((await api().get(`${P}/tournaments`).expect(200)).body.items).toHaveLength(0);
    // The esports console is not for a sports organisation; strangers see nothing.
    await api().get(`${P}/org/${org.id}/esports/dashboard`).set(h.bearer(owner)).expect(404);
    const stranger = await h.signupUser({ name: 'Random Person' });
    await api().get(`${P}/org/${org.id}/sports/tournaments`).set(h.bearer(stranger)).expect(404);

    const t = await tf.approved(owner, org.id, reviewer, { format: 'double_league', minTeams: 2, maxTeams: 2 });
    expect((await api().get(`${P}/tournaments?status=open`).expect(200)).body.items.map((x) => x.id)).toEqual([t.id]);
    const caps = [await tf.captain('Rafi Ahmed'), await tf.captain('Sakib Hasan')];
    for (const c of caps) await tf.register(c, t.id);
    for (const r of (await consoleGet(`/tournaments/${t.id}/registrations?status=pending_approval`).expect(200)).body.items) await consolePost(`/registrations/${r.id}/approve`).expect(200);
    await consolePost(`/tournaments/${t.id}/registration/close`).expect(200);
    await consolePost(`/tournaments/${t.id}/draw/confirm`, { seeding: 'manual', manualOrder: [caps[1].team.id, caps[0].team.id] }).expect(200);
    await consolePost(`/tournaments/${t.id}/fixtures/generate`, {}).expect(200);
    await consolePost(`/tournaments/${t.id}/fixtures/publish`).expect(200);
    // A move with a stale version is refused.
    const [m] = (await consoleGet(`/tournaments/${t.id}/fixtures`).expect(200)).body.matches;
    const venueId = (await consoleGet(`/tournaments/${t.id}`).expect(200)).body.venues[0].id;
    const start = new Date(Date.now() + 5 * tf.DAY).toISOString();
    await api().patch(`${P}/org/${org.id}/sports/matches/${m.id}`).set(h.bearer(owner)).send({ scheduledStart: start, venueId, court: 'Court 1', version: m.version }).expect(200);
    await api().patch(`${P}/org/${org.id}/sports/matches/${m.id}`).set(h.bearer(owner)).send({ scheduledStart: start, version: m.version }).expect(409);
    // The first result locks the rules and releases tranche 1; unlocking needs a reason and is audited.
    await api().put(`${P}/org/${org.id}/sports/matches/${m.id}/result`).set(h.bearer(owner)).send({ sets: [[21, 15], [21, 16]] }).expect(200);
    expect((await api().patch(`${P}/org/${org.id}/sports/tournaments/${t.id}`).set(h.bearer(owner)).send({ rules: { pW: 3 } }).expect(409)).body.code).toBe('RULES_LOCKED');
    await consolePost(`/tournaments/${t.id}/rules/unlock`, { reason: 'Points per win were set wrong' }).expect(200);
    await api().patch(`${P}/org/${org.id}/sports/tournaments/${t.id}`).set(h.bearer(owner)).send({ rules: { pW: 3 } }).expect(200);
    const hub = (await api().get(`${P}/tournaments/${t.slug}`).expect(200)).body;
    expect(hub.standings[0].rows[0].points).toBe(3);
    expect(await models.AuditLog.count({ where: { action: 'tournament.rules_unlocked' } })).toBe(1);
    // Cancel after the first result: each team gets back what is still held (the other half).
    await consolePost(`/tournaments/${t.id}/cancel`, { reason: 'The venue flooded' }).expect(200);
    await h.drainEvents();
    const mine = (await api().get(`${P}/me/registrations`).set(h.bearer(caps[0])).expect(200)).body.items[0];
    expect(mine).toMatchObject({ status: 'cancelled', refundedPoisha: 900000 });
    expect(await tf.balance(`payable:user:${owner.user.id}`)).toBe(2 * (900000 - 45000));
    expect(await models.Notification.count({ where: { userId: caps[1].user.id, code: 'TOURNAMENT_CANCELLED' } })).toBe(1);
  }, 240000);
});
