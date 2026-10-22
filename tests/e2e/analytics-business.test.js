'use strict';

// M19 Round B2 end to end: numbers and reports for businesses (M19 §6.3, FR-01 to FR-12, FR-22,
// FR-23; M14 §4.1). Shop facts from real M13 events (sub-orders and lines) and the shop dashboard
// (Sales = Σ items, Orders, Average order = Sales / Orders, Repeat buyers; charts adding up to the
// tiles, FR-06); gym facts from real M20 events (passes and admissions) and the gym dashboard; the
// sports organiser's dashboard through M14's facade (membership checked, M06 escrow money) and its
// to-do provider; the new CSV exports (no buyer or holder data, capped, rate-limited, audited); the
// M14 registrations CSV (org admins only); the one-off backfill and the nightly reconcile.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const facts = require('../../src/modules/analytics/facts.service');
const orderReads = require('../../src/modules/orders/orders.reads');
const f = require('../fixtures/market');
const b = require('../fixtures/business');
const g = require('../fixtures/gym');

const { api, P, models } = h;

let master;
let reviewer;
let docsReviewer;

beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  reviewer = await f.staffWith(master, ['approve_listings', 'approve_documents']);
  docsReviewer = reviewer;
  await facts.refreshViews();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

async function settle() {
  await h.drainEvents({ rounds: 10 });
  await facts.refreshViews();
}

const dash = (who, q) => api().get(`${P}/me/dashboard?${q}`).set(h.bearer(who));
const exp = (who, dataset, period = '7w') => api().get(`${P}/me/dashboard/export?dataset=${dataset}&period=${period}`).set(h.bearer(who));
const sum = (xs, field = 'value') => xs.reduce((n, x) => n + x[field], 0);
const PERSONAL = (who) => [who.phone, who.user.id, b.SHIP.name, b.SHIP.phone, b.SHIP.line];

