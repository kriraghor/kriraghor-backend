'use strict';

/**
 * M14 Tournaments, step 1 (migration 20261105000003): tournaments, their rules and venues, stages,
 * groups and the draw, registrations with the entry fee in escrow, and matches. M15 lite results and
 * standings (20261105000005) live here too, owned by the scoring module. index.js re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');
const { toPoisha } = require('../common/money');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const ts = { createdAt: 'createdAt', updatedAt: 'updatedAt' };
// BIGINT comes back as a string from pg: read money as poisha (a safe JS integer).
const bigint = (field, allowNull = false) => ({
  type: DataTypes.BIGINT,
  allowNull,
  ...(allowNull ? {} : { defaultValue: 0 }),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : toPoisha(v);
  },
});
// A fresh object per attribute: Sequelize writes the column name into the definition it is given.
const count = () => ({ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });

const TOURNAMENT_STATUS = ['draft', 'pending_review', 'changes_requested', 'rejected', 'registration_open', 'registration_closed', 'live', 'completed', 'cancelled'];
const REG_STATUS = ['pending_payment', 'reserve', 'offered', 'pending_approval', 'approved', 'rejected', 'lapsed', 'withdrawn', 'removed', 'cancelled'];
const MATCH_STATUS = ['draft', 'scheduled', 'postponed', 'completed', 'no_result', 'walkover', 'abandoned', 'cancelled'];

class Tournament extends Model {}
Tournament.init(
  {
    id,
    organisationId: req(DataTypes.UUID),
    sportId: req(DataTypes.UUID),
    slug: req(DataTypes.STRING(100)),
    name: req(DataTypes.STRING(80)),
    description: DataTypes.TEXT,
    format: req(DataTypes.ENUM('league', 'double_league', 'groups_knockout', 'knockout')),
    category: DataTypes.STRING(20),
    status: { type: DataTypes.ENUM(...TOURNAMENT_STATUS), allowNull: false, defaultValue: 'draft' },
    minTeams: req(DataTypes.SMALLINT),
    maxTeams: req(DataTypes.SMALLINT),
    squadMin: req(DataTypes.SMALLINT),
    squadMax: req(DataTypes.SMALLINT),
    entryFeePoisha: bigint('entryFeePoisha'),
    prizePoolPoisha: bigint('prizePoolPoisha', true),
    prizeSplit: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    prizeText: DataTypes.STRING(200),
    eligibility: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    contactUserId: DataTypes.UUID,
    registrationOpensAt: DataTypes.DATE(3),
    registrationClosesAt: DataTypes.DATE(3),
    startDate: DataTypes.DATEONLY,
    endDate: DataTypes.DATEONLY,
    feeBps: DataTypes.INTEGER,
    releasePct: DataTypes.SMALLINT,
    rulesLockedAt: DataTypes.DATE(3),
    rulesUnlockedUntil: DataTypes.DATE(3),
    firstResultAt: DataTypes.DATE(3),
    tranche1At: DataTypes.DATE(3),
    extended: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    currentSubmissionId: DataTypes.UUID,
    reviewReason: DataTypes.JSONB,
    approvedAt: DataTypes.DATE(3),
    completedAt: DataTypes.DATE(3),
    cancelledAt: DataTypes.DATE(3),
    cancelledBy: DataTypes.UUID,
    cancelReason: DataTypes.STRING(255),
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    createdBy: req(DataTypes.UUID),
    updatedBy: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Tournament', tableName: 'tournaments', ...ts }
);

class TournamentRules extends Model {}
TournamentRules.init(
  {
    tournamentId: { type: DataTypes.UUID, primaryKey: true },
    schemaVersion: req(DataTypes.SMALLINT),
    presetKey: req(DataTypes.STRING(30)),
    values: req(DataTypes.JSONB),
    formatConfig: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    tiebreakers: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    summaryEn: DataTypes.TEXT,
    summaryBn: DataTypes.TEXT,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'TournamentRules', tableName: 'tournament_rules', ...ts }
);

class TournamentVenue extends Model {}
TournamentVenue.init(
  {
    id,
    tournamentId: req(DataTypes.UUID),
    groundId: DataTypes.UUID,
    venueText: DataTypes.STRING(160),
    areaId: DataTypes.UUID,
    courts: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'TournamentVenue', tableName: 'tournament_venues', ...ts }
);

class Stage extends Model {}
Stage.init(
  {
    id,
    tournamentId: req(DataTypes.UUID),
    key: req(DataTypes.ENUM('L', 'G', 'K')),
    kind: req(DataTypes.ENUM('league', 'group', 'knockout')),
    seq: req(DataTypes.SMALLINT),
    seeding: DataTypes.ENUM('registration_order', 'manual', 'random'),
    drawSeed: DataTypes.STRING(64),
    drawConfirmedAt: DataTypes.DATE(3),
    drawConfirmedBy: DataTypes.UUID,
    lots: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    status: { type: DataTypes.ENUM('draft', 'active', 'completed', 'cancelled'), allowNull: false, defaultValue: 'draft' },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Stage', tableName: 'stages', ...ts }
);

class Group extends Model {}
Group.init(
  {
    id,
    stageId: req(DataTypes.UUID),
    name: req(DataTypes.STRING(2)),
    seq: req(DataTypes.SMALLINT),
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Group', tableName: 'groups', createdAt: 'createdAt', updatedAt: false }
);

class GroupTeam extends Model {}
GroupTeam.init(
  {
    id,
    groupId: req(DataTypes.UUID),
    teamId: req(DataTypes.UUID),
    seedNo: req(DataTypes.SMALLINT),
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'GroupTeam', tableName: 'group_teams', createdAt: 'createdAt', updatedAt: false }
);

class Registration extends Model {}
Registration.init(
  {
    id,
    tournamentId: req(DataTypes.UUID),
    teamId: req(DataTypes.UUID),
    captainId: req(DataTypes.UUID),
    status: req(DataTypes.ENUM(...REG_STATUS)),
    reservePosition: DataTypes.INTEGER,
    seedNo: DataTypes.SMALLINT,
    holdExpiresAt: DataTypes.DATE(3),
    offerExpiresAt: DataTypes.DATE(3),
    paymentId: DataTypes.UUID,
    feePoisha: bigint('feePoisha'),
    feeWaived: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    waiveReason: DataTypes.STRING(255),
    refundedPoisha: bigint('refundedPoisha'),
    idempotencyKey: DataTypes.STRING(80),
    reason: DataTypes.STRING(255),
    decidedBy: DataTypes.UUID,
    decidedAt: DataTypes.DATE(3),
    approvedAt: DataTypes.DATE(3),
    endedAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Registration', tableName: 'registrations', ...ts }
);

class Match extends Model {}
Match.init(
  {
    id,
    tournamentId: req(DataTypes.UUID),
    stageId: req(DataTypes.UUID),
    groupId: DataTypes.UUID,
    round: req(DataTypes.SMALLINT),
    matchNo: req(DataTypes.SMALLINT),
    roundName: DataTypes.STRING(20),
    teamARef: { type: DataTypes.JSONB, allowNull: false, field: 'team_a_ref' },
    teamBRef: { type: DataTypes.JSONB, allowNull: false, field: 'team_b_ref' },
    teamAId: { type: DataTypes.UUID, field: 'team_a_id' },
    teamBId: { type: DataTypes.UUID, field: 'team_b_id' },
    scheduledStart: DataTypes.DATE(3),
    scheduledEnd: DataTypes.DATE(3),
    venueId: DataTypes.UUID,
    court: DataTypes.STRING(40),
    status: { type: DataTypes.ENUM(...MATCH_STATUS), allowNull: false, defaultValue: 'draft' },
    statusReason: DataTypes.STRING(255),
    postponedFrom: DataTypes.DATE(3),
    walkoverTeamId: DataTypes.UUID,
    published: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Match', tableName: 'matches', ...ts }
);

// ---- M15 lite (owned by the scoring module)
class MatchResult extends Model {}
MatchResult.init(
  {
    id,
    matchId: req(DataTypes.UUID),
    tournamentId: req(DataTypes.UUID),
    version: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
    outcome: req(DataTypes.ENUM('win', 'draw', 'tie', 'no_result', 'walkover')),
    winnerTeamId: DataTypes.UUID,
    margin: count(),
    score: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    isCurrent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    reason: DataTypes.STRING(255),
    enteredBy: req(DataTypes.UUID),
    supersededAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'MatchResult', tableName: 'match_results', createdAt: 'createdAt', updatedAt: false }
);

class Standing extends Model {}
Standing.init(
  {
    id,
    tournamentId: req(DataTypes.UUID),
    stageId: req(DataTypes.UUID),
    groupId: DataTypes.UUID,
    teamId: req(DataTypes.UUID),
    played: count(),
    won: count(),
    drawn: count(),
    lost: count(),
    noResult: count(),
    points: count(),
    scoreFor: count(),
    scoreAgainst: count(),
    setsFor: count(),
    setsAgainst: count(),
    runsFor: count(),
    runsAgainst: count(),
    ballsFaced: count(),
    ballsBowled: count(),
    nrr: {
      type: DataTypes.DECIMAL(8, 3),
      allowNull: false,
      defaultValue: 0,
      get() {
        return Number(this.getDataValue('nrr'));
      },
    },
    position: req(DataTypes.SMALLINT),
    needsLots: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Standing', tableName: 'standings', createdAt: false, updatedAt: 'updatedAt' }
);

module.exports = { Tournament, TournamentRules, TournamentVenue, Stage, Group, GroupTeam, Registration, Match, MatchResult, Standing };
