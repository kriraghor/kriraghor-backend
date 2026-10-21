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
});
