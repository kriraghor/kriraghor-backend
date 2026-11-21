'use strict';

// M19 step 1 end to end: facts written from real M10/M06 events (FR-08), views refreshed (FR-10), the
// owner's dashboard (§6.2: revenue under v3, occupancy, bookings by source, charts adding up to the
// tiles, FR-06), the member's (§6.3), the platform overview (§6.4: GTV with venue money, fee revenue
// from the ledger, take rate, esports), idempotency, the nightly reconcile (FR-09), RBAC (Q104),
// "Needs your action" (FR-11) and CSV exports (FR-22, FR-23).
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const facts = require('../../src/modules/analytics/facts.service');
const esportsFacts = require('../../src/modules/esports/esports.facts');
const { owner, liveGround, moveTo } = require('../fixtures/bookings');

const { api, P, models } = h;
const HALF = 30 * 60 * 1000;
let seq = 0;
const key = (p) => `${p}-${Date.now()}-${(seq += 1)}`;
const slot = (days = 1, plusHalfHours = 0) => new Date(Math.ceil((Date.now() + days * 86400000) / HALF) * HALF + plusHalfHours * HALF).toISOString();

let master;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  await facts.refreshViews();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

async function book(m, g, { start = slot(), payment = 'advance', minutes = 60 } = {}) {
  const r = await api().post(`${P}/bookings/holds`).set(h.bearer(m)).set('Idempotency-Key', key('hold')).send({ groundId: g.id, courtIds: [g.courts[0]], start, minutes, payment }).expect(201);
  await h.payWithSimulator(m, r.body.payment.id);
  await h.drainEvents();
  return models.Booking.findByPk(r.body.booking.id);
}

async function settle() {
  await h.drainEvents({ rounds: 10 });
  await facts.refreshViews();
}

let emp = 0;
async function staffWith(permissions) {
  emp += 1;
  const s = await h.signupUser({ name: 'Analyst' });
  await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'staff.write')).send({ userId: s.user.id, employeeId: `KG-A-${emp}`, permissions }).expect(201);
  return h.signInStaff(s.phone, s.user.id);
}

