'use strict';

// M27 gym operations, round 2, end to end: check-out (desk, second entrance scan, the auto-close job), the
// live count and the desk feed; classes (timetable, sessions ahead, bookings, the waitlist, cancelling,
// attendance, reminders, the public timetable); reward points (check-ins, streaks, referrals, rewards,
// redeeming, expiry); notices to a segment; enquiries from the gym page; the exercise library.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const realtime = require('../../src/common/realtime');
const gm = require('../fixtures/gym-manage');
const visits = require('../../src/modules/gym-manage/visits.service');
const classesSvc = require('../../src/modules/gym-ops/classes.service');
const pointsSvc = require('../../src/modules/gym-ops/points.service');
const rules = require('../../src/modules/gym-ops/gym-ops.rules');

const { models } = h;
const HOUR = 3600000;

beforeEach(async () => {
  await h.resetDb();
  // The enquiry form's counters live in Redis and outlast resetDb: start each test from zero.
  await h.clearVelocity('gym_lead_');
  await h.createSignedInMaster();
  realtime.clearEmitted();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const outbox = (name) => models.OutboxEvent.count({ where: { name } });
const me = (who) => ({
  get: (p) => h.api().get(`${h.P}${p}`).set(h.bearer(who)),
  post: (p, body = {}, ik = false) => {
    const r = h.api().post(`${h.P}${p}`).set(h.bearer(who));
    if (ik) r.set('Idempotency-Key', gm.key());
    return r.send(body);
  },
});
/** Move a check-in back in time (the table is append-only; tests only). */
async function backdate(attendanceId, ms) {
  await models.sequelize.query('ALTER TABLE gym_attendance DISABLE TRIGGER trg_gym_attendance_append_only');
  await models.sequelize.query('UPDATE gym_attendance SET checked_in_at = checked_in_at - (:ms || \' milliseconds\')::interval WHERE id = :id', { replacements: { id: attendanceId, ms: String(ms) } });
  await models.sequelize.query('ALTER TABLE gym_attendance ENABLE TRIGGER trg_gym_attendance_append_only');
}
async function linkedMember(owner, gymId, pkg, name = 'Linked Lima', months = true) {
  const who = await h.signupUser({ name });
  const added = await gm.addMember(owner, gymId, { displayName: name, phone: who.phone, ...(months ? { membership: { packageId: pkg('month').id, startsOn: gm.today() } } : {}) });
  await gm.linkMember(owner, gymId, added.member.id, who);
  return { who, member: added.member };
}

describe('M27 visits: check-out and the live count', () => {
  it('the desk checks out; a second entrance scan after the minimum checks out; the job closes stale visits; the feed goes to the desk', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
    const g = gm.manage(owner, gym.id);
    const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['attendance.mark', 'members.view']);
    const a = await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    const inRes = (await g.post('/checkins', { memberId: a.member.id }).expect(201)).body;
    expect((await g.get('/checkins').expect(200)).body).toMatchObject({ counted: 1, inGymNow: 1 });
    expect(realtime.emitted().filter((x) => x.name === 'gym.desk_feed').map((x) => x.userId).sort()).toEqual([owner.user.id, desk.user.id].sort());
    await backdate(inRes.attendanceId, 90 * 60000);
    const out = (await gm.manage(desk, gym.id).post(`/checkins/${inRes.attendanceId}/out`).expect(200)).body;
    expect(out).toMatchObject({ method: 'desk', visitMinutes: 90 });
    expect((await g.post(`/checkins/${inRes.attendanceId}/out`).expect(409)).body.code).toBe('GYM_VISIT_CLOSED');
    const day = (await g.get('/checkins').expect(200)).body;
    expect(day.inGymNow).toBe(0);
    expect(day.items[0]).toMatchObject({ visitMinutes: 90 });
    expect(await outbox('gym_attendance.exited')).toBe(1);

    // The entrance: a scan at once is a repeat; after the minimum visit it checks out.
    const { who, member } = await linkedMember(owner, gym.id, pkg);
    const token = (await g.get('/entrance-token').expect(200)).body.token;
    const first = (await me(who).post('/me/gym-checkins', { token }).expect(201)).body;
    expect(first.checkedOut).toBe(false);
    expect((await me(who).post('/me/gym-checkins', { token }).expect(200)).body).toMatchObject({ counted: false });
    const rows = await models.GymAttendance.findAll({ where: { memberId: member.id } });
    for (const r of rows) await backdate(r.id, 45 * 60000);
    const bye = (await me(who).post('/me/gym-checkins', { token }).expect(200)).body;
    expect(bye).toMatchObject({ checkedOut: true, visitMinutes: 45 });
    expect(await models.GymAttendanceExit.count({ where: { memberId: member.id } })).toBe(2);

    // Left open: the job closes it after the window, with no length.
    const c = await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    const open = (await g.post('/checkins', { memberId: c.member.id }).expect(201)).body;
    await backdate(open.attendanceId, 5 * HOUR);
    expect(await visits.closeStale()).toEqual({ closed: 1 });
    expect(await visits.closeStale()).toEqual({ closed: 0 });
    expect((await models.GymAttendanceExit.findOne({ where: { attendanceId: open.attendanceId } })).toJSON()).toMatchObject({ method: 'auto', visitMinutes: null });
    expect((await g.get('/overview').expect(200)).body.tiles.inGymNow).toBe(0);
  });
});

