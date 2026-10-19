'use strict';

// M21 esports step 1 end to end: UIDs through M05 (FR-02 to FR-04), squads (FR-05), authoring and
// review (FR-06, FR-07), registration with slots, payment, waitlist and refunds (FR-08 to FR-12, §6.6),
// check-in (FR-13), room credentials (FR-14 to FR-17), results, disputes, standings (FR-18 to FR-21),
// disqualification (FR-22), prizes through the M06 pool with escrow ending at zero (FR-23 to FR-25,
// §6.5 examples), withdrawal (FR-26), rankings (FR-27, FR-28) and the permission matrix.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const { loadPrincipal } = require('../../src/modules/auth/authz.service');
const lifecycle = require('../../src/modules/esports/esports.lifecycle');
const registrations = require('../../src/modules/esports/registrations.service');
const ledger = require('../../src/modules/payments/ledger.service');
const realtime = require('../../src/common/realtime');

const { api, P, models } = h;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake screenshot')]);

let master;
let reviewer;
let seq = 0;
const key = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

beforeEach(async () => {
  await h.resetDb();
  await h.setSettingForTest('esports.ranking_min_tournaments', 1);
  master = await h.createSignedInMaster();
  reviewer = await staffWith(['approve_listings']);
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

let emp = 0;
async function staffWith(permissions) {
  emp += 1;
  const s = await h.signupUser({ name: 'Rumana Akter' });
  await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'staff.write')).send({ userId: s.user.id, employeeId: `KG-E-${emp}`, permissions }).expect(201);
  return h.signInStaff(s.phone, s.user.id);
}

const codesOf = async (userId) => (await models.Notification.findAll({ where: { userId } })).map((n) => n.code);
const game = (k) => models.EsportsGame.findOne({ where: { key: k } });
const modeOf = async (gameKey, modeKey) => models.EsportsMode.findOne({ where: { gameId: (await game(gameKey)).id, key: modeKey } });
const mapsOf = async (gameKey) => models.EsportsMap.findAll({ where: { gameId: (await game(gameKey)).id }, order: [['sort', 'ASC']] });

/** Approve (or decide) the open M05 submission of a subject. */
async function review(kind, subjectId, decision = 'approve', extra = {}) {
  const sub = await models.Submission.findOne({ where: { kind, subjectId, status: 'pending_review' } });
  await api().post(`${P}/admin/submissions/${sub.id}/claim`).set(h.bearer(reviewer)).expect(200);
  const rubric = await models.ReviewRubric.findByPk(sub.rubricId);
  await api().put(`${P}/admin/submissions/${sub.id}/ticks`).set(h.bearer(reviewer)).send({ ticks: rubric.items.map((i) => i.key) }).expect(200);
  await api().post(`${P}/admin/submissions/${sub.id}/decide`).set(h.bearer(reviewer)).set('Idempotency-Key', key('dec')).send({ decision, ...extra }).expect(200);
  await h.drainEvents();
}

/** A member with a verified UID for a game (through the API and the Moderation desk). */
let uidSeq = 100000;
async function player(name, gameKey = 'free_fire') {
  const m = await h.signupUser({ name });
  const up = await api().post(`${P}/me/esports/uploads`).set(h.bearer(m)).set('Content-Type', 'image/jpeg').send(Buffer.concat([JPEG, Buffer.from(name)])).expect(201);
  uidSeq += 1;
  const p = await api().post(`${P}/me/esports/profiles`).set(h.bearer(m)).send({ gameId: (await game(gameKey)).id, uid: `9${uidSeq}`, ign: name.split(' ')[0], screenshotKey: up.body.key }).expect(201);
  await review('game_profile', p.body.id);
  m.profileId = p.body.id;
  return m;
}

/** A published tournament (created by the master, approved by the reviewer). */
async function tournament({ gameKey = 'free_fire', modeKey = 'solo', fee = 5000, maxSlots = 4, min = 2, prizes = [100000, 60000, 30000], killReward = 0, matches = 1, featured = false } = {}) {
  const mode = await modeOf(gameKey, modeKey);
  const maps = await mapsOf(gameKey);
  const preset = await models.EsportsPointsPreset.findOne({ where: { gameId: mode.gameId } });
  const start = Date.now() + 6 * 3600000;
  const body = {
    gameId: mode.gameId,
    modeId: mode.id,
    titleEn: `FF Daily ${(seq += 1)}`,
    titleBn: 'ফ্রি ফায়ার ডেইলি',
    tier: 'daily',
    format: matches > 1 ? 'series' : 'single_match',
    entryFee: fee,
    maxSlots,
    minParticipants: min,
    prizes: prizes.map((amount, i) => ({ place: i + 1, amount })),
    killReward,
    pointsPresetId: preset.id,
    registrationOpensAt: new Date(Date.now() + 60000).toISOString(),
    matches: Array.from({ length: matches }, (_, i) => ({ mapId: maps[i % maps.length].id, startsAt: new Date(start + i * 3600000).toISOString() })),
    rulesMd: 'Play fair.',
    featured,
  };
  const t = await api().post(`${P}/admin/esports/tournaments`).set(h.bearer(master)).send(body).expect(201);
  await api().post(`${P}/admin/esports/tournaments/${t.body.id}/submit`).set(h.bearer(master)).expect(200);
  await review('esports_tournament', t.body.id);
  return t.body;
}

