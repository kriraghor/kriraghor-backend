'use strict';

/**
 * M03 reads of the hire taxonomy (hire_categories, hire_roles) for other modules: M02 checks a
 * credential's hire role and level, M11 prices and checks against the role. Active rows only.
 */
const { HireCategory, HireRole } = require('../../models');

const LEVELS = ['amateur', 'semi_pro', 'pro', 'national'];

function view(r, c) {
  return {
    id: r.id,
    key: r.key,
    nameEn: r.nameEn,
    nameBn: r.nameBn,
    categoryKey: c.key,
    forRole: c.forRole,
    sportKeys: r.sportKeys,
    allowedUnits: r.allowedUnits,
    formatPriced: r.formatPriced,
    formats: r.formats,
    baseHourlyPoisha: r.baseHourlyPoisha,
    specialisations: r.specialisations,
    credentialTiers: r.credentialTiers,
    levels: LEVELS.filter((l) => r.credentialTiers.some((t) => t.level === l)),
    requiresCredential: r.requiresCredential,
    policeCheckForU16: r.policeCheckForU16,
    isOfficial: r.isOfficial,
  };
}

/** A role by key (or id), with its category's platform role; null when unknown or inactive. */
async function role(keyOrId, { transaction } = {}) {
  const where = /^[0-9a-f-]{36}$/i.test(keyOrId) ? { id: keyOrId } : { key: keyOrId };
  const r = await HireRole.findOne({ where: { ...where, isActive: true }, include: [{ model: HireCategory, as: 'category' }], transaction });
  if (!r || !r.category?.isActive) return null;
  return view(r, r.category);
}

/** The whole active taxonomy: categories in order, each with its roles. */
async function taxonomy() {
  const cats = await HireCategory.findAll({ where: { isActive: true }, order: [['sort', 'ASC'], ['code', 'ASC']] });
  const roles = await HireRole.findAll({ where: { isActive: true, categoryId: cats.map((c) => c.id) }, order: [['sort', 'ASC'], ['key', 'ASC']] });
  return cats.map((c) => ({
    id: c.id,
    key: c.key,
    code: c.code,
    forRole: c.forRole,
    nameEn: c.nameEn,
    nameBn: c.nameBn,
    tint: c.tint ?? null,
    roles: roles.filter((r) => r.categoryId === c.id).map((r) => view(r, c)),
  }));
}

module.exports = { role, taxonomy, LEVELS };