describe('M19 shop owner (§6.3 "Shop")', () => {
  it('facts from M13 events; Sales, Orders, Average order, Repeat buyers; charts add up (FR-06); conversion comes later', async () => {
    const shop = await b.bootShop(docsReviewer, reviewer);
    const tanvir = await h.signupUser({ name: 'Tanvir Hasan' });
    const nadia = await h.signupUser({ name: 'Nadia Islam' });
    const s1 = await b.paidOrder(tanvir, shop, ['42', '43']);
    const s2 = await b.paidOrder(tanvir, shop, ['44']);
    const s3 = await b.paidOrder(nadia, shop, ['40']);
    const s4 = await b.paidOrder(nadia, shop, ['41']);
    await b.shopPost(shop.owner, s1.id, 'accept').expect(200);
    await b.shopPost(shop.owner, s4.id, 'reject', { reason: 'out_of_stock' }).expect(200);
    await settle();

    // M19-FR-08: the facts are the sub-orders re-read through orders.reads (lines carry the category).
    const fact = await models.KpiFactSubOrder.findByPk(s1.id);
    expect(fact).toMatchObject({ status: 'accepted', units: 2, itemsPoisha: s1.itemsPoisha, sellerId: shop.owner.user.id, buyerId: tanvir.user.id });
    const lines = await models.KpiFactOrderLine.findAll({ where: { subOrderId: s1.id } });
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.categoryId && l.status === 'accepted')).toBe(true);
    expect((await models.KpiFactSubOrder.findByPk(s4.id)).status).toBe('rejected');

    const d = (await dash(shop.owner, 'role=shop_owner&period=7w').expect(200)).body;
    const counted = [s1, s2, s3].reduce((n, s) => n + s.itemsPoisha, 0);
    expect(d.role).toBe('shop_owner');
    expect(d.tiles.sales).toMatchObject({ value: counted, note: { items: 4 } });
    expect(d.tiles.orders.value).toBe(3); // the rejected one is not counted
    expect(d.tiles.averageOrder.value).toBe(Math.round(counted / 3));
    expect(d.tiles.repeatBuyers.value).toBe(0.5); // Tanvir twice, Nadia once (her rejected order does not count)
    expect(d.tiles.sales.spark[6]).toBe(d.tiles.sales.value);
    // FR-06: every split adds up to its tile.
    expect(sum(d.charts.ordersByDay)).toBe(d.tiles.orders.value);
    expect(sum(d.charts.salesByCategory)).toBe(d.tiles.sales.value);
    expect(d.charts.weeklySales.points[6].value).toBe(d.tiles.sales.value);
    expect(d.charts.weeklySales.lastYearShown).toBe(false);
    expect(d.charts.bestSellers).toEqual([expect.objectContaining({ productId: shop.product.id, units: 4, value: counted })]);
    expect(d.charts.salesByCategory[0].name).toBeTruthy();
    expect(d.comingLater).toEqual(['conversion', 'shopperFunnel']);
    expect(d.definitions.average_order).toMatch(/Sales divided by orders/);
    expect(d.definitions.conversion).toMatch(/Coming later/);

    // The role is checked on the server; a buyer cannot read the shop's numbers.
    expect((await dash(tanvir, 'role=shop_owner').expect(403)).body.code).toBe('ROLE_REQUIRED');
    const year = (await dash(shop.owner, 'role=shop_owner&period=yr').expect(200)).body;
    expect(year.tiles.sales.value).toBe(counted);
    expect(year.buckets).toHaveLength(12);

    // FR-22/23: the orders and sales-by-product CSVs: codes, products and money; no buyer data.
    const orders = await exp(shop.owner, 'shop_orders').expect(200);
    expect(orders.text.charCodeAt(0)).toBe(0xfeff);
    const rows = orders.text.slice(1).trim().split('\r\n');
    expect(rows[0]).toBe('"code","placed","status","items","items_taka","delivery_taka","commission_taka","refunded_taka"');
    expect(rows).toHaveLength(5); // every placed sub-order, the rejected one with its status
    for (const s of [s1, s2, s3, s4]) expect(orders.text).toContain(s.code);
    expect(orders.text).toContain('"rejected"');
    const byProduct = (await exp(shop.owner, 'shop_sales_by_product').expect(200)).text;
    expect(byProduct).toContain(`"4","${(counted / 100).toFixed(2)}"`);
    for (const text of [orders.text, byProduct]) for (const personal of [...PERSONAL(tanvir), ...PERSONAL(nadia)]) expect(text).not.toContain(personal);
    expect(await models.AuditLog.count({ where: { action: 'analytics.exported' } })).toBe(2);
    expect((await exp(tanvir, 'shop_orders').expect(403)).body.code).toBe('ROLE_REQUIRED');
    // The cap (export_sync_max_rows) and the per-hour limit (exports_per_hour).
    await h.setSettingForTest('analytics.export_sync_max_rows', 3);
    expect((await exp(shop.owner, 'shop_orders').expect(422)).body.code).toBe('EXPORT_TOO_LARGE');
    await h.setSettingForTest('analytics.export_sync_max_rows', 5000);
    await h.setSettingForTest('analytics.exports_per_hour', 2);
    expect((await exp(shop.owner, 'shop_orders').expect(429)).body.code).toBe('EXPORT_LIMIT');
  });
});