// ---- moving the clock (the lifecycle job decides from the stored times)
const ago = (ms) => new Date(Date.now() - ms);
const soon = (ms) => new Date(Date.now() + ms);
async function openRegistration(t) {
  await models.EsportsTournament.update({ registrationOpensAt: ago(2 * 3600000) }, { where: { id: t.id } });
  await lifecycle.tick();
}
async function closeRegistration(t) {
  await models.EsportsTournament.update({ registrationClosesAt: ago(3600000) }, { where: { id: t.id } });
  await lifecycle.tick();
  await h.drainEvents();
}
async function openCheckin(t) {
  await models.EsportsStage.update({ checkinOpensAt: ago(600000), checkinClosesAt: soon(600000) }, { where: { tournamentId: t.id } });
  await lifecycle.tick();
}
async function closeCheckin(t) {
  await models.EsportsStage.update({ checkinClosesAt: ago(1000) }, { where: { tournamentId: t.id } });
  await lifecycle.tick();
}
async function startMatches(t) {
  const ms = await models.EsportsMatch.findAll({ where: { tournamentId: t.id }, order: [['seq', 'ASC']] });
  for (const [i, m] of ms.entries()) await m.update({ startsAt: ago(60000 * (ms.length - i)) });
  await models.EsportsTournament.update({ startsAt: ago(60000 * ms.length) }, { where: { id: t.id } });
  await lifecycle.tick();
}

const register = (who, t, body, k = key('reg')) => api().post(`${P}/esports/tournaments/${t.id}/registrations`).set(h.bearer(who)).set('Idempotency-Key', k).send(body);
const solo = (who, t) => register(who, t, { players: [who.profileId] });
async function enterPaid(who, t) {
  const r = await solo(who, t).expect(201);
  if (r.body.payment) await h.payWithSimulator(who, r.body.payment.id);
  return r.body.registration;
}
const checkIn = (who, regId) => api().post(`${P}/me/esports/registrations/${regId}/check-in`).set(h.bearer(who));
const matchesOf = (t) => models.EsportsMatch.findAll({ where: { tournamentId: t.id }, order: [['seq', 'ASC']] });

describe('game profiles and UID bans (FR-02 to FR-04)', () => {
  it('a UID goes through review; one per account per game, one account per UID; bans block it', async () => {
    const a = await h.signupUser({ name: 'Tanvir Ahmed' });
    const ff = await game('free_fire');
    const up = await api().post(`${P}/me/esports/uploads`).set(h.bearer(a)).set('Content-Type', 'image/jpeg').send(JPEG).expect(201);
    expect(up.body.key.startsWith(`esports/${a.user.id}/`)).toBe(true);
    expect((await api().post(`${P}/me/esports/uploads`).set(h.bearer(a)).set('Content-Type', 'image/png').send(JPEG).expect(415)).body.code).toBe('FILE_TYPE_MISMATCH');
    expect((await api().post(`${P}/me/esports/profiles`).set(h.bearer(a)).send({ gameId: ff.id, uid: '12ab', ign: 'Tanvir', screenshotKey: up.body.key }).expect(422)).body.code).toBe('ESPORTS_UID_FORMAT');
    const p = await api().post(`${P}/me/esports/profiles`).set(h.bearer(a)).send({ gameId: ff.id, uid: '512345690', ign: 'Tanvir', screenshotKey: up.body.key }).expect(201);
    expect(p.body).toMatchObject({ status: 'pending', uidMasked: '5123•••690' });
    expect((await api().post(`${P}/me/esports/profiles`).set(h.bearer(a)).send({ gameId: ff.id, uid: '512345691', ign: 'Tanvir', screenshotKey: up.body.key }).expect(409)).body.code).toBe('ESPORTS_PROFILE_EXISTS');

    const b = await h.signupUser({ name: 'Copy Cat' });
    const upB = await api().post(`${P}/me/esports/uploads`).set(h.bearer(b)).set('Content-Type', 'image/jpeg').send(JPEG).expect(201);
    expect((await api().post(`${P}/me/esports/profiles`).set(h.bearer(b)).send({ gameId: ff.id, uid: '512345690', ign: 'Cat', screenshotKey: upB.body.key }).expect(409)).body.code).toBe('ESPORTS_UID_TAKEN');
    // Another user's upload key is never accepted.
    expect((await api().post(`${P}/me/esports/profiles`).set(h.bearer(b)).send({ gameId: ff.id, uid: '612345690', ign: 'Cat', screenshotKey: up.body.key }).expect(422)).body.code).toBe('ESPORTS_UPLOAD_INVALID');

    // The reviewer sees the screenshot (audited), the checks pass, and approves.
    const sub = await models.Submission.findOne({ where: { kind: 'game_profile', subjectId: p.body.id } });
    const c = await api().post(`${P}/admin/submissions/${sub.id}/claim`).set(h.bearer(reviewer)).expect(200);
    expect(c.body.checks.map((k) => [k.key, k.result])).toEqual(expect.arrayContaining([['uid_format', 'pass'], ['uid_not_banned', 'pass'], ['uid_unique', 'pass']]));
    expect(c.body.reasons.map((r) => r.code)).toContain('uid_mismatch');
    await api().get(`${P}/admin/esports/profiles/${p.body.id}/screenshot`).set(h.bearer(reviewer)).expect(200);
    expect(await models.AuditLog.count({ where: { action: 'esports_game_profile.screenshot_viewed' } })).toBe(1);
    await api().post(`${P}/admin/submissions/${sub.id}/release`).set(h.bearer(reviewer)).send({}).expect(200);
    await review('game_profile', p.body.id);
    expect((await models.EsportsGameProfile.findByPk(p.body.id)).status).toBe('verified');
    expect(await codesOf(a.user.id)).toContain('ESPORTS_UID_VERIFIED');

    // A ban: the profile is banned and the UID can't be added again.
    await api().post(`${P}/admin/esports/uid-bans`).set(h.bearer(master)).send({ gameId: ff.id, uid: '512345690', reasonCode: 'hacking', note: 'Aimbot in the replay' }).expect(201);
    expect((await models.EsportsGameProfile.findByPk(p.body.id)).status).toBe('banned');
    const view = await api().get(`${P}/me/esports/profiles`).set(h.bearer(a)).expect(200);
    expect(view.body.items[0]).toMatchObject({ status: 'banned' });
  });

  it('a rejected UID frees the number; unlinking leaves the squad', async () => {
    const a = await h.signupUser({ name: 'Rafi Islam' });
    const ff = await game('free_fire');
    const up = await api().post(`${P}/me/esports/uploads`).set(h.bearer(a)).set('Content-Type', 'image/jpeg').send(JPEG).expect(201);
    const p = await api().post(`${P}/me/esports/profiles`).set(h.bearer(a)).send({ gameId: ff.id, uid: '700000001', ign: 'Rafi', screenshotKey: up.body.key }).expect(201);
    await review('game_profile', p.body.id, 'reject', { reasonCode: 'uid_mismatch' });
    expect(await models.EsportsGameProfile.findByPk(p.body.id)).toMatchObject({ status: 'rejected', rejectReason: 'uid_mismatch' });
    expect(await codesOf(a.user.id)).toContain('ESPORTS_UID_REJECTED');
    const again = await api().post(`${P}/me/esports/profiles`).set(h.bearer(a)).send({ gameId: ff.id, uid: '700000001', ign: 'Rafi', screenshotKey: up.body.key }).expect(201);
    await review('game_profile', again.body.id);
    const sq = await api().post(`${P}/me/esports/squads`).set(h.bearer(a)).send({ gameId: ff.id, name: 'Night Owls', tag: 'NOWL' }).expect(201);
    await api().post(`${P}/me/esports/profiles/${again.body.id}/unlink`).set(h.bearer(a)).expect(200);
    expect((await models.EsportsSquad.findByPk(sq.body.id)).status).toBe('disbanded');
  });
});

