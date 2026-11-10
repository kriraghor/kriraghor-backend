'use strict';

/**
 * The demo gym's own panel (M24 gym management, M27 gym operations, M24 §17 trial visits): one demo gym
 * (data.js GYM_PANEL) is run like a real one, so its owner, front desk, trainer and members sign in to
 * screens with content. Everything goes through the real routes as the person who would do it:
 *  - the owner picks the plan and the gym's settings, gives the front desk its permissions and adds a
 *    trainer; members join with packages and pay at the counter (backdated within gym_manage.backdate_days);
 *    four members are linked to demo accounts by the gym's invite, which they accept;
 *  - today's check-ins, a frozen membership, unpaid and part-paid dues, an open payment link;
 *  - the gym's books (expenses, the cash drawer, the counter shop and stock, sales, lockers), classes and
 *    bookings, rewards and points, a notice, enquiries from the gym page, staff shifts, clocking, pay terms
 *    and last month's payroll, the equipment register, a workout plan and a diet chart;
 *  - free trial visits booked by demo players, and a join request waiting for the owner.
 * No online payment is taken (counter money is bookkeeping only, M24-FR-34), so it suits both profiles.
 *
 * Re-running adds nothing that exists: each part is looked up first (by name, number or title in the gym's
 * own lists). The records are not listed one by one in demo_records: they belong to the demo gym, which is.
 * demo:hide suspends the owner, which pauses the gym and takes the staff's workplace away.
 */
const rt = require('../runtime');
const people = require('./people');
const D = require('../data');
const rules = require('../../../src/modules/gym-manage/gym-manage.rules');

const { models } = rt;
const G = D.GYM_PANEL;
const today = () => rules.dhakaDate(new Date());
const day = (n) => rules.addDays(today(), n);
const byName = (list, key = 'name') => new Map(list.map((x) => [x[key], x]));
const WEEK = [0, 1, 2, 3, 4, 6];

/** Everything the parts below need: the gym, its people and a request helper per person. */
async function context() {
  const gymId = await rt.marked('gym', `gym:${G.gym}`);
  const ownerUser = await models.User.findOne({ where: { phone: people.phoneOf(G.owner) } });
  if (!gymId || !ownerUser) return null;
  const owner = await people.member(G.owner, D.OWNERS.find((o) => o.n === G.owner).name);
  const gym = await models.Gym.findByPk(gymId, { attributes: ['id', 'slug', 'name', 'status'] });
  const base = `/manage/gyms/${gymId}`;
  const as = (a) => ({
    get: (p, o) => rt.get(a, `${base}${p}`, o),
    post: (p, b, o) => rt.post(a, `${base}${p}`, b, o),
    put: (p, b, o) => rt.put(a, `${base}${p}`, b, o),
    patch: (p, b, o) => rt.patch(a, `${base}${p}`, b, o),
  });
  return { gymId, gym, owner, o: as(owner), as };
}

/** Accept a known 4xx `code` (the thing exists already); anything else fails the run. */
function accept(res, codes, what) {
  if (res?.code && !codes.includes(res.code)) throw new Error(`${what}: ${res.code} ${res.detail ?? res.title ?? ''}`);
  return res;
}

// ---------------------------------------------------------------- the plan, settings and staff

async function plan({ owner, o }) {
  const billing = await rt.get(owner, '/manage/billing');
  if (billing.subscription.chosenTier !== G.tier) await rt.put(owner, '/manage/billing/tier', { tier: G.tier });
  const s = await o.get('/settings');
  await o.patch('/settings', {
    ...(s.setupDone ? {} : { shortCode: G.shortCode }),
    entryPolicy: 'warn',
    joinRequestsOpen: true,
    visitsOpen: true,
    visitDailyCap: 6,
    visitPerPerson: 1,
    visitNote: G.visitNote,
    receiptFooter: 'Thank you for training with us.',
  });
}

