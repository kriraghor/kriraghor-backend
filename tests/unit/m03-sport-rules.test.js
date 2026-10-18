'use strict';

// M03 sport rule schemas for M14 (M14-FR-08, §6.10): 100% coverage gate, plus the seed's shape.
const R = require('../../src/modules/catalog/sport-rules.rules');
const seed = require('../../src/db/seed/reference/rules.v1.json');
const places = require('../../src/db/seed/reference/places.v1.json');

const cricket = seed.sportRules.find((s) => s.sport === 'cricket');

describe('M03 sport-rules.rules', () => {
  it('starts from defaults, applies a preset, then the organiser values', () => {
    expect(R.validate(cricket).values.overs).toBe(20);
    expect(R.validate(cricket).presetKey).toBe('custom');
    const t10 = R.validate(cricket, {}, 't10');
    expect([t10.values.overs, t10.values.maxOv, t10.presetKey]).toEqual([10, 2, 't10']);
    const same = R.validate(cricket, { overs: 10, superOver: true }, 't10');
    expect(same.presetKey).toBe('t10');
    const changed = R.validate(cricket, { overs: 12 }, 't10');
    expect([changed.values.overs, changed.presetKey]).toEqual([12, 'custom']);
  });

  it('refuses unknown presets, unknown fields and values out of range', () => {
    expect(R.validate(cricket, {}, 'tests')).toEqual({ error: { code: 'RULE_PRESET_UNKNOWN', field: 'presetKey' } });
    expect(R.validate(cricket, { innings: 2 })).toEqual({ error: { code: 'RULE_UNKNOWN_FIELD', field: 'innings' } });
    expect(R.validate(cricket, { overs: 51 })).toEqual({ error: { code: 'RULE_OUT_OF_RANGE', field: 'overs' } });
    expect(R.validate(cricket, { overs: 20.5 })).toEqual({ error: { code: 'RULE_OUT_OF_RANGE', field: 'overs' } });
    expect(R.validate(cricket, { ball: 'rubber' })).toEqual({ error: { code: 'RULE_OUT_OF_RANGE', field: 'ball' } });
    expect(R.validate(cricket, { dls: 'yes' })).toEqual({ error: { code: 'RULE_OUT_OF_RANGE', field: 'dls' } });
  });

  it('knows players per side, including rally disciplines', () => {
    expect(R.playersOf({ players: 7 })).toBe(7);
    expect(R.playersOf({})).toBe(1);
    expect(R.playersOf({ disc: 'xd' })).toBe(2);
    expect(R.playersOf({ disc: 'ms' })).toBe(1);
    expect(R.playersOf({ disc: 'doubles' })).toBe(2);
  });

  it('summarises the rules in English and Bangla', () => {
    const v = R.validate(cricket, {}, 't20').values;
    const en = R.summary(cricket, v, 'en');
    expect(en).toContain('Overs per side: 20');
    expect(en).toContain('Ball: Leather');
    expect(en).toContain('Free hit after a no-ball: Yes');
    expect(en).toContain('DLS for rain: No');
    const bn = R.summary(cricket, v, 'bn');
    expect(bn).toContain('বল: লেদার');
    expect(bn).toContain('হ্যাঁ');
    expect(bn).toContain('না');
    expect(R.summary(cricket, v)).toBe(en);
  });

  it('seeds a valid schema with valid presets for every sport that takes teams', () => {
    const teamSports = places.sports.filter((s) => (s.positions ?? []).length).map((s) => s.key);
    expect(seed.sportRules.map((s) => s.sport).sort()).toEqual([...teamSports].sort());
    for (const s of seed.sportRules) {
      for (const f of s.fields) expect(R.fieldOk(f, f.default)).toBe(true);
      for (const p of s.presets) expect(R.validate(s, {}, p.key).error).toBeUndefined();
      expect(s.fields.some((f) => f.key === 'pW')).toBe(true);
    }
  });
});
