'use strict';

// M24 trial visits (product owner, 9 Nov 2026; M24-FR-109..120), end to end: the gym's visit settings and
// the plan tier, the public slots, booking within the gym's rules (switched on, own gym, hours, the days
// ahead, visits per person, the daily cap), the guest's QR and code at the desk, check-in, the audited phone,
// making the guest a member (source desk, so no referral fee), cancelling from either side, the morning job
// (no-shows, the gym's guests-today list, the guest's reminder) and the notices.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const realtime = require('../../src/common/realtime');
const gm = require('../fixtures/gym-manage');
const guests = require('../../src/modules/gym-manage/guests.service');
const rules = require('../../src/modules/gym-manage/gym-manage.rules');

const { models } = h;
const HOURS = { hours: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, openTime: '06:00', closeTime: '22:00', womenOnly: false })) };

beforeEach(async () => {
  await h.resetDb();
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
const book = (who, body) => me(who).post('/me/gym-visits', body, true);

/** A published gym open 06:00–22:00 every day, on a plan tier. */
async function liveGym(tier = 'basic', opts = {}) {
  const made = await gm.privateGym({ tier, ...opts });
  await models.Gym.update({ status: 'live', liveVersion: 1, liveSnapshot: { name: made.gym.name, ...HOURS } }, { where: { id: made.gym.id } });
  const slug = (await models.Gym.findByPk(made.gym.id)).slug;
  return { ...made, slug };
}

describe('M24 trial visits', () => {
  it('settings, slots, booking rules, the desk check-in by code and QR, the phone, make member, cancelling', async () => {
    const { owner, gym, slug } = await liveGym('basic');
    const g = gm.manage(owner, gym.id);
    const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['attendance.mark']);
    const ana = await h.signupUser({ name: 'Guest Ana' });
    const bo = await h.signupUser({ name: 'Guest Bo' });
    const cy = await h.signupUser({ name: 'Guest Cy' });
    const tomorrow = gm.inDays(1);
    const slot = { gymId: gym.id, date: tomorrow, arriveAt: '18:00' };

    // Off by default (M24-FR-109): the page shows nothing and a booking is refused.
    expect((await h.api().get(`${h.P}/gym/gyms/${slug}/visit-slots`).expect(200)).body).toEqual({ open: false, note: null, days: [] });
    expect((await book(ana, slot).expect(409)).body.code).toBe('GYM_VISITS_CLOSED');

    // The owner switches visits on: a daily cap of 2, one visit per person, a note; limits from the settings.
    expect((await g.patch('/settings', { visitDailyCap: 51 }).expect(422)).body.code).toBeDefined();
    expect((await g.patch('/settings', { visitPerPerson: 4 }).expect(422)).body.code).toBeDefined();
    await gm.manage(desk, gym.id).patch('/settings', { visitsOpen: true }).expect(403);
    const set = (await g.patch('/settings', { visitsOpen: true, visitDailyCap: 2, visitPerPerson: 1, visitNote: 'Bring a towel; ask for Rumi.' }).expect(200)).body;
    expect(set).toMatchObject({ visitsOpen: true, visitDailyCap: 2, visitPerPerson: 1, visitNote: 'Bring a towel; ask for Rumi.', visitDailyCapMax: 50, visitPerPersonMax: 3 });

    // The public slots (M24-FR-110): today and the 14 days ahead, each with its hours and places left.
    const slots = (await h.api().get(`${h.P}/gym/gyms/${slug}/visit-slots`).expect(200)).body;
    expect(slots).toMatchObject({ open: true, note: 'Bring a towel; ask for Rumi.', perPerson: 1 });
    expect(slots.days).toHaveLength(15);
    expect(slots.days.find((d) => d.date === tomorrow)).toMatchObject({ placesLeft: 2, windows: [{ openTime: '06:00', closeTime: '22:00', womenOnly: false }] });

    // Booking (M24-FR-111): confirmed at once, with the QR token and the code; the gym's own people cannot.
    expect((await book(owner, slot).expect(409)).body.code).toBe('GYM_VISIT_OWN_GYM');
    expect((await book(desk, slot).expect(409)).body.code).toBe('GYM_VISIT_OWN_GYM');
    expect((await book(ana, { ...slot, arriveAt: '23:00' }).expect(422)).body.code).toBe('GYM_VISIT_HOURS');
    expect((await book(ana, { ...slot, date: gm.inDays(20) }).expect(422)).body.code).toBe('GYM_VISIT_DATE');
    expect((await book(ana, { ...slot, date: gm.inDays(-1) }).expect(422)).body.code).toBe('GYM_VISIT_DATE');
    await me(ana).post('/me/gym-visits', slot).expect(400);
    const a = (await book(ana, slot).expect(201)).body.visit;
    expect(a).toMatchObject({ status: 'booked', date: tomorrow, arriveAt: '18:00', gym: { id: gym.id, slug } });
    expect(a.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(rules.looksLikeVisitToken(a.token)).toBe(true);
    expect(await outbox('gym_visit.booked')).toBe(1);

    // Visits per person and the daily cap.
    expect((await book(ana, { ...slot, date: gm.inDays(2) }).expect(409)).body).toMatchObject({ code: 'GYM_VISIT_LIMIT' });
    const b = (await book(bo, slot).expect(201)).body.visit;
    expect((await book(cy, slot).expect(409)).body.code).toBe('GYM_VISIT_FULL');

    // The gym's list (M24-FR-113): the name and the last 4 digits of the phone only.
    const day = (await gm.manage(desk, gym.id).get(`/visits?date=${tomorrow}`).expect(200)).body;
    expect(day).toMatchObject({ date: tomorrow, open: true, cap: 2, counts: { booked: 2, attended: 0 } });
    expect(day.items.find((x) => x.id === a.id).guest).toMatchObject({ userId: ana.user.id, name: 'Guest Ana' });
    expect(day.items.find((x) => x.id === a.id).guest.phoneLast4).toHaveLength(4);
    expect(JSON.stringify(day)).not.toContain(a.code);

    // Check-in (M24-FR-114): only on the day; found at the desk by the typed code or the QR.
    expect((await gm.manage(desk, gym.id).post(`/visits/${a.id}/check-in`).expect(409)).body.code).toBe('GYM_VISIT_NOT_TODAY');
    await models.GymVisit.update({ visitDate: gm.today() }, { where: { id: a.id } });
    const byCode = (await gm.manage(desk, gym.id).get(`/desk/search?q=${encodeURIComponent(a.code.toLowerCase())}`).expect(200)).body;
    expect(byCode.visit).toMatchObject({ id: a.id, status: 'booked' });
    const byQr = (await gm.manage(desk, gym.id).get(`/desk/search?q=${encodeURIComponent(a.token)}`).expect(200)).body;
    expect(byQr.visit.id).toBe(a.id);
    expect((await gm.manage(desk, gym.id).get(`/desk/search?q=${encodeURIComponent(`${a.token.slice(0, -4)}0000`)}`).expect(200)).body.visit ?? null).toBeNull();
    expect((await g.get('/overview').expect(200)).body.tiles.guestsToday).toBe(1);
    const came = (await gm.manage(desk, gym.id).post(`/visits/${a.id}/check-in`).expect(200)).body.visit;
    expect(came).toMatchObject({ id: a.id, status: 'attended' });
    expect((await gm.manage(desk, gym.id).post(`/visits/${a.id}/check-in`).expect(409)).body.code).toBe('GYM_VISIT_STATE');
    expect(await outbox('gym_visit.attended')).toBe(1);
    // The live desk hears the guest on its own event (desks built before visits only know gym.desk_feed).
    await new Promise((r) => setTimeout(r, 50));
    expect(realtime.emitted().filter((x) => x.name === 'gym.desk_guest' && x.userId === desk.user.id).length).toBe(1);
    expect(realtime.emitted().filter((x) => x.name === 'gym.desk_feed').length).toBe(0);
    expect((await me(ana).get('/me/gym-visits').expect(200)).body.items[0]).toMatchObject({ id: a.id, status: 'attended', code: null, token: null });

    // The phone (M24-FR-116): members.view only, no-store, audited.
    await gm.manage(desk, gym.id).post(`/visits/${a.id}/reveal-phone`).expect(403);
    const phone = await g.post(`/visits/${a.id}/reveal-phone`).expect(200);
    expect(phone.headers['cache-control']).toContain('no-store');
    expect(phone.body.phone.slice(-4)).toBe(day.items.find((x) => x.id === a.id).guest.phoneLast4);
    expect(await models.AuditLog.count({ where: { action: 'gym_visit.phone_revealed' } })).toBe(1);

    // Make member (M24-FR-117): linked, source desk (no Kriraghor referral fee); only once.
    await gm.manage(desk, gym.id).post(`/visits/${a.id}/convert`).expect(403);
    const made = (await g.post(`/visits/${a.id}/convert`).expect(201)).body.member;
    const member = await models.GymMember.findByPk(made.id);
    expect(member).toMatchObject({ gymId: gym.id, userId: ana.user.id, source: 'desk', displayName: 'Guest Ana' });
    expect((await models.GymVisit.findByPk(a.id)).memberId).toBe(made.id);
    expect((await g.post(`/visits/${a.id}/convert`).expect(409)).body.code).toBe('GYM_VISIT_STATE');
    expect(await outbox('gym_visit.converted')).toBe(1);

    // Cancelling (M24-FR-112, FR-115): the guest frees the place; the gym cancels with a reason.
    expect((await me(bo).post(`/me/gym-visits/${b.id}/cancel`).expect(200)).body.items[0]).toMatchObject({ id: b.id, status: 'cancelled', cancelledBy: 'guest' });
    expect((await me(bo).post(`/me/gym-visits/${b.id}/cancel`).expect(409)).body.code).toBe('GYM_VISIT_STATE');
    await me(cy).post(`/me/gym-visits/${b.id}/cancel`).expect(404);
    const c = (await book(cy, slot).expect(201)).body.visit;
    expect((await gm.manage(desk, gym.id).post(`/visits/${c.id}/cancel`, { reason: 'Closed for a private event' }).expect(200)).body.visit).toMatchObject({ status: 'cancelled', cancelledBy: 'gym' });
    expect((await me(cy).get('/me/gym-visits').expect(200)).body.items[0]).toMatchObject({ id: c.id, cancelledBy: 'gym', cancelReason: 'Closed for a private event', token: null });
    expect(await outbox('gym_visit.cancelled')).toBe(2);
    // A cancelled visit does not count against the person: Bo can book again.
    await book(bo, slot).expect(201);

    // The notices: the gym hears of each booking and of the guest's cancellation; the guest of the gym's.
    await h.drainEvents();
    const count = (code, userId) => models.Notification.count({ where: { code, ...(userId ? { userId } : {}) } });
    expect(await count('GYM_VISIT_BOOKED', owner.user.id)).toBe(4);
    expect(await count('GYM_VISIT_BOOKED', desk.user.id)).toBe(4);
    expect(await count('GYM_VISIT_CONFIRMED', ana.user.id)).toBe(1);
    expect(await count('GYM_VISIT_CANCELLED_BY_GUEST', owner.user.id)).toBe(1);
    expect(await count('GYM_VISIT_CANCELLED', cy.user.id)).toBe(1);
    expect(await count('GYM_VISIT_CANCELLED', bo.user.id)).toBe(0);
  });

  it('the morning job: no-shows, the guests-today list and the reminder, once each', async () => {
    const { owner, gym } = await liveGym('basic');
    const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['attendance.mark']);
    await gm.manage(owner, gym.id).patch('/settings', { visitsOpen: true, visitPerPerson: 2 }).expect(200);
    const ana = await h.signupUser({ name: 'Guest Ana' });
    const bo = await h.signupUser({ name: 'Guest Bo' });
    const old = (await book(ana, { gymId: gym.id, date: gm.inDays(1), arriveAt: '07:00' }).expect(201)).body.visit;
    const late = (await book(bo, { gymId: gym.id, date: gm.inDays(1), arriveAt: '21:30' }).expect(201)).body.visit;
    const early = (await book(ana, { gymId: gym.id, date: gm.inDays(2), arriveAt: '06:30' }).expect(201)).body.visit;
    const today = gm.today();
    await models.GymVisit.update({ visitDate: gm.inDays(-1) }, { where: { id: old.id } });
    await models.GymVisit.update({ visitDate: today }, { where: { id: [late.id, early.id] } });

    // Before the morning time only the no-shows.
    expect(await guests.daily(rules.visitStartAt(today, '05:00'))).toEqual({ lists: 0, reminders: 0, noShows: 1 });
    expect((await models.GymVisit.findByPk(old.id)).status).toBe('no_show');
    // After it: one list for the gym; a reminder only for the visit still ahead (06:30 has passed at 08:30).
    const at = rules.visitStartAt(today, '08:30');
    expect(await guests.daily(at)).toEqual({ lists: 1, reminders: 1, noShows: 0 });
    expect(await guests.daily(at)).toEqual({ lists: 0, reminders: 0, noShows: 0 });
    expect(await outbox('gym_visits.listed')).toBe(1);
    expect(await outbox('gym_visit.reminded')).toBe(1);
    await h.drainEvents();
    expect(await models.Notification.count({ where: { code: 'GYM_GUESTS_TODAY', userId: [owner.user.id, desk.user.id] } })).toBe(2);
    expect(await models.Notification.count({ where: { code: 'GYM_VISIT_REMINDER', userId: bo.user.id } })).toBe(1);
    expect(await models.Notification.count({ where: { code: 'GYM_VISIT_REMINDER', userId: ana.user.id } })).toBe(0);
    // A no-show counts against the person (2 used of 2).
    expect((await book(ana, { gymId: gym.id, date: gm.inDays(3), arriveAt: '10:00' }).expect(409)).body.code).toBe('GYM_VISIT_LIMIT');
  });

  it('Basic and up (M24-FR-120): a Free gym does not take visits; the list asks for Basic', async () => {
    const { owner, gym, slug } = await liveGym(null, { name: 'Free Gym', shortCode: 'FG' });
    await gm.manage(owner, gym.id).patch('/settings', { visitsOpen: true }).expect(200);
    expect((await h.api().get(`${h.P}/gym/gyms/${slug}/visit-slots`).expect(200)).body.open).toBe(false);
    expect((await gm.manage(owner, gym.id).get('/visits').expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'visits', minTier: 'basic' });
    expect((await gm.manage(owner, gym.id).get('/overview').expect(200)).body.tiles.guestsToday).toBeUndefined();
    const ana = await h.signupUser({ name: 'Guest Ana' });
    expect((await book(ana, { gymId: gym.id, date: gm.inDays(1), arriveAt: '10:00' }).expect(409)).body.code).toBe('GYM_VISITS_CLOSED');
    await h.api().get(`${h.P}/gym/gyms/no-such-gym/visit-slots`).expect(404);
  });
});
