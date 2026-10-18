'use strict';

/**
 * M23 Esports big events (migration 20261103000002): the event hub, its stages (M21 tournaments),
 * qualifications for invite-only finals, streams, sponsors, polls and votes, follows, the feed and the
 * follow alerts sent. index.js re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const ts = { createdAt: 'createdAt', updatedAt: 'updatedAt' };
const created = { timestamps: true, createdAt: 'createdAt', updatedAt: false };

class EsportsEvent extends Model {}
EsportsEvent.init(
  {
    id,
    slug: req(DataTypes.STRING(90)),
    titleEn: req(DataTypes.STRING(120)),
    titleBn: req(DataTypes.STRING(160)),
    taglineEn: DataTypes.STRING(160),
    taglineBn: DataTypes.STRING(200),
    aboutMdEn: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    aboutMdBn: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    bannerKey: DataTypes.STRING(255),
    accentHex: { type: DataTypes.STRING(7), allowNull: false, defaultValue: '#f2a33a' },
    startsAt: req(DataTypes.DATE(3)),
    endsAt: req(DataTypes.DATE(3)),
    status: { type: DataTypes.ENUM('draft', 'published', 'cancelled'), allowNull: false, defaultValue: 'draft' },
    featured: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    publishedAt: DataTypes.DATE(3),
    publishedBy: DataTypes.UUID,
    cancelledAt: DataTypes.DATE(3),
    cancelledBy: DataTypes.UUID,
    cancelReason: DataTypes.STRING(255),
    lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdBy: req(DataTypes.UUID),
    updatedBy: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsEvent', tableName: 'esports_events', ...ts }
);

class EsportsEventStage extends Model {}
EsportsEventStage.init(
  {
    id,
    eventId: req(DataTypes.UUID),
    tournamentId: req(DataTypes.UUID),
    role: req(DataTypes.ENUM('qualifier', 'final')),
    labelEn: req(DataTypes.STRING(80)),
    labelBn: req(DataTypes.STRING(120)),
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    qualifyCount: DataTypes.SMALLINT,
    finalTournamentId: DataTypes.UUID,
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    createdBy: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsEventStage', tableName: 'esports_event_stages', ...ts }
);

class EsportsEventQualification extends Model {}
EsportsEventQualification.init(
  {
    id,
    eventId: req(DataTypes.UUID),
    finalTournamentId: req(DataTypes.UUID),
    sourceTournamentId: DataTypes.UUID,
    sourceRegistrationId: DataTypes.UUID,
    squadId: DataTypes.UUID,
    userId: DataTypes.UUID,
    players: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    rank: DataTypes.SMALLINT,
    status: req(DataTypes.ENUM('qualified', 'invited', 'entered', 'missed', 'revoked')),
    finalRegistrationId: DataTypes.UUID,
    reason: DataTypes.STRING(255),
    actorId: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsEventQualification', tableName: 'esports_event_qualifications', ...ts }
);

class EsportsEventStream extends Model {}
EsportsEventStream.init(
  {
    id,
    eventId: req(DataTypes.UUID),
    platform: req(DataTypes.ENUM('youtube', 'facebook', 'tiktok')),
    url: req(DataTypes.STRING(500)),
    videoRef: DataTypes.STRING(120),
    title: req(DataTypes.STRING(120)),
    isLive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsEventStream', tableName: 'esports_event_streams', ...ts }
);

class EsportsEventSponsor extends Model {}
EsportsEventSponsor.init(
  {
    id,
    eventId: req(DataTypes.UUID),
    name: req(DataTypes.STRING(80)),
    tier: req(DataTypes.ENUM('title', 'gold', 'partner')),
    logoKey: DataTypes.STRING(255),
    url: DataTypes.STRING(500),
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    createdBy: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsEventSponsor', tableName: 'esports_event_sponsors', ...ts }
);

class EsportsEventPoll extends Model {}
EsportsEventPoll.init(
  {
    id,
    eventId: req(DataTypes.UUID),
    questionEn: req(DataTypes.STRING(160)),
    questionBn: req(DataTypes.STRING(220)),
    status: { type: DataTypes.ENUM('draft', 'open', 'closed'), allowNull: false, defaultValue: 'draft' },
    closesAt: DataTypes.DATE(3),
    openedAt: DataTypes.DATE(3),
    closedAt: DataTypes.DATE(3),
    createdBy: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsEventPoll', tableName: 'esports_event_polls', ...ts }
);

class EsportsEventPollOption extends Model {}
EsportsEventPollOption.init(
  {
    id,
    pollId: req(DataTypes.UUID),
    labelEn: req(DataTypes.STRING(80)),
    labelBn: req(DataTypes.STRING(120)),
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsEventPollOption', tableName: 'esports_event_poll_options', ...created }
);

class EsportsEventPollVote extends Model {}
EsportsEventPollVote.init(
  {
    id,
    pollId: req(DataTypes.UUID),
    optionId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsEventPollVote', tableName: 'esports_event_poll_votes', ...created }
);

class EsportsEventFollow extends Model {}
EsportsEventFollow.init(
  {
    id,
    eventId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsEventFollow', tableName: 'esports_event_follows', ...ts }
);

class EsportsEventFeedItem extends Model {}
EsportsEventFeedItem.init(
  {
    id,
    eventId: req(DataTypes.UUID),
    kind: req(DataTypes.ENUM('announcement', 'tournament_finalised', 'tournament_cancelled', 'qualified', 'final_live', 'stream_live', 'event_cancelled')),
    tournamentId: DataTypes.UUID,
    refId: DataTypes.UUID,
    textEn: DataTypes.STRING(280),
    textBn: DataTypes.STRING(400),
    data: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    actorId: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsEventFeedItem', tableName: 'esports_event_feed', ...created }
);

class EsportsEventAlert extends Model {}
EsportsEventAlert.init(
  {
    id,
    eventId: req(DataTypes.UUID),
    kind: req(DataTypes.ENUM('event_started', 'stream_live', 'final_soon')),
    key: req(DataTypes.STRING(160)),
    followerCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    pages: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    sentAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsEventAlert', tableName: 'esports_event_alerts', timestamps: false }
);

EsportsEventPoll.hasMany(EsportsEventPollOption, { as: 'options', foreignKey: 'pollId' });

module.exports = {
  EsportsEvent,
  EsportsEventStage,
  EsportsEventQualification,
  EsportsEventStream,
  EsportsEventSponsor,
  EsportsEventPoll,
  EsportsEventPollOption,
  EsportsEventPollVote,
  EsportsEventFollow,
  EsportsEventFeedItem,
  EsportsEventAlert,
};
