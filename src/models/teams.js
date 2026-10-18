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

module.exports = { Team, TeamMember, TeamInvite, PlayerProfile };
