'use strict';

/**
 * Shared bits of M21: the error catalogue (spec §9 codes), catalogue lookups (M03 rows read through
 * the models M03 owns, read-only), the settings a tournament snapshots, and realtime room names.
 */
const { AppError } = require('../../common/errors');
const { EsportsGame, EsportsMode, EsportsMap, EsportsPointsPreset } = require('../../models');
const settings = require('../settings/settings.service');

const ERRORS = {
  // profiles and squads
  ESPORTS_GAME_UNKNOWN: [422, 'Choose an active game'],
  ESPORTS_UID_FORMAT: [422, 'The UID does not look right for this game'],
  ESPORTS_IGN_INVALID: [422, 'Enter your in-game name as it appears in the game'],
  ESPORTS_UID_BANNED: [403, 'This UID is banned from Kriraghor tournaments'],
  ESPORTS_UID_TAKEN: [409, 'This UID is already linked to another account'],
  ESPORTS_PROFILE_EXISTS: [409, 'You already have a UID for this game'],
  ESPORTS_PROFILE_IN_USE: [409, 'This UID is in an active tournament entry'],
  ESPORTS_UPLOAD_INVALID: [422, 'Upload the screenshot first'],
  ESPORTS_GAME_PROFILE_REQUIRED: [403, 'Every player needs a verified UID for this game'],
  ESPORTS_ALREADY_IN_SQUAD: [409, 'You are already in a squad for this game'],
  ESPORTS_SQUAD_NAME_TAKEN: [409, 'That squad name is taken for this game'],
  ESPORTS_SQUAD_FULL: [409, 'This squad is full'],
  ESPORTS_SQUAD_CAPTAIN_ONLY: [403, 'Only the captain can do this'],
  ESPORTS_SQUAD_INVITE_UNKNOWN: [404, 'Invite not found'],
  ESPORTS_NOT_IN_SQUAD: [403, 'You are not in this squad'],
  // tournaments
  ESPORTS_PRIZE_TABLE_LOCKED: [409, 'The prize table, fee, slots and schedule are locked after publishing'],
  ESPORTS_TOURNAMENT_STATE: [409, 'The tournament cannot do that in its current state'],
  ESPORTS_NOT_FINALISABLE: [409, 'Every match must be final and no dispute open before finalising'],
  PRIZE_TABLE_REQUIRED: [422, 'Add the prize table'],
  PRIZE_PLACES_INVALID: [422, 'Prize places must run 1, 2, 3… and fit the slots'],
  PRIZE_AMOUNT_INVALID: [422, 'Each prize must be more than zero'],
  MIN_ABOVE_MAX: [422, 'The minimum participants cannot be more than the slots'],
  ENTRY_UNIT_INVALID: [422, 'Squad modes take squad entries; solo modes take player entries'],
  SLOTS_ABOVE_LOBBY: [422, 'More slots than the lobby holds for this mode'],
  SCHEDULE_INVALID: [422, 'Registration must open in the future and close before the first match; matches in order'],
  POINTS_INVALID: [422, 'The points table is not valid'],
  STREAM_URL_INVALID: [422, 'Use an https link on YouTube, Facebook or TikTok'],
  // registration
  ESPORTS_REGISTRATION_CLOSED: [409, 'Registration is not open'],
  ESPORTS_ALREADY_REGISTERED: [409, 'A player in this entry is already registered in this tournament'],
  ESPORTS_SQUAD_SIZE_INVALID: [422, 'The number of players and substitutes does not match the mode'],
  SLOTS_FULL: [409, 'All slots are taken'],
  ESPORTS_REGISTRATION_STATE: [409, 'This entry cannot do that in its current state'],
  ESPORTS_OFFER_EXPIRED: [409, 'The slot offer has expired'],
  SPLIT_INVALID: [422, 'Give each playing member a whole percent; they must add up to 100'],
  ESPORTS_SPLIT_LOCKED: [409, 'The prize split can only change before the first match'],
  ESPORTS_CHECKIN_CLOSED: [409, 'Check-in is not open'],
  ESPORTS_NOT_IN_MATCH: [403, 'You are not in this match'],
  // rooms
  ESPORTS_NOT_CHECKED_IN: [403, 'Check in to see the room'],
  ESPORTS_ROOM_NOT_REVEALED: [409, 'The room is not revealed yet'],
  ESPORTS_ROOM_NOT_SET: [409, 'The room is not set yet'],
  // results
  ESPORTS_RESULT_ENTRY_UNKNOWN: [422, 'Every row must be a different entry in this match'],
  ESPORTS_PLACEMENT_INVALID: [422, 'Placements run from 1 to the number of entries'],
  ESPORTS_PLACEMENT_DUPLICATE: [422, 'Two entries cannot share a placement'],
  ESPORTS_KILLS_MISMATCH: [422, 'Kills must be whole numbers for players in that entry'],
  ESPORTS_MATCH_STATE: [409, 'The match cannot do that in its current state'],
  ESPORTS_TOO_EARLY: [409, 'Results can only be posted after the match starts'],
  ESPORTS_DISPUTE_WINDOW_CLOSED: [409, 'The dispute window is closed'],
  ESPORTS_DISPUTE_LIMIT: [409, 'You have used all your disputes for this match'],
  ESPORTS_DISPUTE_NOT_OPEN: [409, 'This dispute is already resolved'],
  ESPORTS_ALREADY_DISQUALIFIED: [409, 'This entry is already disqualified'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

// ---------------------------------------------------------------- M03 catalogue (read-only)

async function game(id, { transaction } = {}) {
  const g = await EsportsGame.findByPk(id, { transaction });
  if (!g || !g.isActive) throw fail('ESPORTS_GAME_UNKNOWN');
  return g;
}
async function mode(id, gameId, { transaction } = {}) {
  const m = await EsportsMode.findByPk(id, { transaction });
  if (!m || !m.isActive || m.gameId !== gameId) throw fail('ESPORTS_GAME_UNKNOWN');
  return m;
}
async function maps(ids, gameId, { transaction } = {}) {
  const rows = await EsportsMap.findAll({ where: { id: [...new Set(ids)] }, transaction });
  if (rows.length !== new Set(ids).size || rows.some((r) => r.gameId !== gameId || !r.isActive)) throw fail('ESPORTS_GAME_UNKNOWN');
  return new Map(rows.map((r) => [r.id, r]));
}
async function preset(id, gameId, { transaction } = {}) {
  const p = await EsportsPointsPreset.findByPk(id, { transaction });
  if (!p || p.gameId !== gameId) throw fail('POINTS_INVALID');
  return p;
}
/** The largest roster a squad of this game needs (team size + substitutes, Q127). */
async function maxSquadSize(gameId, { transaction } = {}) {
  const modes = await EsportsMode.findAll({ where: { gameId, isActive: true }, transaction });
  return Math.max(1, ...modes.map((m) => m.teamSize + m.maxSubs));
}

// ---------------------------------------------------------------- settings snapshot (§6.1)

const SNAPSHOT_KEYS = [
  'esports.payment_hold_minutes',
  'esports.withdraw_refund_pct',
  'esports.checkin_open_minutes',
  'esports.checkin_close_minutes',
  'esports.room_reveal_minutes',
  'esports.result_dispute_minutes',
  'esports.dispute_max_per_entry',
  'esports.tier_weights',
];
const snapshot = () => Object.fromEntries(SNAPSHOT_KEYS.map((k) => [k, settings.get(k)]));
/** A tournament's value: its snapshot (taken at publish) or the live setting before that. */
const setting = (t, key) => (t.settingsSnapshot && t.settingsSnapshot[key] !== undefined ? t.settingsSnapshot[key] : settings.get(key));

// ---------------------------------------------------------------- realtime rooms

const rooms = {
  tournament: (id) => `esports_tournament:${id}`,
  match: (id) => `esports_match:${id}`,
};

const money = (poisha) => ({ amount: poisha, currency: 'BDT' });

module.exports = { ERRORS, fail, game, mode, maps, preset, maxSquadSize, SNAPSHOT_KEYS, snapshot, setting, rooms, money };
