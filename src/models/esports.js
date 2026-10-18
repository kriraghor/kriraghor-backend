'use strict';

/**
 * M21 esports models (migration 20261023000001-create-esports). Kept apart from index.js for size;
 * index.js re-exports them and declares the associations.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');
const { toPoisha } = require('../common/money');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
// BIGINT comes back from pg as a string; money getters return checked numbers (as in index.js).
const poisha = (field) => ({
  type: DataTypes.BIGINT,
  allowNull: false,
  defaultValue: 0,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : toPoisha(v);
  },
});
const ts = { createdAt: 'createdAt', updatedAt: 'updatedAt' };

class EsportsGameProfile extends Model {}
EsportsGameProfile.init(
  {
    id,
    userId: req(DataTypes.UUID),
    gameId: req(DataTypes.UUID),
    uid: req(DataTypes.STRING(32)),
    ign: req(DataTypes.STRING(40)),
    status: { type: DataTypes.ENUM('pending', 'verified', 'rejected', 'banned', 'unlinked'), allowNull: false, defaultValue: 'pending' },
    screenshotKey: req(DataTypes.STRING(255)),
    screenshotMime: req(DataTypes.STRING(40)),
    submissionId: DataTypes.UUID,
    verifiedAt: DataTypes.DATE(3),
    verifiedBy: DataTypes.UUID,
    rejectReason: DataTypes.STRING(255),
    unlinkedAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsGameProfile', tableName: 'esports_game_profiles', ...ts }
);

class EsportsUidBan extends Model {}
EsportsUidBan.init(
  {
    id,
    gameId: req(DataTypes.UUID),
    uid: req(DataTypes.STRING(32)),
    reasonCode: req(DataTypes.ENUM('cheating', 'hacking', 'account_sharing', 'abuse', 'other')),
    note: req(DataTypes.STRING(1000)),
    evidence: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    bannedBy: req(DataTypes.UUID),
    expiresAt: DataTypes.DATE(3),
    liftedAt: DataTypes.DATE(3),
    liftedBy: DataTypes.UUID,
    liftReason: DataTypes.STRING(300),
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsUidBan', tableName: 'esports_uid_bans', updatedAt: false }
);

class EsportsSquad extends Model {}
EsportsSquad.init(
  {
    id,
    gameId: req(DataTypes.UUID),
    name: req(DataTypes.STRING(40)),
    tag: req(DataTypes.STRING(8)),
    captainUserId: req(DataTypes.UUID),
    status: { type: DataTypes.ENUM('active', 'disbanded'), allowNull: false, defaultValue: 'active' },
    inviteCode: req(DataTypes.STRING(10)),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsSquad', tableName: 'esports_squads', ...ts }
);

class EsportsSquadMember extends Model {}
EsportsSquadMember.init(
  {
    id,
    squadId: req(DataTypes.UUID),
    gameId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    role: { type: DataTypes.ENUM('captain', 'member'), allowNull: false, defaultValue: 'member' },
    status: req(DataTypes.ENUM('invited', 'active', 'declined', 'left', 'removed')),
    invitedBy: DataTypes.UUID,
    joinedAt: DataTypes.DATE(3),
    leftAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsSquadMember', tableName: 'esports_squad_members', ...ts }
);

const TOURNAMENT_STATUSES = ['draft', 'review', 'scheduled', 'registration_open', 'registration_closed', 'check_in', 'live', 'results_pending', 'finalised', 'paid_out', 'cancelled'];

class EsportsTournament extends Model {}
EsportsTournament.init(
  {
    id,
    slug: req(DataTypes.STRING(80)),
    gameId: req(DataTypes.UUID),
    modeId: req(DataTypes.UUID),
    titleEn: req(DataTypes.STRING(120)),
    titleBn: req(DataTypes.STRING(160)),
    tier: req(DataTypes.ENUM('daily', 'weekly', 'monthly', 'major')),
    format: req(DataTypes.ENUM('single_match', 'series')),
    organiserType: { type: DataTypes.ENUM('kriraghor', 'organisation'), allowNull: false, defaultValue: 'kriraghor' },
    organisationId: DataTypes.UUID,
    // M22: the fee snapshotted at publish for an organiser tournament, its contract, and the per-kill cap.
    saasFeeModel: { type: DataTypes.ENUM('none', 'percentage', 'flat'), allowNull: false, defaultValue: 'none' },
    saasFeeBps: DataTypes.INTEGER,
    contractId: DataTypes.UUID,
    maxPaidKills: DataTypes.INTEGER,
    entryUnit: req(DataTypes.ENUM('player', 'squad')),
    entryFeePoisha: poisha('entryFeePoisha'),
    maxSlots: req(DataTypes.SMALLINT),
    minParticipants: req(DataTypes.SMALLINT),
    prizePoolPoisha: poisha('prizePoolPoisha'),
    killRewardPoisha: poisha('killRewardPoisha'),
    pointsPresetId: DataTypes.UUID,
    placementPoints: req(DataTypes.JSON),
    killPoints: req(DataTypes.SMALLINT),
    registrationOpensAt: req(DataTypes.DATE(3)),
    registrationClosesAt: req(DataTypes.DATE(3)),
    startsAt: req(DataTypes.DATE(3)),
    status: { type: DataTypes.ENUM(...TOURNAMENT_STATUSES), allowNull: false, defaultValue: 'draft' },
    featured: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    rulesMd: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    settingsSnapshot: DataTypes.JSON,
    settlement: DataTypes.JSON,
    cancelReason: DataTypes.STRING(255),
    submissionId: DataTypes.UUID,
    publishedAt: DataTypes.DATE(3),
    finalisedAt: DataTypes.DATE(3),
    paidOutAt: DataTypes.DATE(3),
    cancelledAt: DataTypes.DATE(3),
    createdBy: req(DataTypes.UUID),
    updatedBy: DataTypes.UUID,
    lockVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsTournament', tableName: 'esports_tournaments', ...ts }
);

class EsportsPrizePlace extends Model {}
EsportsPrizePlace.init(
  {
    tournamentId: { type: DataTypes.UUID, primaryKey: true },
    place: { type: DataTypes.SMALLINT, primaryKey: true },
    amountPoisha: poisha('amountPoisha'),
  },
  { sequelize, modelName: 'EsportsPrizePlace', tableName: 'esports_prize_places', timestamps: false }
);

class EsportsStage extends Model {}
EsportsStage.init(
  {
    id,
    tournamentId: req(DataTypes.UUID),
    seq: req(DataTypes.SMALLINT),
    nameEn: req(DataTypes.STRING(60)),
    nameBn: req(DataTypes.STRING(80)),
    kind: { type: DataTypes.ENUM('main', 'group', 'semi', 'final'), allowNull: false, defaultValue: 'main' },
    checkinOpensAt: req(DataTypes.DATE(3)),
    checkinClosesAt: req(DataTypes.DATE(3)),
    checkinOpenedAt: DataTypes.DATE(3),
    checkinClosedAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsStage', tableName: 'esports_stages', updatedAt: false }
);

class EsportsMatch extends Model {}
EsportsMatch.init(
  {
    id,
    tournamentId: req(DataTypes.UUID),
    stageId: req(DataTypes.UUID),
    seq: req(DataTypes.SMALLINT),
    mapId: req(DataTypes.UUID),
    startsAt: req(DataTypes.DATE(3)),
    status: { type: DataTypes.ENUM('scheduled', 'room_ready', 'room_revealed', 'live', 'results_pending', 'disputed', 'final', 'cancelled'), allowNull: false, defaultValue: 'scheduled' },
    resultsPostedAt: DataTypes.DATE(3),
    disputeClosesAt: DataTypes.DATE(3),
    finalisedAt: DataTypes.DATE(3),
    cancelledAt: DataTypes.DATE(3),
    cancelReason: DataTypes.STRING(255),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsMatch', tableName: 'esports_matches', ...ts }
);

class EsportsRegistration extends Model {}
EsportsRegistration.init(
  {
    id,
    tournamentId: req(DataTypes.UUID),
    registrantUserId: req(DataTypes.UUID),
    squadId: DataTypes.UUID,
    slotNo: DataTypes.SMALLINT,
    status: req(DataTypes.ENUM('pending_payment', 'confirmed', 'waitlisted', 'offered', 'checked_in', 'no_show', 'withdrawn', 'refunded', 'disqualified', 'cancelled')),
    amountPoisha: poisha('amountPoisha'),
    paymentId: DataTypes.UUID,
    holdExpiresAt: DataTypes.DATE(3),
    offerExpiresAt: DataTypes.DATE(3),
    waitlistPosition: DataTypes.INTEGER,
    prizeSplit: DataTypes.JSON,
    idempotencyKey: req(DataTypes.STRING(80)),
    confirmedAt: DataTypes.DATE(3),
    withdrawnAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsRegistration', tableName: 'esports_registrations', ...ts }
);

class EsportsRegistrationPlayer extends Model {}
EsportsRegistrationPlayer.init(
  {
    id,
    registrationId: req(DataTypes.UUID),
    tournamentId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    gameProfileId: req(DataTypes.UUID),
    isSubstitute: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsRegistrationPlayer', tableName: 'esports_registration_players', ...ts }
);

class EsportsCheckin extends Model {}
EsportsCheckin.init(
  {
    id,
    stageId: req(DataTypes.UUID),
    registrationId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    source: req(DataTypes.ENUM('web', 'mobile', 'staff')),
    createdBy: DataTypes.UUID,
    checkedInAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, modelName: 'EsportsCheckin', tableName: 'esports_checkins', timestamps: false }
);

class EsportsRoomCredential extends Model {}
EsportsRoomCredential.init(
  {
    id,
    matchId: req(DataTypes.UUID),
    version: req(DataTypes.SMALLINT),
    roomIdEnc: req(DataTypes.STRING(255)),
    passwordEnc: req(DataTypes.STRING(255)),
    status: req(DataTypes.ENUM('scheduled', 'revealed', 'superseded')),
    revealAt: req(DataTypes.DATE(3)),
    revealedAt: DataTypes.DATE(3),
    createdBy: req(DataTypes.UUID),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsRoomCredential', tableName: 'esports_room_credentials', ...ts }
);

class EsportsCredentialView extends Model {}
EsportsCredentialView.init(
  {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    credentialId: req(DataTypes.UUID),
    matchId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    actorType: req(DataTypes.ENUM('player', 'staff')),
    channel: req(DataTypes.ENUM('api', 'socket')),
    ip: DataTypes.STRING(45),
    userAgent: DataTypes.STRING(255),
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsCredentialView', tableName: 'esports_credential_views', updatedAt: false }
);

class EsportsResult extends Model {}
EsportsResult.init(
  {
    id,
    matchId: req(DataTypes.UUID),
    registrationId: req(DataTypes.UUID),
    placement: DataTypes.SMALLINT,
    kills: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    placementPoints: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    killPointsTotal: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    totalPoints: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM('draft', 'posted', 'final', 'void'), allowNull: false, defaultValue: 'draft' },
    enteredBy: req(DataTypes.UUID),
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsResult', tableName: 'esports_results', ...ts }
);

class EsportsResultPlayer extends Model {}
EsportsResultPlayer.init(
  {
    resultId: { type: DataTypes.UUID, primaryKey: true },
    userId: { type: DataTypes.UUID, primaryKey: true },
    kills: req(DataTypes.SMALLINT),
  },
  { sequelize, modelName: 'EsportsResultPlayer', tableName: 'esports_result_players', timestamps: false }
);

class EsportsResultEvidence extends Model {}
EsportsResultEvidence.init(
  {
    id,
    matchId: req(DataTypes.UUID),
    registrationId: DataTypes.UUID,
    uploadedBy: req(DataTypes.UUID),
    actorType: req(DataTypes.ENUM('player', 'staff')),
    kind: req(DataTypes.ENUM('screenshot', 'video_link')),
    fileKey: DataTypes.STRING(255),
    mime: DataTypes.STRING(40),
    url: DataTypes.STRING(500),
    note: DataTypes.STRING(500),
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsResultEvidence', tableName: 'esports_result_evidence', updatedAt: false }
);

class EsportsResultDispute extends Model {}
EsportsResultDispute.init(
  {
    id,
    matchId: req(DataTypes.UUID),
    registrationId: req(DataTypes.UUID),
    raisedBy: req(DataTypes.UUID),
    reason: req(DataTypes.STRING(500)),
    evidenceIds: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    status: { type: DataTypes.ENUM('open', 'rejected', 'corrected'), allowNull: false, defaultValue: 'open' },
    resolvedBy: DataTypes.UUID,
    resolutionNote: DataTypes.STRING(500),
    resolvedAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsResultDispute', tableName: 'esports_result_disputes', ...ts }
);

class EsportsDisqualification extends Model {}
EsportsDisqualification.init(
  {
    id,
    tournamentId: req(DataTypes.UUID),
    registrationId: req(DataTypes.UUID),
    userId: DataTypes.UUID,
    reasonCode: req(DataTypes.ENUM('cheating', 'uid_mismatch', 'account_sharing', 'no_show_abuse', 'abuse', 'other')),
    note: req(DataTypes.STRING(1000)),
    evidence: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    effects: req(DataTypes.JSON),
    decidedBy: req(DataTypes.UUID),
    createdAt: DataTypes.DATE(3),
    revertedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsDisqualification', tableName: 'esports_disqualifications', updatedAt: false }
);

class EsportsStanding extends Model {}
EsportsStanding.init(
  {
    stageId: { type: DataTypes.UUID, primaryKey: true },
    registrationId: { type: DataTypes.UUID, primaryKey: true },
    rank: req(DataTypes.SMALLINT),
    totalPoints: req(DataTypes.INTEGER),
    wins: req(DataTypes.SMALLINT),
    kills: req(DataTypes.INTEGER),
    lastPlacement: DataTypes.SMALLINT,
    matchesPlayed: req(DataTypes.SMALLINT),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsStanding', tableName: 'esports_standings', createdAt: false, updatedAt: 'updatedAt' }
);

class EsportsPrizeAward extends Model {}
EsportsPrizeAward.init(
  {
    id,
    tournamentId: req(DataTypes.UUID),
    registrationId: req(DataTypes.UUID),
    kind: req(DataTypes.ENUM('place', 'kill_reward')),
    place: DataTypes.SMALLINT,
    amountPoisha: poisha('amountPoisha'),
    status: { type: DataTypes.ENUM('pending', 'credited', 'forfeited', 'reversed'), allowNull: false, defaultValue: 'pending' },
    ledgerTxnId: DataTypes.UUID,
    idempotencyKey: req(DataTypes.STRING(120)),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsPrizeAward', tableName: 'esports_prize_awards', ...ts }
);

class EsportsPrizeShare extends Model {}
EsportsPrizeShare.init(
  {
    id,
    awardId: req(DataTypes.UUID),
    tournamentId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    amountPoisha: poisha('amountPoisha'),
    status: { type: DataTypes.ENUM('pending', 'credited', 'reversed'), allowNull: false, defaultValue: 'pending' },
    ledgerTxnId: DataTypes.UUID,
    reversalTxnId: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsPrizeShare', tableName: 'esports_prize_shares', ...ts }
);

class EsportsStream extends Model {}
EsportsStream.init(
  {
    id,
    tournamentId: req(DataTypes.UUID),
    matchId: DataTypes.UUID,
    platform: req(DataTypes.ENUM('youtube', 'facebook', 'tiktok', 'other')),
    url: req(DataTypes.STRING(500)),
    title: req(DataTypes.STRING(120)),
    isLive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    startsAt: DataTypes.DATE(3),
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsStream', tableName: 'esports_streams', ...ts }
);

const decimal = (field) => ({
  type: DataTypes.DECIMAL(12, 3),
  allowNull: false,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : Number(v);
  },
});

class EsportsRankingEntry extends Model {}
EsportsRankingEntry.init(
  {
    userId: { type: DataTypes.UUID, primaryKey: true },
    tournamentId: { type: DataTypes.UUID, primaryKey: true },
    gameId: req(DataTypes.UUID),
    placementScore: decimal('placementScore'),
    kills: req(DataTypes.INTEGER),
    tierWeight: req(DataTypes.SMALLINT),
    finalisedAt: req(DataTypes.DATE(3)),
  },
  { sequelize, modelName: 'EsportsRankingEntry', tableName: 'esports_ranking_entries', timestamps: false }
);

class EsportsRanking extends Model {}
EsportsRanking.init(
  {
    userId: { type: DataTypes.UUID, primaryKey: true },
    gameId: { type: DataTypes.UUID, primaryKey: true },
    scope: { type: DataTypes.ENUM('rolling', 'season'), primaryKey: true },
    seasonKey: { type: DataTypes.STRING(16), primaryKey: true },
    points: decimal('points'),
    rank: req(DataTypes.INTEGER),
    tournaments: req(DataTypes.SMALLINT),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EsportsRanking', tableName: 'esports_rankings', createdAt: false, updatedAt: 'updatedAt' }
);

/** Associations within M21 (index.js adds the ones to M03 catalogue models). */
EsportsTournament.hasMany(EsportsPrizePlace, { as: 'prizes', foreignKey: 'tournamentId' });
EsportsTournament.hasMany(EsportsStage, { as: 'stages', foreignKey: 'tournamentId' });
EsportsTournament.hasMany(EsportsMatch, { as: 'matches', foreignKey: 'tournamentId' });
EsportsTournament.hasMany(EsportsStream, { as: 'streams', foreignKey: 'tournamentId' });
EsportsMatch.belongsTo(EsportsTournament, { as: 'tournament', foreignKey: 'tournamentId' });
EsportsMatch.belongsTo(EsportsStage, { as: 'stage', foreignKey: 'stageId' });
EsportsRegistration.hasMany(EsportsRegistrationPlayer, { as: 'players', foreignKey: 'registrationId' });
EsportsRegistration.belongsTo(EsportsTournament, { as: 'tournament', foreignKey: 'tournamentId' });
EsportsSquad.hasMany(EsportsSquadMember, { as: 'members', foreignKey: 'squadId' });
EsportsResult.hasMany(EsportsResultPlayer, { as: 'players', foreignKey: 'resultId' });
EsportsPrizeAward.hasMany(EsportsPrizeShare, { as: 'shares', foreignKey: 'awardId' });

module.exports = {
  EsportsGameProfile,
  EsportsUidBan,
  EsportsSquad,
  EsportsSquadMember,
  EsportsTournament,
  EsportsPrizePlace,
  EsportsStage,
  EsportsMatch,
  EsportsRegistration,
  EsportsRegistrationPlayer,
  EsportsCheckin,
  EsportsRoomCredential,
  EsportsCredentialView,
  EsportsResult,
  EsportsResultPlayer,
  EsportsResultEvidence,
  EsportsResultDispute,
  EsportsDisqualification,
  EsportsStanding,
  EsportsPrizeAward,
  EsportsPrizeShare,
  EsportsStream,
  EsportsRankingEntry,
  EsportsRanking,
};
