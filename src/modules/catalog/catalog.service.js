'use strict';

/**
 * M03 catalogues: esports (§7.1 [v3]: games, modes, maps, points presets) and, for M09 and later
 * verticals, sports, divisions, districts, areas, facilities and surfaces (§6.1, §6.3); for M12 the
 * item catalogue (item categories, item types and their spec fields, FR-09); for M11 the hire
 * taxonomy (categories and roles: units, match formats, base rate, credential tiers).
 *  - Rows are never deleted: deactivate hides them from pickers, old references stay valid (M03-FR-01).
 *  - `key` (and the parent row) are immutable after create: CATALOG_KEY_IMMUTABLE.
 *  - Points presets are immutable rows: an edit inserts version n+1, so tournaments that
 *    snapshotted an older version keep scoring with it.
 */
const { AppError, E } = require('../../common/errors');
const { sequelize, Exercise, EsportsGame, EsportsMode, EsportsMap, EsportsPointsPreset, Sport, Division, District, Area, Facility, Surface, ItemCategory, ItemType, ItemTypeField, HireCategory, HireRole, AREA_FLAGS } = require('../../models');
const audit = require('../audit').audit;
const events = require('../events').events;
const { modeCapacityError, presetPointsError, uidRegexError, itemFieldError, hireRoleError } = require('./catalog.validate');

/** parentKey: the immutable foreign key to the parent row (and the list filter). */
const TABLES = {
  'esports-games': { Model: EsportsGame, entity: 'esports_game', esports: true },
  'esports-modes': { Model: EsportsMode, entity: 'esports_mode', esports: true, parentKey: 'gameId', Parent: EsportsGame, parentLabel: 'Game' },
  'esports-maps': { Model: EsportsMap, entity: 'esports_map', esports: true, parentKey: 'gameId', Parent: EsportsGame, parentLabel: 'Game' },
  'esports-points-presets': { Model: EsportsPointsPreset, entity: 'esports_points_preset', esports: true, parentKey: 'gameId', Parent: EsportsGame, parentLabel: 'Game', versioned: true },
  sports: { Model: Sport, entity: 'sport' },
  divisions: { Model: Division, entity: 'division' },
  districts: { Model: District, entity: 'district', parentKey: 'divisionId', Parent: Division, parentLabel: 'Division' },
  areas: { Model: Area, entity: 'area', parentKey: 'districtId', Parent: District, parentLabel: 'District' },
  facilities: { Model: Facility, entity: 'facility' },
  surfaces: { Model: Surface, entity: 'surface' },
  'item-categories': { Model: ItemCategory, entity: 'item_category' },
  'item-types': { Model: ItemType, entity: 'item_type', parentKey: 'categoryId', Parent: ItemCategory, parentLabel: 'Item category' },
  // Field keys repeat across item types (size, flavour), so they are unique per type.
  'item-type-fields': { Model: ItemTypeField, entity: 'item_type_field', parentKey: 'itemTypeId', Parent: ItemType, parentLabel: 'Item type', scopedKey: true },
  'hire-categories': { Model: HireCategory, entity: 'hire_category' },
  'hire-roles': { Model: HireRole, entity: 'hire_role', parentKey: 'categoryId', Parent: HireCategory, parentLabel: 'Hire category' },
};

const invalid = (field, message) => new AppError(422, 'VALIDATION_FAILED', 'Some fields are invalid', { errors: [{ field, message }] });
const iso = (d) => (d ? new Date(d).toISOString() : null);
const HIDDEN = new Set(['createdAt', 'createdBy', 'updatedBy']);

/** Every column except the audit ones; missing optional values are null. */
function serialize(row, { latest } = {}) {
  const r = row.get({ plain: true });
  const out = {};
  for (const k of Object.keys(row.constructor.rawAttributes)) if (!HIDDEN.has(k)) out[k] = r[k] ?? null;
  out.updatedAt = iso(r.updatedAt);
  if (row instanceof EsportsPointsPreset) out.isLatest = latest ? latest.get(`${r.gameId}:${r.key}`) === r.version : true;
  return out;
}

