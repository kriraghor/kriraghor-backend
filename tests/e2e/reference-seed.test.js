'use strict';

// Start-up reference seed: skipped while the reference data and seed code are unchanged, so a deploy
// opens its port in seconds on a remote database (Render). M03 §8 seeds stay idempotent either way.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const { seedReferenceIfChanged, seedFingerprint, SETTING_KEYS } = require('../../src/db/seed');

const { models } = h;
const { sequelize } = models;

beforeEach(h.resetDb);
afterAll(async () => {
  await closeAllRedis();
  await sequelize.close();
});

async function storedFingerprint() {
  const [rows] = await sequelize.query('SELECT fingerprint FROM reference_seed_state WHERE id = 1');
  return rows[0]?.fingerprint ?? null;
}

/** Number of SQL statements a call runs. */
async function countQueries(fn) {
  const before = sequelize.options.logging;
  let n = 0;
  sequelize.options.logging = () => {
    n += 1;
  };
  try {
    return { result: await fn(), queries: n };
  } finally {
    sequelize.options.logging = before;
  }
}

describe('seedFingerprint', () => {
  test('is a stable SHA-256 of the reference data and seed code', () => {
    const a = seedFingerprint();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(seedFingerprint()).toBe(a);
  });
});

describe('seedReferenceIfChanged', () => {
  test('seeds when no fingerprint is recorded, then skips with two queries', async () => {
    expect(await storedFingerprint()).toBeNull();
    const first = await seedReferenceIfChanged();
    expect(first.skipped).toBe(false);
    expect(await storedFingerprint()).toBe(seedFingerprint());

    const { result, queries } = await countQueries(() => seedReferenceIfChanged());
    expect(result).toEqual({ skipped: true, fingerprint: seedFingerprint() });
    expect(queries).toBe(2);
  });

  test('reseeds when the recorded fingerprint is from other reference data', async () => {
    await seedReferenceIfChanged();
    await sequelize.query("UPDATE reference_seed_state SET fingerprint = repeat('0', 64) WHERE id = 1");
    const again = await seedReferenceIfChanged();
    expect(again.skipped).toBe(false);
    expect(await storedFingerprint()).toBe(seedFingerprint());
  });

  test('reseeds when settings are missing, even with a matching fingerprint (boot check stays safe)', async () => {
    await seedReferenceIfChanged();
    // Settings rows are never deleted (history references them); emptying the tables stands in for a
    // database restored without them.
    await sequelize.query('TRUNCATE TABLE settings_change_requests, settings_history, platform_settings CASCADE');
    const again = await seedReferenceIfChanged();
    expect(again.skipped).toBe(false);
    expect(again.inserted.settings).toBe(SETTING_KEYS.length);
    const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM platform_settings WHERE key IN (:keys)', { replacements: { keys: SETTING_KEYS } });
    expect(n).toBe(SETTING_KEYS.length);
  });

  test('force always seeds and keeps a single state row', async () => {
    await seedReferenceIfChanged();
    const forced = await seedReferenceIfChanged({ force: true });
    expect(forced.skipped).toBe(false);
    const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM reference_seed_state');
    expect(n).toBe(1);
  });

  test('the state table holds one row only', async () => {
    await expect(sequelize.query("INSERT INTO reference_seed_state (id, fingerprint) VALUES (2, repeat('1', 64))")).rejects.toThrow();
  });
});