describe('M19 gym owner (§6.3 gym, Round B2)', () => {
  it('facts from M20 events; pass sales, passes by kind, admissions, unused share; charts add up; CSVs without holders', async () => {
    const { owner, gym } = await b.liveGym(docsReviewer, reviewer);
    const fahim = await h.signupUser({ name: 'Fahim Rahman' });
    const rina = await h.signupUser({ name: 'Rina Begum' });
    const day = await b.paidPass(fahim, gym, 'day');
    const month = await b.paidPass(rina, gym, 'month');
    const sumi = await h.signupUser({ name: 'Sumi Akter' });
    const unused = await b.paidPass(sumi, gym, 'day');
    await b.admit(owner, gym, day);
    await b.admit(owner, gym, month);
    await settle();

    expect(await models.KpiFactGymPass.findByPk(day.id)).toMatchObject({ status: 'redeemed', kind: 'day', pricePoisha: 40000, admissions: 1, ownerId: owner.user.id });
    expect(await models.KpiFactGymAdmission.count({ where: { ownerId: owner.user.id } })).toBe(2);
    // The unused day pass ends without a visit (the gym's closing-time expiry, simulated here).
    await models.GymPass.update({ status: 'expired', closedAt: new Date() }, { where: { id: unused.id } });
    await facts.refreshGymPass(unused.id);
    await facts.refreshViews();

    const d = (await dash(owner, 'role=gym_owner&period=7w').expect(200)).body;
    expect(d.role).toBe('gym_owner');
    expect(d.tiles.passSales.value).toBe(40000 + 450000 + 40000);
    expect(d.tiles.passesSold).toMatchObject({ value: 3, note: { day: 2, month: 1, quarter: 0 } });
    expect(d.tiles.admissions.value).toBe(2);
    expect(d.tiles.unusedShare.value).toBe(0.5); // two day passes ended today: one used, one never
    expect(sum(d.charts.admissionsByDay)).toBe(2);
    expect(sum(d.charts.salesByPackage)).toBe(d.tiles.passSales.value);
    expect(d.charts.salesByPackage.map((p) => [p.kind, p.passes])).toEqual([
      ['month', 1],
      ['day', 2],
    ]);
    expect(sum(d.charts.busiestHours, 'admissions')).toBe(2);
    expect(d.charts.sales.points[6].value).toBe(d.tiles.passSales.value);
    expect(d.definitions.unused_share).toMatch(/never used/);
    expect((await dash(fahim, 'role=gym_owner').expect(403)).body.code).toBe('ROLE_REQUIRED');

    const passes = (await exp(owner, 'gym_passes').expect(200)).text;
    for (const p of [day, month, unused]) expect(passes).toContain(p.code);
    expect(passes).toContain('"4500.00"');
    const admissions = await exp(owner, 'gym_admissions').expect(200);
    expect(admissions.text.slice(1).trim().split('\r\n')).toHaveLength(3);
    expect(admissions.text).toContain(day.code);
    for (const text of [passes, admissions.text]) for (const personal of [...PERSONAL(fahim), ...PERSONAL(rina), ...PERSONAL(sumi), 'Fahim Rahman', 'Rina Begum', 'Sumi Akter']) expect(text).not.toContain(personal);
    expect((await exp(fahim, 'gym_passes').expect(403)).body.code).toBe('ROLE_REQUIRED');
    // A dataset of another role is not available here.
    expect((await exp(owner, 'shop_orders').expect(403)).body.code).toBe('ROLE_REQUIRED');
  });
});

