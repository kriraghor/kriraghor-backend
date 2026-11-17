'use strict';

/**
 * M24 §21 desk mode with a PIN (product owner, 11 Nov 2026; ADR-010). Expand only:
 *  - gym_desk_pins: a person's own 4-digit desk PIN at a gym (the owner or a staff member). Only an
 *    argon2id hash over a server-keyed value is kept. Wrong tries are counted here (not in Redis, which
 *    fails open): failed_count, lockouts in a row, locked_until. A cleared PIN keeps its row.
 *  - gym_desk_sessions: a device in desk mode. Bound to the sign-in's session family (the session id
 *    changes at every token refresh; the family does not). One open row per family. device_fail_count
 *    stops someone trying the same PIN against every name.
 *  - gym_desk_unlocks: who unlocked the desk and until when. One live row per desk session; while it is
 *    live the server acts as that person. Never deleted.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ type: DataTypes.UUID, allowNull: true, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const small = { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 };
    const index = (name, sql) => h.ensureIndexSql(queryInterface, name, sql);

    await h.ensureTable(queryInterface, 'gym_desk_pins', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      user_id: fk('users'),
      pin_hash: { type: DataTypes.STRING(200), allowNull: true },
      status: { type: h.ENUM('active', 'cleared'), allowNull: false, defaultValue: 'active' },
      failed_count: small,
      lockouts: small,
      locked_until: at,
      set_at: now,
      cleared_at: at,
      cleared_by: optFk('users'),
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_desk_pins', 'chk_gym_desk_pins', "CHECK (((status = 'active') = (pin_hash IS NOT NULL)) AND failed_count >= 0 AND lockouts >= 0)");
    await index('uq_gym_desk_pins_person', 'CREATE UNIQUE INDEX uq_gym_desk_pins_person ON gym_desk_pins (gym_id, user_id)');

    await h.ensureTable(queryInterface, 'gym_desk_sessions', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      owner_id: fk('users'),
      opened_by: fk('users'),
      family_id: uuid,
      opened_session_id: uuid,
      status: { type: h.ENUM('open', 'closed'), allowNull: false, defaultValue: 'open' },
      device_fail_count: small,
      device_locked_until: at,
      opened_at: now,
      closed_at: at,
      closed_by: optFk('users'),
      close_reason: { type: h.ENUM('ended', 'ended_by_owner', 'signed_out', 'opener_left'), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_desk_sessions', 'chk_gym_desk_sessions', "CHECK (((status = 'closed') = (closed_at IS NOT NULL)) AND device_fail_count >= 0)");
    await index('uq_gym_desk_sessions_family', "CREATE UNIQUE INDEX uq_gym_desk_sessions_family ON gym_desk_sessions (family_id) WHERE status = 'open'");
    await index('ix_gym_desk_sessions_gym', "CREATE INDEX ix_gym_desk_sessions_gym ON gym_desk_sessions (gym_id) WHERE status = 'open'");

    await h.ensureTable(queryInterface, 'gym_desk_unlocks', {
      id: { ...uuid, primaryKey: true },
      desk_session_id: fk('gym_desk_sessions'),
      gym_id: fk('gyms'),
      user_id: fk('users'),
      unlocked_at: now,
      last_touch_at: now,
      expires_at: { type: h.TS, allowNull: false },
      ended_at: at,
      end_reason: { type: h.ENUM('locked', 'idle', 'switched', 'closed', 'pin_reset', 'removed'), allowNull: true },
      created_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_desk_unlocks', 'chk_gym_desk_unlocks', 'CHECK ((ended_at IS NULL) = (end_reason IS NULL))');
    await index('uq_gym_desk_unlocks_live', 'CREATE UNIQUE INDEX uq_gym_desk_unlocks_live ON gym_desk_unlocks (desk_session_id) WHERE ended_at IS NULL');
    await index('ix_gym_desk_unlocks_user', 'CREATE INDEX ix_gym_desk_unlocks_user ON gym_desk_unlocks (gym_id, user_id) WHERE ended_at IS NULL');
  },

  // Expand only: the three tables stay.
  async down() {},
};