describe('squads (FR-05)', () => {
  it('create, join by code, the size limit, one squad per game, captain hand-over', async () => {
    const ff = await game('free_fire');
    const people = [];
    for (const n of ['Cap One', 'Two Two', 'Three Three', 'Four Four', 'Five Five', 'Six Six']) people.push(await player(n));
    const [cap, ...rest] = people;
    const sq = await api().post(`${P}/me/esports/squads`).set(h.bearer(cap)).send({ gameId: ff.id, name: 'Dhaka Kings', tag: 'dk' }).expect(201);
    expect(sq.body).toMatchObject({ tag: 'DK', maxMembers: 5 });
    expect((await api().post(`${P}/me/esports/squads`).set(h.bearer(rest[0])).send({ gameId: ff.id, name: 'dhaka kings', tag: 'X1' }).expect(409)).body.code).toBe('ESPORTS_SQUAD_NAME_TAKEN');
    for (const m of rest.slice(0, 4)) await api().post(`${P}/me/esports/squads/join`).set(h.bearer(m)).send({ code: sq.body.inviteCode }).expect(200);
    expect((await api().post(`${P}/me/esports/squads/join`).set(h.bearer(rest[4])).send({ code: sq.body.inviteCode }).expect(409)).body.code).toBe('ESPORTS_SQUAD_FULL');
    expect((await api().post(`${P}/me/esports/squads`).set(h.bearer(rest[0])).send({ gameId: ff.id, name: 'Second', tag: 'SE' }).expect(409)).body.code).toBe('ESPORTS_ALREADY_IN_SQUAD');
    expect((await api().post(`${P}/me/esports/squads/${sq.body.id}/captain`).set(h.bearer(rest[0])).send({ userId: rest[1].user.id }).expect(403)).body.code).toBe('ESPORTS_SQUAD_CAPTAIN_ONLY');
    await api().post(`${P}/me/esports/squads/${sq.body.id}/leave`).set(h.bearer(cap)).expect(200);
    expect((await models.EsportsSquad.findByPk(sq.body.id)).captainUserId).toBe(rest[0].user.id);
    // An unverified player cannot join.
    const plain = await h.signupUser({ name: 'No Uid' });
    expect((await api().post(`${P}/me/esports/squads/join`).set(h.bearer(plain)).send({ code: sq.body.inviteCode }).expect(403)).body.code).toBe('ESPORTS_GAME_PROFILE_REQUIRED');
  });
});

describe('authoring and publishing (FR-06, FR-07)', () => {
  it('a draft is checked on submit, reviewed by someone else, then the prize table locks', async () => {
    const mode = await modeOf('free_fire', 'solo');
    const maps = await mapsOf('free_fire');
    const start = new Date(Date.now() + 5 * 3600000).toISOString();
    const draft = await api()
      .post(`${P}/admin/esports/tournaments`)
      .set(h.bearer(master))
      .send({ gameId: mode.gameId, modeId: mode.id, titleEn: 'Bad', titleBn: 'খারাপ', tier: 'daily', format: 'single_match', entryFee: 5000, maxSlots: 60, minParticipants: 2, prizes: [{ place: 1, amount: 1000 }], placementPoints: [12, 9], killPoints: 1, registrationOpensAt: new Date(Date.now() + 60000).toISOString(), matches: [{ mapId: maps[0].id, startsAt: start }] })
      .expect(201);
    expect((await api().post(`${P}/admin/esports/tournaments/${draft.body.id}/submit`).set(h.bearer(master)).expect(422)).body.code).toBe('SLOTS_ABOVE_LOBBY');
    await api().patch(`${P}/admin/esports/tournaments/${draft.body.id}`).set(h.bearer(master)).send({ gameId: mode.gameId, modeId: mode.id, maxSlots: 40, entryFee: 5000, prizes: [{ place: 1, amount: 1000 }], killReward: 0, placementPoints: [12, 9], killPoints: 1, matches: [{ mapId: maps[0].id, startsAt: start }], registrationOpensAt: new Date(Date.now() + 60000).toISOString(), tier: 'daily', format: 'single_match', titleEn: 'Fixed', titleBn: 'ঠিক', minParticipants: 2, rulesMd: '', featured: true }).expect(200);
    await api().post(`${P}/admin/esports/tournaments/${draft.body.id}/submit`).set(h.bearer(master)).expect(200);
    // Not public while in review.
    await api().get(`${P}/esports/tournaments/${draft.body.slug}`).expect(404);
    // The author cannot approve their own tournament (M05 self-review).
    const sub = await models.Submission.findOne({ where: { kind: 'esports_tournament', subjectId: draft.body.id } });
    expect((await api().post(`${P}/admin/submissions/${sub.id}/claim`).set(h.bearer(master)).expect(403)).body.code).toBe('SELF_REVIEW_FORBIDDEN');
    await review('esports_tournament', draft.body.id);
    const t = await models.EsportsTournament.findByPk(draft.body.id);
    expect(t).toMatchObject({ status: 'scheduled', featured: true });
    expect(t.settingsSnapshot).toMatchObject({ 'esports.room_reveal_minutes': 15, 'esports.result_dispute_minutes': 60 });
    const pub = await api().get(`${P}/esports/tournaments/${t.slug}`).expect(200);
    expect(pub.body).toMatchObject({ titleEn: 'Fixed', prizePool: { amount: 1000, currency: 'BDT' }, slotsTaken: 0 });
    expect((await api().patch(`${P}/admin/esports/tournaments/${t.id}`).set(h.bearer(master)).send({ entryFee: 1 }).expect(409)).body.code).toBe('ESPORTS_PRIZE_TABLE_LOCKED');
    await api().patch(`${P}/admin/esports/tournaments/${t.id}`).set(h.bearer(master)).send({ titleEn: 'Fixed Final' }).expect(200);
    const list = await api().get(`${P}/esports/tournaments?game=free_fire&featured=true`).expect(200);
    expect(list.body.items.map((x) => x.id)).toEqual([t.id]);
  });
});

