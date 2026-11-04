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
    expect(await count('/tournaments?status=open&limit=24')).toBe(6);
    // --sports-only: a retired event is cancelled by its organiser with its record kept, its place is
    // taken by a new one, and nothing else is touched.
    const others = await models.DemoRecord.count({ where: { entity: 'ground' } });
    const retired = await models.DemoRecord.findOne({ where: { entity: 'sports_tournament', label: 'sports:dhaka-futsal-cup' } });
    await retired.update({ label: 'sports:futsal-league' });
    expect(await run('demo-seed.js', ['--sports-only'])).toContain('sports events');
    expect(await models.Tournament.findByPk(retired.entityId)).toMatchObject({ status: 'cancelled', cancelReason: 'Demo event replaced by newer demo events' });
    expect(await count('/tournaments?status=open&limit=24')).toBe(6);
    expect(await models.DemoRecord.count({ where: { entity: 'ground' } })).toBe(others);
    // Listings never take a payment: no ledger rows, free entry.
    expect(await models.LedgerTransaction.count()).toBe(0);
    // Demo staff cannot sign in: no phone, email or password.
    for (const label of ['master', 'reviewer']) {
      const row = await models.DemoRecord.findOne({ where: { entity: 'staff', label } });
      expect(await models.User.findByPk(row.entityId)).toMatchObject({ phone: null, email: null, passwordHash: null });
    }

    // Round B3: three business staff (venue and gym front desks, a shop packer), added by their owners
    // with the default permissions; members with a verified phone, never Kriraghor staff.
    const D = require('../../scripts/demo/data');
    const staffPhones = D.BUSINESS_STAFF.map((s) => `+8801300${String(s.n).padStart(6, '0')}`);
    const staffUsers = await models.User.findAll({ where: { phone: staffPhones } });
    expect(staffUsers).toHaveLength(3);
    expect(staffUsers.every((u) => u.phoneVerifiedAt)).toBe(true);
    expect(await models.StaffMember.count({ where: { userId: staffUsers.map((u) => u.id) } })).toBe(0);
    const team = await models.BusinessMember.findAll({ where: { memberId: staffUsers.map((u) => u.id), status: 'active' } });
    expect(team.map((m) => m.businessType).sort()).toEqual(['gym', 'shop', 'venue']);
    expect(team.find((m) => m.businessType === 'shop').permissions).toContain('orders.ship');

    const before = await records();
    await run('demo-seed.js', ['--profile=listings']);
    expect(await records()).toBe(before);
    expect(await models.BusinessMember.count()).toBe(3);
    await run('demo-seed.js', ['--access-only']);
    expect(await models.BusinessMember.count()).toBe(3);

    const full = await run('demo-seed.js', ['--profile=full']);
    expect(await count('/esports/top-players')).toBeGreaterThan(0);
    expect(await models.Booking.count({ where: { status: 'completed' } })).toBe(24);
    expect(await models.Review.count({ where: { status: 'published', subjectType: 'ground' } })).toBe(24);
    // Round B1: reviews of pros, shops and gyms, owner replies, and one item of each kind left to rate.
    const bySubject = Object.fromEntries((await models.Review.findAll({ where: { status: 'published' }, attributes: ['subjectType', [models.sequelize.fn('COUNT', '*'), 'n']], group: ['subjectType'], raw: true })).map((r) => [r.subjectType, Number(r.n)]));
    expect(bySubject).toMatchObject({ hire_profile: expect.any(Number), shop: expect.any(Number) });
    // Gym visits need the front desk open now (Dhaka hours); outside them the seeder says to re-run.
    if (!bySubject.gym) expect(full).toContain('re-run when the gym is open');
    expect(await models.Review.count({ where: { replyText: { [require('sequelize').Op.ne]: null }, subjectType: ['hire_profile', 'shop', 'gym'] } })).toBeGreaterThan(0);
    expect(await models.AvailabilityBlock.count({ where: { status: 'active' } })).toBeGreaterThan(0);

    const dry = await run('demo-hide.js', ['--dry-run']);
    expect(dry).toContain('Dry run: nothing changed.');
    expect(await count('/grounds?limit=12')).toBe(8);

    await run('demo-hide.js', []);
    for (const p of ['/grounds?limit=12', '/market/items?limit=24', '/gym/gyms?limit=24', '/hire/profiles?limit=24', '/esports/tournaments?status=registration_open&limit=12', '/esports/events', '/tournaments?status=open&limit=24']) {
      expect({ p, n: await count(p) }).toEqual({ p, n: 0 });
    }
    // The business staff are suspended with the other demo accounts; nothing is deleted.
    expect(await models.User.count({ where: { id: staffUsers.map((u) => u.id), status: 'suspended' } })).toBe(3);
    expect(await models.BusinessMember.count()).toBe(3);
  }, 20 * 60000);
});