/** The front desk gets a receptionist's permissions; the trainer is added. → { [n]: { actor, staffId } } */
async function staff({ gymId, owner }) {
  const out = {};
  const q = new URLSearchParams({ businessType: 'gym', businessId: gymId, status: 'all' });
  for (const s of [G.frontDesk, G.trainer]) {
    const name = s.name ?? D.BUSINESS_STAFF.find((b) => b.n === s.n).name;
    const actor = await people.member(s.n, name);
    let team = (await rt.get(owner, `/me/team?${q}`)).items;
    let row = team.find((m) => m.member.id === actor.userId && m.status === 'active');
    if (!row && !team.some((m) => m.member.id === actor.userId)) {
      accept(await rt.post(owner, '/me/team', { businessType: 'gym', businessId: gymId, phone: people.phoneOf(s.n), permissions: s.permissions }, { ok: [409] }), ['ALREADY_MEMBER'], 'add staff');
      team = (await rt.get(owner, `/me/team?${q}`)).items;
      row = team.find((m) => m.member.id === actor.userId && m.status === 'active');
    }
    if (!row) continue; // removed by the owner: left as is
    const want = [...s.permissions].sort().join();
    if ([...row.permissions].sort().join() !== want) await rt.patch(owner, `/me/team/${row.id}`, { permissions: s.permissions });
    out[s.n] = { actor, staffId: row.id, name };
  }
  await rt.drain();
  return out;
}

// ---------------------------------------------------------------- members, fees and links

