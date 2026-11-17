'use strict';

/**
 * M24 §22 the desk through a lost connection (product owner, 11 Nov 2026; ADR-010 amendment). Expand only.
 *
 * gym_desk_offline_items: each check-in or cash fee the desk took while it had no connection, as the
 * server received it later. It is both the duplicate guard (one row per client id per gym, so a resend
 * never applies twice) and the owner's "Offline items to check" list.
 *  - taken_at: the snapshot's server time plus the time that passed on the device (M24-FR-147); a time
 *    after the server's own clock (beyond the skew) is set to the time it arrived and flagged.
 *  - taken_by: who the device says took it (not a foreign key: it is the device's word); recorded_as:
 *    the person the check-in or payment was recorded for (taken_by when that person works at the gym,
 *    otherwise the sender).
 *  - outcome: applied, flagged (applied, with flags) or parked (not applied: the due was already paid or
 *    the member was removed). Flagged and parked rows wait for the owner or fees.adjust staff
 *    (resolution checked, applied_to_due or returned).
 * Never deleted (CLAUDE.md).
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
    const index = (name, sql) => h.ensureIndexSql(queryInterface, name, sql);

    await h.ensureTable(queryInterface, 'gym_desk_offline_items', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      client_id: uuid,
      kind: { type: h.ENUM('checkin', 'cash_fee'), allowNull: false },
      member_id: fk('gym_members'),
      due_id: optFk('gym_dues'),
      amount_poisha: { type: DataTypes.BIGINT, allowNull: true },
      slip_no: { type: DataTypes.STRING(20), allowNull: true },
      method: { type: h.ENUM('desk', 'member_qr'), allowNull: false, defaultValue: 'desk' },
      taken_at: { type: h.TS, allowNull: false },
      taken_on: { type: DataTypes.DATEONLY, allowNull: false },
      taken_by: uuid,
      recorded_as: fk('users'),
      desk_session_id: optFk('gym_desk_sessions'),
      unlock_id: optFk('gym_desk_unlocks'),
      pin_on_device: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      sent_by: fk('users'),
      sent_at: now,
      outcome: { type: h.ENUM('applied', 'flagged', 'parked'), allowNull: false },
      flags: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      park_reason: { type: h.ENUM('due_paid', 'due_changed', 'due_void', 'member_removed', 'member_left'), allowNull: true },
      attendance_id: optFk('gym_attendance'),
      fee_payment_id: optFk('gym_fee_payments'),
      resolution: { type: h.ENUM('checked', 'applied_to_due', 'returned'), allowNull: true },
      resolved_by: optFk('users'),
      resolved_at: at,
      resolution_note: { type: DataTypes.STRING(300), allowNull: true },
      resolution_payment_id: optFk('gym_fee_payments'),
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(
      queryInterface,
      'gym_desk_offline_items',
      'chk_gym_desk_offline_items',
      'CHECK (' +
        // A check-in names no due or money; a cash fee names its due, a positive amount and the slip.
        "((kind = 'checkin' AND due_id IS NULL AND amount_poisha IS NULL AND slip_no IS NULL) OR (kind = 'cash_fee' AND due_id IS NOT NULL AND amount_poisha > 0 AND slip_no IS NOT NULL)) AND " +
        // Parked: nothing applied and a reason; applied or flagged: the row it became, and no park reason.
        "((outcome = 'parked') = (park_reason IS NOT NULL)) AND " +
        "(outcome = 'parked' OR (kind = 'checkin' AND attendance_id IS NOT NULL) OR (kind = 'cash_fee' AND fee_payment_id IS NOT NULL)) AND " +
        "(outcome <> 'parked' OR (attendance_id IS NULL AND fee_payment_id IS NULL)) AND " +
        // A resolution has who and when; an applied item never needs one.
        '((resolution IS NULL) = (resolved_at IS NULL)) AND ((resolution IS NULL) = (resolved_by IS NULL)) AND ' +
        "(resolution IS NULL OR outcome <> 'applied') AND " +
        "((resolution = 'applied_to_due') = (resolution_payment_id IS NOT NULL))" +
        ')'
    );
    await index('uq_gym_desk_offline_items_client', 'CREATE UNIQUE INDEX uq_gym_desk_offline_items_client ON gym_desk_offline_items (gym_id, client_id)');
    await index('ix_gym_desk_offline_items_review', "CREATE INDEX ix_gym_desk_offline_items_review ON gym_desk_offline_items (gym_id, sent_at DESC) WHERE outcome <> 'applied' AND resolution IS NULL");
    await index('ix_gym_desk_offline_items_gym', 'CREATE INDEX ix_gym_desk_offline_items_gym ON gym_desk_offline_items (gym_id, sent_at DESC)');
  },

  // Expand only: the table stays.
  async down() {},
};
