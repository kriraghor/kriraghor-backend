'use strict';

/**
 * M03 sport rule schemas (M14-FR-08): the latest active version per sport for new tournaments, an
 * exact version for existing ones, and the public payload the wizard renders (fields, presets, the
 * tiebreakers a sport allows). Other modules call this, never the table.
 */
const { E } = require('../../common/errors');
const { Sport, SportRuleSchema } = require('../../models');

const shape = (sport, row) => ({
  sport: { id: sport.id, key: sport.key, nameEn: sport.nameEn, nameBn: sport.nameBn, engine: sport.engine, defaultTiebreakers: sport.defaultTiebreakers ?? [] },
  version: row.version,
  fields: row.fields,
  presets: row.presets,
  tiebreakers: row.tiebreakers,
});

/** The schema for a sport: an exact version, or the latest active one. Null when the sport has none. */
async function schemaFor(sportId, { version = null, transaction } = {}) {
  const sport = await Sport.findByPk(sportId, { transaction });
  if (!sport) return null;
  const row = await SportRuleSchema.findOne({ where: { sportId, ...(version ? { version } : { isActive: true }) }, order: [['version', 'DESC']], transaction });
  return row ? shape(sport, row) : null;
}

/** A sport that takes tournaments, by key, with its latest schema. */
async function bySportKey(key, { transaction } = {}) {
  const sport = await Sport.findOne({ where: { key, isActive: true }, transaction });
  const row = sport && (await SportRuleSchema.findOne({ where: { sportId: sport.id, isActive: true }, order: [['version', 'DESC']], transaction }));
  return row ? shape(sport, row) : null;
}

/** GET /catalog/sport-rules/:sportKey (public, for the wizard and the hub). */
async function publicSchema(key) {
  const s = await bySportKey(key);
  if (!s) throw E.notFound('Sport rules');
  return s;
}

module.exports = { schemaFor, bySportKey, publicSchema };