describe('M19 sports organiser (§6.3 "Organiser", M14 §4.1)', () => {
  it('members of the organisation only; teams of places, entry fees from escrow, matches; registrations over time; to-do', async () => {
    const { owner, org, t, caps } = await b.busyOrganiser(reviewer);
    const helper = await b.addOrgMember(owner, org.id, 'staff');
    const outsider = await h.signupUser({ name: 'Outsider' });
    await settle();

    const d = (await dash(owner, `role=organiser&orgId=${org.id}&period=7w`).expect(200)).body;
    expect(d.role).toBe('organiser');
    expect(d.organisation).toEqual({ id: org.id, name: org.name });
    expect(d.tiles.teams).toMatchObject({ value: 2, note: { maxTeams: 4, waiting: 1, unpaid: 1, reserve: 0 } });
    // Three ৳18,000 entry fees held in escrow (M06), none released yet.
    expect(d.tiles.entryFees).toMatchObject({ value: 3 * 1800000, note: { held: 3 * 1800000, released: 0, refunded: 0 } });
    expect(d.tiles.matchesPlayed).toMatchObject({ value: 0, note: { total: 0 } });
    expect(d.charts.registrationsOverTime[6]).toMatchObject({ registered: 4, approved: 2 });
    expect(sum(d.charts.registrationsOverTime, 'registered')).toBe(4);
    expect(d.charts.feesByEvent).toEqual([expect.objectContaining({ tournamentId: t.id, collected: 3 * 1800000, held: 3 * 1800000 })]);
    expect(JSON.stringify(d)).not.toMatch(new RegExp(caps.map((c) => c.user.id).join('|')));

    // Staff of the organisation see it too; anyone else gets 404 (M22-FR-03); orgId is required.
    await dash(helper, `role=organiser&orgId=${org.id}`).expect(200);
    expect((await dash(outsider, `role=organiser&orgId=${org.id}`).expect(404)).body.code).toBe('NOT_FOUND');
    expect((await dash(owner, 'role=organiser').expect(422)).body.code).toBe('VALIDATION_FAILED');

    // To-do (FR-11): admins approve; every member sees unpaid holds.
    const todo = (await api().get(`${P}/me/dashboard/actions?role=organiser`).set(h.bearer(owner)).expect(200)).body.items;
    expect(todo).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'registrations_waiting', count: 1, severity: 'high', href: `/vendor/tournaments/${org.id}` }),
        expect.objectContaining({ key: 'registrations_unpaid', count: 1, severity: 'low' }),
      ])
    );
    expect((await api().get(`${P}/me/dashboard/actions?role=organiser`).set(h.bearer(helper)).expect(200)).body.items.map((x) => x.key)).toEqual(['registrations_unpaid']);
    expect((await api().get(`${P}/me/dashboard/actions?role=organiser`).set(h.bearer(outsider)).expect(200)).body.items).toEqual([]);
  });

  it('M14 registrations CSV: org admins only; team, status, fees, dates, squad counts; names and NID yes/no with the roster; never phones or ids', async () => {
    const { owner, org, t, caps } = await b.busyOrganiser(reviewer);
    const helper = await b.addOrgMember(owner, org.id, 'staff');
    const outsider = await h.signupUser({ name: 'Outsider' });
    const url = (q = '') => `${P}/org/${org.id}/sports/tournaments/${t.id}/registrations.csv${q}`;

    const plain = await api().get(url()).set(h.bearer(owner)).expect(200);
    expect(plain.headers['content-type']).toMatch(/text\/csv/);
    expect(plain.headers['content-disposition']).toMatch(/registrations/);
    expect(plain.text.charCodeAt(0)).toBe(0xfeff);
    const rows = plain.text.slice(1).trim().split('\r\n');
    expect(rows[0]).toBe('"team","short_code","status","reserve_position","fee_taka","fee_waived","refunded_taka","registered","approved","squad_players","eligible_players","squad_ready"');
    expect(rows).toHaveLength(5);
    for (const c of caps) expect(plain.text).toContain(c.team.name);
    expect(plain.text).toContain('"18000.00"');
    const approvedRows = rows.filter((r) => r.split(',')[2] === '"approved"');
    expect(approvedRows).toHaveLength(2);
    expect(approvedRows.every((r) => r.split(',')[8].endsWith('+06:00"') && r.endsWith('"1","1","yes"'))).toBe(true);
    expect(plain.text).toContain('"pending_payment"');

    const roster = (await api().get(url('?include=roster')).set(h.bearer(owner)).expect(200)).text;
    expect(roster.slice(1).split('\r\n')[0]).toContain('"player","nid_verified"');
    expect(roster).toContain('"Rafi Ahmed","yes"');
    for (const c of caps) for (const personal of [c.phone, c.user.id, c.team.id]) expect(roster).not.toContain(personal);
    expect(roster).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/); // no ids at all
    expect(await models.AuditLog.count({ where: { action: 'tournament.registrations_exported', entityId: t.id } })).toBe(2);

    // Staff members and outsiders get 404 (the console hides other organisations, M22-FR-03).
    await api().get(url()).set(h.bearer(helper)).expect(404);
    await api().get(url()).set(h.bearer(outsider)).expect(404);
    await api().get(url('?include=everything')).set(h.bearer(owner)).expect(422);
    // The shared cap and per-hour limit (M19-FR-22/23).
    await h.setSettingForTest('analytics.export_sync_max_rows', 2);
    expect((await api().get(url()).set(h.bearer(owner)).expect(422)).body.code).toBe('EXPORT_TOO_LARGE');
    await h.setSettingForTest('analytics.export_sync_max_rows', 5000);
    await h.setSettingForTest('analytics.exports_per_hour', 2);
    expect((await api().get(url()).set(h.bearer(owner)).expect(429)).body.code).toBe('EXPORT_LIMIT');
  });
});

