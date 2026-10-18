'use strict';

/**
 * M03 sport rule schemas (pure; 100% coverage gate). M14-FR-08, §4.3, §6.10.
 * A schema is {fields:[{key, type:'int'|'enum'|'bool', min, max, options:[{key,en,bn}], default,
 * group, en, bn}], presets:[{key, en, bn, values}]}. Values start from the field defaults, then the
 * preset, then the organiser's own values.
 */

/** Checks one value against its field. */
function fieldOk(f, v) {
  if (f.type === 'int') return Number.isInteger(v) && v >= f.min && v <= f.max;
  if (f.type === 'enum') return f.options.some((o) => o.key === v);
  return typeof v === 'boolean';
}

/**
 * Full rule values for a tournament. Returns {values, presetKey} or {error:{code, field}} with codes
 * RULE_PRESET_UNKNOWN, RULE_UNKNOWN_FIELD, RULE_OUT_OF_RANGE.
 */
function validate(schema, given = {}, presetKey = null) {
  const preset = presetKey ? schema.presets.find((p) => p.key === presetKey) : null;
  if (presetKey && !preset) return { error: { code: 'RULE_PRESET_UNKNOWN', field: 'presetKey' } };
  const byKey = new Map(schema.fields.map((f) => [f.key, f]));
  for (const k of Object.keys(given)) if (!byKey.has(k)) return { error: { code: 'RULE_UNKNOWN_FIELD', field: k } };
  const values = Object.fromEntries(schema.fields.map((f) => [f.key, f.default]));
  Object.assign(values, preset?.values ?? {}, given);
  for (const f of schema.fields) if (!fieldOk(f, values[f.key])) return { error: { code: 'RULE_OUT_OF_RANGE', field: f.key } };
  // Any change away from the preset makes it "custom" (§4.2 step 3).
  const custom = !preset || Object.entries(given).some(([k, v]) => (preset.values[k] ?? byKey.get(k).default) !== v);
  return { values, presetKey: custom ? 'custom' : preset.key };
}

/** Players per side: the rule's `players`, or 1/2 from a rally discipline (singles, doubles). */
function playersOf(values) {
  if (values.disc) return ['md', 'wd', 'xd', 'doubles'].includes(values.disc) ? 2 : 1;
  return values.players ?? 1;
}

/** A plain-language rules summary for the hub, built from the schema labels (§4.3). */
function summary(schema, values, locale = 'en') {
  const lang = locale === 'bn' ? 'bn' : 'en';
  const shown = (f) => {
    const v = values[f.key];
    if (f.type === 'enum') return f.options.find((o) => o.key === v)[lang];
    if (f.type === 'bool') return v ? (lang === 'bn' ? 'হ্যাঁ' : 'Yes') : lang === 'bn' ? 'না' : 'No';
    return String(v);
  };
  return schema.fields.map((f) => `${f[lang]}: ${shown(f)}`).join(' · ');
}

module.exports = { fieldOk, validate, playersOf, summary };
