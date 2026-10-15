'use strict';

/**
 * M03 reference data seed (§8 Seeds). Versioned JSON files, keyed by `key`:
 *  - settings are inserted only when missing, so a value a master changed is never overwritten;
 *  - catalogue rows are inserted only when missing, so staff edits survive a redeploy.
 * Running it twice is a no-op. It runs after migrations in scripts/release.js (Helm migrate Job).
 */
const settingsSeed = require('./reference/settings.v1.json');
const esportsSeed = require('./reference/esports.v1.json');
const templatesSeed = require('./reference/templates.v1.json');
const { sequelize, PlatformSetting, SettingsHistory, EsportsGame, EsportsMode, EsportsMap, EsportsPointsPreset, MessageTemplate } = require('../../models');

const SEED_REASON = `Seed settings v${settingsSeed.seedVersion}`;

function settingRow(s) {
  return {
    key: s.key,
    category: s.category,
    value: s.value,
    valueType: s.type,
    unit: s.unit ?? null,
    minValue: s.min ?? null,
    maxValue: s.max ?? null,
    enumOptions: s.options ?? null,
    approval: s.approval ?? 'single',
    isPublic: Boolean(s.public),
    labelEn: s.en,
    labelBn: s.bn,
    whyEn: s.why ?? null,
    whyBn: s.whyBn ?? null,
    version: 1,
  };
}

/** Every key the code may read. The boot check fails when one is missing in the database. */
const SETTING_KEYS = settingsSeed.settings.map((s) => s.key);

async function seedSettings(transaction) {
  const existing = new Set((await PlatformSetting.findAll({ attributes: ['key'], transaction })).map((r) => r.key));
  const missing = settingsSeed.settings.filter((s) => !existing.has(s.key));
  if (!missing.length) return 0;
  const now = new Date();
  await PlatformSetting.bulkCreate(missing.map(settingRow), { transaction });
  await SettingsHistory.bulkCreate(
    missing.map((s) => ({ key: s.key, version: 1, oldValue: null, newValue: s.value, effectiveAt: now, reason: SEED_REASON })),
    { transaction }
  );
  return missing.length;
}

async function insertMissing(Model, where, values, transaction) {
  const found = await Model.findOne({ where, transaction });
  if (found) return [found, false];
  return [await Model.create({ ...where, ...values }, { transaction }), true];
}

async function seedEsports(transaction) {
  let inserted = 0;
  for (const g of esportsSeed.games) {
    const { modes, maps, presets, key, ...game } = g;
    const [row, created] = await insertMissing(EsportsGame, { key }, game, transaction);
    inserted += Number(created);
    for (const m of modes) {
      const { key: mk, ...mode } = m;
      inserted += Number((await insertMissing(EsportsMode, { gameId: row.id, key: mk }, mode, transaction))[1]);
    }
    for (const m of maps) {
      const { key: mk, ...map } = m;
      inserted += Number((await insertMissing(EsportsMap, { gameId: row.id, key: mk }, map, transaction))[1]);
    }
    for (const p of presets) {
      const { key: pk, ...preset } = p;
      // Any version of the preset counts as present; edits live in later versions.
      const any = await EsportsPointsPreset.findOne({ where: { gameId: row.id, key: pk }, transaction });
      if (!any) {
        await EsportsPointsPreset.create({ gameId: row.id, key: pk, version: 1, ...preset }, { transaction });
        inserted += 1;
      }
    }
  }
  return inserted;
}

/** M08 message templates: version 1 of each (code, channel, locale), active, only when missing. */
async function seedTemplates(transaction) {
  let inserted = 0;
  for (const t of templatesSeed.templates) {
    const where = { code: t.code, channel: t.channel, locale: t.locale };
    if (await MessageTemplate.findOne({ where, transaction })) continue;
    await MessageTemplate.create(
      { ...where, version: 1, subject: t.subject ?? null, body: t.body, variables: t.variables, isActive: true, maxSmsSegments: t.channel === 'sms' ? 3 : null },
      { transaction }
    );
    inserted += 1;
  }
  return inserted;
}

async function seedReference() {
  return sequelize.transaction(async (transaction) => ({
    settings: await seedSettings(transaction),
    esports: await seedEsports(transaction),
    templates: await seedTemplates(transaction),
  }));
}

module.exports = { seedReference, seedSettings, seedEsports, seedTemplates, settingRow, SETTING_KEYS, settingsSeed, esportsSeed, templatesSeed };
