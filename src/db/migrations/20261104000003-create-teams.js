'use strict';

/**
 * M16 Teams and players, step 1 (owned by M16):
 *  - teams: a sports team (one sport); name and short code are not unique, so a captaincy hand-over
 *    can never fail on them.
 *  - team_members: one active row per (team, user); one active captain and at most one active
 *    vice-captain per team (partial unique indexes; hand-over demotes before it promotes).
 *  - team_invites: by phone, stored only as hmac('phone:'+e164) and a masked form (no plain phone);
 *    a share-link token hash; one pending invite per (team, phone).
 *  - player_profiles: a member's sports and positions, bio and visibility (the handle is the username).
 * Rosters, RSVPs, lineups, suspensions and transfers come with M14 and M15.
 */
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

    await h.createTable(queryInterface, 'teams', {
      id: { ...uuid, primaryKey: true },
      sport_id: fk('sports'),
      name: { type: DataTypes.STRING(40), allowNull: false },
      short_code: { type: DataTypes.STRING(4), allowNull: true },
      home_area_id: optFk('areas'),
      logo_key: { type: DataTypes.STRING(255), allowNull: true },
      status: { type: h.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
      archived_at: at,
      archive_reason: { type: DataTypes.STRING(255), allowNull: true },
      created_by: uuid,
      updated_by: optUuid,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('teams', ['sport_id', 'status'], { name: 'ix_teams_sport' });
    await q("ALTER TABLE teams ADD CONSTRAINT chk_teams_short_code CHECK (short_code IS NULL OR short_code ~ '^[A-Z0-9]{2,4}$')");

    await h.createTable(queryInterface, 'team_members', {
      id: { ...uuid, primaryKey: true },
      team_id: fk('teams'),
      user_id: fk('users'),
      role: { type: h.ENUM('captain', 'vice_captain', 'player'), allowNull: false, defaultValue: 'player' },
      jersey_no: { type: DataTypes.SMALLINT, allowNull: true },
      status: { type: h.ENUM('active', 'left', 'removed'), allowNull: false, defaultValue: 'active' },
      left_reason: { type: DataTypes.STRING(40), allowNull: true },
      joined_at: now,
      left_at: at,
      added_by: optUuid,
      created_at: now,
      updated_at: now,
    });
    await q("CREATE UNIQUE INDEX uq_team_members_active ON team_members (team_id, user_id) WHERE status = 'active'");
    await q("CREATE UNIQUE INDEX uq_team_members_captain ON team_members (team_id) WHERE status = 'active' AND role = 'captain'");
    await q("CREATE UNIQUE INDEX uq_team_members_vice ON team_members (team_id) WHERE status = 'active' AND role = 'vice_captain'");
    await queryInterface.addIndex('team_members', ['user_id', 'status'], { name: 'ix_team_members_user' });
    await q('ALTER TABLE team_members ADD CONSTRAINT chk_team_members_jersey CHECK (jersey_no IS NULL OR jersey_no BETWEEN 0 AND 999)');

    await h.createTable(queryInterface, 'team_invites', {
      id: { ...uuid, primaryKey: true },
      team_id: fk('teams'),
      phone_hash: { type: DataTypes.STRING(64), allowNull: false },
      phone_masked: { type: DataTypes.STRING(20), allowNull: false },
      user_id: optFk('users'),
      role: { type: h.ENUM('vice_captain', 'player'), allowNull: false, defaultValue: 'player' },
      invited_by: fk('users'),
      token_hash: { type: DataTypes.STRING(64), allowNull: false },
      status: { type: h.ENUM('pending', 'accepted', 'declined', 'expired', 'cancelled'), allowNull: false, defaultValue: 'pending' },
      expires_at: { type: h.TS, allowNull: false },
      resent_at: at,
      resend_count: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      decided_at: at,
      decided_by: optUuid,
      created_at: now,
      updated_at: now,
    });
    await q("CREATE UNIQUE INDEX uq_team_invites_pending ON team_invites (team_id, phone_hash) WHERE status = 'pending'");
    await queryInterface.addIndex('team_invites', ['token_hash'], { unique: true, name: 'uq_team_invites_token' });
    await queryInterface.addIndex('team_invites', ['phone_hash', 'status'], { name: 'ix_team_invites_phone' });
    await queryInterface.addIndex('team_invites', ['status', 'expires_at'], { name: 'ix_team_invites_expiry' });

    await h.createTable(queryInterface, 'player_profiles', {
      user_id: { ...fk('users'), primaryKey: true },
      sports: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      bio: { type: DataTypes.STRING(500), allowNull: true },
      visibility: { type: h.ENUM('public', 'members'), allowNull: false, defaultValue: 'public' },
      created_at: now,
      updated_at: now,
    });
  },

  async down(queryInterface) {
    for (const t of ['player_profiles', 'team_invites', 'team_members', 'teams']) await queryInterface.dropTable(t);
  },
};
