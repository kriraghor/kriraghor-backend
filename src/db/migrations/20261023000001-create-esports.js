'use strict';

/**
 * M21 esports, step 1 (§7). Kriraghor-run PUBG Mobile and Free Fire tournaments:
 *  - game profiles (UID per game, M05 review) and UID bans; squads;
 *  - tournaments with prize places, stages and matches (single match and series; groups in step 2);
 *  - registrations with numbered slots (UNIQUE(tournament_id, slot_no) stops overselling, FR-09),
 *    players (a UID in one entry per tournament), check-ins;
 *  - room credentials (encrypted, versioned) and their append-only view log (FR-14 to FR-17);
 *  - results, evidence, disputes (built in until M17), disqualifications, the standings projection;
 *  - prize awards and shares (money moves through M06), streams, rankings (projections).
 */
const TOURNAMENT_STATUSES = ['draft', 'review', 'scheduled', 'registration_open', 'registration_closed', 'check_in', 'live', 'results_pending', 'finalised', 'paid_out', 'cancelled'];
const REG_STATUSES = ['pending_payment', 'confirmed', 'waitlisted', 'offered', 'checked_in', 'no_show', 'withdrawn', 'refunded', 'disqualified', 'cancelled'];
const MATCH_STATUSES = ['scheduled', 'room_ready', 'room_revealed', 'live', 'results_pending', 'disputed', 'final', 'cancelled'];

