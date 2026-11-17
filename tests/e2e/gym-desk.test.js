'use strict';

// M24 §21 desk mode with a PIN (product owner, 11 Nov 2026; ADR-010; M24-FR-134 to FR-143), end to end:
// each person's own PIN (weak ones refused, never returned); a device in desk mode does nothing until a
// PIN unlocks it, and stays locked after a token refresh; while unlocked it works as that person, inside its
// gym only, never on owner-only pages (not even with the owner's PIN), and the audit says it was a desk;
// wrong PINs are counted exactly under parallel tries, lock the person, and three lockouts clear the PIN;
// the device has its own limit; idle locks; a removed staff member's unlock dies; a PIN reset ends unlocks;
// ending desk mode signs the device out; the owner can end it from their own sign-in; and the plan tier.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const gm = require('../fixtures/gym-manage');
const s = require('../../src/modules/gym-manage/gym-manage.schemas');

const { api, P, models } = h;
jest.setTimeout(300000);

beforeEach(async () => {
  await h.resetDb();
  await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const conforms = (schema, body) => expect(schema.safeParse(body).error?.issues ?? []).toEqual([]);
const PASSWORD = 'Front-Desk-2026';
const setPin = (who, gymId, pin) => api().put(`${P}/me/gym-desk-pins`).set(h.bearer(who)).send({ gymId, pin });
const desk = (device) => ({
  state: () => api().get(`${P}/manage/desk-mode`).set(h.bearer(device)),
  unlock: (userId, pin) => api().post(`${P}/manage/desk-mode/unlock`).set(h.bearer(device)).send({ userId, pin }),
  lock: () => api().post(`${P}/manage/desk-mode/lock`).set(h.bearer(device)),
  touch: () => api().post(`${P}/manage/desk-mode/touch`).set(h.bearer(device)),
  close: (userId, pin) => api().post(`${P}/manage/desk-mode/close`).set(h.bearer(device)).send({ userId, pin }),
});
/** A second, separate sign-in of the same person (its own session family). */
const signInAgain = async (who) => ({ ...who, accessToken: (await api().post(`${P}/auth/login`).send({ identifier: who.phone, password: PASSWORD }).expect(200)).body.accessToken });

/** A Basic gym, its owner (PIN 4826), a desk clerk (PIN 5937) and a coach without a PIN. */
async function setup({ tier = 'basic' } = {}) {
  const owner = await h.signupUser({ name: 'Karim Uddin', password: PASSWORD });
  const { gym } = await gm.privateGym({ owner, tier });
  const clerk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi', password: PASSWORD }), ['attendance.mark', 'members.view', 'members.edit']);
  const coach = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Coach Tania' }), ['plans.manage', 'members.view']);
  await setPin(owner, gym.id, '4826').expect(200);
  await setPin(clerk, gym.id, '5937').expect(200);
  return { owner, gym, clerk, coach };
}

describe('M24 desk mode with a PIN', () => {
  it('own PINs, opening, the lock, working as the unlocked person, owner-only pages, the audit and ending', async () => {
    const { owner, gym, clerk, coach } = await setup();

    // FR-134: four digits, not too easy, not my phone's last four; never returned.
    expect((await setPin(coach, gym.id, '7777').expect(422)).body).toMatchObject({ code: 'GYM_DESK_PIN_WEAK', reason: 'repeat' });
    expect((await setPin(coach, gym.id, '6543').expect(422)).body.reason).toBe('run');
    expect((await setPin(coach, gym.id, coach.phone.slice(-4)).expect(422)).body.reason).toBe('phone');
    await setPin(coach, gym.id, '12a4').expect(422);
    const elsewhere = await gm.privateGym({ name: 'Other Gym', shortCode: 'OG' });
    await setPin(coach, elsewhere.gym.id, '3816').expect(404);
    const mine = (await api().get(`${P}/me/gym-desk-pins`).set(h.bearer(clerk)).expect(200)).body;
    conforms(s.MyDeskPins, mine);
    expect(mine.items).toEqual([{ gymId: gym.id, set: true, setAt: expect.any(String), lockedUntil: null }]);
    expect(JSON.stringify(mine)).not.toContain('5937');
    const row = await models.GymDeskPin.findOne({ where: { userId: clerk.user.id } });
    expect(row.pinHash).toMatch(/^\$argon2id\$/);
    expect(row.pinHash).not.toContain('5937');

    // FR-136: the opener needs their own PIN; the device is the clerk's own sign-in.
    await api().post(`${P}/manage/gyms/${gym.id}/desk-mode/open`).set(h.bearer(coach)).expect(409);
    expect((await desk(clerk).state().expect(200)).body).toEqual({ open: false });
    const opened = (await api().post(`${P}/manage/gyms/${gym.id}/desk-mode/open`).set(h.bearer(clerk)).expect(201)).body;
    conforms(s.DeskState, opened);
    expect(opened).toMatchObject({ open: true, gym: { id: gym.id }, idleMinutes: 5, unlocked: null, deviceLockedUntil: null });
    // The lock screen lists those with a PIN set: the owner and the clerk, not the coach.
    expect(opened.people.map((p) => [p.displayName, p.role]).sort()).toEqual([['Desk Rumi', 'staff'], ['Karim Uddin', 'owner']]);
    expect((await api().post(`${P}/manage/gyms/${gym.id}/desk-mode/open`).set(h.bearer(clerk)).expect(423)).body.code).toBe('GYM_DESK_LOCKED');

    // Locked: the gym's work waits for a PIN; everything else is refused; the clerk's own account is out of reach.
    const device = clerk;
    expect((await gm.manage(device, gym.id).get('/overview').expect(423)).body.code).toBe('GYM_DESK_LOCKED');
    expect((await api().get(`${P}/manage/gyms`).set(h.bearer(device)).expect(423)).body.code).toBe('GYM_DESK_LOCKED');
    expect((await api().get(`${P}/me/notifications`).set(h.bearer(device)).expect(403)).body.code).toBe('GYM_DESK_SCOPE');
    expect((await setPin(device, gym.id, '2468').expect(403)).body.code).toBe('GYM_DESK_SCOPE');
    expect((await api().get(`${P}/manage/billing`).set(h.bearer(device)).expect(403)).body.code).toBe('GYM_DESK_SCOPE');
    expect((await gm.manage(device, elsewhere.gym.id).get('/overview').expect(403)).body.code).toBe('GYM_DESK_SCOPE');

    // Still locked after a token refresh (bound to the sign-in's family, not the session id).
    const refreshed = await h.refreshWeb(device.cookie).expect(200);
    device.accessToken = refreshed.body.accessToken;
    device.cookie = refreshed.headers['set-cookie'];
    await gm.manage(device, gym.id).get('/overview').expect(423);

    // FR-138: unlocked as the clerk, the device works with the clerk's permissions.
    const asClerk = (await desk(device).unlock(clerk.user.id, '5937').expect(200)).body;
    conforms(s.DeskState, asClerk);
    expect(asClerk.unlocked).toMatchObject({ userId: clerk.user.id, displayName: 'Desk Rumi', role: 'staff' });
    await gm.manage(device, gym.id).get('/overview').expect(200);
    expect((await api().get(`${P}/manage/gyms`).set(h.bearer(device)).expect(200)).body.items.map((g) => g.id)).toEqual([gym.id]);
    expect((await api().get(`${P}/me`).set(h.bearer(device)).expect(200)).body.id).toBe(clerk.user.id);
    expect((await gm.manage(device, gym.id).get('/desk').expect(403)).body.code).toBe('GYM_DESK_SCOPE');
    const added = await gm.addMember(device, gym.id, { displayName: 'Walk-in Sabbir' });
    // The audit names the clerk and says it was a desk (who opened it, which unlock).
    const trail = await models.AuditLog.findAll({ where: { actorId: clerk.user.id }, order: [['createdAt', 'DESC']] });
    const memberRow = trail.find((r) => r.entityId === added.member.id);
    expect(memberRow.meta).toMatchObject({ desk: { deskId: opened.deskId, openedBy: clerk.user.id, unlockId: expect.any(String) }, onBehalfOf: owner.user.id });

    // FR-140: the owner's PIN opens the gym's work as the owner, but never an owner-only page.
    const asOwner = (await desk(device).unlock(owner.user.id, '4826').expect(200)).body;
    expect(asOwner.unlocked).toMatchObject({ userId: owner.user.id, role: 'owner' });
    await gm.manage(device, gym.id).get('/overview').expect(200);
    expect((await gm.manage(device, gym.id).get('/desk').expect(403)).body.code).toBe('GYM_DESK_SCOPE');
    expect((await gm.manage(device, gym.id).get('/settings').expect(403)).body.code).toBe('GYM_DESK_SCOPE');
    expect((await gm.manage(device, gym.id).post('/desk-mode/end').expect(403)).body.code).toBe('GYM_DESK_SCOPE');
    expect((await gm.manage(device, gym.id).post(`/members/${added.member.id}/remove`, { reason: 'Moved away' }).expect(403)).body.code).toBe('GYM_DESK_SCOPE');
    expect((await gm.manage(device, gym.id).get('/members?status=removed').expect(403)).body.code).toBe('GYM_DESK_SCOPE');
    // The clerk's earlier unlock ended when the owner unlocked (one live unlock per desk).
    expect(await models.GymDeskUnlock.count({ where: { deskSessionId: opened.deskId, endedAt: null } })).toBe(1);
    expect((await models.GymDeskUnlock.findOne({ where: { userId: clerk.user.id } })).endReason).toBe('switched');

    // Lock, then idle: only touch (real input) keeps it awake.
    await desk(device).lock().expect(200);
    await gm.manage(device, gym.id).get('/overview').expect(423);
    await desk(device).touch().expect(423);
    await desk(device).unlock(clerk.user.id, '5937').expect(200);
    const touched = (await desk(device).touch().expect(200)).body;
    conforms(s.DeskTouch, touched);
    await models.GymDeskUnlock.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { deskSessionId: opened.deskId, endedAt: null } });
    await gm.manage(device, gym.id).get('/overview').expect(423);
    expect((await models.GymDeskUnlock.findOne({ where: { userId: clerk.user.id }, order: [['unlockedAt', 'DESC']] })).endReason).toBe('idle');

    // The owner's own sign-in sees the desk; it cannot be opened twice on one sign-in.
    const ownerElsewhere = await signInAgain(owner);
    const view = (await gm.manage(ownerElsewhere, gym.id).get('/desk').expect(200)).body;
    conforms(s.DeskOverview, view);
    expect(view.desks).toEqual([{ deskId: opened.deskId, openedBy: { userId: clerk.user.id, displayName: 'Desk Rumi' }, openedAt: expect.any(String), unlockedBy: null }]);
    expect(view.people.find((p) => p.displayName === 'Coach Tania').pin).toBe('none');

    // FR-141: ending desk mode needs a valid PIN and signs the device out.
    expect((await desk(device).close(owner.user.id, '1111').expect(403)).body.code).toBe('GYM_DESK_PIN_WRONG');
    const closed = (await desk(device).close(owner.user.id, '4826').expect(200)).body;
    conforms(s.DeskClosed, closed);
    expect((await gm.manage(device, gym.id).get('/overview').expect(401)).body.code).toBe('SESSION_REVOKED');
    await h.refreshWeb(device.cookie).expect(401);
    expect((await models.GymDeskSession.findByPk(opened.deskId)).closeReason).toBe('ended');
    // Every step is in the audit, never with a PIN.
    const actions = (await models.AuditLog.findAll({ where: { entityType: ['gym', 'user'] } })).map((r) => r.action).filter((a) => a.startsWith('gym_desk.'));
    expect(new Set(actions)).toEqual(new Set(['gym_desk.pin_set', 'gym_desk.opened', 'gym_desk.unlocked', 'gym_desk.closed']));
    const all = JSON.stringify((await models.AuditLog.findAll()).map((r) => [r.before, r.after, r.meta]));
    for (const pin of ['4826', '5937']) expect(all).not.toContain(pin);
  });

  it('wrong PINs: counted exactly under parallel tries, the lock, three lockouts clear the PIN, the device limit', async () => {
    const { owner, gym, clerk } = await setup();
    await api().post(`${P}/manage/gyms/${gym.id}/desk-mode/open`).set(h.bearer(clerk)).expect(201);
    const d = desk(clerk);

    // FR-137: twenty wrong tries at once; five are counted (the fifth locks), the rest wait without a try.
    const tries = await Promise.all(Array.from({ length: 20 }, () => d.unlock(owner.user.id, '0000')));
    const codes = tries.map((r) => r.body.code);
    expect(codes.filter((x) => x === 'GYM_DESK_PIN_WRONG')).toHaveLength(4);
    expect(codes.filter((x) => x === 'GYM_DESK_PIN_LOCKED')).toHaveLength(16);
    expect(tries.find((r) => r.body.code === 'GYM_DESK_PIN_WRONG').body.left).toBeGreaterThan(0);
    let pin = (await models.GymDeskPin.findOne({ where: { userId: owner.user.id } })).toJSON();
    expect(pin).toMatchObject({ failedCount: 0, lockouts: 1, status: 'active' });
    expect(pin.lockedUntil.getTime()).toBeGreaterThan(Date.now() + 14 * 60000);
    // Locked, even the right PIN waits.
    expect((await d.unlock(owner.user.id, '4826').expect(423)).body.scope).toBe('person');
    // The lock screen says so.
    expect((await d.state().expect(200)).body.people.find((p) => p.userId === owner.user.id).lockedUntil).toEqual(expect.any(String));

    // Two more lockouts in a row: the PIN is cleared and must be set again from the owner's own sign-in.
    for (const round of [2, 3]) {
      await models.GymDeskPin.update({ lockedUntil: new Date(Date.now() - 1000) }, { where: { userId: owner.user.id } });
      await models.GymDeskSession.update({ deviceFailCount: 0 }, { where: { gymId: gym.id } });
      for (let i = 0; i < 4; i++) await d.unlock(owner.user.id, '0000').expect(403);
      const last = (await d.unlock(owner.user.id, '0000')).body;
      expect(last.code).toBe(round === 3 ? 'GYM_DESK_PIN_REQUIRED' : 'GYM_DESK_PIN_LOCKED');
    }
    pin = (await models.GymDeskPin.findOne({ where: { userId: owner.user.id } })).toJSON();
    expect(pin).toMatchObject({ status: 'cleared', pinHash: null });
    expect((await d.state().expect(200)).body.people.map((p) => p.userId)).toEqual([clerk.user.id]);
    const audit = (await models.AuditLog.findAll({ where: { entityId: owner.user.id } })).map((r) => r.action);
    expect(audit.filter((a) => a === 'gym_desk.pin_locked')).toHaveLength(2);
    expect(audit).toContain('gym_desk.pin_cleared');
    // A success resets the person's counts.
    await d.unlock(clerk.user.id, '1357').expect(403);
    await d.unlock(clerk.user.id, '5937').expect(200);
    expect((await models.GymDeskPin.findOne({ where: { userId: clerk.user.id } })).toJSON()).toMatchObject({ failedCount: 0, lockouts: 0 });

    // The device's own limit stops one PIN tried against every name.
    await h.setSettingForTest('gym_manage.desk_device_fail_limit', 5);
    await setPin(await signInAgain(owner), gym.id, '4826').expect(200);
    for (const who of [owner, clerk, owner, clerk]) await d.unlock(who.user.id, '0000').expect(403);
    expect((await d.unlock(clerk.user.id, '0000').expect(423)).body.scope).toBe('device');
    expect((await d.unlock(clerk.user.id, '5937').expect(423)).body.scope).toBe('device');
    expect((await d.state().expect(200)).body.deviceLockedUntil).toEqual(expect.any(String));
  });

  it('a removed staff member’s unlock dies, a PIN reset ends unlocks, an opener who left ends the desk, the owner ends it remotely, the tier', async () => {
    const { owner, gym, clerk, coach } = await setup();
    const ownerElsewhere = await signInAgain(owner);
    // The owner opens a desk on one sign-in; the clerk unlocks it.
    const ownerDesk = await signInAgain(owner);
    const opened = (await api().post(`${P}/manage/gyms/${gym.id}/desk-mode/open`).set(h.bearer(ownerDesk)).expect(201)).body;
    await desk(ownerDesk).unlock(clerk.user.id, '5937').expect(200);
    await gm.manage(ownerDesk, gym.id).get('/overview').expect(200);

    // FR-135: the owner clears the clerk's PIN from their own sign-in; the clerk's unlock ends.
    const reset = (await gm.manage(ownerElsewhere, gym.id).post(`/desk-pins/${clerk.user.id}/reset`).expect(200)).body;
    conforms(s.DeskPinReset, reset);
    await gm.manage(ownerDesk, gym.id).get('/overview').expect(423);
    expect((await desk(ownerDesk).unlock(clerk.user.id, '5937').expect(409)).body.code).toBe('GYM_DESK_PIN_REQUIRED');
    await gm.manage(coach, gym.id).post(`/desk-pins/${clerk.user.id}/reset`).expect(403);

    // FR-142: a staff member removed from the team loses their unlock on the next request.
    await setPin(coach, gym.id, '3816').expect(200);
    await desk(ownerDesk).unlock(coach.user.id, '3816').expect(200);
    await gm.manage(ownerDesk, gym.id).get('/overview').expect(200);
    const bm = await models.BusinessMember.findOne({ where: { memberId: coach.user.id, businessId: gym.id } });
    await api().post(`${P}/me/team/${bm.id}/remove`).set(h.bearer(ownerElsewhere)).expect(200);
    await gm.manage(ownerDesk, gym.id).get('/overview').expect(423);
    expect((await models.GymDeskUnlock.findOne({ where: { userId: coach.user.id } })).endReason).toBe('removed');
    expect((await desk(ownerDesk).state().expect(200)).body.people.map((p) => p.userId)).toEqual([owner.user.id]);

    // FR-141: the owner ends desk mode from their own sign-in; the desk device is signed out.
    const ended = (await gm.manage(ownerElsewhere, gym.id).post('/desk-mode/end').expect(200)).body;
    conforms(s.DeskEnded, ended);
    expect(ended).toEqual({ gymId: gym.id, ended: 1 });
    await gm.manage(ownerDesk, gym.id).get('/overview').expect(401);
    expect((await models.GymDeskSession.findByPk(opened.deskId)).closeReason).toBe('ended_by_owner');
    await gm.manage(ownerElsewhere, gym.id).get('/overview').expect(200);

    // FR-142: a desk opened by a staff member who then leaves ends, and the device is signed out.
    await setPin(clerk, gym.id, '5937').expect(200);
    await api().post(`${P}/manage/gyms/${gym.id}/desk-mode/open`).set(h.bearer(clerk)).expect(201);
    const clerkBm = await models.BusinessMember.findOne({ where: { memberId: clerk.user.id, businessId: gym.id } });
    await api().post(`${P}/me/team/${clerkBm.id}/remove`).set(h.bearer(ownerElsewhere)).expect(200);
    // The removal first stales the sign-in's permissions (401 AUTHZ_STALE); the page refreshes, and the desk ends.
    expect((await desk(clerk).state().expect(401)).body.code).toBe('AUTHZ_STALE');
    const again = await h.refreshWeb(clerk.cookie).expect(200);
    await desk({ accessToken: again.body.accessToken }).state().expect(401);
    await h.refreshWeb(again.headers['set-cookie']).expect(401);
    expect((await models.GymDeskSession.findOne({ where: { openedBy: clerk.user.id } })).closeReason).toBe('opener_left');

    // The plan: desk mode needs Basic or above.
    const free = await gm.privateGym({ name: 'Free Gym', shortCode: 'FG', owner: await h.signupUser({ name: 'Free Owner' }) });
    await setPin(free.owner, free.gym.id, '2580').expect(200);
    expect((await api().post(`${P}/manage/gyms/${free.gym.id}/desk-mode/open`).set(h.bearer(free.owner)).expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'desk_mode' });
  });
});
