'use strict';

/**
 * The demo seeder and the hide command (scripts/demo-seed.js, scripts/demo-hide.js) against the test
 * database: every public section gets items, a second run adds nothing, the full profile fills the
 * leaderboards, bookings and reviews, and hiding empties the public lists. The scripts run as child
 * processes with the test environment, exactly as a person would run them.
 */
const path = require('path');
const { execFile } = require('child_process');
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');

const { api, P, models } = h;
const root = path.join(__dirname, '..', '..');
const run = (script, args) =>
  new Promise((resolve, reject) =>
    execFile(process.execPath, [path.join(root, 'scripts', script), ...args], { cwd: root, env: { ...process.env, LOG_LEVEL: 'error' }, timeout: 15 * 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${script} ${args.join(' ')} failed:\n${stdout}\n${stderr}`)) : resolve(stdout)
    )
  );
const count = async (p) => {
  const body = (await api().get(`${P}${p}`).expect(200)).body;
  return (body.items ?? body).length;
};
const records = async () => models.DemoRecord.count();

beforeAll(async () => {
  await h.resetDb();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

describe('demo data', () => {
  it('seeds every section, re-runs without duplicates, plays the full profile and hides it all', async () => {
    const out = await run('demo-seed.js', ['--profile=listings']);
    expect(out).toContain('Demo records:');
    await h.settings.load();
    expect(await count('/grounds?limit=12')).toBe(8);
    expect(await count('/market/items?limit=24')).toBe(17);
    expect(await count('/gym/gyms?limit=24')).toBe(4);
    expect(await count('/hire/profiles?limit=24')).toBe(14);
    expect(await count('/esports/tournaments?status=registration_open&limit=12')).toBeGreaterThanOrEqual(6);
    expect(await count('/esports/events?featured=true&limit=3')).toBe(1);
    expect(await count('/tournaments?status=open&limit=24')).toBe(3);
    // Listings never take a payment: no ledger rows, free entry.
    expect(await models.LedgerTransaction.count()).toBe(0);
    // Demo staff cannot sign in: no phone, email or password.
    for (const label of ['master', 'reviewer']) {
      const row = await models.DemoRecord.findOne({ where: { entity: 'staff', label } });
      expect(await models.User.findByPk(row.entityId)).toMatchObject({ phone: null, email: null, passwordHash: null });
    }

    const before = await records();
    await run('demo-seed.js', ['--profile=listings']);
    expect(await records()).toBe(before);

    await run('demo-seed.js', ['--profile=full']);
    expect(await count('/esports/top-players')).toBeGreaterThan(0);
    expect(await models.Booking.count({ where: { status: 'completed' } })).toBe(24);
    expect(await models.Review.count({ where: { status: 'published' } })).toBe(24);

    const dry = await run('demo-hide.js', ['--dry-run']);
    expect(dry).toContain('Dry run: nothing changed.');
    expect(await count('/grounds?limit=12')).toBe(8);

    await run('demo-hide.js', []);
    for (const p of ['/grounds?limit=12', '/market/items?limit=24', '/gym/gyms?limit=24', '/hire/profiles?limit=24', '/esports/tournaments?status=registration_open&limit=12', '/esports/events', '/tournaments?status=open&limit=24']) {
      expect({ p, n: await count(p) }).toEqual({ p, n: 0 });
    }
  }, 20 * 60000);
});
