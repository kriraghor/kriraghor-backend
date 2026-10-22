'use strict';

/**
 * M03 reference data seed (§8 Seeds). Versioned JSON files, keyed by `key`:
 *  - settings are inserted only when missing, so a value a master changed is never overwritten;
 *  - catalogue rows are inserted only when missing, so staff edits survive a redeploy.
 * Running it twice is a no-op. It runs after migrations in scripts/release.js (Helm migrate Job).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const settingsSeed = require('./reference/settings.v1.json');
const esportsSeed = require('./reference/esports.v1.json');
const templatesSeed = require('./reference/templates.v1.json');
const kycSeed = require('./reference/kyc-requirements.v1.json');
const moderationSeed = require('./reference/moderation.v1.json');
const placesSeed = require('./reference/places.v1.json');
const itemsSeed = require('./reference/items.v1.json');
const hireSeed = require('./reference/hire.v1.json');
const rulesSeed = require('./reference/rules.v1.json');
const { sequelize, PlatformSetting, SettingsHistory, EsportsGame, EsportsMode, EsportsMap, EsportsPointsPreset, MessageTemplate, DocumentRequirement, ReviewRubric, RejectionReason, Sport, Division, District, Area, Facility, Surface, ItemCategory, ItemType, ItemTypeField, HireCategory, HireRole, SportRuleSchema } = require('../../models');

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

/** M02 document requirements, only when (role, type or derived key) is missing. */
async function seedKycRequirements(transaction) {
  let inserted = 0;
  for (const r of kycSeed.requirements) {
    const where = { role: r.role, isActive: true, ...(r.docType ? { docType: r.docType } : { derivedKey: r.derivedKey }) };
    if (await DocumentRequirement.findOne({ where, transaction })) continue;
    await DocumentRequirement.create({ ...r, isActive: true, version: 1 }, { transaction });
    inserted += 1;
  }
  return inserted;
}

/** M05 rubrics (one active version per kind) and rejection reasons, only when missing. */
async function seedModeration(transaction) {
  let inserted = 0;
  for (const r of moderationSeed.rubrics) {
    if (await ReviewRubric.findOne({ where: { kind: r.kind }, transaction })) continue;
    await ReviewRubric.create({ kind: r.kind, version: r.version, items: r.items, isActive: true }, { transaction });
    inserted += 1;
  }
  for (const r of moderationSeed.reasons) {
    const existing = await RejectionReason.findByPk(r.code, { transaction });
    if (existing) {
      // Additive only: a reason gains the kinds of newly built modules; nothing is ever removed.
      const missing = r.kinds.filter((k) => !existing.kinds.includes(k));
      if (missing.length) {
        await existing.update({ kinds: [...existing.kinds, ...missing] }, { transaction });
        inserted += 1;
      }
      continue;
    }
    await RejectionReason.create({ requiresText: false, ...r }, { transaction });
    inserted += 1;
  }
  return inserted;
}

/** M03 sports and places (for M09 and later), only when the key is missing; parents by key. */
async function seedPlaces(transaction) {
  let inserted = 0;
  const add = async (Model, rows, extra = () => ({})) => {
    for (const r of rows) {
      const { key, ...rest } = r;
      inserted += Number((await insertMissing(Model, { key }, { ...rest, ...(await extra(r)) }, transaction))[1]);
    }
  };
  const idOf = async (Model, key) => (await Model.findOne({ where: { key }, transaction })).id;
  await add(Sport, placesSeed.sports);
  await add(Division, placesSeed.divisions);
  await add(District, placesSeed.districts.map(({ division, ...d }) => ({ ...d, divisionKey: division })), async (d) => ({ divisionId: await idOf(Division, d.divisionKey) }));
  await add(Area, placesSeed.areas.map(({ district, ...a }) => ({ ...a, districtKey: district })), async (a) => ({ districtId: await idOf(District, a.districtKey) }));
  await add(Facility, placesSeed.facilities);
  await add(Surface, placesSeed.surfaces);
  return inserted;
}