describe('M27 classes', () => {
  it('a class with weekly slots, bookings, the waitlist, cancelling, attendance, reminders, the timetable', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'standard' });
    const g = gm.manage(owner, gym.id);
    const trainer = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Coach Tania' }), ['classes.manage', 'members.view']);
    const tomorrow = gm.inDays(1);
    const dow = rules.dowOf(tomorrow);
    const k = (await g.post('/classes', { name: 'Morning HIIT', trainerUserId: trainer.user.id, capacity: 1, minutes: 45, room: 'Studio', slots: [{ dow, startTime: '06:30' }] }).expect(201)).body;
    expect(k).toMatchObject({ name: 'Morning HIIT', capacity: 1, trainer: { id: trainer.user.id, displayName: 'Coach Tania' }, slots: [{ dow, startTime: '06:30' }] });
    const stranger = await h.signupUser({ name: 'Not Staff' });
    expect((await g.post('/classes', { name: 'X', trainerUserId: stranger.user.id, capacity: 5, minutes: 30, slots: [] }).expect(422)).body.code).toBe('GYM_CLASS_TRAINER');
    const week = (await g.get(`/class-sessions?from=${gm.today()}&to=${gm.inDays(27)}`).expect(200)).body;
    expect(week.items.length).toBeGreaterThanOrEqual(3);
    const s = week.items.find((x) => x.localDate === tomorrow);
    expect(s).toMatchObject({ startsAt: `${tomorrow}T00:30:00.000Z`, capacity: 1, spaces: 1 });

    // Members book in the app: one place, then the waitlist; no membership → refused.
    const lima = await linkedMember(owner, gym.id, pkg, 'Lima Akter');
    const rafi = await linkedMember(owner, gym.id, pkg, 'Rafi Khan');
    const none = await linkedMember(owner, gym.id, pkg, 'No Package', false);
    const tt = (await me(lima.who).get(`/me/gym-classes?memberId=${lima.member.id}`).expect(200)).body;
    expect(tt.items.find((x) => x.id === s.id)).toMatchObject({ myBooking: null, spaces: 1 });
    const b1 = (await me(lima.who).post(`/me/gym-classes/${s.id}/book`, { memberId: lima.member.id }, true).expect(201)).body;
    expect(b1.status).toBe('booked');
    expect((await me(lima.who).post(`/me/gym-classes/${s.id}/book`, { memberId: lima.member.id }, true).expect(409)).body.code).toBe('GYM_CLASS_BOOKED');
    const b2 = (await me(rafi.who).post(`/me/gym-classes/${s.id}/book`, { memberId: rafi.member.id }, true).expect(201)).body;
    expect(b2.status).toBe('waitlisted');
    expect((await me(none.who).post(`/me/gym-classes/${s.id}/book`, { memberId: none.member.id }, true).expect(409)).body.code).toBe('GYM_MEMBERSHIP_NEEDED');
    await me(rafi.who).post(`/me/gym-classes/${s.id}/book`, { memberId: lima.member.id }, true).expect(404);

    // Lima cancels: Rafi is promoted and told.
    expect((await me(lima.who).post(`/me/gym-bookings/${b1.id}/cancel`).expect(200)).body.status).toBe('cancelled');
    expect(await outbox('gym_booking.promoted')).toBe(1);
    const detail = (await gm.manage(trainer, gym.id).get(`/class-sessions/${s.id}`).expect(200)).body;
    expect(detail.bookings.map((b) => [b.member.displayName, b.status])).toEqual([
      ['Lima Akter', 'cancelled'],
      ['Rafi Khan', 'booked'],
    ]);
    expect((await me(rafi.who).get(`/me/gym-bookings?memberId=${rafi.member.id}`).expect(200)).body.items[0]).toMatchObject({ status: 'booked', promoted: true });

    // The desk books Lima again (waitlist), the reminder goes once, then attendance after the start.
    expect((await gm.manage(trainer, gym.id).post(`/class-sessions/${s.id}/bookings`, { memberId: lima.member.id }, true).expect(201)).body.status).toBe('waitlisted');
    await models.GymClassSession.update({ startsAt: new Date(Date.now() + 30 * 60000), endsAt: new Date(Date.now() + 75 * 60000) }, { where: { id: s.id } });
    expect(await classesSvc.reminders()).toEqual({ sent: 1 });
    expect(await classesSvc.reminders()).toEqual({ sent: 0 });
    // Members cannot cancel inside the cutoff; the desk can until the start.
    expect((await me(rafi.who).post(`/me/gym-bookings/${b2.id}/cancel`).expect(409)).body.code).toBe('GYM_CLASS_CANCEL_CLOSED');
    await models.GymClassSession.update({ startsAt: new Date(Date.now() - 10 * 60000) }, { where: { id: s.id } });
    expect((await gm.manage(trainer, gym.id).post(`/class-sessions/${s.id}/bookings`, { memberId: none.member.id }, true).expect(409)).body.code).toBe('GYM_CLASS_STARTED');
    const marked = (await gm.manage(trainer, gym.id).post(`/class-sessions/${s.id}/attendance`, { attended: [rafi.member.id] }).expect(200)).body;
    expect(marked.status).toBe('done');
    expect(marked.bookings.find((b) => b.member.id === rafi.member.id).status).toBe('attended');

    // Cancelling another session tells everyone booked; retiring the class cancels the rest.
    const later = week.items.find((x) => x.localDate > tomorrow);
    await me(lima.who).post(`/me/gym-classes/${later.id}/book`, { memberId: lima.member.id }, true).expect(201);
    expect((await g.post(`/class-sessions/${later.id}/cancel`, { reason: 'Trainer is ill' }).expect(200)).body.status).toBe('cancelled');
    expect(await outbox('gym_class.session_cancelled')).toBe(1);
    await g.patch(`/classes/${k.id}`, { status: 'retired' }).expect(200);
    expect(await models.GymClassSession.count({ where: { classId: k.id, status: 'scheduled' } })).toBe(0);

    // The gym page timetable: a published gym only, no member data.
    await me(lima.who).get(`/gym/gyms/${gym.slug}/timetable`).expect(404);
    await models.Gym.update({ status: 'live', liveVersion: 1, liveSnapshot: { name: gym.name } }, { where: { id: gym.id } });
    const k2 = (await g.post('/classes', { name: 'Yoga', capacity: 20, minutes: 60, slots: [{ dow, startTime: '18:00' }] }).expect(201)).body;
    const pub = (await h.api().get(`${h.P}/gym/gyms/${gym.slug}/timetable`).expect(200)).body;
    expect(pub.enquiries).toBe(true);
    expect(pub.items.some((x) => x.name === 'Yoga' && x.spaces === 20)).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('Lima');
    void k2;
  });

  it('classes need the Standard plan', async () => {
    const { owner, gym } = await gm.privateGym({ tier: 'basic' });
    expect((await gm.manage(owner, gym.id).get('/classes').expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'classes', minTier: 'standard' });
  });
});

