'use strict';

// Migration 20261112000002-kyc-min-age-18 (M02 §6.3 age_ok, product owner 25 Oct 2026): a database
// still at the seeded kyc.min_age_years (16, version 1) moves to 18 (bounds 18 to 21, version 2) with
// one append-only settings_history row; a value a master changed is kept, with a warning. A fresh
// database has no row when migrations run (global-setup migrates before seeding), so nothing happens.
const { Sequelize } = require('sequelize');
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const migration = require('../../src/db/migrations/20261112000002-kyc-min-age-18');

const { models } = h;
const KEY = 'kyc.min_age_years';
const up = () => migration.up(models.sequelize.getQueryInterface(), Sequelize);
const row = () => models.PlatformSetting.findByPk(KEY);
const history = () => models.SettingsHistory.findAll({ where: { key: KEY }, order: [['version', 'ASC']] });

beforeEach(async () => {
  await h.resetDb();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

/** The row as a database seeded before 25 Oct 2026 holds it (seed v28). */
const seededAt16 = () => models.PlatformSetting.update({ value: 16, minValue: 13, maxValue: 21, version: 1 }, { where: { key: KEY } });

it('moves the seeded 16 to 18 with bounds 18 to 21 and one history row', async () => {
  await seededAt16();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await up();
  const r = await row();
  expect({ value: r.value, min: Number(r.minValue), max: Number(r.maxValue), version: r.version }).toEqual({ value: 18, min: 18, max: 21, version: 2 });
  const rows = await history();
  expect(rows.map((x) => x.version)).toEqual([1, 2]); // v1 is the seed's own row
  expect(rows[1]).toMatchObject({ oldValue: 16, newValue: 18, reason: 'M02 25 Oct 2026: NID verification is 18+ (product owner)', requestId: null, changedBy: null, approvedBy: null });
  expect(rows[1].effectiveAt).toBeInstanceOf(Date);
  expect(warn).not.toHaveBeenCalled();

  // Running it again changes nothing: the value is no longer the seed's.
  await up();
  expect((await row()).version).toBe(2);
  expect(await history()).toHaveLength(2);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('left unchanged: it is 18 at version 2'));

  // The settings engine reads the new value and bounds.
  await h.settings.load();
  expect(h.settings.get(KEY)).toBe(18);
});

it('keeps a value a master changed, with a warning naming it', async () => {
  await models.PlatformSetting.update({ value: 17, minValue: 13, maxValue: 21, version: 3 }, { where: { key: KEY } });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await up();
  const r = await row();
  expect({ value: r.value, min: Number(r.minValue), version: r.version }).toEqual({ value: 17, min: 13, version: 3 });
  expect(await history()).toHaveLength(1);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('kyc.min_age_years left unchanged: it is 17 at version 3'));
});

it('leaves 16 alone when it is not version 1 (a master set it back)', async () => {
  await models.PlatformSetting.update({ value: 16, version: 4 }, { where: { key: KEY } });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  await up();
  expect((await row()).value).toBe(16);
  expect(await history()).toHaveLength(1);
});

it('the down step changes nothing (history is append-only)', async () => {
  await seededAt16();
  await up();
  await migration.down(models.sequelize.getQueryInterface(), Sequelize);
  expect((await row()).value).toBe(18);
  expect(await history()).toHaveLength(2);
});