/** M03 item catalogue for M12 (Q77), only when the key is missing; fields by (type, key). */
async function seedItems(transaction) {
  let inserted = 0;
  const categories = new Map();
  for (const c of itemsSeed.categories) {
    const { key, ...rest } = c;
    const [row, created] = await insertMissing(ItemCategory, { key }, rest, transaction);
    categories.set(key, row.id);
    inserted += Number(created);
  }
  for (const t of itemsSeed.types) {
    const { key, category, fields, ...rest } = t;
    const [row, created] = await insertMissing(ItemType, { key }, { ...rest, categoryId: categories.get(category) }, transaction);
    inserted += Number(created);
    for (const f of fields) {
      const { key: fk, ...field } = f;
      inserted += Number((await insertMissing(ItemTypeField, { itemTypeId: row.id, key: fk }, field, transaction))[1]);
    }
  }
  return inserted;
}

/** M03 hire taxonomy for M11, only when the key is missing; roles by category key. */
async function seedHire(transaction) {
  let inserted = 0;
  const categories = new Map();
  for (const c of hireSeed.categories) {
    const { key, ...rest } = c;
    const [row, created] = await insertMissing(HireCategory, { key }, rest, transaction);
    categories.set(key, row.id);
    inserted += Number(created);
  }
  for (const r of hireSeed.roles) {
    const { key, category, ...rest } = r;
    inserted += Number((await insertMissing(HireRole, { key }, { ...rest, categoryId: categories.get(category) }, transaction))[1]);
  }
  return inserted;
}

/** M03 sport rule schemas for M14, only when (sport, version) is missing (places must be seeded first). */
async function seedRules(transaction) {
  let inserted = 0;
  for (const r of rulesSeed.sportRules) {
    const sport = await Sport.findOne({ where: { key: r.sport }, transaction });
    inserted += Number((await insertMissing(SportRuleSchema, { sportId: sport.id, version: r.version }, { fields: r.fields, presets: r.presets, tiebreakers: r.tiebreakers }, transaction))[1]);
  }
  return inserted;
}

async function seedReference() {
  return sequelize.transaction(async (transaction) => ({
    settings: await seedSettings(transaction),
    esports: await seedEsports(transaction),
    templates: await seedTemplates(transaction),
    kycRequirements: await seedKycRequirements(transaction),
    moderation: await seedModeration(transaction),
    places: await seedPlaces(transaction),
    items: await seedItems(transaction),
    hire: await seedHire(transaction),
    rules: await seedRules(transaction),
  }));
}

/**
 * Fingerprint of the reference JSON and of this file (the seed logic). Any change to either means the
 * next start reseeds; an unchanged fingerprint means the seed would insert nothing.
 */
function seedFingerprint() {
  const dir = path.join(__dirname, 'reference');
  const hash = crypto.createHash('sha256');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    hash.update(file).update(fs.readFileSync(path.join(dir, file)));
  }
  hash.update(fs.readFileSync(__filename));
  return hash.digest('hex');
}

/**
 * The start-up seed: skip the full seed (about 900 sequential queries, minutes on a remote database)
 * when the fingerprint matches the last applied one and every setting key exists. A setting missing for
 * any reason reseeds, so the settings boot check never fails because of a skip. `force` always seeds.
 */
async function seedReferenceIfChanged({ force = false } = {}) {
  const fingerprint = seedFingerprint();
  if (!force) {
    const [rows] = await sequelize.query('SELECT fingerprint FROM reference_seed_state WHERE id = 1');
    const [[{ present }]] = await sequelize.query('SELECT count(*)::int AS present FROM platform_settings WHERE key IN (:keys)', { replacements: { keys: SETTING_KEYS } });
    if (rows[0]?.fingerprint === fingerprint && present === SETTING_KEYS.length) return { skipped: true, fingerprint };
  }
  const inserted = await seedReference();
  await sequelize.query(
    `INSERT INTO reference_seed_state (id, fingerprint, seeded_at) VALUES (1, :fingerprint, CURRENT_TIMESTAMP(3))
     ON CONFLICT (id) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, seeded_at = EXCLUDED.seeded_at`,
    { replacements: { fingerprint } }
  );
  return { skipped: false, fingerprint, inserted };
}

module.exports = { seedReference, seedReferenceIfChanged, seedFingerprint,seedPlaces, placesSeed, seedItems, itemsSeed, seedHire, hireSeed, seedRules, rulesSeed, seedSettings, seedEsports, seedTemplates, seedKycRequirements, kycSeed, seedModeration, moderationSeed, settingRow, SETTING_KEYS, settingsSeed, esportsSeed, templatesSeed };