describe('M19 dashboards from real events (v3 money)', () => {
  it('owner, member and platform numbers follow a played booking and a member cancel', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser({ name: 'Rafi Ahmed' });

    // ৳2,000 booking, ৳500 advance: played (checked in) today.
    let b1 = await book(m, g);
    b1 = await moveTo(b1, new Date());
    await api().post(`${P}/me/ground-bookings/${b1.id}/check-in`).set(h.bearer(o)).expect(200);
    // A second one tomorrow, cancelled by the member: the ৳500 advance is kept.
    const b2 = await book(m, g, { start: slot(1, 6) });
    await api().post(`${P}/me/bookings/${b2.id}/cancel`).set(h.bearer(m)).send({ expectedRefund: 0 }).expect(200);
    await settle();

    const fact = await models.KpiFactBooking.findByPk(b1.id);
    expect(fact).toMatchObject({ status: 'checked_in', earnedPoisha: 200000, onlinePoisha: 50000, feePoisha: 10000 });
    expect((await models.KpiFactBooking.findByPk(b2.id)).earnedPoisha).toBe(50000);

    const d = (await api().get(`${P}/me/dashboard?role=ground_owner&period=7w`).set(h.bearer(o)).expect(200)).body;
    expect(d.asOf).toBeTruthy();
    expect(d.buckets).toHaveLength(7);
    const thisWeek = d.tiles.revenue.spark[6];
    expect(thisWeek).toBe(d.tiles.revenue.value);
    // b1 today earns ৳2,000; b2 earns ৳500 if its Dhaka day is in this week (late in the evening the
    // slot 27 h ahead falls two days later, so read its real start).
    const b2Day = new Date(new Date(b2.startAt).getTime() + 6 * 3600000).toISOString().slice(0, 10);
    const b2SameWeek = d.buckets[6].to > b2Day;
    expect(d.tiles.revenue.value).toBe(b2SameWeek ? 250000 : 200000);
    expect(d.tiles.bookings.value).toBe(1); // the cancelled one is not counted
    expect(d.tiles.bookings.note).toEqual({ app: 1, walkIn: 0, series: 0 });
    // FR-06: the charts add up to their tiles.
    expect(d.charts.bookingsByDay.reduce((n, x) => n + x.value, 0)).toBe(d.tiles.bookings.value);
    expect(d.charts.revenueByGround.reduce((n, x) => n + x.value, 0)).toBe(d.tiles.revenue.value);
    expect(d.charts.weeklyRevenue.points[6].value).toBe(d.tiles.revenue.value);
    expect(d.charts.busiestHours.reduce((n, x) => n + x.hours, 0)).toBe(1); // one hour played (it may span two clock hours)
    // Occupancy: 2 booked half-hours of 48 open today (court open around the clock).
    const occ = await models.KpiFactCourtDay.findOne({ where: { courtId: g.courts[0], day: new Date(Date.now() + 6 * 3600000).toISOString().slice(0, 10) } });
    expect(occ).toMatchObject({ openHh: 48, bookedHh: 2 });
    expect(d.tiles.occupancy.value).toBeGreaterThan(0);
    expect(d.definitions.revenue).toMatch(/before the Kriraghor fee/);

    // 30 days (dashboards round 2): one bucket a day; the tiles and the by-day bars cover the whole 30 days.
    const d30 = (await api().get(`${P}/me/dashboard?role=ground_owner&period=30d`).set(h.bearer(o)).expect(200)).body;
    expect(d30.period).toBe('30d');
    expect(d30.buckets).toHaveLength(30);
    const today30 = d30.buckets[29].from;
    expect(d30.tiles.revenue.value).toBe(b2Day <= today30 ? 250000 : 200000);
    expect(d30.tiles.revenue.spark).toHaveLength(30);
    expect(d30.tiles.revenue.spark.reduce((n, x) => n + x, 0)).toBe(d30.tiles.revenue.value);
    expect(d30.charts.bookingsByDay).toHaveLength(30);
    expect(d30.charts.bookingsByDay.reduce((n, x) => n + x.value, 0)).toBe(d30.tiles.bookings.value);
    expect(d30.charts.revenueByGround.reduce((n, x) => n + x.value, 0)).toBe(d30.tiles.revenue.value);
    expect(d30.charts.weeklyRevenue.points).toHaveLength(30);

    const me = (await api().get(`${P}/me/dashboard?period=7w`).set(h.bearer(m)).expect(200)).body;
    expect(me.tiles.spent.value).toBe(100000); // two ৳500 advances paid online
    expect(me.charts.whereItWent).toEqual([{ vertical: 'grounds', value: 100000 }]);

    const p = (await api().get(`${P}/admin/analytics/overview?period=7w`).set(h.bearer(master)).expect(200)).body;
    // Fee revenue from the ledger: ৳100 at check-in + ৳25 on the kept advance.
    expect(p.tiles.feeRevenue.value).toBe(12500);
    expect(p.tiles.gtv.note.online).toBe(100000);
    expect(p.tiles.takeRate.value).toBe(0.125);
    expect(p.tiles.verifiedMembers.value).toBeGreaterThanOrEqual(1);
  });

  it('replays change nothing; the nightly reconcile repairs a missing fact and logs drift (FR-08, FR-09)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    const b = await book(m, g);
    await settle();
    const before = (await models.KpiFactBooking.findByPk(b.id)).toJSON();
    await facts.refreshBooking(b.id);
    expect((await models.KpiFactBooking.findByPk(b.id)).toJSON()).toMatchObject({ earnedPoisha: before.earnedPoisha, status: before.status });
    // An older version never overwrites a newer one.
    expect(await facts.upsertBooking({ ...(await require('../../src/modules/bookings/bookings.reads').bookingFact(b.id)), sourceVersion: 1, status: 'expired' })).toBe(false);
    expect((await models.KpiFactBooking.findByPk(b.id)).status).toBe('confirmed');

    await models.KpiFactBooking.destroy({ where: { bookingId: b.id } });
    const r = await facts.reconcile();
    expect(r.repaired).toBeGreaterThanOrEqual(1);
    expect(await models.KpiFactBooking.findByPk(b.id)).not.toBeNull();
    expect(await models.KpiDrift.count({ where: { dataset: 'booking', recordId: b.id } })).toBe(1);
  });

  it('esports entries and prizes reach the platform overview', async () => {
    const t = '01a14a00-0000-7000-8000-000000000001';
    const game = '01a14a00-0000-7000-8000-000000000002';
    jest.spyOn(esportsFacts, 'entryFact').mockResolvedValue({ registrationId: '01a14a00-0000-7000-8000-000000000003', tournamentId: t, userId: master.user.id, confirmedAt: new Date(), paid: true });
    jest.spyOn(esportsFacts, 'tournamentFact').mockResolvedValue({ tournamentId: t, gameId: game, finalisedAt: new Date(), awards: 3, paid: 150000, subsidy: 0, revenue: 30000 });
    await facts.refreshEntry('01a14a00-0000-7000-8000-000000000003');
    await facts.refreshTournament(t);
    await facts.refreshViews();
    const p = (await api().get(`${P}/admin/analytics/overview?period=7w`).set(h.bearer(master)).expect(200)).body;
    expect(p.tiles.esportsEntries.value).toBe(1);
    expect(p.tiles.prizesPaid.value).toBe(150000);
    jest.restoreAllMocks();
  });
});