const TABLES = [
  'esports_rankings',
  'esports_ranking_entries',
  'esports_streams',
  'esports_prize_shares',
  'esports_prize_awards',
  'esports_standings',
  'esports_disqualifications',
  'esports_result_disputes',
  'esports_result_evidence',
  'esports_result_players',
  'esports_results',
  'esports_credential_views',
  'esports_room_credentials',
  'esports_checkins',
  'esports_registration_players',
  'esports_registrations',
  'esports_matches',
  'esports_stages',
  'esports_prize_places',
  'esports_tournaments',
  'esports_squad_members',
  'esports_squads',
  'esports_uid_bans',
  'esports_game_profiles',
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const q = (sql) => queryInterface.sequelize.query(sql);
    const TS = 'TIMESTAMP(3) WITH TIME ZONE';
    const now = { type: TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const ref = (model) => ({ references: { model, key: 'id' }, onDelete: 'RESTRICT' });
    const user = ref('users');
    const money = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };

    // ---------------------------------------------------------------- profiles and bans (FR-02 to FR-04)
    await h.createTable(queryInterface, 'esports_game_profiles', {
      id: { ...uuid, primaryKey: true },
      user_id: { ...uuid, ...user },
      game_id: { ...uuid, ...ref('esports_games') },
      uid: { type: DataTypes.STRING(32), allowNull: false },
      ign: { type: DataTypes.STRING(40), allowNull: false },
      status: { type: h.ENUM('pending', 'verified', 'rejected', 'banned', 'unlinked'), allowNull: false, defaultValue: 'pending' },
      screenshot_key: { type: DataTypes.STRING(255), allowNull: false },
      screenshot_mime: { type: DataTypes.STRING(40), allowNull: false },
      submission_id: optUuid,
      verified_at: at,
      verified_by: optUuid,
      reject_reason: { type: DataTypes.STRING(255), allowNull: true },
      unlinked_at: at,
      created_at: now,
      updated_at: now,
    });
    const live = ['pending', 'verified', 'banned'];
    await queryInterface.addIndex('esports_game_profiles', ['game_id', 'uid'], { unique: true, name: 'uq_esports_profiles_uid', where: { status: live } });
    await queryInterface.addIndex('esports_game_profiles', ['game_id', 'user_id'], { unique: true, name: 'uq_esports_profiles_user_game', where: { status: live } });
    await queryInterface.addIndex('esports_game_profiles', ['user_id'], { name: 'ix_esports_profiles_user' });

    await h.createTable(queryInterface, 'esports_uid_bans', {
      id: { ...uuid, primaryKey: true },
      game_id: { ...uuid, ...ref('esports_games') },
      uid: { type: DataTypes.STRING(32), allowNull: false },
      reason_code: { type: h.ENUM('cheating', 'hacking', 'account_sharing', 'abuse', 'other'), allowNull: false },
      note: { type: DataTypes.STRING(1000), allowNull: false },
      evidence: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      banned_by: uuid,
      expires_at: at,
      lifted_at: at,
      lifted_by: optUuid,
      lift_reason: { type: DataTypes.STRING(300), allowNull: true },
      created_at: now,
    });
    await queryInterface.addIndex('esports_uid_bans', ['game_id', 'uid'], { name: 'ix_esports_uid_bans_uid' });

    // ---------------------------------------------------------------- squads (FR-05)
    await h.createTable(queryInterface, 'esports_squads', {
      id: { ...uuid, primaryKey: true },
      game_id: { ...uuid, ...ref('esports_games') },
      name: { type: DataTypes.STRING(40), allowNull: false },
      tag: { type: DataTypes.STRING(8), allowNull: false },
      captain_user_id: { ...uuid, ...user },
      status: { type: h.ENUM('active', 'disbanded'), allowNull: false, defaultValue: 'active' },
      invite_code: { type: DataTypes.STRING(10), allowNull: false, unique: true },
      created_at: now,
      updated_at: now,
    });
    await q("CREATE UNIQUE INDEX uq_esports_squads_name ON esports_squads (game_id, lower(name)) WHERE status = 'active'");

    await h.createTable(queryInterface, 'esports_squad_members', {
      id: { ...uuid, primaryKey: true },
      squad_id: { ...uuid, ...ref('esports_squads') },
      game_id: uuid,
      user_id: { ...uuid, ...user },
      role: { type: h.ENUM('captain', 'member'), allowNull: false, defaultValue: 'member' },
      status: { type: h.ENUM('invited', 'active', 'declined', 'left', 'removed'), allowNull: false },
      invited_by: optUuid,
      joined_at: at,
      left_at: at,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('esports_squad_members', ['squad_id', 'user_id'], { unique: true, name: 'uq_esports_squad_members_open', where: { status: ['invited', 'active'] } });
    // One squad per game per player (the service locks first; this is the backstop).
    await queryInterface.addIndex('esports_squad_members', ['game_id', 'user_id'], { unique: true, name: 'uq_esports_squad_members_game', where: { status: 'active' } });

    // ---------------------------------------------------------------- tournaments, stages, matches (FR-06, FR-07)
    await h.createTable(queryInterface, 'esports_tournaments', {
      id: { ...uuid, primaryKey: true },
      slug: { type: DataTypes.STRING(80), allowNull: false, unique: true },
      game_id: { ...uuid, ...ref('esports_games') },
      mode_id: { ...uuid, ...ref('esports_modes') },
      title_en: { type: DataTypes.STRING(120), allowNull: false },
      title_bn: { type: DataTypes.STRING(160), allowNull: false },
      tier: { type: h.ENUM('daily', 'weekly', 'monthly', 'major'), allowNull: false },
      format: { type: h.ENUM('single_match', 'series'), allowNull: false },
      organiser_type: { type: h.ENUM('kriraghor', 'organisation'), allowNull: false, defaultValue: 'kriraghor' },
      organisation_id: optUuid,
      entry_unit: { type: h.ENUM('player', 'squad'), allowNull: false },
      entry_fee_poisha: money,
      max_slots: { type: DataTypes.SMALLINT, allowNull: false },
      min_participants: { type: DataTypes.SMALLINT, allowNull: false },
      prize_pool_poisha: money,
      kill_reward_poisha: money,
      points_preset_id: { ...optUuid, ...ref('esports_points_presets') },
      placement_points: { type: DataTypes.JSONB, allowNull: false },
      kill_points: { type: DataTypes.SMALLINT, allowNull: false },
      registration_opens_at: { type: TS, allowNull: false },
      registration_closes_at: { type: TS, allowNull: false },
      starts_at: { type: TS, allowNull: false },
      status: { type: h.ENUM(...TOURNAMENT_STATUSES), allowNull: false, defaultValue: 'draft' },
      featured: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      rules_md: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      // §6.1 values used by this tournament, taken at publish (FR-07).
      settings_snapshot: { type: DataTypes.JSONB, allowNull: true },
      // The M06 pool settlement result (collected, paid, subsidy, fee, transaction id), kept once.
      settlement: { type: DataTypes.JSONB, allowNull: true },
      cancel_reason: { type: DataTypes.STRING(255), allowNull: true },
      submission_id: optUuid,
      published_at: at,
      finalised_at: at,
      paid_out_at: at,
      cancelled_at: at,
      created_by: uuid,
      updated_by: optUuid,
      lock_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: now,
      updated_at: now,
    });
    await q(
      'ALTER TABLE esports_tournaments ADD CONSTRAINT ck_esports_tournaments_numbers CHECK (' +
        'entry_fee_poisha >= 0 AND prize_pool_poisha >= 0 AND kill_reward_poisha >= 0 AND kill_points >= 0 AND ' +
        'max_slots >= 2 AND min_participants >= 1 AND min_participants <= max_slots AND ' +
        'registration_opens_at < registration_closes_at AND registration_closes_at <= starts_at)'
    );
    await queryInterface.addIndex('esports_tournaments', ['status', 'starts_at'], { name: 'ix_esports_tournaments_status' });
    await queryInterface.addIndex('esports_tournaments', ['game_id', 'status', 'starts_at'], { name: 'ix_esports_tournaments_game' });
    await queryInterface.addIndex('esports_tournaments', ['featured', 'starts_at'], { name: 'ix_esports_tournaments_featured' });

    await h.createTable(queryInterface, 'esports_prize_places', {
      tournament_id: { ...uuid, primaryKey: true, ...ref('esports_tournaments') },
      place: { type: DataTypes.SMALLINT, allowNull: false, primaryKey: true },
      amount_poisha: { type: DataTypes.BIGINT, allowNull: false },
    });
    await q('ALTER TABLE esports_prize_places ADD CONSTRAINT ck_esports_prize_places CHECK (place >= 1 AND amount_poisha > 0)');

    await h.createTable(queryInterface, 'esports_stages', {
      id: { ...uuid, primaryKey: true },
      tournament_id: { ...uuid, ...ref('esports_tournaments') },
      seq: { type: DataTypes.SMALLINT, allowNull: false },
      name_en: { type: DataTypes.STRING(60), allowNull: false },
      name_bn: { type: DataTypes.STRING(80), allowNull: false },
      kind: { type: h.ENUM('main', 'group', 'semi', 'final'), allowNull: false, defaultValue: 'main' },
      checkin_opens_at: { type: TS, allowNull: false },
      checkin_closes_at: { type: TS, allowNull: false },
      checkin_opened_at: at,
      checkin_closed_at: at,
      created_at: now,
    });
    await queryInterface.addConstraint('esports_stages', { fields: ['tournament_id', 'seq'], type: 'unique', name: 'uq_esports_stages_seq' });

    await h.createTable(queryInterface, 'esports_matches', {
      id: { ...uuid, primaryKey: true },
      tournament_id: { ...uuid, ...ref('esports_tournaments') },
      stage_id: { ...uuid, ...ref('esports_stages') },
      seq: { type: DataTypes.SMALLINT, allowNull: false },
      map_id: { ...uuid, ...ref('esports_maps') },
      starts_at: { type: TS, allowNull: false },
      status: { type: h.ENUM(...MATCH_STATUSES), allowNull: false, defaultValue: 'scheduled' },
      results_posted_at: at,
      dispute_closes_at: at,
      finalised_at: at,
      cancelled_at: at,
      cancel_reason: { type: DataTypes.STRING(255), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addConstraint('esports_matches', { fields: ['stage_id', 'seq'], type: 'unique', name: 'uq_esports_matches_seq' });
    await queryInterface.addIndex('esports_matches', ['status', 'starts_at'], { name: 'ix_esports_matches_status' });

    // ---------------------------------------------------------------- registrations (FR-08 to FR-13)
    await h.createTable(queryInterface, 'esports_registrations', {
      id: { ...uuid, primaryKey: true },
      tournament_id: { ...uuid, ...ref('esports_tournaments') },
      registrant_user_id: { ...uuid, ...user },
      squad_id: { ...optUuid, ...ref('esports_squads') },
      // NULL while waitlisted or after the entry let its slot go.
      slot_no: { type: DataTypes.SMALLINT, allowNull: true },
      status: { type: h.ENUM(...REG_STATUSES), allowNull: false },
      amount_poisha: money,
      payment_id: optUuid,
      hold_expires_at: at,
      offer_expires_at: at,
      waitlist_position: { type: DataTypes.INTEGER, allowNull: true },
      prize_split: { type: DataTypes.JSONB, allowNull: true },
      idempotency_key: { type: DataTypes.STRING(80), allowNull: false },
      confirmed_at: at,
      withdrawn_at: at,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addConstraint('esports_registrations', { fields: ['tournament_id', 'slot_no'], type: 'unique', name: 'uq_esports_registrations_slot' });
    await queryInterface.addConstraint('esports_registrations', { fields: ['registrant_user_id', 'idempotency_key'], type: 'unique', name: 'uq_esports_registrations_idem' });
    await queryInterface.addIndex('esports_registrations', ['tournament_id', 'status'], { name: 'ix_esports_registrations_status' });
    await queryInterface.addIndex('esports_registrations', ['payment_id'], { name: 'ix_esports_registrations_payment' });

    await h.createTable(queryInterface, 'esports_registration_players', {
      id: { ...uuid, primaryKey: true },
      registration_id: { ...uuid, ...ref('esports_registrations') },
      tournament_id: uuid,
      user_id: { ...uuid, ...user },
      game_profile_id: { ...uuid, ...ref('esports_game_profiles') },
      is_substitute: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      created_at: now,
      updated_at: now,
    });
    // A UID (and a player) is in one entry per tournament (edge case 4).
    await queryInterface.addIndex('esports_registration_players', ['tournament_id', 'game_profile_id'], { unique: true, name: 'uq_esports_reg_players_profile', where: { status: 'active' } });
    await queryInterface.addIndex('esports_registration_players', ['tournament_id', 'user_id'], { unique: true, name: 'uq_esports_reg_players_user', where: { status: 'active' } });
    await queryInterface.addIndex('esports_registration_players', ['registration_id'], { name: 'ix_esports_reg_players_reg' });

    await h.createTable(queryInterface, 'esports_checkins', {
      id: { ...uuid, primaryKey: true },
      stage_id: { ...uuid, ...ref('esports_stages') },
      registration_id: { ...uuid, ...ref('esports_registrations') },
      user_id: { ...uuid, ...user },
      source: { type: h.ENUM('web', 'mobile', 'staff'), allowNull: false },
      created_by: optUuid,
      checked_in_at: now,
    });
    await queryInterface.addConstraint('esports_checkins', { fields: ['stage_id', 'user_id'], type: 'unique', name: 'uq_esports_checkins_user' });

    // ---------------------------------------------------------------- room credentials (FR-14 to FR-17)
    await h.createTable(queryInterface, 'esports_room_credentials', {
      id: { ...uuid, primaryKey: true },
      match_id: { ...uuid, ...ref('esports_matches') },
      version: { type: DataTypes.SMALLINT, allowNull: false },
      room_id_enc: { type: DataTypes.STRING(255), allowNull: false },
      password_enc: { type: DataTypes.STRING(255), allowNull: false },
      status: { type: h.ENUM('scheduled', 'revealed', 'superseded'), allowNull: false },
      reveal_at: { type: TS, allowNull: false },
      revealed_at: at,
      created_by: uuid,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addConstraint('esports_room_credentials', { fields: ['match_id', 'version'], type: 'unique', name: 'uq_esports_room_credentials_version' });
    await queryInterface.addIndex('esports_room_credentials', ['match_id'], { unique: true, name: 'uq_esports_room_credentials_current', where: { status: ['scheduled', 'revealed'] } });

    await queryInterface.createTable('esports_credential_views', {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      credential_id: { ...uuid, ...ref('esports_room_credentials') },
      match_id: uuid,
      user_id: uuid,
      actor_type: { type: DataTypes.STRING(6), allowNull: false },
      channel: { type: DataTypes.STRING(6), allowNull: false },
      ip: { type: DataTypes.STRING(45), allowNull: true },
      user_agent: { type: DataTypes.STRING(255), allowNull: true },
      created_at: now,
    });
    await h.enumCheck(queryInterface, 'esports_credential_views', 'actor_type', ['player', 'staff']);
    await h.enumCheck(queryInterface, 'esports_credential_views', 'channel', ['api', 'socket']);
    await queryInterface.addIndex('esports_credential_views', ['match_id', 'created_at'], { name: 'ix_esports_credential_views_match' });
    await h.appendOnly(queryInterface, 'esports_credential_views');

    // ---------------------------------------------------------------- results (FR-18 to FR-22)
    await h.createTable(queryInterface, 'esports_results', {
      id: { ...uuid, primaryKey: true },
      match_id: { ...uuid, ...ref('esports_matches') },
      registration_id: { ...uuid, ...ref('esports_registrations') },
      placement: { type: DataTypes.SMALLINT, allowNull: true },
      kills: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      placement_points: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      kill_points_total: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      total_points: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      status: { type: h.ENUM('draft', 'posted', 'final', 'void'), allowNull: false, defaultValue: 'draft' },
      entered_by: uuid,
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: now,
      updated_at: now,
    });
    await q('ALTER TABLE esports_results ADD CONSTRAINT ck_esports_results_numbers CHECK (kills >= 0 AND (placement IS NULL OR placement >= 1))');
    await queryInterface.addConstraint('esports_results', { fields: ['match_id', 'registration_id'], type: 'unique', name: 'uq_esports_results_entry' });

    await h.createTable(queryInterface, 'esports_result_players', {
      result_id: { ...uuid, primaryKey: true, ...ref('esports_results') },
      user_id: { ...uuid, primaryKey: true },
      kills: { type: DataTypes.SMALLINT, allowNull: false },
    });
    await q('ALTER TABLE esports_result_players ADD CONSTRAINT ck_esports_result_players_kills CHECK (kills >= 0)');

    await h.createTable(queryInterface, 'esports_result_evidence', {
      id: { ...uuid, primaryKey: true },
      match_id: { ...uuid, ...ref('esports_matches') },
      registration_id: optUuid,
      uploaded_by: uuid,
      actor_type: { type: h.ENUM('player', 'staff'), allowNull: false },
      kind: { type: h.ENUM('screenshot', 'video_link'), allowNull: false },
      file_key: { type: DataTypes.STRING(255), allowNull: true },
      mime: { type: DataTypes.STRING(40), allowNull: true },
      url: { type: DataTypes.STRING(500), allowNull: true },
      note: { type: DataTypes.STRING(500), allowNull: true },
      created_at: now,
    });
    await queryInterface.addIndex('esports_result_evidence', ['match_id'], { name: 'ix_esports_result_evidence_match' });

    await h.createTable(queryInterface, 'esports_result_disputes', {
      id: { ...uuid, primaryKey: true },
      match_id: { ...uuid, ...ref('esports_matches') },
      registration_id: { ...uuid, ...ref('esports_registrations') },
      raised_by: { ...uuid, ...user },
      reason: { type: DataTypes.STRING(500), allowNull: false },
      evidence_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      status: { type: h.ENUM('open', 'rejected', 'corrected'), allowNull: false, defaultValue: 'open' },
      resolved_by: optUuid,
      resolution_note: { type: DataTypes.STRING(500), allowNull: true },
      resolved_at: at,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('esports_result_disputes', ['match_id', 'registration_id'], { unique: true, name: 'uq_esports_disputes_open', where: { status: 'open' } });

    await h.createTable(queryInterface, 'esports_disqualifications', {
      id: { ...uuid, primaryKey: true },
      tournament_id: { ...uuid, ...ref('esports_tournaments') },
      registration_id: { ...uuid, ...ref('esports_registrations') },
      user_id: optUuid,
      reason_code: { type: h.ENUM('cheating', 'uid_mismatch', 'account_sharing', 'no_show_abuse', 'abuse', 'other'), allowNull: false },
      note: { type: DataTypes.STRING(1000), allowNull: false },
      evidence: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      effects: { type: DataTypes.JSONB, allowNull: false },
      decided_by: uuid,
      created_at: now,
      reverted_at: at,
    });
    await queryInterface.addIndex('esports_disqualifications', ['tournament_id'], { name: 'ix_esports_disqualifications_tournament' });

    await h.createTable(queryInterface, 'esports_standings', {
      stage_id: { ...uuid, primaryKey: true, ...ref('esports_stages') },
      registration_id: { ...uuid, primaryKey: true, ...ref('esports_registrations') },
      rank: { type: DataTypes.SMALLINT, allowNull: false },
      total_points: { type: DataTypes.INTEGER, allowNull: false },
      wins: { type: DataTypes.SMALLINT, allowNull: false },
      kills: { type: DataTypes.INTEGER, allowNull: false },
      last_placement: { type: DataTypes.SMALLINT, allowNull: true },
      matches_played: { type: DataTypes.SMALLINT, allowNull: false },
      updated_at: now,
    });

    // ---------------------------------------------------------------- prizes (FR-23 to FR-25)
    await h.createTable(queryInterface, 'esports_prize_awards', {
      id: { ...uuid, primaryKey: true },
      tournament_id: { ...uuid, ...ref('esports_tournaments') },
      registration_id: { ...uuid, ...ref('esports_registrations') },
      kind: { type: h.ENUM('place', 'kill_reward'), allowNull: false },
      place: { type: DataTypes.SMALLINT, allowNull: true },
      amount_poisha: { type: DataTypes.BIGINT, allowNull: false },
      status: { type: h.ENUM('pending', 'credited', 'forfeited', 'reversed'), allowNull: false, defaultValue: 'pending' },
      ledger_txn_id: optUuid,
      idempotency_key: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      created_at: now,
      updated_at: now,
    });
    await q('ALTER TABLE esports_prize_awards ADD CONSTRAINT ck_esports_prize_awards_amount CHECK (amount_poisha > 0)');

    await h.createTable(queryInterface, 'esports_prize_shares', {
      id: { ...uuid, primaryKey: true },
      award_id: { ...uuid, ...ref('esports_prize_awards') },
      tournament_id: uuid,
      user_id: { ...uuid, ...user },
      amount_poisha: { type: DataTypes.BIGINT, allowNull: false },
      status: { type: h.ENUM('pending', 'credited', 'reversed'), allowNull: false, defaultValue: 'pending' },
      ledger_txn_id: optUuid,
      reversal_txn_id: optUuid,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addConstraint('esports_prize_shares', { fields: ['award_id', 'user_id'], type: 'unique', name: 'uq_esports_prize_shares_user' });
    await queryInterface.addIndex('esports_prize_shares', ['user_id'], { name: 'ix_esports_prize_shares_user' });
    await q('ALTER TABLE esports_prize_shares ADD CONSTRAINT ck_esports_prize_shares_amount CHECK (amount_poisha > 0)');

    // ---------------------------------------------------------------- streams and rankings (FR-27 to FR-29)
    await h.createTable(queryInterface, 'esports_streams', {
      id: { ...uuid, primaryKey: true },
      tournament_id: { ...uuid, ...ref('esports_tournaments') },
      match_id: optUuid,
      platform: { type: h.ENUM('youtube', 'facebook', 'tiktok', 'other'), allowNull: false },
      url: { type: DataTypes.STRING(500), allowNull: false },
      title: { type: DataTypes.STRING(120), allowNull: false },
      is_live: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      starts_at: at,
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('esports_streams', ['tournament_id'], { name: 'ix_esports_streams_tournament' });

    await h.createTable(queryInterface, 'esports_ranking_entries', {
      user_id: { ...uuid, primaryKey: true },
      tournament_id: { ...uuid, primaryKey: true, ...ref('esports_tournaments') },
      game_id: uuid,
      placement_score: { type: DataTypes.DECIMAL(7, 3), allowNull: false },
      kills: { type: DataTypes.INTEGER, allowNull: false },
      tier_weight: { type: DataTypes.SMALLINT, allowNull: false },
      finalised_at: { type: TS, allowNull: false },
    });
    await queryInterface.addIndex('esports_ranking_entries', ['game_id', 'finalised_at'], { name: 'ix_esports_ranking_entries_game' });

    await h.createTable(queryInterface, 'esports_rankings', {
      user_id: { ...uuid, primaryKey: true },
      game_id: { ...uuid, primaryKey: true },
      scope: { type: h.ENUM('rolling', 'season'), allowNull: false, primaryKey: true },
      season_key: { type: DataTypes.STRING(16), allowNull: false, primaryKey: true },
      points: { type: DataTypes.DECIMAL(12, 3), allowNull: false },
      rank: { type: DataTypes.INTEGER, allowNull: false },
      tournaments: { type: DataTypes.SMALLINT, allowNull: false },
      updated_at: now,
    });
    await queryInterface.addIndex('esports_rankings', ['game_id', 'scope', 'season_key', 'rank'], { name: 'ix_esports_rankings_rank' });
  },

  async down(queryInterface) {
    for (const t of TABLES) await queryInterface.dropTable(t);
  },
};
