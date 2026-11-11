'use strict';

// M20 holidays and special hours (product owner, 11 Nov 2026; M20-FR-16 to FR-22), end to end: the owner's
// list, the checks and the preview, a holiday that closes the gym (open now, the public page, trial-visit
// slots and bookings, class sessions), special hours that replace the week's windows, removing one (its
// class sessions come back empty), and who may do it.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const gm = require('../fixtures/gym-manage');
const rules = require('../../src/modules/gym/gym.rules');

const { models } = h;
const HOURS = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, openTime: '06:00', closeTime: '22:00', womenOnly: false }));

beforeEach(async () => {
  await h.resetDb();
  await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const outbox = (name) => models.OutboxEvent.count({ where: { name } });
const as = (who) => ({
  get: (p) => h.api().get(`${h.P}${p}`).set(h.bearer(who)),
  post: (p, body = {}, ik = false) => {
    const r = h.api().post(`${h.P}${p}`).set(h.bearer(who));
    if (ik) r.set('Idempotency-Key', gm.key());
    return r.send(body);
  },
});
const pub = (p) => h.api().get(`${h.P}${p}`);

/** A published gym on the Standard plan (classes and trial visits), open 06:00–22:00 every day. */
async function liveGym() {
  const made = await gm.privateGym({ tier: 'standard' });
  await models.Gym.update(
    { status: 'live', liveVersion: 1, liveSnapshot: { name: made.gym.name, areaId: null, addressLine: 'Road 11, Banani', photos: [], packages: [], facilityIds: [], hours: HOURS } },
    { where: { id: made.gym.id } }
  );
  const slug = (await models.Gym.findByPk(made.gym.id)).slug;
  return { ...made, slug };
}

describe('M20 holidays and special hours', () => {
  it('the checks, the preview, a holiday that cancels a class and a trial visit, and removing it', async () => {
    const { owner, gym, slug } = await liveGym();
    const o = as(owner);
    const g = gm.manage(owner, gym.id);
    const base = `/me/gyms/${gym.id}/special-days`;
    const tomorrow = gm.inDays(1);
    const dayAfter = gm.inDays(2);

    // Nothing yet; the limits come from the settings (M20-FR-16).
    const empty = (await o.get(base).expect(200)).body;
    expect(empty).toMatchObject({ today: gm.today(), items: [], limits: { maxDays: 60, aheadDays: 365, maxActive: 30, publicDays: 30 } });

    // The checks: dates, a closed day without hours, changed hours with valid ones, a title.
    const closed = { fromOn: tomorrow, toOn: dayAfter, kind: 'closed', title: 'Eid-ul-Fitr' };
    expect((await o.post(base, { ...closed, fromOn: gm.inDays(-1) }).expect(422)).body).toMatchObject({ code: 'GYM_SPECIAL_DAY_DATES', reason: 'past' });
    expect((await o.post(base, { ...closed, fromOn: dayAfter, toOn: tomorrow }).expect(422)).body).toMatchObject({ code: 'GYM_SPECIAL_DAY_DATES', reason: 'order' });
    expect((await o.post(base, { ...closed, toOn: gm.inDays(61) }).expect(422)).body).toMatchObject({ code: 'GYM_SPECIAL_DAY_DATES', reason: 'too_long' });
    expect((await o.post(base, { ...closed, windows: [{ openTime: '10:00', closeTime: '12:00' }] }).expect(422)).body).toMatchObject({ code: 'GYM_SPECIAL_DAY_HOURS', reason: 'closed_has_windows' });
    expect((await o.post(base, { ...closed, kind: 'hours' }).expect(422)).body).toMatchObject({ code: 'GYM_SPECIAL_DAY_HOURS', reason: 'no_windows' });
    expect((await o.post(base, { ...closed, title: 'x' }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    expect(await models.GymSpecialDay.count()).toBe(0);

    // A class tomorrow morning with one member booked, and a guest's free visit tomorrow evening.
    const pkg = (await g.get('/packages').expect(200)).body.items.find((p) => p.kind === 'month');
    const rafi = await gm.addMember(owner, gym.id, { displayName: 'Rafi Ahmed', membership: { packageId: pkg.id, startsOn: gm.today() } });
    const klass = (await g.post('/classes', { name: 'Morning HIIT', capacity: 10, minutes: 45, slots: [{ dow: rules.dowOf(tomorrow), startTime: '06:30' }] }).expect(201)).body;
    const sessions = (await g.get(`/class-sessions?from=${gm.today()}&to=${gm.inDays(27)}`).expect(200)).body.items.filter((s) => s.classId === klass.id);
    const session = sessions.find((s) => s.localDate === tomorrow);
    expect(session).toBeDefined();
    await g.post(`/class-sessions/${session.id}/bookings`, { memberId: rafi.member.id }, true).expect(201);
    await g.patch('/settings', { visitsOpen: true }).expect(200);
    const ana = await h.signupUser({ name: 'Guest Ana' });
    const visit = (await as(ana).post('/me/gym-visits', { gymId: gym.id, date: tomorrow, arriveAt: '18:00' }, true).expect(201)).body.visit;

    // The preview counts what it would cancel and writes nothing (M20-FR-17).
    expect((await o.post(`${base}/preview`, closed).expect(200)).body).toEqual({ ok: true, affected: { classSessions: 1, visits: 1 } });
    expect(await models.GymSpecialDay.count()).toBe(0);
    expect(await outbox('gym_special_day.created')).toBe(0);

    // Saving it applies at once (M20-FR-16): audited, an event, and the gym is closed on both days.
    const made = (await o.post(base, closed).expect(201)).body;
    expect(made).toMatchObject({ gymId: gym.id, fromOn: tomorrow, toOn: dayAfter, kind: 'closed', windows: [], title: 'Eid-ul-Fitr', status: 'active', phase: 'upcoming' });
    expect(await outbox('gym_special_day.created')).toBe(1);
    expect(await models.AuditLog.count({ where: { action: 'gym.special_day_added', entityId: gym.id } })).toBe(1);
    expect((await o.get(base).expect(200)).body.items.map((x) => x.id)).toEqual([made.id]);

    // Trial visits (M20-FR-20): the closed days leave the slot list, a booking there is refused at once.
    const slots = (await pub(`/gym/gyms/${slug}/visit-slots`).expect(200)).body;
    expect(slots.days.map((d) => d.date)).not.toContain(tomorrow);
    expect(slots.days.map((d) => d.date)).not.toContain(dayAfter);
    expect(slots.days).toHaveLength(13);
    const bo = await h.signupUser({ name: 'Guest Bo' });
    expect((await as(bo).post('/me/gym-visits', { gymId: gym.id, date: tomorrow, arriveAt: '10:00' }, true).expect(422)).body.code).toBe('GYM_VISIT_HOURS');

    // The consumers: the booked visit and the class session are cancelled, and the people are told.
    await h.drainEvents();
    const gone = await models.GymVisit.findByPk(visit.id);
    expect(gone.toJSON()).toMatchObject({ status: 'cancelled', cancelBy: 'gym', cancelReason: 'The gym is closed: Eid-ul-Fitr' });
    expect(await models.OutboxEvent.count({ where: { name: 'gym_visit.cancelled', aggregateId: visit.id } })).toBe(1);
    const shut = await models.GymClassSession.findByPk(session.id);
    expect(shut.toJSON()).toMatchObject({ status: 'cancelled', cancelReason: 'The gym is closed: Eid-ul-Fitr', specialDayId: made.id });
    expect((await models.GymClassBooking.findOne({ where: { sessionId: session.id, memberId: rafi.member.id } })).status).toBe('cancelled');
    expect(await models.OutboxEvent.count({ where: { name: 'gym_class.session_cancelled', aggregateId: session.id } })).toBe(1);
    // A second delivery of the event changes nothing more.
    await h.drainEvents();
    expect(await models.OutboxEvent.count({ where: { name: 'gym_visit.cancelled', aggregateId: visit.id } })).toBe(1);

    // The public page lists it (M20-FR-19); today itself is not affected.
    const page = (await pub(`/gym/gyms/${slug}`).expect(200)).body;
    expect(page.specialDays).toEqual([{ id: made.id, fromOn: tomorrow, toOn: dayAfter, kind: 'closed', windows: [], title: 'Eid-ul-Fitr' }]);
    expect(page.specialToday).toBeNull();

    // No overlap, and only the owner (M20-FR-16).
    expect((await o.post(base, { ...closed, fromOn: dayAfter, toOn: gm.inDays(4), title: 'Repairs' }).expect(409)).body.code).toBe('GYM_SPECIAL_DAY_OVERLAP');
    const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['attendance.mark', 'classes.manage']);
    expect((await as(desk).post(base, { ...closed, fromOn: gm.inDays(10), toOn: gm.inDays(10) }).expect(403)).body.code).toBeDefined();
    expect((await as(desk).get(base).expect(403)).body.code).toBeDefined();

    // Removing it (M20-FR-21): the days open again, the class session comes back empty, the visit stays cancelled.
    expect((await o.post(`${base}/${made.id}/remove`).expect(200)).body).toMatchObject({ id: made.id, status: 'removed' });
    expect((await o.post(`${base}/${made.id}/remove`).expect(409)).body.code).toBe('GYM_SPECIAL_DAY_STATE');
    expect(await outbox('gym_special_day.removed')).toBe(1);
    expect(await models.AuditLog.count({ where: { action: 'gym.special_day_removed', entityId: gym.id } })).toBe(1);
    await h.drainEvents();
    expect((await models.GymClassSession.findByPk(session.id)).toJSON()).toMatchObject({ status: 'scheduled', cancelReason: null, specialDayId: null });
    expect((await models.GymClassBooking.findOne({ where: { sessionId: session.id, memberId: rafi.member.id } })).status).toBe('cancelled');
    expect((await models.GymVisit.findByPk(visit.id)).status).toBe('cancelled');
    expect((await pub(`/gym/gyms/${slug}/visit-slots`).expect(200)).body.days.map((d) => d.date)).toContain(tomorrow);
    expect((await pub(`/gym/gyms/${slug}`).expect(200)).body.specialDays).toEqual([]);
    expect((await o.get(`${base}?scope=past`).expect(200)).body.items.map((x) => [x.id, x.status])).toEqual([[made.id, 'removed']]);
    expect((await o.get(base).expect(200)).body.items).toEqual([]);
    expect(await models.GymSpecialDay.count()).toBe(1); // never deleted

    // Another gym's owner cannot touch it.
    const other = await gm.privateGym({ name: 'Other Gym', shortCode: 'OG' });
    expect((await as(other.owner).post(base, closed).expect(403)).body.code).toBe('NOT_OWNER');
  });

  it('closed today: the page says so; special hours replace the week for visits and classes', async () => {
    const { owner, gym, slug } = await liveGym();
    const o = as(owner);
    const g = gm.manage(owner, gym.id);
    const base = `/me/gyms/${gym.id}/special-days`;
    const today = gm.today();

    // A holiday today (M20-FR-19): not open now, whatever the hour, on the page and on the list card.
    const eid = (await o.post(base, { fromOn: today, toOn: today, kind: 'closed', title: 'Victory Day' }).expect(201)).body;
    expect(eid.phase).toBe('running');
    const page = (await pub(`/gym/gyms/${slug}`).expect(200)).body;
    expect(page).toMatchObject({ openNow: false, specialToday: { kind: 'closed', title: 'Victory Day' } });
    const card = (await pub('/gym/gyms').expect(200)).body.items.find((x) => x.id === gym.id);
    expect(card).toMatchObject({ openNow: false, specialToday: { kind: 'closed', title: 'Victory Day' } });

    // Special hours in five days: 10:00–14:00 only (M20-FR-18).
    const day = gm.inDays(5);
    const hours = { fromOn: day, toOn: day, kind: 'hours', windows: [{ openTime: '10:00', closeTime: '14:00' }], title: 'Ramadan timings' };
    await g.patch('/settings', { visitsOpen: true }).expect(200);
    const early = (await g.post('/classes', { name: 'Dawn run', capacity: 5, minutes: 30, slots: [{ dow: rules.dowOf(day), startTime: '06:30' }] }).expect(201)).body;
    const noon = (await g.post('/classes', { name: 'Noon stretch', capacity: 5, minutes: 30, slots: [{ dow: rules.dowOf(day), startTime: '11:00' }] }).expect(201)).body;
    const on = async (klass) => models.GymClassSession.findOne({ where: { classId: klass.id, localDate: day } });
    expect((await o.post(`${base}/preview`, hours).expect(200)).body.affected).toEqual({ classSessions: 1, visits: 0 });
    const made = (await o.post(base, hours).expect(201)).body;
    expect(made.windows).toEqual([{ openTime: '10:00', closeTime: '14:00', womenOnly: false }]);
    await h.drainEvents();
    expect((await on(early)).toJSON()).toMatchObject({ status: 'cancelled', cancelReason: 'The gym’s hours changed: Ramadan timings', specialDayId: made.id });
    expect((await on(noon)).status).toBe('scheduled');

    // Trial visits follow the special windows: 11:00 is fine, 18:00 is outside.
    const slot = (await pub(`/gym/gyms/${slug}/visit-slots`).expect(200)).body.days.find((d) => d.date === day);
    expect(slot.windows).toEqual([{ openTime: '10:00', closeTime: '14:00', womenOnly: false }]);
    const ana = await h.signupUser({ name: 'Guest Ana' });
    expect((await as(ana).post('/me/gym-visits', { gymId: gym.id, date: day, arriveAt: '18:00' }, true).expect(422)).body.code).toBe('GYM_VISIT_HOURS');
    await as(ana).post('/me/gym-visits', { gymId: gym.id, date: day, arriveAt: '11:00' }, true).expect(201);

    // A new class at a shut time gets no session that day; the daily job makes none either.
    const late = (await g.post('/classes', { name: 'Evening lift', capacity: 5, minutes: 30, slots: [{ dow: rules.dowOf(day), startTime: '18:00' }] }).expect(201)).body;
    expect(await on(late)).toBeNull();
    await require('../../src/modules/gym-ops/classes.service').sessionsAhead();
    expect(await on(late)).toBeNull();
    expect(await models.GymClassSession.count({ where: { classId: late.id } })).toBeGreaterThan(0);

    // The running holiday can still be removed; both stay in the table.
    await o.post(`${base}/${eid.id}/remove`).expect(200);
    expect((await pub(`/gym/gyms/${slug}`).expect(200)).body.specialToday).toBeNull();
    expect(await models.GymSpecialDay.count()).toBe(2);
  });
});