describe('M19 access, actions and exports', () => {
  it('roles are checked on the server; staff need view_analytics (Q104)', async () => {
    const m = await h.signupUser();
    expect((await api().get(`${P}/me/dashboard?role=ground_owner`).set(h.bearer(m)).expect(403)).body.code).toBe('ROLE_REQUIRED');
    expect((await api().get(`${P}/me/dashboard?period=week`).set(h.bearer(m)).expect(422)).body.code).toBe('VALIDATION_FAILED');
    const plain = await staffWith(['approve_listings']);
    expect((await api().get(`${P}/admin/analytics/overview`).set(h.bearer(plain)).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    const analyst = await staffWith(['view_analytics']);
    await api().get(`${P}/admin/analytics/overview?period=qtr`).set(h.bearer(analyst)).expect(200);
    expect((await api().get(`${P}/kpis/take_rate/definition?locale=bn`).expect(200)).body.text).toContain('÷');
    await api().get(`${P}/kpis/nope/definition`).expect(404);
  });

  it('needs your action: check-ins due and holds to pay (FR-11)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    await moveTo(await book(m, g), new Date());
    const owned = (await api().get(`${P}/me/dashboard/actions?role=ground_owner`).set(h.bearer(o)).expect(200)).body;
    expect(owned.items).toEqual([expect.objectContaining({ key: 'check_in_due', count: 1, href: '/vendor/bookings' })]);
    await api().post(`${P}/bookings/holds`).set(h.bearer(m)).set('Idempotency-Key', key('hold')).send({ groundId: g.id, courtIds: [g.courts[0]], start: slot(2), minutes: 60, payment: 'advance' }).expect(201);
    const mine = (await api().get(`${P}/me/dashboard/actions`).set(h.bearer(m)).expect(200)).body;
    expect(mine.items.map((x) => x.key)).toContain('hold_to_pay');
    await api().get(`${P}/me/dashboard/actions?role=ground_owner`).set(h.bearer(m)).expect(403);
    const staff = (await api().get(`${P}/admin/analytics/actions`).set(h.bearer(master)).expect(200)).body;
    expect(Array.isArray(staff.items)).toBe(true);
  });

  it('CSV exports: scoped, with a BOM, audited and limited per hour (FR-22, FR-23)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const m = await h.signupUser();
    // About an hour from now, so the booking is in this week's export even on a Sunday (tomorrow is next week).
    const b = await book(m, g, { start: slot(0, 2) });
    await settle();
    const csv = await api().get(`${P}/me/dashboard/export?dataset=owner_bookings&period=7w`).set(h.bearer(o)).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain(b.code);
    expect(csv.text).toContain('"2000.00"');
    expect(await models.AuditLog.count({ where: { action: 'analytics.exported' } })).toBe(1);
    await api().get(`${P}/me/dashboard/export?dataset=owner_bookings`).set(h.bearer(m)).expect(403);
    const mine = await api().get(`${P}/me/dashboard/export?dataset=member_payments`).set(h.bearer(m)).expect(200);
    expect(mine.text).toContain('"500.00"');
    await h.setSettingForTest('analytics.exports_per_hour', 1);
    expect((await api().get(`${P}/me/dashboard/export?dataset=member_payments`).set(h.bearer(m)).expect(429)).body.code).toBe('EXPORT_LIMIT');
    const daily = await api().get(`${P}/admin/analytics/export?dataset=platform_daily&period=7w`).set(h.bearer(master)).expect(200);
    expect(daily.text.split('\r\n')[0]).toContain('online_gmv_taka');
  });
});