describe('M27 reward points', () => {
  it('check-ins, a streak, a referral, rewards redeemed at the desk, adjusting and expiry', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'standard' });
    const g = gm.manage(owner, gym.id);
    const cashier = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Cashier Mitu' }), ['members.view', 'rewards.redeem']);
    const { who, member } = await linkedMember(owner, gym.id, pkg);
    // Six days in a row already (written directly), then today's check-in completes a 7-day streak.
    for (let i = 6; i >= 1; i -= 1) {
      await models.GymAttendance.create({ gymId: gym.id, memberId: member.id, localDate: gm.inDays(-i), checkedInAt: new Date(Date.now() - i * 86400000), method: 'desk', counted: true, decision: 'allow', reasons: [] });
    }
    await g.post('/checkins', { memberId: member.id }).expect(201);
    await h.drainEvents();
    let pts = (await g.get(`/members/${member.id}/points`).expect(200)).body;
    expect(pts.balance).toBe(60); // 10 for the check-in + 50 streak bonus
    expect(pts.history.map((x) => x.kind).sort()).toEqual(['checkin', 'streak']);
    expect(await outbox('gym_points.earned')).toBe(1);

    // Rewards: the owner's list; the cashier redeems.
    const list = (await g.put('/rewards', { rewards: [{ title: '7 extra days', points: 50, kind: 'days', value: 7 }, { title: '৳200 off', points: 40, kind: 'discount', value: 20000 }] }).expect(200)).body.items;
    expect(list).toHaveLength(2);
    await gm.manage(cashier, gym.id).put('/rewards', { rewards: [] }).expect(403);
    const days = list.find((x) => x.kind === 'days');
    const off = list.find((x) => x.kind === 'discount');
    const before = await models.GymMembership.findOne({ where: { memberId: member.id, status: 'active' } });
    const r1 = (await gm.manage(cashier, gym.id).post(`/members/${member.id}/redeem`, { rewardId: days.id }, true).expect(201)).body;
    expect(r1).toMatchObject({ balance: 10, applied: { kind: 'days', days: 7, endsOn: rules.addDays(before.endsOn, 7) } });
    expect((await gm.manage(cashier, gym.id).post(`/members/${member.id}/redeem`, { rewardId: off.id }, true).expect(409)).body.code).toBe('GYM_POINTS_SHORT');
    await g.post(`/members/${member.id}/points/adjust`, { points: 100, note: 'Welcome gift' }).expect(200);
    // Money off needs something owed.
    const due = await models.GymDue.findOne({ where: { memberId: member.id } });
    if (due && due.status !== 'paid') await models.GymDue.update({ status: 'paid', paidPoisha: due.amountPoisha }, { where: { id: due.id } });
    expect((await gm.manage(cashier, gym.id).post(`/members/${member.id}/redeem`, { rewardId: off.id }, true).expect(409)).body.code).toBe('GYM_REWARD_NOTHING');
    await models.GymDue.update({ status: 'unpaid', paidPoisha: 0 }, { where: { id: due.id } });
    const r2 = (await gm.manage(cashier, gym.id).post(`/members/${member.id}/redeem`, { rewardId: off.id }, true).expect(201)).body;
    expect(r2.applied).toEqual({ kind: 'discount', waivedPoisha: 20000 });
    expect((await models.GymDue.findByPk(due.id)).waivedPoisha).toBe(20000);

    // A referral: the friend's first fee rewards the member who brought them.
    const friend = await gm.addMember(owner, gym.id, { displayName: 'Friend Faruk', membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    await g.post(`/members/${friend.member.id}/referral`, { referrerMemberId: member.id }).expect(200);
    expect((await g.post(`/members/${friend.member.id}/referral`, { referrerMemberId: member.id }).expect(409)).body.code).toBe('GYM_REFERRAL_EXISTS');
    await g.post(`/dues/${friend.due.id}/payments`, { amountPoisha: 100000, method: 'cash' }, true).expect(201);
    await h.drainEvents();
    pts = (await g.get(`/members/${member.id}/points`).expect(200)).body;
    expect(pts.history.some((x) => x.kind === 'referral' && x.points === 200)).toBe(true);

    // The member sees their own points; others' are not theirs.
    const mine = (await me(who).get(`/me/gym-points?memberId=${member.id}`).expect(200)).body;
    expect(mine).toMatchObject({ on: true, balance: pts.balance, earn: { perCheckin: 10, streakDays: 7 } });
    await me(who).get(`/me/gym-points?memberId=${friend.member.id}`).expect(404);

    // Expiry, first in first out: earned points past their date expire, less what was already spent.
    await models.sequelize.query('ALTER TABLE gym_point_entries DISABLE TRIGGER trg_gym_point_entries_append_only');
    await models.GymPointEntry.update({ expiresOn: gm.inDays(-1) }, { where: { memberId: member.id, kind: ['checkin', 'streak'] } });
    await models.sequelize.query('ALTER TABLE gym_point_entries ENABLE TRIGGER trg_gym_point_entries_append_only');
    const balance = await pointsSvc.balanceOf(member.id);
    expect(await pointsSvc.expire()).toEqual({ expired: 0 }); // 60 earned and due, 90 already spent
    expect(await pointsSvc.balanceOf(member.id)).toBe(balance);
  });
});

