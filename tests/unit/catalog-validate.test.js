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
