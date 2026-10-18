'use strict';

// M16 teams and players step 1 end to end: teams with a verified-phone gate; invites by phone with a
// share link, the same answer for numbers with and without accounts, linking on read (phone sign-up,
// a phone added to an email account), accept re-checks (expiry before the job, team size race),
// resend cooldown, duplicates; roles, one vice-captain, hand-over, leave, ban succession, staff
// archive; player profiles and the public page (never gender, DOB or phone); self-only eligibility
// previews; gender set once and corrected by staff (M16-FR-01 to FR-08, Q27).
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const jobs = require('../../src/modules/teams/teams.jobs');

const { api, P, models } = h;

let master;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const as = (who) => ({
  get: (p) => api().get(`${P}${p}`).set(h.bearer(who)),
  post: (p, body = {}) => api().post(`${P}${p}`).set(h.bearer(who)).send(body),
  put: (p, body = {}) => api().put(`${P}${p}`).set(h.bearer(who)).send(body),
  patch: (p, body = {}) => api().patch(`${P}${p}`).set(h.bearer(who)).send(body),
});
const codes = async (userId, code) => models.Notification.count({ where: { userId, code } });
const tokenOf = (shareUrl) => shareUrl.split('/').pop();

/** Phone sign-up with a chosen local number (the invite was sent to it before the account existed). */
async function signupWith(phone, name) {
  await api().post(`${P}/auth/otp/send`).send({ target: phone, purpose: 'signup' }).expect(202);
  const v = await api().post(`${P}/auth/otp/verify`).send({ target: phone, purpose: 'signup', code: h.lastCode(phone) }).expect(200);
  const res = await api().post(`${P}/auth/signup`).send({ signupToken: v.body.signupToken, displayName: name }).expect(201);
  return { accessToken: res.body.accessToken, cookie: res.headers['set-cookie'], user: res.body.user, phone };
}

/** Email sign-up (no phone), like a Google account. */
async function signupByEmail(email, name) {
  await api().post(`${P}/auth/otp/send`).send({ target: email, purpose: 'signup' }).expect(202);
  const v = await api().post(`${P}/auth/otp/verify`).send({ target: email, purpose: 'signup', code: h.lastEmailCode(email) }).expect(200);
  const res = await api().post(`${P}/auth/signup`).send({ signupToken: v.body.signupToken, displayName: name }).expect(201);
  return { accessToken: res.body.accessToken, cookie: res.headers['set-cookie'], user: res.body.user };
}

async function teamOf(captain, body = {}) {
  return (await as(captain).post('/teams', { sportKey: 'football', name: 'Gulshan Gladiators', shortCode: 'ggl', ...body }).expect(201)).body;
}

async function join(captain, team, who) {
  const inv = (await as(captain).post(`/teams/${team.id}/invites`, { phone: who.phone }).expect(201)).body;
  await as(who).post(`/me/team-invites/${inv.invite.id}/accept`).expect(200);
  return inv;
}

