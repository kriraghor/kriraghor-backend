'use strict';

/** Shared bits of M14: the error catalogue, settings read per call, events, ownership loaders. */
const { AppError, E } = require('../../common/errors');
const events = require('../events/events.service');
const settings = require('../settings/settings.service');
const { Tournament, TournamentRules, Match } = require('../../models');

const ERRORS = {
  SPORT_NOT_SUPPORTED: [422, 'Choose a team sport'],
  TOURNAMENT_STATE: [409, 'The event is not at a stage where this can be done'],
  TOURNAMENT_INCOMPLETE: [422, 'Finish the event details before submitting'],
  NAME_TAKEN: [409, 'Your organisation already has an event with this name this year'],
  RULE_OUT_OF_RANGE: [422, 'A rule value is outside what the sport allows'],
  RULE_PRESET_UNKNOWN: [422, 'Choose one of the presets'],
  RULE_UNKNOWN_FIELD: [422, 'That rule does not exist for this sport'],
  RULES_LOCKED: [409, 'The rules are locked. Unlock them with a reason first'],
  TIEBREAKER_INVALID: [422, 'Use the tiebreakers this sport allows'],
  CAPACITY_INVALID: [422, 'Teams: at least 2, and the minimum cannot be above the maximum'],
  GROUPS_INVALID: [422, 'Groups need 2 to 16 groups with at least two teams each'],
  QUALIFIERS_INVALID: [422, 'Choose how many teams go through from each group (fewer than the group size)'],
  KNOCKOUT_TOP_INVALID: [422, 'Teams to a knockout: 0, 2, 4 or 8, and no more than the minimum teams'],
  MAX_TEAMS_TOO_HIGH: [422, 'That is more teams than an event can have'],
  DATES_MISSING: [422, 'Set the registration window and the match dates'],
  REGISTRATION_WINDOW_INVALID: [422, 'Registration must open before it closes'],
  REGISTRATION_CLOSES_TOO_LATE: [422, 'Registration must close a little before the first match day'],
  END_BEFORE_START: [422, 'The last match day cannot be before the first'],
  START_TOO_SOON: [422, 'The first match day is too soon for staff review and registration'],
  SQUAD_LIMITS_INVALID: [422, 'Squad sizes must fit the sport and be at most 30'],
  PRIZE_SPLIT_INVALID: [422, 'The prize split must add up to 100%'],
  PRIZE_SPLIT_WITHOUT_POOL: [422, 'Set a prize pool before splitting it'],
  ENTRY_FEE_TOO_HIGH: [422, 'The entry fee is above the most allowed'],
  VENUE_INVALID: [422, 'Pick a listed venue, or type one with its area'],
  VENUE_IN_USE: [409, 'Matches use this venue. Move them first'],
  REGISTRATION_NOT_YET_OPEN: [409, 'Registration has not opened yet'],
  REGISTRATION_CLOSED: [409, 'Registration is closed'],
  TEAM_ALREADY_REGISTERED: [409, 'This team is already in the event'],
  TEAM_SPORT_MISMATCH: [422, 'The team plays a different sport'],
  TEAM_ARCHIVED: [409, 'This team is archived'],
  NOT_TEAM_CAPTAIN: [403, 'Only the captain or vice-captain can do this'],
  SQUAD_TOO_SMALL: [422, 'Pick more players for the squad'],
  SQUAD_TOO_LARGE: [422, 'Pick fewer players for the squad'],
  PLAYER_NOT_IN_TEAM: [422, 'Pick players from the team'],
  PLAYER_IN_OTHER_TEAM: [409, 'A player is already in another team in this event'],
  ROSTER_NOT_READY: [409, 'The squad does not have enough eligible players yet'],
  ROSTER_FROZEN: [409, 'The squad is fixed now that matches have started'],
  CAPACITY_FULL: [409, 'All places are taken'],
  REGISTRATION_STATE: [409, 'This registration cannot be changed now'],
  NOT_ENOUGH_TEAMS: [409, 'At least two approved teams are needed'],
  REGISTRATION_STILL_OPEN: [409, 'Close registration first'],
  PENDING_DECISIONS: [409, 'Approve or reject the teams waiting for a decision first'],
  DRAW_NOT_CONFIRMED: [409, 'Confirm the draw first'],
  DRAW_INVALID: [422, 'The manual order must list every approved team once'],
  FIXTURES_EXIST: [409, 'Fixtures are already generated'],
  FIXTURES_MISSING: [409, 'Generate fixtures first'],
  RESULTS_EXIST: [409, 'Results are in. Fixtures can no longer be regenerated'],
  EXTEND_NOT_ALLOWED: [409, 'Registration can be extended once, before fixtures'],
  MATCH_STATE: [409, 'The match is not at a stage where this can be done'],
  MATCH_TEAMS_UNKNOWN: [409, 'Both teams must be known first'],
  SCHEDULE_CLASH: [409, 'That time clashes with another match'],
  VERSION_CONFLICT: [409, 'Someone else changed this. Reload and try again'],
  LOTS_NOT_NEEDED: [409, 'No tie needs drawing lots here'],
  LOTS_INVALID: [422, 'List each tied team once, in the order drawn'],
  WALKOVER_TOO_EARLY: [409, 'A no-show walkover can be given 30 minutes after the start'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

const config = () => ({
  closeDays: settings.get('tournament.registration_close_days'),
  minStartDays: settings.get('tournament.min_start_days'),
  holdMinutes: settings.get('tournament.payment_hold_minutes'),
  offerHours: settings.get('tournament.reserve_offer_hours'),
  afterClosePct: settings.get('tournament.withdraw_refund_after_close_pct'),
  feeMax: settings.get('tournament.entry_fee_max_poisha'),
  maxTeams: settings.get('tournament.max_teams'),
  relockHours: settings.get('tournament.rules_relock_hours'),
  releasePct: settings.get('tournament.escrow_release_first_match_pct'),
});

const publish = (transaction, name, aggregateType, aggregateId, payload, actor = null) => events.publish(transaction, { name, aggregateType, aggregateId, payload, actor });

const DHAKA_MS = 6 * 3600000;
const today = (now = new Date()) => new Date(now.getTime() + DHAKA_MS).toISOString().slice(0, 10);

/** A tournament of this organisation (404 otherwise, so ids cannot be probed). */
async function ownTournament(org, id, { transaction, lock = false } = {}) {
  const t = await Tournament.findOne({ where: { id, organisationId: org.id }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!t) throw E.notFound('Tournament');
  return t;
}

/**
 * A match of one of this organisation's tournaments, with its tournament. Locks always go tournament
 * first, then match (the order every M14 path uses), so two edits can never deadlock.
 */
async function ownMatch(org, matchId, { transaction, lock = false } = {}) {
  const probe = await Match.findByPk(matchId, { attributes: ['id', 'tournamentId'], transaction });
  const t = probe && (await Tournament.findOne({ where: { id: probe.tournamentId, organisationId: org.id }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) }));
  if (!t) throw E.notFound('Match');
  const m = await Match.findByPk(matchId, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  return { m, t };
}

const rulesOf = (tournamentId, transaction) => TournamentRules.findByPk(tournamentId, { transaction });

module.exports = { ERRORS, fail, config, publish, today, ownTournament, ownMatch, rulesOf };
