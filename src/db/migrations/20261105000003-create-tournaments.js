'use strict';

/**
 * M14 Tournaments, step 1 (owned by M14). Physical-sport tournaments run by verified organisations:
 *  - tournaments: the event, reviewed on the Moderation desk (M05 kind `tournament`); fee and
 *    release snapshots at approval; never deleted (cancelled instead).
 *  - tournament_rules: the M03 rule values, format settings and tiebreakers.
 *  - tournament_venues: an M09 ground or a free-text venue with an area (no M10 courts in step 1).
 *  - stages, groups, group_teams: the league, groups or knockout, the draw (seed published).
 *  - registrations: a team entering, with the entry fee in escrow (M06 purpose tournament_entry),
 *    the reserve list and offers; one live registration per (tournament, team).
 *  - matches: numbered fixtures with placeholder references; regenerating cancels old drafts.
 */
const TOURNAMENT_STATUS = ['draft', 'pending_review', 'changes_requested', 'rejected', 'registration_open', 'registration_closed', 'live', 'completed', 'cancelled'];
const REG_STATUS = ['pending_payment', 'reserve', 'offered', 'pending_approval', 'approved', 'rejected', 'lapsed', 'withdrawn', 'removed', 'cancelled'];
const MATCH_STATUS = ['draft', 'scheduled', 'postponed', 'completed', 'no_result', 'walkover', 'abandoned', 'cancelled'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const q = (sql) => queryInterface.sequelize.query(sql);

    await h.createTable(queryInterface, 'tournaments', {
      id: { ...uuid, primaryKey: true },
      organisation_id: fk('organisations'),
      sport_id: fk('sports'),
      slug: { type: DataTypes.STRING(100), allowNull: false },
      name: { type: DataTypes.STRING(80), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      format: { type: h.ENUM('league', 'double_league', 'groups_knockout', 'knockout'), allowNull: false },
      category: { type: DataTypes.STRING(20), allowNull: true },
      status: { type: h.ENUM(...TOURNAMENT_STATUS), allowNull: false, defaultValue: 'draft' },
      min_teams: { type: DataTypes.SMALLINT, allowNull: false },
      max_teams: { type: DataTypes.SMALLINT, allowNull: false },
      squad_min: { type: DataTypes.SMALLINT, allowNull: false },
      squad_max: { type: DataTypes.SMALLINT, allowNull: false },
      entry_fee_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      prize_pool_poisha: { type: DataTypes.BIGINT, allowNull: true },
      prize_split: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      prize_text: { type: DataTypes.STRING(200), allowNull: true },
      eligibility: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      contact_user_id: optFk('users'),
      registration_opens_at: at,
      registration_closes_at: at,
      start_date: { type: DataTypes.DATEONLY, allowNull: true },
      end_date: { type: DataTypes.DATEONLY, allowNull: true },
      fee_bps: { type: DataTypes.INTEGER, allowNull: true },
      release_pct: { type: DataTypes.SMALLINT, allowNull: true },
      rules_locked_at: at,
      rules_unlocked_until: at,
      first_result_at: at,
      tranche1_at: at,
      extended: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      current_submission_id: optUuid,
      review_reason: { type: DataTypes.JSONB, allowNull: true },
      approved_at: at,
      completed_at: at,
      cancelled_at: at,
      cancelled_by: optUuid,
      cancel_reason: { type: DataTypes.STRING(255), allowNull: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      created_by: uuid,
      updated_by: optUuid,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('tournaments', ['slug'], { unique: true, name: 'uq_tournaments_slug' });
    await queryInterface.addIndex('tournaments', ['organisation_id', 'status'], { name: 'ix_tournaments_org' });
    await queryInterface.addIndex('tournaments', ['status', 'start_date'], { name: 'ix_tournaments_status' });
    await queryInterface.addIndex('tournaments', ['sport_id', 'status'], { name: 'ix_tournaments_sport' });
    await q("CREATE UNIQUE INDEX uq_tournaments_name_year ON tournaments (organisation_id, lower(name), (EXTRACT(YEAR FROM start_date))) WHERE status NOT IN ('cancelled', 'rejected') AND start_date IS NOT NULL");
    await q('ALTER TABLE tournaments ADD CONSTRAINT chk_tournaments_teams CHECK (min_teams >= 2 AND min_teams <= max_teams)');
    await q('ALTER TABLE tournaments ADD CONSTRAINT chk_tournaments_squad CHECK (squad_min >= 1 AND squad_min <= squad_max)');
    await q('ALTER TABLE tournaments ADD CONSTRAINT chk_tournaments_fee CHECK (entry_fee_poisha >= 0 AND (prize_pool_poisha IS NULL OR prize_pool_poisha >= 0))');
    await q('ALTER TABLE tournaments ADD CONSTRAINT chk_tournaments_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)');

    await h.createTable(queryInterface, 'tournament_rules', {
      tournament_id: { ...fk('tournaments'), primaryKey: true },
      schema_version: { type: DataTypes.SMALLINT, allowNull: false },
      preset_key: { type: DataTypes.STRING(30), allowNull: false },
      values: { type: DataTypes.JSONB, allowNull: false },
      format_config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      tiebreakers: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      summary_en: { type: DataTypes.TEXT, allowNull: true },
      summary_bn: { type: DataTypes.TEXT, allowNull: true },
      created_at: now,
      updated_at: now,
    });

    await h.createTable(queryInterface, 'tournament_venues', {
      id: { ...uuid, primaryKey: true },
      tournament_id: fk('tournaments'),
      ground_id: optFk('grounds'),
      venue_text: { type: DataTypes.STRING(160), allowNull: true },
      area_id: optFk('areas'),
      courts: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('tournament_venues', ['tournament_id', 'status'], { name: 'ix_tournament_venues' });
    await q('ALTER TABLE tournament_venues ADD CONSTRAINT chk_tournament_venues_where CHECK (ground_id IS NOT NULL OR venue_text IS NOT NULL)');

    await h.createTable(queryInterface, 'stages', {
      id: { ...uuid, primaryKey: true },
      tournament_id: fk('tournaments'),
      key: { type: h.ENUM('L', 'G', 'K'), allowNull: false },
      kind: { type: h.ENUM('league', 'group', 'knockout'), allowNull: false },
      seq: { type: DataTypes.SMALLINT, allowNull: false },
      seeding: { type: h.ENUM('registration_order', 'manual', 'random'), allowNull: true },
      draw_seed: { type: DataTypes.STRING(64), allowNull: true },
      draw_confirmed_at: at,
      draw_confirmed_by: optUuid,
      lots: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      status: { type: h.ENUM('draft', 'active', 'completed', 'cancelled'), allowNull: false, defaultValue: 'draft' },
      created_at: now,
      updated_at: now,
    });
    await q("CREATE UNIQUE INDEX uq_stages_seq ON stages (tournament_id, seq) WHERE status <> 'cancelled'");

    await h.createTable(queryInterface, 'groups', {
      id: { ...uuid, primaryKey: true },
      stage_id: fk('stages'),
      name: { type: DataTypes.STRING(2), allowNull: false },
      seq: { type: DataTypes.SMALLINT, allowNull: false },
      created_at: now,
    });
    await queryInterface.addIndex('groups', ['stage_id', 'name'], { unique: true, name: 'uq_groups_name' });

    await h.createTable(queryInterface, 'group_teams', {
      id: { ...uuid, primaryKey: true },
      group_id: fk('groups'),
      team_id: fk('teams'),
      seed_no: { type: DataTypes.SMALLINT, allowNull: false },
      created_at: now,
    });
    await queryInterface.addIndex('group_teams', ['group_id', 'team_id'], { unique: true, name: 'uq_group_teams' });

    await h.createTable(queryInterface, 'registrations', {
      id: { ...uuid, primaryKey: true },
      tournament_id: fk('tournaments'),
      team_id: fk('teams'),
      captain_id: fk('users'),
      status: { type: h.ENUM(...REG_STATUS), allowNull: false },
      reserve_position: { type: DataTypes.INTEGER, allowNull: true },
      seed_no: { type: DataTypes.SMALLINT, allowNull: true },
      hold_expires_at: at,
      offer_expires_at: at,
      payment_id: optUuid,
      fee_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      fee_waived: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      waive_reason: { type: DataTypes.STRING(255), allowNull: true },
      refunded_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      idempotency_key: { type: DataTypes.STRING(80), allowNull: true },
      reason: { type: DataTypes.STRING(255), allowNull: true },
      decided_by: optUuid,
      decided_at: at,
      approved_at: at,
      ended_at: at,
      created_at: now,
      updated_at: now,
    });
    await q("CREATE UNIQUE INDEX uq_registrations_live ON registrations (tournament_id, team_id) WHERE status IN ('pending_payment', 'reserve', 'offered', 'pending_approval', 'approved')");
    await q('CREATE UNIQUE INDEX uq_registrations_idem ON registrations (captain_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
    await queryInterface.addIndex('registrations', ['tournament_id', 'status', 'reserve_position'], { name: 'ix_registrations_tournament' });
    await queryInterface.addIndex('registrations', ['payment_id'], { name: 'ix_registrations_payment' });
    await queryInterface.addIndex('registrations', ['status', 'hold_expires_at'], { name: 'ix_registrations_hold' });
    await q('ALTER TABLE registrations ADD CONSTRAINT chk_registrations_money CHECK (fee_poisha >= 0 AND refunded_poisha >= 0 AND refunded_poisha <= fee_poisha)');

    await h.createTable(queryInterface, 'matches', {
      id: { ...uuid, primaryKey: true },
      tournament_id: fk('tournaments'),
      stage_id: fk('stages'),
      group_id: optFk('groups'),
      round: { type: DataTypes.SMALLINT, allowNull: false },
      match_no: { type: DataTypes.SMALLINT, allowNull: false },
      round_name: { type: DataTypes.STRING(20), allowNull: true },
      team_a_ref: { type: DataTypes.JSONB, allowNull: false },
      team_b_ref: { type: DataTypes.JSONB, allowNull: false },
      team_a_id: optFk('teams'),
      team_b_id: optFk('teams'),
      scheduled_start: at,
      scheduled_end: at,
      venue_id: optFk('tournament_venues'),
      court: { type: DataTypes.STRING(40), allowNull: true },
      status: { type: h.ENUM(...MATCH_STATUS), allowNull: false, defaultValue: 'draft' },
      status_reason: { type: DataTypes.STRING(255), allowNull: true },
      postponed_from: at,
      walkover_team_id: optFk('teams'),
      published: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: now,
      updated_at: now,
    });
    await q("CREATE UNIQUE INDEX uq_matches_no ON matches (tournament_id, match_no) WHERE NOT (status = 'cancelled' AND status_reason = 'regenerated')");
    await queryInterface.addIndex('matches', ['tournament_id', 'scheduled_start'], { name: 'ix_matches_time' });
    await queryInterface.addIndex('matches', ['stage_id', 'group_id'], { name: 'ix_matches_stage' });
    await q('ALTER TABLE matches ADD CONSTRAINT chk_matches_time CHECK (scheduled_end IS NULL OR scheduled_end > scheduled_start)');
  },

  async down(queryInterface) {
    for (const t of ['matches', 'registrations', 'group_teams', 'groups', 'stages', 'tournament_venues', 'tournament_rules', 'tournaments']) await queryInterface.dropTable(t);
  },
};