describe('registration (FR-08 to FR-12)', () => {
  it('pays into the pool; the key replays; the same player cannot enter twice; only during registration', async () => {
    const t = await tournament();
    const a = await player('Ayan Khan');
    expect((await solo(a, t).expect(409)).body.code).toBe('ESPORTS_REGISTRATION_CLOSED');
    await openRegistration(t);
    const k = key('reg');
    const r = await register(a, t, { players: [a.profileId] }, k).expect(201);
    expect(r.body).toMatchObject({ registration: { status: 'pending_payment', slotNo: 1, amount: { amount: 5000 } }, waitlisted: false });
    expect(r.body.payment.payUrl).toContain(`/pay/${r.body.payment.id}`);
    expect((await register(a, t, { players: [a.profileId] }, k).expect(201)).body.registration.id).toBe(r.body.registration.id);
    expect((await solo(a, t).expect(409)).body.code).toBe('ESPORTS_ALREADY_REGISTERED');
    await h.payWithSimulator(a, r.body.payment.id);
    expect((await models.EsportsRegistration.findByPk(r.body.registration.id)).status).toBe('confirmed');
    const hold = await models.EscrowHold.findOne({ where: { paymentId: r.body.payment.id } });
    expect(hold).toMatchObject({ purpose: 'esports_entry', groupRef: t.id, payeeId: null });
    await h.drainEvents();
    expect(await codesOf(a.user.id)).toContain('ESPORTS_REG_CONFIRMED');
    // Someone else's UID is not yours to enter.
    const b = await player('Bilal Hasan');
    expect((await register(b, t, { players: [a.profileId] }).expect(403)).body.code).toBe('ESPORTS_GAME_PROFILE_REQUIRED');
    // No verified phone, no entry (gate join_esports).
    await models.User.update({ phoneVerifiedAt: null }, { where: { id: b.user.id } });
    await models.User.increment('authzVersion', { where: { id: b.user.id } });
    const fresh = await h.refreshWeb(b.cookie);
    expect((await register({ accessToken: fresh.body.accessToken }, t, { players: [b.profileId] }).expect(403)).body.code).toBe('PHONE_REQUIRED');
  });

  it('200 people race for 48 slots: exactly 48 hold a slot, the rest wait (FR-09)', async () => {
    const t = await tournament({ fee: 0, maxSlots: 48, min: 2 });
    await openRegistration(t);
    const ff = await game('free_fire');
    const principals = [];
    for (let i = 0; i < 200; i += 1) {
      const u = await models.User.create({ phone: `+88017${String(30000000 + i)}`, phoneVerifiedAt: new Date(), displayName: `Racer ${i}` });
      await models.UserRole.create({ userId: u.id, role: 'member', status: 'applied' });
      const p = await models.EsportsGameProfile.create({ userId: u.id, gameId: ff.id, uid: `8${String(10000000 + i)}`, ign: `R${i}`, status: 'verified', screenshotKey: 'x', screenshotMime: 'image/jpeg' });
      principals.push({ principal: await loadPrincipal(u.id), profileId: p.id });
    }
    const out = await Promise.allSettled(principals.map((x, i) => registrations.register(x.principal, t.id, { players: [x.profileId] }, `race-${i}`, null)));
    expect(out.filter((o) => o.status === 'rejected')).toEqual([]);
    const regs = await models.EsportsRegistration.findAll({ where: { tournamentId: t.id } });
    expect(regs.filter((r) => r.status === 'confirmed')).toHaveLength(48);
    expect(new Set(regs.filter((r) => r.slotNo !== null).map((r) => r.slotNo)).size).toBe(48);
    expect(regs.filter((r) => r.status === 'waitlisted')).toHaveLength(152);
  }, 180000);

  it('waitlist: a slot freed before close is offered; the offer expires to the end of the queue (FR-10, FR-11, Q122, Q124)', async () => {
    const t = await tournament({ maxSlots: 2, min: 2, prizes: [10000] });
    await openRegistration(t);
    const [a, b, c, d] = [await player('Asha Rani'), await player('Bina Das'), await player('Chandan Roy'), await player('Dipa Saha')];
    const ra = await enterPaid(a, t);
    await enterPaid(b, t);
    const wc = await solo(c, t).expect(201);
    expect(wc.body).toMatchObject({ waitlisted: true, payment: null, registration: { waitlistPosition: 1 } });
    const wd = await solo(d, t).expect(201);
    // A withdraws before close: refunded in full, and C is offered the slot.
    const w = await api().post(`${P}/me/esports/registrations/${ra.id}/withdraw`).set(h.bearer(a)).expect(200);
    expect(w.body).toMatchObject({ status: 'withdrawn', refunded: { amount: 5000 } });
    await h.drainPaymentJobs();
    expect(await models.Refund.findOne({ where: { idempotencyKey: `esports:refund:${ra.id}` } })).toMatchObject({ reasonCode: 'esports_withdraw', amountPoisha: 5000 });
    expect((await models.EsportsRegistration.findByPk(wc.body.registration.id)).status).toBe('offered');
    await h.drainEvents();
    expect(await codesOf(c.user.id)).toContain('ESPORTS_WAITLIST_OFFER');
    // C lets the offer lapse: back to the end of the queue, D is offered.
    await models.EsportsRegistration.update({ offerExpiresAt: ago(1000) }, { where: { id: wc.body.registration.id } });
    await lifecycle.tick();
    expect(await models.EsportsRegistration.findByPk(wc.body.registration.id)).toMatchObject({ status: 'waitlisted', waitlistPosition: 3 });
    expect((await models.EsportsRegistration.findByPk(wd.body.registration.id)).status).toBe('offered');
    const acc = await api().post(`${P}/me/esports/registrations/${wd.body.registration.id}/accept-offer`).set(h.bearer(d)).set('Idempotency-Key', key('acc')).expect(200);
    expect(acc.body.registration.status).toBe('pending_payment');
    await h.payWithSimulator(d, acc.body.payment.id);
    expect((await models.EsportsRegistration.findByPk(wd.body.registration.id)).status).toBe('confirmed');
    // After close, a withdrawal forfeits the fee.
    await closeRegistration(t);
    expect((await models.EsportsRegistration.findByPk(wc.body.registration.id)).status).toBe('cancelled');
    const late = await api().post(`${P}/me/esports/registrations/${wd.body.registration.id}/withdraw`).set(h.bearer(d)).expect(200);
    expect(late.body.refunded).toEqual({ amount: 0, currency: 'BDT' });
  });

  it('an unpaid hold that expires frees the slot (payment.expired)', async () => {
    const t = await tournament({ maxSlots: 2, min: 1, prizes: [10000] });
    await openRegistration(t);
    const a = await player('Hold Er');
    const r = await solo(a, t).expect(201);
    await models.Payment.update({ expiresAt: ago(3600000) }, { where: { id: r.body.payment.id } });
    await require('../../src/modules/payments/payments.service').expireIntents();
    await h.drainEvents();
    expect(await models.EsportsRegistration.findByPk(r.body.registration.id)).toMatchObject({ status: 'cancelled', slotNo: null });
    expect(await models.EsportsRegistrationPlayer.count({ where: { registrationId: r.body.registration.id, status: 'active' } })).toBe(0);
  });

  it('below min_participants at close the tournament is cancelled and every entry refunded 100% (FR-12)', async () => {
    const t = await tournament({ maxSlots: 4, min: 3 });
    await openRegistration(t);
    const a = await player('Mina Akter');
    const b = await player('Nila Sultana');
    const ra = await enterPaid(a, t);
    await enterPaid(b, t);
    await closeRegistration(t);
    expect((await models.EsportsTournament.findByPk(t.id)).status).toBe('cancelled');
    expect(await models.Refund.count({ where: { reasonCode: 'esports_min_not_met' } })).toBe(2);
    expect((await models.EsportsRegistration.findByPk(ra.id)).status).toBe('refunded');
    expect(await codesOf(a.user.id)).toContain('ESPORTS_CANCELLED');
    // Running the job again changes nothing.
    await lifecycle.tick();
    expect(await models.Refund.count()).toBe(2);
  });
});

