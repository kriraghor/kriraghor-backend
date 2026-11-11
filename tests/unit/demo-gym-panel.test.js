'use strict';

// The demo gym's panel content (scripts/demo/data.js GYM_PANEL, steps/gym-panel.js): it only names people,
// products, lockers and permissions that exist, stays inside the demo phone block and what the routes take
// (gym_manage.backdate_days, the gym's staff permissions), and never touches online money.
const D = require('../../scripts/demo/data');
const access = require('../../scripts/demo/steps/access');
const team = require('../../src/modules/business-members/business-members.rules');
const ops = require('../../src/modules/gym-ops/gym-ops.rules');
const manage = require('../../src/modules/gym-manage/gym-manage.rules');
const settings = require('../../src/db/seed/reference/settings.v1.json').settings;

const G = D.GYM_PANEL;
const setting = (key) => settings.find((s) => s.key === key).value;
const accounts = [...D.OWNERS, ...D.PROS, ...D.TRAINERS, ...D.PLAYERS, D.MEMBER, ...D.BUSINESS_STAFF, ...access.STAFF].map((p) => p.n);

describe('the demo gym panel', () => {
  it('is one of the demo gyms, run by its owner, with the front desk from the business staff', () => {
    const gym = D.GYMS.find((g) => g.name === G.gym);
    expect(gym?.owner).toBe(G.owner);
    expect(D.BUSINESS_STAFF.find((s) => s.n === G.frontDesk.n)).toMatchObject({ businessType: 'gym', business: G.gym });
    expect(manage.TIERS).toContain(G.tier);
    expect(G.shortCode).toMatch(/^[A-Z]{2,6}$/);
  });

  it('gives staff only permissions a gym can give, and the trainer a free demo phone with a sign-in', () => {
    const allowed = Object.keys(team.PERMISSIONS.gym);
    for (const s of [G.frontDesk, G.trainer]) {
      for (const p of s.permissions) expect(allowed).toContain(p);
      // The team API accepts the list as it is: nothing unknown, and every permission another one needs is there.
      expect(team.normalizePermissions('gym', s.permissions)).toEqual({ permissions: [...s.permissions].sort() });
    }
    expect(accounts).not.toContain(G.trainer.n);
    expect(G.trainer.n).toBeGreaterThanOrEqual(1);
    expect(G.trainer.n).toBeLessThanOrEqual(199);
    expect(access.MEMBERS).toContainEqual({ n: G.trainer.n, kind: G.trainer.kind, where: 'gym.kriraghor.com' });
    // Staff who clock in and get shifts and pay terms are the two on the team.
    for (const n of [...Object.keys(G.shifts), ...Object.keys(G.pay)]) expect([G.frontDesk.n, G.trainer.n]).toContain(Number(n));
    for (const terms of Object.values(G.pay)) {
      expect(terms.ptCommissionBps).toBeLessThanOrEqual(setting('gym_ops.commission_bps_max'));
      expect(terms.salesCommissionBps).toBeLessThanOrEqual(setting('gym_ops.commission_bps_max'));
    }
  });

  it('names each member once, with phones in the demo block that no account uses', () => {
    const names = G.members.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    G.members.forEach((m, i) => expect(accounts).not.toContain(100 + i));
    expect(100 + G.members.length - 1).toBeLessThan(140);
    for (const e of G.enquiries) {
      expect(accounts).not.toContain(e.phoneN);
      expect(e.phoneN).toBeGreaterThanOrEqual(140);
      expect(e.phoneN).toBeLessThanOrEqual(190);
    }
    // Linked members, trial-visit guests and the join request are demo accounts, each used once.
    const used = [...G.linked.map((m) => m.n), ...G.visits.map((v) => v.n), G.joinRequest.n];
    expect(new Set(used).size).toBe(used.length);
    for (const n of used) expect([D.MEMBER.n, ...D.PLAYERS.map((p) => p.n)]).toContain(n);
  });

  it('keeps start dates, payments and packages inside what the desk accepts', () => {
    const back = setting('gym_manage.backdate_days');
    const kinds = D.GYMS.find((g) => g.name === G.gym).packages.map((p) => p.kind);
    for (const m of [...G.members, ...G.linked]) {
      if (!m.pkg) continue;
      expect(kinds).toContain(m.pkg);
      expect(m.start).toBeLessThanOrEqual(0);
      expect(m.start).toBeGreaterThanOrEqual(-back);
      if (m.pay !== 'none') expect(manage.METHODS).toContain(m.method);
      if (m.freeze) expect(m.freeze.to).toBeGreaterThanOrEqual(m.freeze.from);
    }
    // Something of each kind for the screens: unpaid, part-paid, frozen, no package, a referral.
    expect(G.members.filter((m) => m.pay === 'none' && m.pkg).length).toBeGreaterThanOrEqual(2);
    expect(G.members.some((m) => typeof m.pay === 'number')).toBe(true);
    expect(G.members.some((m) => m.freeze)).toBe(true);
    expect(G.members.some((m) => !m.pkg)).toBe(true);
    for (const m of G.members.filter((x) => x.referredBy)) expect(G.members.map((x) => x.name)).toContain(m.referredBy);
  });

  it('only checks in, sells to and rents lockers to members who are on the list', () => {
    const names = new Set(G.members.map((m) => m.name));
    const running = new Set(G.members.filter((m) => m.pkg && !m.freeze).map((m) => m.name));
    for (const n of G.checkIns) expect(running).toContain(n);
    const products = new Set(G.products.map((p) => p.name));
    for (const s of G.sales) {
      expect(ops.SALE_METHODS).toContain(s.method);
      for (const [name, qty] of s.lines) {
        expect(products).toContain(name);
        expect(qty).toBeLessThanOrEqual(G.products.find((p) => p.name === name).stock);
      }
      if (s.member) expect(names).toContain(s.member);
    }
    for (const [number, member, days, method] of G.lockers.rented) {
      expect(G.lockers.numbers).toContain(number);
      expect(names).toContain(member);
      expect(days).toBeLessThanOrEqual(setting('gym_ops.locker_rental_max_days'));
      if (method) expect(ops.SALE_METHODS).toContain(method);
    }
    expect(G.lockers.monthlyFee).toBeLessThanOrEqual(setting('gym_ops.locker_fee_max_poisha'));
  });

  it('uses the gym-ops value lists and limits', () => {
    const cats = ops.DEFAULT_CATEGORIES.map((c) => c.key);
    for (const e of G.expenses) {
      expect(cats).toContain(e.category);
      expect(ops.EXPENSE_METHODS).toContain(e.method);
      expect(e.daysAgo).toBeLessThanOrEqual(setting('gym_manage.backdate_days'));
      expect(e.amount).toBeLessThanOrEqual(setting('gym_ops.expense_max_poisha'));
    }
    expect(new Set(G.expenses.map((e) => e.payee)).size).toBe(G.expenses.length);
    for (const p of G.products) {
      expect(ops.PRODUCT_CATEGORIES).toContain(p.category);
      expect(p.price).toBeLessThanOrEqual(setting('gym_ops.product_price_max_poisha'));
      expect(p.cost).toBeLessThan(p.price);
    }
    for (const a of G.assets) expect(ops.ASSET_CATEGORIES).toContain(a.category);
    for (const a of G.assets.filter((x) => x.service)) expect(a.lastServiceDaysAgo).toBeLessThanOrEqual(setting('gym_manage.backdate_days'));
    expect(new Set(G.assets.map((a) => a.name)).size).toBe(G.assets.length);
    for (const c of G.classes) {
      expect(c.days.every((d) => d >= 0 && d <= 6)).toBe(true);
      expect(c.time).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    }
    expect(G.rewards.length).toBeLessThanOrEqual(setting('gym_ops.rewards_max'));
    for (const r of G.rewards.filter((x) => x.kind === 'discount')) expect(r.value).toBeLessThanOrEqual(setting('gym_ops.reward_discount_max_poisha'));
    expect(ops.NOTICE_SEGMENTS).toContain(G.notice.segment.kind);
    expect(G.enquiries.length).toBeLessThanOrEqual(setting('gym_ops.lead_per_ip_hour'));
  });

  it('writes plans the plan schema accepts, and visits within the gym’s limits', () => {
    const s = require('../../src/modules/gym-manage/gym-manage.schemas');
    for (const [kind, p] of [['workout', G.workoutPlan], ['diet', G.dietChart]]) expect(s.planBody.safeParse({ kind, title: p.title, isTemplate: true, content: p.content }).success).toBe(true);
    expect(G.visits.length).toBeLessThanOrEqual(setting('gym_manage.visit_daily_cap_default'));
    for (const v of G.visits) expect(v.inDays).toBeLessThanOrEqual(setting('gym_manage.visit_book_ahead_days'));
    expect(G.visitNote.length).toBeLessThanOrEqual(300);
  });

  it('closes the gym for one day the special-day rules accept, after the demo visits', () => {
    const gym = require('../../src/modules/gym/gym.rules');
    const s = G.specialDay;
    const today = '2026-11-11';
    const on = require('../../src/modules/gym-manage/gym-manage.rules').addDays(today, s.inDays);
    expect(gym.specialDayBlock({ fromOn: on, toOn: on, kind: s.kind, windows: [], today, others: [], maxDays: setting('gym.special_day_max_days'), aheadDays: setting('gym.special_days_ahead_days'), maxActive: setting('gym.special_days_max_active') })).toBeNull();
    expect(s.title.length).toBeGreaterThanOrEqual(2);
    expect(s.title.length).toBeLessThanOrEqual(80);
    // Shown on the public page at once, and no demo visit falls on it.
    expect(s.inDays).toBeLessThanOrEqual(setting('gym.special_days_public_days'));
    expect(Math.max(...G.visits.map((v) => v.inDays)) + 1).toBeLessThan(s.inDays);
  });
});