describe('M16 invites and linking', () => {
  it('creates a team; invites by phone with one answer for every number; links on sign-up and on an added phone', async () => {
    const cap = await h.signupUser({ name: 'Rafi Ahmed' });
    const team = await teamOf(cap);
    expect(team).toMatchObject({ name: 'Gulshan Gladiators', shortCode: 'GGL', myRole: 'captain', status: 'active', sport: { key: 'football' }, can: { invite: true, manage: true } });
    expect(team.members).toEqual([expect.objectContaining({ userId: cap.user.id, role: 'captain', nidVerified: false })]);
    expect((await as(cap).post('/teams', { sportKey: 'gym', name: 'Lifters' }).expect(422)).body.code).toBe('TEAM_SPORT_UNKNOWN');
    expect((await as(cap).post('/teams', { sportKey: 'football', name: 'Join www.spam.com' }).expect(422)).body.code).toBe('TEAM_NAME_INVALID');

    // A member with an account and a number with none get the same answer: a share link.
    const sakib = await h.signupUser({ name: 'Sakib Hasan' });
    const known = (await as(cap).post(`/teams/${team.id}/invites`, { phone: sakib.phone }).expect(201)).body;
    const stranger = h.nextPhone();
    const unknown = (await as(cap).post(`/teams/${team.id}/invites`, { phone: stranger }).expect(201)).body;
    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
    expect(Object.keys(known.invite).sort()).toEqual(Object.keys(unknown.invite).sort());
    expect(unknown.shareUrl).toMatch(/\/teams\/join\/[A-Za-z0-9_-]{20,}$/);
    expect(unknown.invite.phoneMasked).toMatch(/^\+880171•••\d{3}$/);
    // Inviting the same number again reuses the invite with a fresh link; a self-invite is refused.
    const again = (await as(cap).post(`/teams/${team.id}/invites`, { phone: stranger }).expect(201)).body;
    expect(again.invite.id).toBe(unknown.invite.id);
    expect(again.shareUrl).not.toBe(unknown.shareUrl);
    await api().get(`${P}/team-invites/${tokenOf(unknown.shareUrl)}`).expect(404);
    expect((await as(cap).post(`/teams/${team.id}/invites`, { phone: cap.phone }).expect(422)).body.code).toBe('INVITE_SELF');
    expect((await as(cap).post(`/teams/${team.id}/invites`, { phone: '0123456789' }).expect(422)).body.code).toBe('PHONE_INVALID');
    // The share link page: team, sport, the inviter's first name, the masked number.
    const link = (await api().get(`${P}/team-invites/${tokenOf(again.shareUrl)}`).expect(200)).body;
    expect(link).toMatchObject({ team: { name: 'Gulshan Gladiators' }, invitedBy: 'Rafi', phoneMasked: unknown.invite.phoneMasked, status: 'pending' });
    expect(JSON.stringify(link)).not.toContain(stranger.slice(-6));

    await h.drainEvents();
    expect(await codes(sakib.user.id, 'TEAM_INVITE')).toBe(1);
    // The stranger signs up with that number: the invite is waiting, and the notice follows.
    const newbie = await signupWith(stranger, 'Nabil Khan');
    await h.drainEvents();
    expect(await codes(newbie.user.id, 'TEAM_INVITE')).toBe(1);
    const waiting = (await as(newbie).get('/me/team-invites').expect(200)).body.items;
    expect(waiting).toEqual([expect.objectContaining({ id: unknown.invite.id, team: expect.objectContaining({ name: 'Gulshan Gladiators' }), invitedBy: 'Rafi' })]);
    await as(newbie).post(`/me/team-invites/${unknown.invite.id}/accept`).expect(200);
    await as(sakib).post(`/me/team-invites/${known.invite.id}/accept`).expect(200);
    await h.drainEvents();
    expect(await codes(cap.user.id, 'TEAM_INVITE_ACCEPTED')).toBe(2);
    expect((await as(cap).get(`/teams/${team.id}`).expect(200)).body.members.map((m) => m.role).sort()).toEqual(['captain', 'player', 'player']);
    expect((await as(newbie).get('/me/teams').expect(200)).body.items).toEqual([expect.objectContaining({ id: team.id, myRole: 'player', members: 3 })]);

    // An email-only (Google-like) account has no phone: the gate asks for one; adding it finds the invite.
    const google = await signupByEmail('tanvir.google@example.com', 'Tanvir Islam');
    expect((await as(google).post('/teams', { sportKey: 'football', name: 'Mirpur Kings' }).expect(403)).body.code).toBe('PHONE_REQUIRED');
    const later = h.nextPhone();
    await as(cap).post(`/teams/${team.id}/invites`, { phone: later }).expect(201);
    expect((await as(google).post('/me/phone', { phone: cap.phone }).expect(409)).body.code).toBe('PHONE_IN_USE');
    await as(google).post('/me/phone', { phone: later }).expect(202);
    await as(google).post('/me/phone/verify', { phone: later, code: h.lastCode(later) }).expect(200);
    await f.refresh(google);
    expect((await as(google).get('/me').expect(200)).body).toMatchObject({ phoneVerified: true });
    expect((await as(google).post('/me/phone', { phone: h.nextPhone() }).expect(409)).body.code).toBe('PHONE_ALREADY_VERIFIED');
    expect((await as(google).get('/me/team-invites').expect(200)).body.items).toHaveLength(1);
    await h.drainEvents();
    expect(await codes(google.user.id, 'TEAM_INVITE')).toBe(1);
  });

  it('accept re-checks the expiry before the job, the team size under a race; resend cooldown; cancel; decline; members only', async () => {
    const cap = await h.signupUser({ name: 'Rafi Ahmed' });
    const team = await teamOf(cap);
    const [a, b, c, d] = [await h.signupUser({ name: 'Arif One' }), await h.signupUser({ name: 'Bashir Two' }), await h.signupUser({ name: 'Chaity Three' }), await h.signupUser({ name: 'Dola Four' })];
    // Expired but the job has not run: refused; the tick then expires it.
    const ia = (await as(cap).post(`/teams/${team.id}/invites`, { phone: a.phone }).expect(201)).body.invite;
    await models.TeamInvite.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: ia.id } });
    expect((await as(a).post(`/me/team-invites/${ia.id}/accept`).expect(409)).body.code).toBe('INVITE_EXPIRED');
    expect((await jobs.tick()).expired).toBe(1);
    // Resend only after the cooldown.
    const ib = (await as(cap).post(`/teams/${team.id}/invites`, { phone: b.phone }).expect(201)).body.invite;
    expect((await as(cap).post(`/teams/${team.id}/invites/${ib.id}/resend`).expect(429)).body.code).toBe('INVITE_RESEND_TOO_SOON');
    await models.TeamInvite.update({ createdAt: new Date(Date.now() - 2 * 3600000) }, { where: { id: ib.id } });
    expect((await as(cap).post(`/teams/${team.id}/invites/${ib.id}/resend`).expect(200)).body.invite.resendCount).toBe(1);
    // Two invites to the same number at once: one pending row.
    const twice = await Promise.all([as(cap).post(`/teams/${team.id}/invites`, { phone: c.phone }), as(cap).post(`/teams/${team.id}/invites`, { phone: c.phone })]);
    expect(twice.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(await models.TeamInvite.count({ where: { teamId: team.id, status: 'pending', phoneHash: (await models.TeamInvite.findOne({ where: { teamId: team.id, userId: c.user.id } })).phoneHash } })).toBe(1);
    // Team size under a race: room for one more, two accept at once.
    await h.setSettingForTest('teams.max_members', 2);
    const ic = (await as(c).get('/me/team-invites').expect(200)).body.items[0];
    const id2 = (await as(cap).post(`/teams/${team.id}/invites`, { phone: d.phone }).expect(201)).body.invite;
    const raced = await Promise.all([as(c).post(`/me/team-invites/${ic.id}/accept`), as(d).post(`/me/team-invites/${id2.id}/accept`)]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(raced.find((r) => r.status === 409).body.code).toBe('TEAM_FULL');
    expect(await models.TeamMember.count({ where: { teamId: team.id, status: 'active' } })).toBe(2);
    await h.setSettingForTest('teams.max_members', 30);
    // Cancel and decline.
    const late = (await as(cap).post(`/teams/${team.id}/invites`, { phone: a.phone }).expect(201)).body.invite;
    await as(cap).post(`/teams/${team.id}/invites/${late.id}/cancel`).expect(200);
    expect((await as(a).post(`/me/team-invites/${late.id}/accept`).expect(409)).body.code).toBe('INVITE_STATE');
    expect((await as(b).post(`/me/team-invites/${ib.id}/decline`).expect(200)).body.status).toBe('declined');
    // Someone else's invite is not found; non-members do not see the team; players cannot invite.
    expect((await as(a).post(`/me/team-invites/${ib.id}/accept`).expect(404)).body.code).toBe('INVITE_NOT_YOURS');
    await as(a).get(`/teams/${team.id}`).expect(404);
    const member = raced[0].status === 200 ? c : d;
    expect((await as(member).post(`/teams/${team.id}/invites`, { phone: a.phone }).expect(403)).body.code).toBe('CAPTAIN_ONLY');
  });
});