/** Latest version per (gameId, key) among the given preset rows. */
function latestVersions(rows) {
  const latest = new Map();
  for (const r of rows) {
    const k = `${r.gameId}:${r.key}`;
    if (!latest.has(k) || latest.get(k) < r.version) latest.set(k, r.version);
  }
  return latest;
}

/** Rules that need the merged row; throws VALIDATION_FAILED. */
function checkRow(table, row) {
  if (table === 'esports-games') {
    const err = uidRegexError(row.uidRegex);
    if (err) throw invalid('uidRegex', err);
  }
  if (table === 'esports-modes') {
    const err = modeCapacityError(row);
    if (err) throw invalid('maxPlayers', err);
  }
  if (table === 'esports-points-presets') {
    const err = presetPointsError(row);
    if (err) throw invalid('placementPoints', err);
  }
  if (table === 'areas' && row.dhakaZone && !row.isDhakaMetro) throw invalid('dhakaZone', 'Only Dhaka metro areas have a zone');
  if (table === 'item-types' && Number(row.priceCeilingPoisha) <= Number(row.priceFloorPoisha)) throw invalid('priceCeilingPoisha', 'Above the lowest price');
  if (table === 'item-type-fields') {
    const err = itemFieldError(row);
    if (err) throw invalid(err.field, err.message);
  }
  if (table === 'hire-roles') {
    const err = hireRoleError(row);
    if (err) throw invalid(err.field, err.message);
  }
}

const cfg = (table) => TABLES[table];

async function emit(transaction, name, table, row, actor, extra = {}) {
  await events.publish(transaction, { name, aggregateType: cfg(table).entity, aggregateId: row.id, payload: { table, id: row.id, key: row.key, ...extra }, actor });
}

/** Admin list: every row including inactive ones and every preset version. */
async function list(table, query = {}) {
  const { Model, parentKey, versioned } = cfg(table);
  const where = parentKey && query[parentKey] ? { [parentKey]: query[parentKey] } : {};
  const rows = await Model.findAll({ where, order: [...(parentKey ? [[parentKey, 'ASC']] : []), ['sort', 'ASC'], ['key', 'ASC'], ...(versioned ? [['version', 'DESC']] : [])] });
  const latest = versioned ? latestVersions(rows) : undefined;
  return { items: rows.map((r) => serialize(r, { latest })) };
}

async function create(actor, table, body, req) {
  const { Model, parentKey, Parent, parentLabel, entity, versioned } = cfg(table);
  checkRow(table, body);
  const row = await sequelize.transaction(async (transaction) => {
    if (parentKey && !(await Parent.findByPk(body[parentKey], { transaction }))) throw E.notFound(parentLabel);
    // Keys are unique per parent for esports children, platform-wide everywhere else.
    const taken = await Model.findOne({ where: parentKey && (cfg(table).esports || cfg(table).scopedKey) ? { [parentKey]: body[parentKey], key: body.key } : { key: body.key }, transaction });
    if (taken) throw E.conflict('CATALOG_KEY_TAKEN', 'That key is already used', `Pick another key than ${body.key}`);
    const created = await Model.create({ ...body, ...(versioned ? { version: 1 } : {}), createdBy: actor.id, updatedBy: actor.id }, { transaction });
    await audit.record({ action: 'catalog_item.created', actor, entityType: entity, entityId: created.id, after: serialize(created), req }, { transaction });
    await emit(transaction, 'catalog_item.created', table, created, actor);
    return created;
  });
  return serialize(row);
}