describe('M19 Round B2 facts: replays, the one-off backfill and the nightly reconcile (FR-08, FR-09)', () => {
  it('replays change nothing; an older version never wins; the backfill fills empty facts once; the reconcile repairs drift', async () => {
    const shop = await b.bootShop(docsReviewer, reviewer);
    const buyer = await h.signupUser({ name: 'Tanvir Hasan' });
    const s = await b.paidOrder(buyer, shop, ['42']);
    const { owner, gym } = await b.liveGym(docsReviewer, reviewer);
    const member = await h.signupUser({ name: 'Fahim Rahman' });
    const pass = await b.paidPass(member, gym, 'month', g.today());
    await b.admit(owner, gym, pass);
    await settle();

    // FR-08: a replay is harmless; an older read never overwrites a newer fact.
    const before = (await models.KpiFactSubOrder.findByPk(s.id)).toJSON();
    await facts.refreshSubOrder(s.id);
    expect((await models.KpiFactSubOrder.findByPk(s.id)).toJSON()).toMatchObject({ status: before.status, itemsPoisha: before.itemsPoisha });
    expect(await facts.upsertSubOrder({ ...(await orderReads.subOrderKpiFact(s.id)), sourceVersion: 1, status: 'cancelled' })).toBe(false);
    expect((await models.KpiFactSubOrder.findByPk(s.id)).status).toBe('placed');

    // The backfill: facts that never existed (as on the day of the migration) are filled once, not as drift.
    for (const m of [models.KpiFactSubOrder, models.KpiFactOrderLine, models.KpiFactGymPass, models.KpiFactGymAdmission, models.KpiProcessedEvent]) await m.destroy({ where: {} });
    const first = await facts.reconcile();
    expect(first.backfilled).toEqual({ subOrders: 1, passes: 1 });
    expect(first.repaired).toBe(0);
    expect(await models.KpiFactSubOrder.findByPk(s.id)).not.toBeNull();
    expect(await models.KpiFactOrderLine.count({ where: { subOrderId: s.id } })).toBe(1);
    expect(await models.KpiFactGymAdmission.count({ where: { passId: pass.id } })).toBe(1);
    expect(await models.KpiDrift.count()).toBe(0);
    expect((await facts.reconcile()).backfilled).toBeUndefined(); // once only

    // The nightly reconcile repairs a lost sub-order and a pass missing an admission, and logs drift.
    await models.KpiFactSubOrder.destroy({ where: { subOrderId: s.id } });
    await models.KpiFactGymAdmission.destroy({ where: { passId: pass.id } });
    const r = await facts.reconcile();
    expect(r.repaired).toBe(2);
    expect(await models.KpiFactSubOrder.findByPk(s.id)).not.toBeNull();
    expect(await models.KpiFactGymAdmission.count({ where: { passId: pass.id } })).toBe(1);
    expect(await models.KpiDrift.count({ where: { dataset: 'sub_order', recordId: s.id } })).toBe(1);
    expect(await models.KpiDrift.count({ where: { dataset: 'gym_pass', recordId: pass.id, vertical: 'gym' } })).toBe(1);
    const d = (await dash(shop.owner, 'role=shop_owner').expect(200)).body;
    expect(d.tiles.orders.value).toBe(1);
  });
});