describe('M16 members and captaincy', () => {
  it('one vice-captain, removing, hand-over, leaving, ban succession and staff archive', async () => {
    const cap = await h.signupUser({ name: 'Rafi Ahmed' });
    const team = await teamOf(cap);
    const [p1, p2, p3] = [await h.signupUser({ name: 'Player One' }), await h.signupUser({ name: 'Player Two' }), await h.signupUser({ name: 'Player Three' })];
    for (const p of [p1, p2, p3]) await join(cap, team, p);
    await as(cap).put(`/teams/${team.id}/members/${p1.user.id}`, { role: 'vice_captain', jerseyNo: 7 }).expect(200);
    const after = (await as(cap).put(`/teams/${team.id}/members/${p2.user.id}`, { role: 'vice_captain' }).expect(200)).body.members;
    expect(after.find((m) => m.userId === p1.user.id)).toMatchObject({ role: 'player', jerseyNo: 7 });
    expect(after.find((m) => m.userId === p2.user.id).role).toBe('vice_captain');
    // The vice-captain removes a player but never the captain.
    expect((await as(p2).post(`/teams/${team.id}/members/${cap.user.id}/remove`).expect(409)).body.code).toBe('CANNOT_REMOVE_CAPTAIN');
    await as(p2).post(`/teams/${team.id}/members/${p3.user.id}/remove`).expect(200);
    await h.drainEvents();
    expect(await codes(p3.user.id, 'TEAM_MEMBER_REMOVED')).toBe(1);
    // A captain hands over before leaving.
    expect((await as(cap).post(`/teams/${team.id}/leave`).expect(409)).body.code).toBe('CAPTAIN_MUST_HAND_OVER');
    await as(cap).post(`/teams/${team.id}/captain`, { userId: p1.user.id }).expect(200);
    await as(cap).post(`/teams/${team.id}/leave`).expect(200);
    await h.drainEvents();
    expect(await codes(p1.user.id, 'TEAM_CAPTAIN_GIVEN')).toBe(1);
    const roles = (await as(p1).get(`/teams/${team.id}`).expect(200)).body.members.map((m) => [m.userId, m.role]);
    expect(roles.sort()).toEqual([[p1.user.id, 'captain'], [p2.user.id, 'vice_captain']].sort());

    // Ban succession: the vice-captain, then the longest-serving member, then the team is archived.
    const ban = async (who) => {
      await api().post(`${P}/admin/users/${who.user.id}/ban`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'user.ban')).send({ reasonCode: 'abuse', note: 'Threatened other players' }).expect(200);
      await h.drainEvents();
    };
    const t2cap = await h.signupUser({ name: 'Kabir Captain' });
    const t2 = await teamOf(t2cap, { name: 'Uttara Royals', shortCode: 'UR' });
    const [v, x, y] = [await h.signupUser({ name: 'Vice Vai' }), await h.signupUser({ name: 'Xenon Early' }), await h.signupUser({ name: 'Yasin Late' })];
    await join(t2cap, t2, x);
    await join(t2cap, t2, y);
    await join(t2cap, t2, v);
    await as(t2cap).put(`/teams/${t2.id}/members/${v.user.id}`, { role: 'vice_captain' }).expect(200);
    await ban(t2cap);
    expect((await models.TeamMember.findOne({ where: { teamId: t2.id, userId: v.user.id, status: 'active' } })).role).toBe('captain');
    await ban(v);
    expect((await models.TeamMember.findOne({ where: { teamId: t2.id, userId: x.user.id, status: 'active' } })).role).toBe('captain');
    await ban(x);
    await ban(y);
    expect((await models.Team.findByPk(t2.id)).status).toBe('archived');

    // Staff archive an offensive name (manage_users), with a reason; pending invites are cancelled.
    const mod = await f.staffWith(master, ['manage_users']);
    await as(p1).post(`/teams/${team.id}/invites`, { phone: h.nextPhone() }).expect(201);
    expect((await as(mod).get('/admin/teams?q=gladiators').expect(200)).body.items.map((t) => t.id)).toEqual([team.id]);
    const staffView = (await as(mod).get(`/admin/teams/${team.id}`).expect(200)).body;
    expect(staffView.invites[0].phoneMasked).toMatch(/•••/);
    await as(mod).post(`/admin/teams/${team.id}/archive`, { reason: 'Offensive team name' }).expect(200);
    expect(await models.TeamInvite.count({ where: { teamId: team.id, status: 'pending' } })).toBe(0);
    expect((await as(p1).post(`/teams/${team.id}/invites`, { phone: h.nextPhone() }).expect(409)).body.code).toBe('TEAM_ARCHIVED');
    // The last member leaving archives a team.
    const solo = await h.signupUser({ name: 'Solo Captain' });
    const st = await teamOf(solo, { name: 'Solo XI', shortCode: 'SX' });
    expect((await as(solo).post(`/teams/${st.id}/leave`).expect(200)).body).toEqual({ left: true, teamStatus: 'archived' });
  });
});

