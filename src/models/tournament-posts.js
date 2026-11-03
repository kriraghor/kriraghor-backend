'use strict';

/**
 * M26 Tournament feed (migration 20261117000001): posts about tournaments people run elsewhere, their
 * photos and comments, and one private thread per post and player. Nothing here holds money: the entry
 * fee and prize are what the post says. index.js re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');
const { toPoisha } = require('../common/money');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const ts = { createdAt: 'createdAt', updatedAt: 'updatedAt' };
const poisha = (field, { allowNull = false, dflt } = {}) => ({
  type: DataTypes.BIGINT,
  allowNull,
  ...(dflt === undefined ? {} : { defaultValue: dflt }),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : toPoisha(v);
  },
});

class TournamentPost extends Model {}
TournamentPost.init(
  {
    id,
    slug: req(DataTypes.STRING(110)),
    authorId: req(DataTypes.UUID),
    title: req(DataTypes.STRING(120)),
    sportId: req(DataTypes.UUID),
    format: req(DataTypes.STRING(20)),
    divisionId: req(DataTypes.UUID),
    districtId: req(DataTypes.UUID),
    areaId: DataTypes.UUID,
    venueName: req(DataTypes.STRING(120)),
    address: DataTypes.STRING(240),
    mapLink: DataTypes.STRING(300),
    startDate: req(DataTypes.DATEONLY),
    endDate: DataTypes.DATEONLY,
    registrationDeadline: req(DataTypes.DATEONLY),
    entryFeePoisha: poisha('entryFeePoisha', { dflt: 0 }),
    prizePoolPoisha: poisha('prizePoolPoisha', { allowNull: true }),
    prizeDetails: DataTypes.STRING(500),
    teamLimit: DataTypes.INTEGER,
    playersPerTeam: DataTypes.INTEGER,
    gender: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'open' },
    ageGroup: DataTypes.STRING(40),
    skillLevel: DataTypes.STRING(20),
    organiserName: req(DataTypes.STRING(120)),
    description: req(DataTypes.TEXT),
    rules: DataTypes.TEXT,
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'open' },
    statusBeforeRemoval: DataTypes.STRING(10),
    removedReason: DataTypes.STRING(300),
    removedBy: DataTypes.UUID,
    removedAt: DataTypes.DATE(3),
    closedAt: DataTypes.DATE(3),
    expiredAt: DataTypes.DATE(3),
    commentCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lastActivityAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'TournamentPost', tableName: 'tournament_posts', ...ts }
);

class TournamentPostPhoto extends Model {}
TournamentPostPhoto.init(
  {
    id,
    postId: req(DataTypes.UUID),
    storageKey: req(DataTypes.STRING(255)),
    mime: req(DataTypes.STRING(40)),
    sizeBytes: req(DataTypes.INTEGER),
    sha256: req(DataTypes.STRING(64)),
    sort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'active' },
    createdBy: req(DataTypes.UUID),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'TournamentPostPhoto', tableName: 'tournament_post_photos', ...ts }
);

class TournamentPostComment extends Model {}
TournamentPostComment.init(
  {
    id,
    postId: req(DataTypes.UUID),
    authorId: req(DataTypes.UUID),
    body: req(DataTypes.TEXT),
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'visible' },
    removedBy: DataTypes.UUID,
    removedAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'TournamentPostComment', tableName: 'tournament_post_comments', ...ts }
);

class TournamentPostThread extends Model {}
TournamentPostThread.init(
  {
    id,
    postId: req(DataTypes.UUID),
    organiserId: req(DataTypes.UUID),
    playerId: req(DataTypes.UUID),
    lastMessageAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'TournamentPostThread', tableName: 'tournament_post_threads', ...ts }
);

class TournamentPostMessage extends Model {}
TournamentPostMessage.init(
  {
    id,
    threadId: req(DataTypes.UUID),
    senderId: req(DataTypes.UUID),
    body: req(DataTypes.TEXT),
    readAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'TournamentPostMessage', tableName: 'tournament_post_messages', ...ts }
);

module.exports = { TournamentPost, TournamentPostPhoto, TournamentPostComment, TournamentPostThread, TournamentPostMessage };