/** Two (or more) paid solo players checked in to a published tournament with a room set. */
async function readyTournament(opts = {}, names = ['Rahim Uddin', 'Karim Mia']) {
  const t = await tournament(opts);
  await openRegistration(t);
  const people = [];
  for (const n of names) {
    const p = await player(n);
    p.reg = await enterPaid(p, t);
    people.push(p);
  }
  await closeRegistration(t);
  await openCheckin(t);
  for (const p of people) await checkIn(p, p.reg.id).expect(200);
  return { t, people };
}

describe('check-in and the room (FR-13 to FR-17)', () => {
  it('only checked-in players get the room, from the reveal; every read is audited; rotation pushes a new version', async () => {
    const { t, people } = await readyTournament({}, ['Rahim Uddin', 'Karim Mia', 'Late Comer']);
    const [a, , late] = people;
    // Late Comer never checked in → no-show at close.
    await models.EsportsCheckin.destroy({ where: { userId: late.user.id } });
    await models.EsportsRegistration.update({ status: 'confirmed' }, { where: { id: late.reg.id } });
    await closeCheckin(t);
    expect((await models.EsportsRegistration.findByPk(late.reg.id)).status).toBe('no_show');
    const [m] = await matchesOf(t);
    await api().put(`${P}/admin/esports/matches/${m.id}/room`).set(h.bearer(master)).send({ roomId: '84512379', password: 'kg2024' }).expect(200);
    expect((await api().get(`${P}/me/esports/matches/${m.id}/room`).set(h.bearer(a)).expect(409)).body.code).toBe('ESPORTS_ROOM_NOT_REVEALED');
    expect((await api().get(`${P}/me/esports/matches/${m.id}/room`).set(h.bearer(late)).expect(403)).body.code).toBe('ESPORTS_NOT_CHECKED_IN');
    realtime.clearEmitted();
    await models.EsportsRoomCredential.update({ revealAt: ago(1000) }, { where: { matchId: m.id } });
    await lifecycle.tick();
    const pushed = realtime.emitted().filter((e) => e.name === 'esports.room_revealed');
    expect(pushed.map((e) => e.userId).sort()).toEqual(people.slice(0, 2).map((p) => p.user.id).sort());
    expect(pushed[0].data).toMatchObject({ matchId: m.id, version: 1, roomId: '84512379', password: 'kg2024' });
    const room = await api().get(`${P}/me/esports/matches/${m.id}/room`).set(h.bearer(a)).expect(200);
    expect(room.headers['cache-control']).toBe('no-store');
    expect(room.body).toMatchObject({ version: 1, roomId: '84512379', password: 'kg2024' });
    await api().post(`${P}/admin/esports/matches/${m.id}/room/rotate`).set(h.bearer(master)).send({ roomId: '99887766', password: 'new1', reason: 'Posted on Facebook' }).expect(200);
    expect((await api().get(`${P}/me/esports/matches/${m.id}/room`).set(h.bearer(a)).expect(200)).body).toMatchObject({ version: 2, roomId: '99887766' });
    const views = await api().get(`${P}/admin/esports/matches/${m.id}/room/views`).set(h.bearer(master)).expect(200);
    expect(views.body.items.length).toBeGreaterThanOrEqual(6); // 2 socket + 2 api + 2 rotation pushes
    await h.drainEvents();
    expect(await codesOf(a.user.id)).toContain('ESPORTS_ROOM_READY');
    // The secret is never in events, notifications, audit rows or error messages.
    const dump = JSON.stringify([await models.OutboxEvent.findAll(), await models.Notification.findAll(), await models.AuditLog.findAll(), await models.SmsLog.findAll()]);
    for (const secret of ['84512379', 'kg2024', '99887766']) expect(dump).not.toContain(secret);
  });
});