describe('M27 notices', () => {
  it('estimate, send to a segment, the daily cap, delivery in the app', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'standard' });
    const g = gm.manage(owner, gym.id);
    const { who } = await linkedMember(owner, gym.id, pkg);
    await gm.addMember(owner, gym.id, { displayName: 'By Email', email: 'by.email@example.test', membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    await gm.addMember(owner, gym.id, { displayName: 'No Contact', membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    expect((await g.post('/notices/estimate', { segment: { kind: 'active' } }).expect(200)).body).toMatchObject({ reach: { app: 1, email: 1 }, sentToday: 0, dailyCap: 3 });
    expect((await g.post('/notices/estimate', { segment: { kind: 'expired', days: 0 } }).expect(422)).body.code).toBe('GYM_NOTICE_SEGMENT');
    const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk No Notice' }), ['members.view']);
    expect((await gm.manage(desk, gym.id).post('/notices', { title: 'Hi', body: 'x', segment: { kind: 'active' } }, true).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    const n = (await g.post('/notices', { title: 'Closed on Friday', body: 'The gym is closed this Friday for cleaning.', segment: { kind: 'active' } }, true).expect(201)).body;
    expect(n).toMatchObject({ targetCount: 2, channels: ['in_app', 'push', 'email'] });
    await h.drainEvents();
    expect(await models.Notification.count({ where: { userId: who.user.id, code: 'GYM_NOTICE' } })).toBe(1);
    await g.post('/notices', { title: 'Two', body: 'b', segment: { kind: 'active' } }, true).expect(201);
    await g.post('/notices', { title: 'Three', body: 'c', segment: { kind: 'active' } }, true).expect(201);
    expect((await g.post('/notices', { title: 'Four', body: 'd', segment: { kind: 'active' } }, true).expect(429)).body.code).toBe('GYM_NOTICE_CAP');
    expect((await g.get('/notices').expect(200)).body).toMatchObject({ sentToday: 3 });
  });
});

describe('M27 enquiries and the exercise library', () => {
  it('a published gym takes enquiries (trap, limits); staff follow them up; the library is public', async () => {
    const { owner, gym } = await gm.privateGym({ tier: 'basic' });
    const g = gm.manage(owner, gym.id);
    const pub = (body, status) => h.api().post(`${h.P}/gym/gyms/${gym.slug}/enquiries`).send(body).expect(status);
    await pub({ name: 'Nadia', phone: '01711000111' }, 404); // not published yet
    await models.Gym.update({ status: 'live', liveVersion: 1, liveSnapshot: { name: gym.name } }, { where: { id: gym.id } });
    await pub({ name: 'Robot', phone: '01711000999', website: 'http://spam.example' }, 202);
    expect(await models.GymLead.count()).toBe(0);
    await pub({ name: 'Nadia', phone: '01711000111', message: 'Ladies batch?', bestTime: 'Evening' }, 202);
    await pub({ name: 'Nadia', phone: '+8801711000111' }, 202);
    expect((await pub({ name: 'Nadia', phone: '01711000111' }, 429)).body.code).toBe('RATE_LIMITED');
    expect(await outbox('gym_lead.received')).toBe(2);
    const row = await models.GymLead.findOne();
    expect(row.phoneEnc).not.toContain('1711000111');
    const list = (await g.get('/leads').expect(200)).body;
    expect(list.counts).toMatchObject({ new: 2 });
    expect(list.items[0]).toMatchObject({ phoneLast4: '0111' });
    expect(JSON.stringify(list)).not.toContain('01711000111');
    const lead = list.items.find((x) => x.message === 'Ladies batch?');
    expect((await g.post(`/leads/${lead.id}/reveal-phone`).expect(200)).body.phone).toBe('+8801711000111');
    await g.patch(`/leads/${lead.id}`, { status: 'contacted', note: 'Called, coming Saturday' }).expect(200);
    expect((await g.patch(`/leads/${lead.id}`, { status: 'joined' }).expect(422)).body.code).toBe('GYM_MEMBER_UNKNOWN');
    const m = await gm.addMember(owner, gym.id, { displayName: 'Nadia' });
    expect((await g.patch(`/leads/${lead.id}`, { status: 'joined', memberId: m.member.id }).expect(200)).body).toMatchObject({ status: 'joined', memberId: m.member.id });
    expect((await g.patch(`/leads/${lead.id}`, { status: 'lost' }).expect(409)).body.code).toBe('GYM_LEAD_STATE');

    const ex = (await h.api().get(`${h.P}/catalog/exercises`).expect(200)).body.items;
    expect(ex.length).toBeGreaterThanOrEqual(60);
    expect(ex.find((x) => x.key === 'push_up')).toMatchObject({ nameBn: 'পুশ-আপ', muscle: 'chest', stepsEn: expect.any(Array) });
  });
});
