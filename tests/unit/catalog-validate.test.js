'use strict';

// M03 §7.1 / M21 §6.3 esports catalogue rules. 100% branch coverage (points feed prize money).
const { modeCapacityError, presetPointsError, uidRegexError } = require('../../src/modules/catalog/catalog.validate');

describe('mode capacity: max_teams × team_size ≤ max_players', () => {
  it('accepts the seeded squads', () => {
    expect(modeCapacityError({ teamSize: 4, maxTeams: 25, maxPlayers: 100 })).toBeNull(); // PUBG Mobile
    expect(modeCapacityError({ teamSize: 4, maxTeams: 12, maxPlayers: 50 })).toBeNull(); // Free Fire BR
  });
  it('rejects too many teams', () => {
    expect(modeCapacityError({ teamSize: 4, maxTeams: 13, maxPlayers: 50 })).toBe('13 teams of 4 need 52 players, more than the 50 allowed');
  });
});

describe('points presets', () => {
  it('accepts the M21 presets', () => {
    expect(presetPointsError({ placementPoints: [15, 12, 10, 8, 6, 4, 2, 1, 1, 1, 1, 1, 0], killPoints: 1 })).toBeNull();
    expect(presetPointsError({ placementPoints: [1, 0], killPoints: 0 })).toBeNull();
    expect(presetPointsError({ placementPoints: [0], killPoints: 1 })).toBeNull(); // kills-only
  });
  it('rejects a worse place scoring more', () => {
    expect(presetPointsError({ placementPoints: [10, 8, 9], killPoints: 1 })).toBe('Place 3 cannot score more than place 2');
  });
  it('rejects a table that awards nothing', () => {
    expect(presetPointsError({ placementPoints: [0, 0], killPoints: 0 })).toBe('The table must award some points');
  });
});

describe('UID pattern', () => {
  it('accepts anchored, valid patterns', () => {
    expect(uidRegexError('^[0-9]{5,12}$')).toBeNull();
  });
  it('requires both anchors', () => {
    expect(uidRegexError('[0-9]{5,12}$')).toBe('Start with ^ and end with $');
    expect(uidRegexError('^[0-9]{5,12}')).toBe('Start with ^ and end with $');
  });
  it('rejects a pattern that does not compile', () => {
    expect(uidRegexError('^[0-9{5,12$')).toBe('Not a valid pattern');
  });
});

describe('M03 item fields (M12; Q77)', () => {
  const { itemFieldError } = require('../../src/modules/catalog/catalog.validate');
  const opts = (...values) => values.map((value) => ({ value, labelEn: value, labelBn: value }));
  it('accepts a pick-list axis and a bounded number', () => {
    expect(itemFieldError({ kind: 'select', isVariantAxis: true, options: opts('S', 'M') })).toBeNull();
    expect(itemFieldError({ kind: 'number', minValue: 1, maxValue: 10 })).toBeNull();
    expect(itemFieldError({ kind: 'number', minValue: null, maxValue: 10 })).toBeNull();
    expect(itemFieldError({ kind: 'text' })).toBeNull();
  });
  it('refuses a non-select axis, an empty or duplicated pick-list and max below min', () => {
    expect(itemFieldError({ kind: 'text', isVariantAxis: true })).toEqual({ field: 'isVariantAxis', message: 'Only a pick-list can be a variant option' });
    expect(itemFieldError({ kind: 'select', options: [] })).toEqual({ field: 'options', message: 'Add at least one option' });
    expect(itemFieldError({ kind: 'select' })).toEqual({ field: 'options', message: 'Add at least one option' });
    expect(itemFieldError({ kind: 'select', options: opts('S', 'S') })).toEqual({ field: 'options', message: 'Option values must be unique' });
    expect(itemFieldError({ kind: 'number', minValue: 5, maxValue: 2 })).toEqual({ field: 'maxValue', message: 'At least the minimum' });
  });
});