describe('results, disputes and prizes (FR-18 to FR-25, §6.5)', () => {
  it('worked example A: points, a dispute corrected, finalise credits prizes and kill rewards; escrow ends at zero', async () => {
    const { t, people } = await readyTournament({ prizes: [10000, 6000, 3000], killReward: 500 }, ['P One', 'P Two', 'P Three', 'P Four']);
    const [p1, p2, p3, p4] = people;
    const [m] = await matchesOf(t);
    await api().put(`${P}/admin/esports/matches/${m.id}/room`).set(h.bearer(master)).send({ roomId: '11112222', password: 'pw' }).expect(200);
    const row = (p, placement, kills) => ({ registrationId: p.reg.id, placement, kills: kills === null ? [] : [{ userId: p.user.id, kills }] });
    // Results cannot be posted before the match starts; placements must be unique.
    expect((await api().post(`${P}/admin/esports/matches/${m.id}/results/post`).set(h.bearer(master)).expect(409)).body.code).toBe('ESPORTS_TOO_EARLY');
    await startMatches(t);
    expect((await api().put(`${P}/admin/esports/matches/${m.id}/results`).set(h.bearer(master)).send({ rows: [row(p1, 1, 2), row(p2, 1, 0)] }).expect(422)).body.code).toBe('ESPORTS_PLACEMENT_DUPLICATE');
    // An enter_results clerk types them in; they can't cancel the tournament.
    const clerk = await staffWith(['enter_results']);
    await api().put(`${P}/admin/esports/matches/${m.id}/results`).set(h.bearer(clerk)).send({ rows: [row(p1, 2, 2), row(p2, 1, 4), row(p3, 3, 0), row(p4, 4, 0)] }).expect(200);
    expect((await api().post(`${P}/admin/esports/tournaments/${t.id}/cancel`).set(h.bearer(clerk)).send({ reason: 'Not allowed for clerks' }).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    await api().post(`${P}/admin/esports/matches/${m.id}/results/post`).set(h.bearer(clerk)).expect(200);
    expect((await models.EsportsTournament.findByPk(t.id)).status).toBe('results_pending');
    const standings = await api().get(`${P}/esports/tournaments/${t.id}/standings`).expect(200);
    expect(standings.body.items.map((s) => [s.registrationId, s.rank, s.totalPoints])).toEqual([[p2.reg.id, 1, 16], [p1.reg.id, 2, 11], [p3.reg.id, 3, 8], [p4.reg.id, 4, 7]]);
    // P1 disputes with evidence; finalising waits; staff correct (P1 actually won).
    const up = await api().post(`${P}/me/esports/uploads`).set(h.bearer(p1)).set('Content-Type', 'image/jpeg').send(JPEG).expect(201);
    const ev = await api().post(`${P}/me/esports/matches/${m.id}/evidence`).set(h.bearer(p1)).send({ kind: 'screenshot', key: up.body.key }).expect(201);
    const d = await api().post(`${P}/me/esports/matches/${m.id}/disputes`).set(h.bearer(p1)).send({ reason: 'I was first, see the scoreboard', evidenceIds: [ev.body.id] }).expect(201);
    expect((await api().post(`${P}/me/esports/matches/${m.id}/disputes`).set(h.bearer(p1)).send({ reason: 'Again please' }).expect(409)).body.code).toBe('ESPORTS_DISPUTE_LIMIT');
    expect((await api().post(`${P}/admin/esports/tournaments/${t.id}/finalise`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'esports.money')).expect(409)).body.code).toBe('ESPORTS_NOT_FINALISABLE');
    // M17: the dispute is also a case on the unified desk (no money, straight to staff).
    expect(d.body.caseCode).toMatch(/^DSP-/);
    const kase = await api().get(`${P}/admin/disputes/${d.body.caseCode}`).set(h.bearer(master)).expect(200);
    expect(kase.body).toMatchObject({ dispute: { sourceType: 'esports_result', status: 'under_review', money: false }, outcomes: ['corrected', 'rejected'], source: { matchId: m.id } });
    await api().post(`${P}/admin/esports/disputes/${d.body.id}/resolve`).set(h.bearer(master)).send({ outcome: 'corrected', rows: [row(p1, 1, 2), row(p2, 2, 4)], note: 'Scoreboard shows P1 first' }).expect(200);
    expect(await models.Dispute.findOne({ where: { code: d.body.caseCode } })).toMatchObject({ status: 'resolved', outcome: 'corrected', decidedRole: 'master' });
    await models.EsportsMatch.update({ disputeClosesAt: ago(1000) }, { where: { id: m.id } });
    await lifecycle.tick();
    expect((await models.EsportsMatch.findByPk(m.id)).status).toBe('final');
    await h.drainEvents();
    expect(await codesOf(p1.user.id)).toContain('ESPORTS_DISPUTE_DECIDED');

    const preview = await api().get(`${P}/admin/esports/tournaments/${t.id}/finalise-preview`).set(h.bearer(master)).expect(200);
    expect(preview.body).toMatchObject({ finalisable: true, totals: { collected: { amount: 20000 }, paid: { amount: 22000 }, subsidy: { amount: 2000 }, revenue: { amount: 0 } } });
    await api().post(`${P}/admin/esports/tournaments/${t.id}/finalise`).set(h.bearer(master)).expect(403);
    const fin = await api().post(`${P}/admin/esports/tournaments/${t.id}/finalise`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'esports.money')).expect(200);
    expect(fin.body).toMatchObject({ status: 'paid_out', settlement: { collected: 20000, paid: 22000, subsidy: 2000, fee: 0 } });
    // 1st ৳100 + 2 kills × ৳5; 2nd ৳60 + 4 kills × ৳5; 3rd ৳30.
    expect(await ledger.balance(`payable:user:${p1.user.id}`)).toBe(11000);
    expect(await ledger.balance(`payable:user:${p2.user.id}`)).toBe(8000);
    expect(await ledger.balance(`payable:user:${p3.user.id}`)).toBe(3000);
    expect(await ledger.balance(`payable:user:${p4.user.id}`)).toBe(0);
    expect(await ledger.balance('escrow:esports_entry')).toBe(0);
    expect(await models.EscrowHold.count({ where: { groupRef: t.id, status: ['holding', 'partially_released'] } })).toBe(0);
    await h.drainEvents();
    expect(await codesOf(p1.user.id)).toContain('ESPORTS_PRIZE_CREDITED');
    // Finalising again changes nothing.
    await api().post(`${P}/admin/esports/tournaments/${t.id}/finalise`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'esports.money')).expect(200);
    expect(await ledger.balance(`payable:user:${p1.user.id}`)).toBe(11000);

    // Rankings and the public player page.
    const lb = await api().get(`${P}/esports/leaderboards?game=free_fire`).expect(200);
    expect(lb.body.items[0]).toMatchObject({ rank: 1, userId: p1.user.id });

    // Q161: a suspended player leaves the leaderboard and top players, and the ranks renumber; a
    // restore brings them back. Their tournament history stays.
    const board = async () => (await api().get(`${P}/esports/leaderboards?game=free_fire`).expect(200)).body.items;
    const top = async () => (await api().get(`${P}/esports/top-players`).expect(200)).body.items ?? [];
    await api().post(`${P}/admin/users/${p1.user.id}/suspend`).set(h.bearer(master)).send({ reasonCode: 'policy_breach', note: 'Q161 ranking check' }).expect(200);
    await h.drainEvents();
    expect((await board()).map((r) => r.userId)).not.toContain(p1.user.id);
    expect((await board())[0]).toMatchObject({ rank: 1, userId: p2.user.id });
    expect((await top()).map((r) => r.userId)).not.toContain(p1.user.id);
    expect(await models.EsportsRankingEntry.count({ where: { userId: p1.user.id } })).toBe(1);
    await api().post(`${P}/admin/users/${p1.user.id}/restore`).set(h.bearer(master)).send({ note: 'Q161 ranking check done' }).expect(200);
    await h.drainEvents();
    expect((await board())[0]).toMatchObject({ rank: 1, userId: p1.user.id });
    const winnings = await api().get(`${P}/me/esports/winnings`).set(h.bearer(p1)).expect(200);
    expect(winnings.body).toMatchObject({ available: { amount: 11000 }, totalWon: { amount: 11000 } });

    // Disqualified after credit (Q123): the unwithdrawn prize is taken back as revenue; nobody is moved up.
    await api().post(`${P}/admin/esports/registrations/${p1.reg.id}/disqualify`).set(h.bearer(master)).send({ reasonCode: 'cheating', note: 'Emulator in a mobile lobby', userId: p1.user.id, banUid: true }).expect(200);
    expect(await ledger.balance(`payable:user:${p1.user.id}`)).toBe(0);
    expect(await ledger.balance('fee_revenue:esports')).toBe(11000);
    expect(await ledger.balance(`payable:user:${p2.user.id}`)).toBe(8000);
    expect((await models.EsportsGameProfile.findByPk(p1.profileId)).status).toBe('banned');
  });

  it('worked example B: a squad series with low fill is subsidised and the prize split goes to the members', async () => {
    const t = await tournament({ modeKey: 'squad', maxSlots: 12, min: 2, fee: 40000, prizes: [100100, 50000], matches: 2 });
    await openRegistration(t);
    const ff = await game('free_fire');
    const squads = [];
    for (const label of ['A', 'B']) {
      const members = [];
      for (let i = 0; i < 4; i += 1) members.push(await player(`${label} Player${i}`));
      const sq = await api().post(`${P}/me/esports/squads`).set(h.bearer(members[0])).send({ gameId: ff.id, name: `Squad ${label}`, tag: `SQ${label}` }).expect(201);
      for (const m of members.slice(1)) await api().post(`${P}/me/esports/squads/join`).set(h.bearer(m)).send({ code: sq.body.inviteCode }).expect(200);
      const r = await register(members[0], t, { squadId: sq.body.id, players: members.map((m) => m.profileId) }).expect(201);
      await h.payWithSimulator(members[0], r.body.payment.id);
      squads.push({ members, reg: r.body.registration });
    }
    // Squad A's captain declares 40/20/20/20.
    const [a, b] = squads;
    await api().put(`${P}/me/esports/registrations/${a.reg.id}/prize-split`).set(h.bearer(a.members[0])).send({ split: a.members.map((m, i) => ({ userId: m.user.id, pct: i === 0 ? 40 : 20 })) }).expect(200);
    await closeRegistration(t);
    await openCheckin(t);
    for (const s of squads) for (const m of s.members) await checkIn(m, s.reg.id).expect(200);
    expect((await models.EsportsRegistration.findByPk(a.reg.id)).status).toBe('checked_in');
    await startMatches(t);
    for (const m of await matchesOf(t)) {
      await api().put(`${P}/admin/esports/matches/${m.id}/results`).set(h.bearer(master)).send({ rows: [{ registrationId: a.reg.id, placement: 1, kills: [{ userId: a.members[0].user.id, kills: 3 }] }, { registrationId: b.reg.id, placement: 2, kills: [] }] }).expect(200);
      await api().post(`${P}/admin/esports/matches/${m.id}/results/post`).set(h.bearer(master)).expect(200);
      await models.EsportsMatch.update({ disputeClosesAt: ago(1000) }, { where: { id: m.id } });
    }
    await lifecycle.tick();
    await api().post(`${P}/admin/esports/tournaments/${t.id}/finalise`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'esports.money')).expect(200);
    // 2 × ৳400 = ৳800 collected; ৳1,001 + ৳500 paid → ৳701 subsidy.
    expect(await ledger.balance('prize_subsidy_expense')).toBe(-70100);
    expect(await ledger.balance('escrow:esports_entry')).toBe(0);
    // A: 40/20/20/20 of 100100 (the captain gets the remainder); B: equal shares of 50000.
    expect(await ledger.balance(`payable:user:${a.members[0].user.id}`)).toBe(40040);
    expect(await ledger.balance(`payable:user:${a.members[1].user.id}`)).toBe(20020);
    for (const m of b.members) expect(await ledger.balance(`payable:user:${m.user.id}`)).toBe(12500);
  });
});