describe('M16 player profiles, gender and eligibility', () => {
  it('profiles and the public page never show gender, DOB or phone; eligibility previews are for the member only', async () => {
    const me = await h.signupUser({ name: 'Rafi Ahmed' });
    const team = await teamOf(me);
    expect((await as(me).put('/me/player-profile', { sports: [{ sportKey: 'football', positions: ['striker'] }] }).expect(422)).body.code).toBe('PROFILE_SPORTS_INVALID');
    await as(me).put('/me/player-profile', { sports: [{ sportKey: 'football', positions: ['goalkeeper', 'defender'], foot: 'left' }, { sportKey: 'cricket', positions: ['wicketkeeper'], battingHand: 'right' }], bio: 'Weekend keeper.' }).expect(200);
    // The public page needs a username.
    await api().get(`${P}/players/rafi10`).expect(404);
    await as(me).put('/me/username', { username: 'rafi10' }).expect(200);
    await f.refresh(me);
    await as(me).put('/me/gender', { gender: 'male' }).expect(200);
    expect((await as(me).put('/me/gender', { gender: 'female' }).expect(409)).body.code).toBe('GENDER_ALREADY_SET');
    await h.verifyMember(me.user.id);
    await models.User.update({ dob: '1996-03-14' }, { where: { id: me.user.id } });
    await f.refresh(me);
    const page = (await api().get(`${P}/players/rafi10`).expect(200)).body;
    expect(page).toMatchObject({ handle: 'rafi10', displayName: 'Rafi Ahmed', bio: 'Weekend keeper.', teams: [expect.objectContaining({ id: team.id, role: 'captain' })] });
    expect(page.sports[0]).toMatchObject({ sportKey: 'football', positions: [expect.objectContaining({ key: 'goalkeeper', en: 'Goalkeeper' }), expect.objectContaining({ key: 'defender' })] });
    const text = JSON.stringify(page);
    for (const bad of ['gender', 'male', 'dob', '1996', 'phone', me.phone.slice(-6)]) expect(text).not.toContain(bad);
    await as(me).put('/me/player-profile', { sports: [], visibility: 'members' }).expect(200);
    await api().get(`${P}/players/rafi10`).expect(404);

    // Readiness and a self-only preview against an event's rules.
    const el = (await as(me).get('/me/eligibility?gender=women&ageMin=30&ageCutoff=2026-01-01').expect(200)).body;
    expect(el.readiness.map((r) => [r.key, r.status])).toEqual([
      ['phone_verified', 'pass'],
      ['nid_verified', 'pass'],
      ['gender_recorded', 'pass'],
    ]);
    expect(el.preview).toMatchObject({ eligible: false, checks: [{ key: 'nid_verified', status: 'pass' }, { key: 'age', status: 'fail' }, { key: 'gender', status: 'fail' }] });
    // Captains see only the NID boolean for members.
    const teammate = await h.signupUser({ name: 'Nadia Islam' });
    await join(me, team, teammate);
    const members = (await as(me).get(`/teams/${team.id}`).expect(200)).body.members;
    expect(members.find((m) => m.userId === me.user.id).nidVerified).toBe(true);
    expect(members.find((m) => m.userId === teammate.user.id).nidVerified).toBe(false);
    expect(JSON.stringify(members)).not.toMatch(/gender|dob|phone/);
    const fresh = (await as(teammate).get('/me/eligibility').expect(200)).body;
    expect(fresh).toEqual({ readiness: [{ key: 'phone_verified', status: 'pass', fix: null }, { key: 'nid_verified', status: 'missing', fix: 'verify_nid' }, { key: 'gender_recorded', status: 'missing', fix: 'set_gender' }], preview: null });

    // Staff correct a gender with a reason; the change is audited and announced without values.
    const mod = await f.staffWith(master, ['manage_users']);
    const fixed = (await as(mod).put(`/admin/users/${me.user.id}/gender`, { gender: 'female', reason: 'Member wrote in to correct it' }).expect(200)).body;
    expect(fixed).toMatchObject({ gender: 'female', genderSource: 'staff_corrected' });
    const evs = await models.OutboxEvent.findAll({ where: { name: 'user.identity_changed' } });
    expect(evs.map((e) => e.payload)).toEqual([
      { userId: me.user.id, fields: ['gender'] },
      { userId: me.user.id, fields: ['gender'] },
    ]);
  });
});