async function update(actor, table, id, body, req) {
  const { Model, entity, versioned, parentKey } = cfg(table);
  const row = await sequelize.transaction(async (transaction) => {
    const current = await Model.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!current) throw E.notFound('Catalogue item');
    if (body.key !== undefined && body.key !== current.key) throw new AppError(422, 'CATALOG_KEY_IMMUTABLE', 'A key cannot change after it is created', { errors: [{ field: 'key', message: 'Keys are permanent' }] });
    if (parentKey && body[parentKey] !== undefined && body[parentKey] !== current[parentKey]) {
      throw new AppError(422, 'CATALOG_KEY_IMMUTABLE', 'An item cannot move to another parent', { errors: [{ field: parentKey, message: 'The parent is permanent' }] });
    }
    const changes = { ...body };
    delete changes.key;
    if (parentKey) delete changes[parentKey];
    const before = serialize(current);
    checkRow(table, { ...current.get({ plain: true }), ...changes });

    let saved;
    if (versioned) {
      // A new immutable version; older versions stay for the tournaments that used them.
      const top = await Model.max('version', { where: { gameId: current.gameId, key: current.key }, transaction });
      const base = current.get({ plain: true });
      saved = await Model.create(
        {
          gameId: base.gameId,
          key: base.key,
          nameEn: base.nameEn,
          nameBn: base.nameBn,
          sort: base.sort,
          isActive: base.isActive,
          placementPoints: base.placementPoints,
          killPoints: base.killPoints,
          ...changes,
          version: Number(top) + 1,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        { transaction }
      );
    } else {
      saved = await current.update({ ...changes, updatedBy: actor.id }, { transaction });
    }
    await audit.record({ action: 'catalog_item.updated', actor, entityType: entity, entityId: saved.id, before, after: serialize(saved), req }, { transaction });
    await emit(transaction, 'catalog_item.updated', table, saved, actor, versioned ? { version: saved.version } : {});
    return saved;
  });
  return serialize(row);
}

/** Deactivate or reactivate. For presets it applies to every version of that key. */
async function setActive(actor, table, id, isActive, req) {
  const { Model, entity, versioned } = cfg(table);
  const row = await sequelize.transaction(async (transaction) => {
    const current = await Model.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!current) throw E.notFound('Catalogue item');
    if (current.isActive === isActive) return current;
    if (versioned) await Model.update({ isActive, updatedBy: actor.id }, { where: { gameId: current.gameId, key: current.key }, transaction });
    else await current.update({ isActive, updatedBy: actor.id }, { transaction });
    await current.reload({ transaction });
    const action = isActive ? 'catalog_item.reactivated' : 'catalog_item.deactivated';
    await audit.record({ action, actor, entityType: entity, entityId: current.id, before: { isActive: !isActive }, after: { isActive }, req }, { transaction });
    // M03 §8 publishes created/updated/deactivated; a reactivation is an update for consumers.
    await emit(transaction, isActive ? 'catalog_item.updated' : 'catalog_item.deactivated', table, current, actor, { isActive });
    return current;
  });
  return serialize(row);
}

/** GET /catalog/esports/games: active games with active modes, maps and the latest preset versions. */
async function publicGames() {
  const games = await EsportsGame.findAll({ where: { isActive: true }, order: [['sort', 'ASC'], ['key', 'ASC']] });
  const gameIds = games.map((g) => g.id);
  const childWhere = { gameId: gameIds, isActive: true };
  const order = [['sort', 'ASC'], ['key', 'ASC']];
  const [modes, maps, presets] = await Promise.all([
    EsportsMode.findAll({ where: childWhere, order }),
    EsportsMap.findAll({ where: childWhere, order }),
    EsportsPointsPreset.findAll({ where: childWhere, order: [...order, ['version', 'DESC']] }),
  ]);
  const latest = latestVersions(presets);
  const current = presets.filter((p) => latest.get(`${p.gameId}:${p.key}`) === p.version);
  const byGame = (rows, gameId) => rows.filter((r) => r.gameId === gameId).map((r) => serialize(r, { latest }));
  return {
    items: games.map((g) => ({ ...serialize(g), modes: byGame(modes, g.id), maps: byGame(maps, g.id), presets: byGame(current, g.id) })),
  };
}

// ---------------- public places and sports (M03 §9) ----------------
const ORDER = [['sort', 'ASC'], ['nameEn', 'ASC']];
const pub = (row) => {
  const out = serialize(row);
  delete out.isActive;
  delete out.updatedAt;
  return out;
};
const activeList = async (Model, where = {}) => ({ items: (await Model.findAll({ where: { isActive: true, ...where }, order: ORDER })).map(pub) });

