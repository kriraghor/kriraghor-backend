'use strict';

/**
 * M03 esports catalogue (§7.1 [v3]): games, modes, maps and points presets.
 *  - Rows are never deleted: deactivate hides them from pickers, old references stay valid (M03-FR-01).
 *  - `key` (and the parent game) are immutable after create: CATALOG_KEY_IMMUTABLE.
 *  - Points presets are immutable rows: an edit inserts version n+1, so tournaments that
 *    snapshotted an older version keep scoring with it.
 */
const { AppError, E } = require('../../common/errors');
const { sequelize, EsportsGame, EsportsMode, EsportsMap, EsportsPointsPreset } = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const { modeCapacityError, presetPointsError, uidRegexError } = require('./catalog.validate');

const TABLES = {
  'esports-games': { Model: EsportsGame, entity: 'esports_game', parent: false },
  'esports-modes': { Model: EsportsMode, entity: 'esports_mode', parent: true },
  'esports-maps': { Model: EsportsMap, entity: 'esports_map', parent: true },
  'esports-points-presets': { Model: EsportsPointsPreset, entity: 'esports_points_preset', parent: true, versioned: true },
};

const invalid = (field, message) => new AppError(422, 'VALIDATION_FAILED', 'Some fields are invalid', { errors: [{ field, message }] });
const iso = (d) => (d ? new Date(d).toISOString() : null);

function serialize(row, { latest } = {}) {
  const r = row.get({ plain: true });
  const out = { id: r.id, key: r.key, nameEn: r.nameEn, nameBn: r.nameBn, sort: r.sort, isActive: r.isActive, updatedAt: iso(r.updatedAt) };
  if (row instanceof EsportsGame) {
    return { ...out, publisher: r.publisher ?? null, platform: r.platform, uidLabelEn: r.uidLabelEn, uidLabelBn: r.uidLabelBn, uidRegex: r.uidRegex, ignMaxLen: r.ignMaxLen, icon: r.icon ?? null };
  }
  out.gameId = r.gameId;
  if (row instanceof EsportsMode) return { ...out, teamSize: r.teamSize, maxTeams: r.maxTeams, maxPlayers: r.maxPlayers, maxSubs: r.maxSubs };
  if (row instanceof EsportsPointsPreset) {
    return { ...out, placementPoints: r.placementPoints, killPoints: r.killPoints, version: r.version, isLatest: latest ? latest.get(`${r.gameId}:${r.key}`) === r.version : true };
  }
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
}

const cfg = (table) => TABLES[table];

async function emit(transaction, name, table, row, actor, extra = {}) {
  await events.publish(transaction, { name, aggregateType: cfg(table).entity, aggregateId: row.id, payload: { table, id: row.id, key: row.key, ...extra }, actor });
}

/** Admin list: every row including inactive ones and every preset version. */
async function list(table, { gameId } = {}) {
  const { Model, parent } = cfg(table);
  const where = parent && gameId ? { gameId } : {};
  const rows = await Model.findAll({ where, order: [...(parent ? [['gameId', 'ASC']] : []), ['sort', 'ASC'], ['key', 'ASC'], ...(cfg(table).versioned ? [['version', 'DESC']] : [])] });
  const latest = cfg(table).versioned ? latestVersions(rows) : undefined;
  return { items: rows.map((r) => serialize(r, { latest })) };
}

async function create(actor, table, body, req) {
  const { Model, parent, entity } = cfg(table);
  checkRow(table, body);
  const row = await sequelize.transaction(async (transaction) => {
    if (parent && !(await EsportsGame.findByPk(body.gameId, { transaction }))) throw E.notFound('Game');
    const taken = await Model.findOne({ where: parent ? { gameId: body.gameId, key: body.key } : { key: body.key }, transaction });
    if (taken) throw E.conflict('CATALOG_KEY_TAKEN', 'That key is already used', `Pick another key than ${body.key}`);
    const created = await Model.create({ ...body, ...(cfg(table).versioned ? { version: 1 } : {}), createdBy: actor.id, updatedBy: actor.id }, { transaction });
    await audit.record({ action: 'catalog_item.created', actor, entityType: entity, entityId: created.id, after: serialize(created), req }, { transaction });
    await emit(transaction, 'catalog_item.created', table, created, actor);
    return created;
  });
  return serialize(row);
}

async function update(actor, table, id, body, req) {
  const { Model, entity, versioned } = cfg(table);
  const row = await sequelize.transaction(async (transaction) => {
    const current = await Model.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!current) throw E.notFound('Catalogue item');
    if (body.key !== undefined && body.key !== current.key) throw new AppError(422, 'CATALOG_KEY_IMMUTABLE', 'A key cannot change after it is created', { errors: [{ field: 'key', message: 'Keys are permanent' }] });
    if (body.gameId !== undefined && body.gameId !== current.gameId) throw new AppError(422, 'CATALOG_KEY_IMMUTABLE', 'An item cannot move to another game', { errors: [{ field: 'gameId', message: 'The game is permanent' }] });
    const changes = { ...body };
    delete changes.key;
    delete changes.gameId;
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

module.exports = { list, create, update, setActive, publicGames, TABLES };