describe('withdrawal of winnings (FR-26, M07)', () => {
  it('needs NID KYC and a verified account; respects the minimum; one at a time', async () => {
    const { t, people } = await readyTournament({ prizes: [20000], fee: 0, min: 1 }, ['Win Ner', 'Lo Ser']);
    const [w] = people;
    await startMatches(t);
    const [m] = await matchesOf(t);
    await api().put(`${P}/admin/esports/matches/${m.id}/results`).set(h.bearer(master)).send({ rows: [{ registrationId: w.reg.id, placement: 1, kills: [] }, { registrationId: people[1].reg.id, placement: 2, kills: [] }] }).expect(200);
    await api().post(`${P}/admin/esports/matches/${m.id}/results/post`).set(h.bearer(master)).expect(200);
    await models.EsportsMatch.update({ disputeClosesAt: ago(1000) }, { where: { id: m.id } });
    await lifecycle.tick();
    await api().post(`${P}/admin/esports/tournaments/${t.id}/finalise`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'esports.money')).expect(200);
    // A free tournament: the whole prize is a subsidy.
    expect(await ledger.balance('prize_subsidy_expense')).toBe(-20000);

    expect((await api().post(`${P}/me/withdrawals`).set(h.bearer(w)).set('Idempotency-Key', key('wd')).expect(403)).body.code).toBe('KYC_REQUIRED');
    await h.verifyMember(w.user.id);
    const fresh = await h.refreshWeb(w.cookie);
    w.accessToken = fresh.body.accessToken;
    w.cookie = fresh.headers['set-cookie'];
    expect((await api().post(`${P}/me/withdrawals`).set(h.bearer(w)).set('Idempotency-Key', key('wd')).expect(409)).body.code).toBe('PAYOUT_ACCOUNT_REQUIRED');
    await models.PayoutAccount.create({ userId: w.user.id, type: 'bkash', accountNoEnc: 'x', accountNoHash: 'a'.repeat(64), accountNoLast4: '5678', accountName: 'Win Ner', status: 'active', activatedAt: new Date() });
    await h.setSettingForTest('esports.min_withdraw_poisha', 50000);
    expect((await api().post(`${P}/me/withdrawals`).set(h.bearer(w)).set('Idempotency-Key', key('wd')).expect(422)).body.code).toBe('WITHDRAW_BELOW_MINIMUM');
    await h.setSettingForTest('esports.min_withdraw_poisha', 10000);
    const wd = await api().post(`${P}/me/withdrawals`).set(h.bearer(w)).set('Idempotency-Key', key('wd')).expect(201);
    expect(wd.body).toMatchObject({ kind: 'withdrawal', amount: 20000 });
    expect((await api().post(`${P}/me/withdrawals`).set(h.bearer(w)).set('Idempotency-Key', key('wd')).expect(409)).body.code).toBe('WITHDRAW_OPEN');
    // The scheduled runs never sweep esports winnings.
    expect(await models.Payout.count({ where: { payeeId: w.user.id, kind: 'earning' } })).toBe(0);
  });
});

describe('sanctions and fair play', () => {
  it('a suspended player is withdrawn and refunded before close', async () => {
    const t = await tournament({ maxSlots: 4, min: 1 });
    await openRegistration(t);
    const a = await player('Sus Pended');
    const reg = await enterPaid(a, t);
    await api().post(`${P}/admin/users/${a.user.id}/suspend`).set(h.bearer(master)).send({ reasonCode: 'abuse', note: 'Abusive messages to other players' }).expect(200);
    await h.drainEvents();
    expect((await models.EsportsRegistration.findByPk(reg.id)).status).toBe('withdrawn');
    expect(await models.Refund.findOne({ where: { idempotencyKey: `esports:refund:${reg.id}` } })).toMatchObject({ reasonCode: 'esports_suspended' });
  });
});
