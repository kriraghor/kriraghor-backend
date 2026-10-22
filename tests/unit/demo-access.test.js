'use strict';

// The demo sign-in step (scripts/demo/steps/access.js): it only runs with a DEMO_PASSWORD of 12–128
// characters, its staff are never masters and stay in the demo phone block, and every account it
// names is a demo account.
const access = require('../../scripts/demo/steps/access');

describe('demo sign-in accounts', () => {
  const saved = process.env.DEMO_PASSWORD;
  afterEach(() => {
    if (saved === undefined) delete process.env.DEMO_PASSWORD;
    else process.env.DEMO_PASSWORD = saved;
  });

  it('runs only with a DEMO_PASSWORD of 12 to 128 characters', () => {
    delete process.env.DEMO_PASSWORD;
    expect(access.enabled()).toMatchObject({ ok: false });
    process.env.DEMO_PASSWORD = 'short';
    expect(access.enabled()).toMatchObject({ ok: false });
    process.env.DEMO_PASSWORD = 'x'.repeat(129);
    expect(access.enabled()).toMatchObject({ ok: false });
    process.env.DEMO_PASSWORD = 'a-long-enough-demo-pass';
    expect(access.enabled()).toEqual({ ok: true, password: 'a-long-enough-demo-pass' });
  });

  it('uses only the demo phone block, and no demo staff can be a master or edit fees or staff', () => {
    for (const a of [...access.MEMBERS, ...access.STAFF]) {
      expect(a.n).toBeGreaterThanOrEqual(1);
      expect(a.n).toBeLessThanOrEqual(199);
    }
    for (const s of access.STAFF) {
      expect(s.permissions).not.toContain('manage_staff');
      expect(s.permissions).not.toContain('edit_fees');
      expect(s).not.toHaveProperty('isMaster');
    }
  });

  it('signs in the Round B3 business staff at the vendor site as members, never as Kriraghor staff', () => {
    const D = require('../../scripts/demo/data');
    const rules = require('../../src/modules/business-members/business-members.rules');
    const taken = [...D.OWNERS, ...D.PROS, ...D.TRAINERS, ...D.PLAYERS, D.MEMBER, ...access.STAFF].map((p) => p.n);
    expect(D.BUSINESS_STAFF.map((s) => s.businessType).sort()).toEqual(['gym', 'shop', 'venue']);
    for (const s of D.BUSINESS_STAFF) {
      expect(taken).not.toContain(s.n);
      expect(access.MEMBERS).toContainEqual({ n: s.n, kind: s.kind, where: 'vendor.kriraghor.com' });
      expect(access.STAFF.map((x) => x.n)).not.toContain(s.n);
      // The listing belongs to the owner named, so POST /me/team as that owner finds it.
      const list = { venue: D.VENUES, gym: D.GYMS, shop: D.SHOPS }[s.businessType];
      expect(list.find((b) => b.name === s.business)?.owner).toBe(s.owner);
    }
    // steps/team.js adds them with the business type's defaults (B3): the shop packer can ship.
    expect(D.BUSINESS_STAFF.every((s) => !('permissions' in s))).toBe(true);
    expect(rules.defaultsFor('shop')).toContain('orders.ship');
  });
});
