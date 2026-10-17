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

// M03 hire taxonomy (M11 §6.1): roles priced per match format, credential tiers in order.
describe('hire role (M11)', () => {
  const { hireRoleError } = require('../../src/modules/catalog/catalog.validate');
  const tiers = (...levels) => levels.map((level) => ({ level, labelEn: level, labelBn: level }));
  it('accepts the seeded umpire and an hourly coach', () => {
    expect(hireRoleError({ allowedUnits: ['match', 'hourly'], formatPriced: true, formats: ['T10', 'T20'], credentialTiers: tiers('amateur', 'semi_pro', 'pro', 'national'), requiresCredential: true })).toBeNull();
    expect(hireRoleError({ allowedUnits: ['hourly'] })).toBeNull();
    expect(hireRoleError({})).toBeNull(); // a PATCH merged onto a row without the lists
  });
  it('refuses formats without match pricing, and match pricing without formats or the match unit', () => {
    expect(hireRoleError({ allowedUnits: ['hourly'], formatPriced: true, formats: ['T20'] })).toEqual({ field: 'formatPriced', message: 'Only a role hired by the match is priced per format' });
    expect(hireRoleError({ allowedUnits: ['match'], formatPriced: true, formats: [] })).toEqual({ field: 'formats', message: 'Add the match formats' });
    expect(hireRoleError({ allowedUnits: ['match'], formatPriced: false, formats: ['T20'] })).toEqual({ field: 'formats', message: 'Formats need format pricing' });
  });
  it('refuses tiers out of order, repeated or unknown, and a credential role without tiers', () => {
    const order = { field: 'credentialTiers', message: 'Levels go up once each: amateur, semi_pro, pro, national' };
    expect(hireRoleError({ allowedUnits: ['match'], credentialTiers: tiers('pro', 'semi_pro') })).toEqual(order);
    expect(hireRoleError({ allowedUnits: ['match'], credentialTiers: tiers('pro', 'pro') })).toEqual(order);
    expect(hireRoleError({ allowedUnits: ['match'], credentialTiers: tiers('grandmaster') })).toEqual(order);
    expect(hireRoleError({ allowedUnits: ['match'], requiresCredential: true })).toEqual({ field: 'credentialTiers', message: 'A role that needs a credential lists its tiers' });
  });
});