async function allMembers(o) {
  const items = [];
  let cursor;
  do {
    const page = await o.get(`/members?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/** Add one member with their package, counter payment and freeze; returns the member row. */
async function addMember(ctx, packages, m, { displayName, phone }) {
  const { o } = ctx;
  const pkg = m.pkg ? packages.find((p) => p.kind === m.pkg) : null;
  const made = await o.post(
    '/members',
    { displayName, phone, ...(m.gender ? { gender: m.gender } : {}), ...(pkg ? { membership: { packageId: pkg.id, startsOn: day(m.start) } } : {}) },
    { idem: true }
  );
  const due = made.due ?? null;
  if (due && m.pay && m.pay !== 'none') {
    const amountPoisha = m.pay === 'full' ? due.amountPoisha : m.pay;
    await o.post(`/dues/${due.id}/payments`, { amountPoisha, method: m.method ?? 'cash', paidOn: day(m.start) }, { idem: true });
  }
  if (m.freeze && made.membership) await o.post(`/memberships/${made.membership.id}/freeze`, { fromOn: day(m.freeze.from), toOn: day(m.freeze.to), reason: m.freeze.reason });
  return made.member;
}

/** → Map displayName → member (id, memberCode, linked). */
async function members(ctx) {
  const { o, owner, gymId } = ctx;
  const packages = (await o.get('/packages')).items ?? (await o.get('/packages')).packages;
  let have = byName(await allMembers(o), 'displayName');
  for (const [i, m] of G.members.entries()) {
    if (!have.has(m.name)) await addMember(ctx, packages, m, { displayName: m.name, phone: people.phoneOf(100 + i) });
  }
  const linked = [];
  for (const m of G.linked) {
    const name = [D.MEMBER, ...D.PLAYERS].find((p) => p.n === m.n).name;
    const actor = await people.member(m.n, name, m.n === D.MEMBER.n ? { username: D.MEMBER.username } : {});
    let row = have.get(name);
    if (!row) row = await addMember(ctx, packages, m, { displayName: name, phone: people.phoneOf(m.n) });
    linked.push({ ...m, name, actor, memberId: row.id });
    const full = await o.get(`/members/${row.id}`);
    if (!(full.member ?? full).linked) {
      // The gym invites the account by its phone; the member accepts (M24-FR-14, FR-15).
      accept(await o.post(`/members/${row.id}/invite`, { phone: people.phoneOf(m.n) }, { ok: [409] }), ['GYM_LINK_PENDING', 'GYM_ALREADY_LINKED'], 'invite');
      await rt.drain();
      const mine = (await rt.get(actor, '/me/gym-requests')).items.find((r) => r.status === 'pending' && r.gym?.id === gymId && r.direction !== 'join_request');
      if (mine) await rt.post(actor, `/me/gym-requests/${mine.id}/accept`);
    }
    if (m.health) await rt.put(actor, `/me/gym-memberships/${row.id}/health`, m.health, { ok: [403, 404, 409, 422] });
  }
  await rt.drain();
  have = byName(await allMembers(o), 'displayName');
  // A referral: the friend's first fee was paid when they were added, so this only records who sent them.
  for (const m of G.members.filter((x) => x.referredBy)) {
    accept(await o.post(`/members/${have.get(m.name).id}/referral`, { referrerMemberId: have.get(m.referredBy).id }, { ok: [409, 422] }), ['GYM_REFERRAL_EXISTS', 'VALIDATION_FAILED'], 'referral');
  }
  // One open payment link on an unpaid due (shown as a QR at the counter; nothing is sent or paid).
  const unpaid = G.members.find((x) => x.pay === 'none' && x.pkg);
  const dues = (await o.get(`/dues?memberId=${have.get(unpaid.name).id}`)).items;
  if (dues[0]) accept(await o.post(`/dues/${dues[0].id}/payment-links`, { channels: [] }, { idem: true, ok: [403, 409] }), ['GYM_PAY_LINK_OPEN', 'GYM_ONLINE_FEES_UNAVAILABLE'], 'payment link');
  void owner;
  return { have, linked };
}

async function checkIns({ o }, have) {
  const done = new Set((await o.get('/checkins')).items.map((c) => c.member.id));
  let first = null;
  for (const name of G.checkIns) {
    const m = have.get(name);
    if (!m || done.has(m.id)) continue;
    const r = await o.post('/checkins', { memberId: m.id }, { ok: [409] });
    first = first ?? r?.attendanceId ?? null;
  }
  if (first) await o.post(`/checkins/${first}/out`, {}, { ok: [409] });
}

// ---------------------------------------------------------------- trainer, plans

async function trainerAndPlans(ctx, team, { have, linked }) {
  const { o, as } = ctx;
  const t = team[G.trainer.n];
  if (!t) return;
  for (const m of [...G.members.filter((x) => x.trainer).map((x) => have.get(x.name)), ...linked.filter((x) => x.trainer).map((x) => ({ id: x.memberId }))]) {
    if (m) await o.put(`/members/${m.id}/trainer`, { businessMemberId: t.staffId });
  }
  const mine = as(t.actor);
  const plans = byName((await mine.get('/plans')).items, 'title');
  const ids = {};
  for (const [kind, p] of [['workout', G.workoutPlan], ['diet', G.dietChart]]) {
    ids[kind] = plans.get(p.title)?.id ?? (await mine.post('/plans', { kind, title: p.title, isTemplate: true, content: p.content })).id;
  }
  for (const m of linked.filter((x) => x.plans)) {
    const has = new Set(((await mine.get(`/members/${m.memberId}/plans`)).items ?? []).filter((a) => a.status === 'active').map((a) => a.kind));
    for (const kind of ['workout', 'diet']) {
      if (!has.has(kind)) await mine.post(`/plans/${ids[kind]}/assign`, { memberIds: [m.memberId], startsOn: day(-2) });
    }
  }
}

// ---------------------------------------------------------------- the gym's books (M27 round 1)

async function books({ o }, have) {
  // Expenses: only when the month has none of ours yet (looked up by payee).
  const cats = byName((await o.get('/expense-categories')).items, 'key');
  const spent = new Set((await o.get(`/expenses?from=${day(-30)}&to=${today()}`)).items.map((e) => e.payee));
  for (const e of G.expenses) {
    if (spent.has(e.payee)) continue;
    await o.post('/expenses', { categoryId: cats.get(e.category).id, amountPoisha: e.amount, spentOn: day(-e.daysAgo), method: e.method, payee: e.payee, ...(e.note ? { note: e.note } : {}) }, { idem: true });
  }
  accept(await o.post('/cash-drawer/open', { openingPoisha: G.drawerOpening }, { ok: [409] }), ['GYM_DRAWER_OPEN', 'GYM_DRAWER_CLOSED'], 'cash drawer');

  // The counter shop: products with their first stock, then today's sales (once a day).
  let products = byName((await o.get('/products')).items);
  for (const p of G.products) {
    if (products.has(p.name)) continue;
    const made = await o.post('/products', {
      name: p.name,
      category: p.category,
      pricePoisha: p.price,
      costPoisha: p.cost,
      reorderLevel: p.reorder,
      ...(p.importer ? { importer: p.importer } : {}),
    });
    await o.post(`/products/${made.id}/stock`, { kind: 'in', qty: p.stock, unitCostPoisha: p.cost, ...(p.batchNo ? { batchNo: p.batchNo, expiresOn: day(p.expiresInDays) } : {}) }, { idem: true });
  }
  products = byName((await o.get('/products')).items);
  const soldToday = (await o.get(`/sales?from=${today()}&to=${today()}`)).items.filter((s) => s.kind === 'pos').length;
  if (!soldToday) {
    for (const s of G.sales) {
      const lines = s.lines.map(([name, qty]) => ({ productId: products.get(name).id, qty }));
      await o.post('/sales', { lines, method: s.method, ...(s.member ? { memberId: have.get(s.member)?.id } : {}) }, { idem: true, ok: [409, 422] });
    }
  }

  // Lockers: ten in the changing room, three rented (one with the fee still to take).
  let lockers = byName((await o.get('/lockers')).items, 'number');
  if (!lockers.size) {
    await o.post('/lockers', { numbers: G.lockers.numbers, zone: G.lockers.zone, size: 'medium', monthlyFeePoisha: G.lockers.monthlyFee });
    lockers = byName((await o.get('/lockers')).items, 'number');
    for (const [number, member, days, method] of G.lockers.rented) {
      await o.post(`/lockers/${lockers.get(number).id}/rent`, { memberId: have.get(member).id, endsOn: day(days), ...(method ? { collect: { method } } : {}) }, { idem: true });
    }
  }
}

// ---------------------------------------------------------------- classes, points, notices, enquiries (round 2)

async function engage({ o, gym }, team, { have, linked }) {
  const trainer = team[G.trainer.n];
  const classes = byName((await o.get('/classes')).items);
  for (const c of G.classes) {
    if (classes.has(c.name)) continue;
    await o.post('/classes', { name: c.name, description: c.description, capacity: c.capacity, minutes: c.minutes, room: c.room, ...(trainer ? { trainerUserId: trainer.actor.userId } : {}), slots: c.days.map((dow) => ({ dow, startTime: c.time })) });
  }
  // The linked members book the next sessions (at the desk, so no gate depends on the clock).
  const sessions = (await o.get(`/class-sessions?from=${today()}&to=${day(7)}`)).items.filter((s) => s.status === 'scheduled' && new Date(s.startsAt) > new Date(Date.now() + 3600000));
  for (const [i, s] of sessions.slice(0, 4).entries()) {
    for (const m of linked.slice(0, 2 + (i % 2))) accept(await o.post(`/class-sessions/${s.id}/bookings`, { memberId: m.memberId }, { idem: true, ok: [409, 422] }), ['GYM_CLASS_BOOKED', 'GYM_CLASS_FULL', 'GYM_MEMBERSHIP_NEEDED', 'GYM_CLASS_STARTED'], 'class booking');
  }

  if (!(await o.get('/rewards')).items.length) await o.put('/rewards', { rewards: G.rewards });
  for (const m of linked.slice(0, 2)) {
    const pts = await o.get(`/members/${m.memberId}/points`);
    if (!pts.history.some((h) => h.kind === 'adjust')) await o.post(`/members/${m.memberId}/points/adjust`, G.welcomePoints);
  }

  if (!(await o.get('/notices')).items.length) await o.post('/notices', G.notice, { idem: true, ok: [422, 429] });

  if (gym.status === 'live' && !(await o.get('/leads')).items.length) {
    for (const e of G.enquiries) await rt.post(null, `/gym/gyms/${gym.slug}/enquiries`, { name: e.name, phone: people.phoneOf(e.phoneN).replace('+880', '0'), message: e.message, bestTime: e.bestTime }, { ok: [404, 429] });
    const first = (await o.get('/leads')).items.at(-1);
    if (first) await o.patch(`/leads/${first.id}`, { status: 'contacted', note: 'Called back; visiting on Saturday.' }, { ok: [409] });
  }
  void have;
}

// ---------------------------------------------------------------- staff, payroll, equipment (round 3)

async function work({ o }, team) {
  for (const [n, [startTime, endTime]] of Object.entries(G.shifts)) {
    const t = team[n];
    if (t) await o.put(`/staff/${t.staffId}/shifts`, { shifts: WEEK.map((dow) => ({ dow, startTime, endTime })) });
  }
  for (const [n, terms] of Object.entries(G.pay)) {
    const t = team[n];
    if (t) await o.put(`/staff/${t.staffId}/pay`, terms);
  }
  // The front desk is on shift: clocked in at the desk by the owner.
  const desk = team[G.frontDesk.n];
  if (desk) accept(await o.post('/staff-times', { staffId: desk.staffId, kind: 'in' }, { ok: [409] }), ['GYM_STAFF_ALREADY_IN'], 'clock in');

  // Last month's payroll: drafted from the terms, approved and paid (salary expenses in the gym's books).
  const period = rules.addMonths(rules.firstOfMonth(today()), -1).slice(0, 7);
  const runs = (await o.get('/payroll')).items ?? [];
  if (!runs.some((r) => r.period === period && r.status !== 'void')) {
    const run = accept(await o.post('/payroll', { period }, { ok: [409, 422] }), ['GYM_PAYROLL_EXISTS', 'GYM_PAYROLL_EMPTY', 'GYM_PAYROLL_PERIOD'], 'payroll');
    if (run?.id) {
      await o.post(`/payroll/${run.id}/approve`);
      for (const line of run.lines) await o.post(`/payroll/${run.id}/lines/${line.id}/pay`, { method: 'bank' }, { idem: true });
    }
  }

  const assets = byName((await o.get('/assets')).items);
  for (const a of G.assets) {
    const made = assets.get(a.name) ?? (await o.post('/assets', {
      name: a.name,
      category: a.category,
      brand: a.brand ?? null,
      serial: a.serial ?? null,
      location: a.location ?? null,
      boughtOn: day(-a.boughtDaysAgo),
      costPoisha: a.cost,
      ...(a.status ? { status: a.status } : {}),
      ...(a.serviceEveryDays ? { serviceEveryDays: a.serviceEveryDays, lastServiceOn: day(-a.lastServiceDaysAgo) } : {}),
      ...(a.note ? { note: a.note } : {}),
    }));
    // The service on record (dated within gym_manage.backdate_days), once.
    if (a.service && !(await o.get(`/assets/${made.id}/logs`)).items.some((l) => l.kind === 'service')) {
      await o.post(`/assets/${made.id}/logs`, { kind: 'service', doneOn: day(-a.lastServiceDaysAgo), costPoisha: a.service.costPoisha, note: a.service.note }, { idem: true });
    }
  }
}

// ---------------------------------------------------------------- trial visits and a join request

async function guests({ gymId }) {
  const nowMinute = rules.dhakaMinute(new Date());
  for (const v of G.visits) {
    const p = D.PLAYERS.find((x) => x.n === v.n);
    const actor = await people.member(p.n, p.name, { username: p.username });
    if ((await rt.get(actor, '/me/gym-visits')).items.some((x) => x.gym?.id === gymId)) continue;
    // Today's visit needs its time still ahead; otherwise it moves to tomorrow.
    const [h, m] = v.at.split(':').map(Number);
    const inDays = v.inDays === 0 && h * 60 + m <= nowMinute + 5 ? 1 : v.inDays;
    accept(await rt.post(actor, '/me/gym-visits', { gymId, date: day(inDays), arriveAt: v.at }, { idem: true, ok: [409, 422, 429] }), ['GYM_VISIT_LIMIT', 'GYM_VISIT_FULL', 'GYM_VISIT_HOURS', 'GYM_VISIT_DATE', 'GYM_VISIT_MEMBER', 'GYM_VISITS_CLOSED', 'RATE_LIMITED'], 'trial visit');
  }
  const j = D.PLAYERS.find((x) => x.n === G.joinRequest.n);
  const asker = await people.member(j.n, j.name, { username: j.username });
  if (!(await rt.get(asker, '/me/gym-requests')).items.some((r) => r.gym?.id === gymId)) {
    await rt.post(asker, '/me/gym-join-requests', { gymId, note: G.joinRequest.note }, { ok: [409, 422] });
  }
}

/** Runs every part. → a one-line report, or { missing } when the listings are not there yet. */
async function run() {
  const ctx = await context();
  if (!ctx) return { missing: 'run the listings seed first (the demo gym and its owner are not there)' };
  // One line per part as it ends: on a slow host the whole step takes many minutes, and a failure names
  // the part it stopped in. A second run skips what the finished parts made.
  let first = true;
  const part = async (name, fn) => {
    const t = Date.now();
    try {
      const r = await fn();
      process.stdout.write(`${first ? '\n' : ''}    ${name}: ${((Date.now() - t) / 1000).toFixed(1)} s\n`);
      first = false;
      return r;
    } catch (err) {
      err.message = `gym panel, ${name}: ${err.message}`;
      throw err;
    }
  };
  await part('plan and settings', () => plan(ctx));
  const team = await part('staff', () => staff(ctx));
  const roster = await part('members and fees', () => members(ctx));
  await part('check-ins', () => checkIns(ctx, roster.have));
  await part('trainer and plans', () => trainerAndPlans(ctx, team, roster));
  await part('expenses, drawer, counter shop, lockers', () => books(ctx, roster.have));
  await part('classes, points, notice, enquiries', () => engage(ctx, team, roster));
  await part('shifts, payroll, equipment', () => work(ctx, team));
  await part('trial visits and the join request', () => guests(ctx));
  await part('events', () => rt.drain());
  const count = async (table) => Number((await models.sequelize.query(`SELECT COUNT(*) AS n FROM ${table} WHERE gym_id = :id`, { replacements: { id: ctx.gymId }, type: models.sequelize.QueryTypes.SELECT }))[0].n);
  return {
    gym: G.gym,
    members: await count('gym_members'),
    payments: await count('gym_fee_payments'),
    checkIns: await count('gym_attendance'),
    expenses: await count('gym_expenses'),
    classes: await count('gym_classes'),
    assets: await count('gym_assets'),
    visits: await count('gym_visits'),
  };
}

module.exports = { run };