const publicSports = () => activeList(Sport);
const publicFacilities = () => activeList(Facility);

/** GET /catalog/exercises (M27-FR-70): the exercise library, active only, in its order; EN and BN. */
async function publicExercises() {
  const rows = await Exercise.findAll({ where: { status: 'active' }, order: [['sort', 'ASC'], ['nameEn', 'ASC']] });
  return {
    items: rows.map((x) => ({ key: x.key, nameEn: x.nameEn, nameBn: x.nameBn, muscle: x.muscle, equipment: x.equipment, level: x.level, stepsEn: x.stepsEn, stepsBn: x.stepsBn, videoUrl: x.videoUrl ?? null })),
  };
}
const publicSurfaces = () => activeList(Surface);

/** GET /catalog/locations: divisions with their districts (optionally one division). */
async function publicLocations({ divisionId } = {}) {
  const divisions = await Division.findAll({ where: { isActive: true, ...(divisionId ? { id: divisionId } : {}) }, order: ORDER });
  const districts = await District.findAll({ where: { isActive: true, divisionId: divisions.map((d) => d.id) }, order: ORDER });
  return { items: divisions.map((d) => ({ ...pub(d), districts: districts.filter((x) => x.divisionId === d.id).map(pub) })) };
}

/**
 * GET /catalog/areas: active areas, optionally in a district, offering a service (grounds), or
 * matching `q` against the English and Bangla names and the aliases.
 */
async function publicAreas({ districtId, service, q } = {}) {
  const where = { isActive: true };
  if (districtId) where.districtId = districtId;
  const rows = await Area.findAll({ where, order: ORDER });
  const bit = service ? AREA_FLAGS[service.toUpperCase()] : 0;
  const needle = q ? q.trim().toLowerCase() : '';
  const items = rows
    .filter((a) => !bit || (a.serviceFlags & bit) === bit)
    .filter((a) => !needle || [a.nameEn, a.nameBn, ...a.aliases].some((n) => n.toLowerCase().includes(needle)))
    .map(pub);
  return { items };
}

/**
 * GET /market/categories (M12 reads it): active item categories with their active item types and the
 * types' active spec fields, in display order. The vendor product form and the Market filters use it.
 */
async function publicItems() {
  const order = [['sort', 'ASC'], ['key', 'ASC']];
  const categories = await ItemCategory.findAll({ where: { isActive: true }, order });
  const types = await ItemType.findAll({ where: { isActive: true, categoryId: categories.map((x) => x.id) }, order });
  const fields = await ItemTypeField.findAll({ where: { isActive: true, itemTypeId: types.map((t) => t.id) }, order });
  const field = (f) => ({ key: f.key, labelEn: f.labelEn, labelBn: f.labelBn, kind: f.kind, options: f.options, unit: f.unit ?? null, min: f.minValue ?? null, max: f.maxValue ?? null, required: f.required, isVariantAxis: f.isVariantAxis });
  return {
    items: categories.map((k) => ({
      id: k.id,
      key: k.key,
      nameEn: k.nameEn,
      nameBn: k.nameBn,
      sportKey: k.sportKey ?? null,
      shopTypes: k.shopTypes,
      isSupplement: k.isSupplement,
      icon: k.icon ?? null,
      types: types
        .filter((t) => t.categoryId === k.id)
        .map((t) => ({ id: t.id, key: t.key, nameEn: t.nameEn, nameBn: t.nameBn, priceFloorPoisha: t.priceFloorPoisha, priceCeilingPoisha: t.priceCeilingPoisha, placeholderEn: t.placeholderEn ?? null, placeholderBn: t.placeholderBn ?? null, fields: fields.filter((f) => f.itemTypeId === t.id).map(field) })),
    })),
  };
}

module.exports = { publicItems, list, create, update, setActive, publicGames, publicSports, publicFacilities, publicExercises, publicSurfaces, publicLocations, publicAreas, TABLES };
