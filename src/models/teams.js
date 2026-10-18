'use strict';

/**
 * M16 Teams and players, step 1 (migration 20261104000003): teams, team members, team invites (phones
 * stored hashed and masked only) and player profiles. index.js re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const ts = { createdAt: 'createdAt', updatedAt: 'updatedAt' };

class Team extends Model {}
Team.init(
  {
    id,
    sportId: req(DataTypes.UUID),
    name: req(DataTypes.STRING(40)),
    shortCode: DataTypes.STRING(4),
    homeAreaId: DataTypes.UUID,
    logoKey: DataTypes.STRING(255),
    status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
    archivedAt: DataTypes.DATE(3),
    archiveReason: DataTypes.STRING(255),
    createdBy: req(DataTypes.UUID),
    updatedBy: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Team', tableName: 'teams', ...ts }
);

class TeamMember extends Model {}
TeamMember.init(
  {
    id,
    teamId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    role: { type: DataTypes.ENUM('captain', 'vice_captain', 'player'), allowNull: false, defaultValue: 'player' },
    jerseyNo: DataTypes.SMALLINT,
    status: { type: DataTypes.ENUM('active', 'left', 'removed'), allowNull: false, defaultValue: 'active' },
    leftReason: DataTypes.STRING(40),
    joinedAt: DataTypes.DATE(3),
    leftAt: DataTypes.DATE(3),
    addedBy: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'TeamMember', tableName: 'team_members', ...ts }
);

class TeamInvite extends Model {}
TeamInvite.init(
  {
    id,
    teamId: req(DataTypes.UUID),
    phoneHash: req(DataTypes.STRING(64)),
    phoneMasked: req(DataTypes.STRING(20)),
    userId: DataTypes.UUID,
    role: { type: DataTypes.ENUM('vice_captain', 'player'), allowNull: false, defaultValue: 'player' },
    invitedBy: req(DataTypes.UUID),
    tokenHash: req(DataTypes.STRING(64)),
    status: { type: DataTypes.ENUM('pending', 'accepted', 'declined', 'expired', 'cancelled'), allowNull: false, defaultValue: 'pending' },
    expiresAt: req(DataTypes.DATE(3)),
    resentAt: DataTypes.DATE(3),
    resendCount: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    decidedAt: DataTypes.DATE(3),
    decidedBy: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'TeamInvite', tableName: 'team_invites', ...ts }
);

class PlayerProfile extends Model {}
PlayerProfile.init(
  {
    userId: { type: DataTypes.UUID, primaryKey: true },
    sports: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    bio: DataTypes.STRING(500),
    visibility: { type: DataTypes.ENUM('public', 'members'), allowNull: false, defaultValue: 'public' },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'PlayerProfile', tableName: 'player_profiles', ...ts }
);

// ---- rosters and stored eligibility, built with M14 step 1 (migration 20261105000004)
class Roster extends Model {}
Roster.init(
  {
    id,
    registrationId: req(DataTypes.UUID),
    tournamentId: req(DataTypes.UUID),
    teamId: req(DataTypes.UUID),
    status: { type: DataTypes.ENUM('active', 'released'), allowNull: false, defaultValue: 'active' },
    frozenAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Roster', tableName: 'rosters', ...ts }
);

class RosterPlayer extends Model {}
RosterPlayer.init(
  {
    id,
    rosterId: req(DataTypes.UUID),
    tournamentId: req(DataTypes.UUID),
    teamId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    addedBy: DataTypes.UUID,
    removedAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'RosterPlayer', tableName: 'roster_players', ...ts }
);

class EligibilityCheck extends Model {}
EligibilityCheck.init(
  {
    id,
    tournamentId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    checkKey: req(DataTypes.ENUM('nid_verified', 'age', 'gender')),
    status: req(DataTypes.ENUM('pass', 'fail', 'pending', 'missing', 'n_a')),
    fix: DataTypes.STRING(20),
    evaluatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EligibilityCheck', tableName: 'eligibility_checks', timestamps: false }
);

module.exports = { Team, TeamMember, TeamInvite, PlayerProfile, Roster, RosterPlayer, EligibilityCheck };
