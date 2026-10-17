'use strict';

/**
 * Esports catalogue rules that need the merged row (create body or current row + patch).
 * Pure functions, unit-tested with 100% branch coverage (points feed prize money in M21).
 */

/** M03 §7.1: max_teams × team_size ≤ max_players. Returns a message or null. */
function modeCapacityError({ teamSize, maxTeams, maxPlayers }) {
  if (teamSize * maxTeams > maxPlayers) return `${maxTeams} teams of ${teamSize} need ${teamSize * maxTeams} players, more than the ${maxPlayers} allowed`;
  return null;
}

/**
 * M21 §6.3 points preset: index 0 is 1st place. Points never go up for a worse placement,
 * and the table must award something (otherwise every team ties).
 */
function presetPointsError({ placementPoints, killPoints }) {
  for (let i = 1; i < placementPoints.length; i += 1) {
    if (placementPoints[i] > placementPoints[i - 1]) return `Place ${i + 1} cannot score more than place ${i}`;
  }
  if (placementPoints[0] === 0 && killPoints === 0) return 'The table must award some points';
  return null;
}

/** Staff-entered UID pattern: must compile and be anchored, so "12345abc" never half-matches. */
function uidRegexError(pattern) {
  if (!pattern.startsWith('^') || !pattern.endsWith('$')) return 'Start with ^ and end with $';
  try {
    new RegExp(pattern);
    return null;
  } catch {
    return 'Not a valid pattern';
  }
}

/**
 * M12 item fields: a select needs options with unique values (and an axis is always a select);
 * min ≤ max for numbers. Returns { field, message } or null.
 */
function itemFieldError(row) {
  if (row.isVariantAxis && row.kind !== 'select') return { field: 'isVariantAxis', message: 'Only a pick-list can be a variant option' };
  if (row.kind === 'select') {
    const values = (row.options ?? []).map((o) => o.value);
    if (!values.length) return { field: 'options', message: 'Add at least one option' };
    if (new Set(values).size !== values.length) return { field: 'options', message: 'Option values must be unique' };
  }
  if (row.minValue !== null && row.minValue !== undefined && row.maxValue !== null && row.maxValue !== undefined && Number(row.maxValue) < Number(row.minValue)) return { field: 'maxValue', message: 'At least the minimum' };
  return null;
}

module.exports = { modeCapacityError, presetPointsError, uidRegexError, itemFieldError };
