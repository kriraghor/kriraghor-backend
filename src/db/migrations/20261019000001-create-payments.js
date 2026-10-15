'use strict';

/**
 * M06 payments (§7): payments, payment_attempts, provider_webhook_events and refunds, plus two
 * platform helpers M06 is the first to need: id_sequences (human codes such as PAY-26-000123) and
 * idempotency_keys (stored responses for POSTs that carry an Idempotency-Key, CLAUDE.md).
 *
 * MySQL notes vs the Postgres spec:
 *  - purpose is VARCHAR validated by the code registry (payments.purposes.js), so new purposes need
 *    no migration; payment_status and the others are column ENUMs;
 *  - one in-flight attempt per payment: inflight_payment_id is a stored generated column, set only
 *    while status = 'in_flight', with a UNIQUE key (no partial indexes in MySQL);
 *  - UNIQUE(provider, provider_trx_id) works as is because MySQL allows many NULLs.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const q = (sql) => queryInterface.sequelize.query(sql);
    const now = { type: DataTypes.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.CHAR(36), allowNull: false };
    const poisha = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    const PROVIDERS = ['sslcommerz', 'bkash', 'nagad'];

    await queryInterface.createTable('id_sequences', {
      name: { type: DataTypes.STRING(40), primaryKey: true },
      next: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    });

    await queryInterface.createTable('idempotency_keys', {
      scope: { type: DataTypes.STRING(60), primaryKey: true },
      user_id: { ...uuid, primaryKey: true },
      key: { type: DataTypes.STRING(80), primaryKey: true },
      request_hash: { type: DataTypes.CHAR(64), allowNull: false },
      status_code: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
      response: { type: DataTypes.JSON, allowNull: true },
      created_at: now,
      expires_at: { type: DataTypes.DATE(3), allowNull: false },
    });
    await queryInterface.addIndex('idempotency_keys', ['expires_at'], { name: 'ix_idempotency_expires' });

    await queryInterface.createTable('payments', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(20), allowNull: false, unique: true },
      purpose: { type: DataTypes.STRING(30), allowNull: false },
      purpose_id: uuid,
      split_group_id: { type: DataTypes.CHAR(36), allowNull: true },
      payer_id: { ...uuid, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      payee_hint_id: { type: DataTypes.CHAR(36), allowNull: true },
      amount_poisha: { type: DataTypes.BIGINT, allowNull: false },
      captured_poisha: poisha,
      refunded_poisha: poisha,
      status: {
        type: DataTypes.ENUM('initiated', 'pending', 'succeeded', 'failed', 'cancelled', 'expired', 'partially_refunded', 'refunded'),
        allowNull: false,
        defaultValue: 'initiated',
      },
      provider: { type: DataTypes.ENUM(...PROVIDERS), allowNull: true },
      method: { type: DataTypes.ENUM('bkash', 'nagad', 'card', 'other'), allowNull: true },
      method_display: { type: DataTypes.STRING(40), allowNull: true },
      provider_trx_id: { type: DataTypes.STRING(80), allowNull: true },
      title: { type: DataTypes.STRING(120), allowNull: false },
      // Escrow instructions captured at obligation time (FR-07): payee, vertical, fee snapshot, release rule, group.
      escrow: { type: DataTypes.JSON, allowNull: false },
      expires_at: { type: DataTypes.DATE(3), allowNull: false },
      idempotency_key: { type: DataTypes.STRING(120), allowNull: false },
      succeeded_at: { type: DataTypes.DATE(3), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('payments', ['payer_id', 'idempotency_key'], { unique: true, name: 'uq_payments_idempotency' });
    await queryInterface.addIndex('payments', ['provider', 'provider_trx_id'], { unique: true, name: 'uq_payments_provider_trx' });
    await queryInterface.addIndex('payments', ['purpose', 'purpose_id'], { name: 'ix_payments_purpose' });
    await queryInterface.addIndex('payments', ['payer_id', 'created_at'], { name: 'ix_payments_payer' });
    await queryInterface.addIndex('payments', ['status', 'expires_at'], { name: 'ix_payments_status_expiry' });
    await q(
      'ALTER TABLE payments ADD CONSTRAINT ck_payments_amount CHECK (amount_poisha > 0), ' +
        'ADD CONSTRAINT ck_payments_captured CHECK (captured_poisha >= 0), ' +
        'ADD CONSTRAINT ck_payments_refunded CHECK (refunded_poisha >= 0 AND refunded_poisha <= captured_poisha)'
    );

    await queryInterface.createTable('payment_attempts', {
      id: { ...uuid, primaryKey: true },
      payment_id: { ...uuid, references: { model: 'payments', key: 'id' }, onDelete: 'RESTRICT' },
      provider: { type: DataTypes.ENUM(...PROVIDERS), allowNull: false },
      method: { type: DataTypes.ENUM('bkash', 'nagad', 'card', 'other'), allowNull: true },
      provider_session_id: { type: DataTypes.STRING(120), allowNull: true },
      status: { type: DataTypes.ENUM('in_flight', 'succeeded', 'failed', 'cancelled', 'unknown'), allowNull: false, defaultValue: 'in_flight' },
      request: { type: DataTypes.JSON, allowNull: true },
      response: { type: DataTypes.JSON, allowNull: true },
      failure_code: { type: DataTypes.STRING(60), allowNull: true },
      started_at: now,
      finished_at: { type: DataTypes.DATE(3), allowNull: true },
    });
    await queryInterface.addIndex('payment_attempts', ['payment_id', 'started_at'], { name: 'ix_attempts_payment' });
    await q(
      "ALTER TABLE payment_attempts ADD COLUMN inflight_payment_id CHAR(36) GENERATED ALWAYS AS (IF(status = 'in_flight', payment_id, NULL)) STORED, " +
        'ADD UNIQUE KEY uq_attempts_one_inflight (inflight_payment_id)'
    );

    await queryInterface.createTable('provider_webhook_events', {
      id: { ...uuid, primaryKey: true },
      provider: { type: DataTypes.ENUM(...PROVIDERS), allowNull: false },
      provider_event_id: { type: DataTypes.STRING(120), allowNull: false },
      payment_id: { type: DataTypes.CHAR(36), allowNull: true },
      signature_ok: { type: DataTypes.BOOLEAN, allowNull: false },
      raw: { type: DataTypes.JSON, allowNull: false },
      received_at: now,
      processed_at: { type: DataTypes.DATE(3), allowNull: true },
      result: { type: DataTypes.STRING(30), allowNull: true },
    });
    await queryInterface.addIndex('provider_webhook_events', ['provider', 'provider_event_id'], { unique: true, name: 'uq_webhook_provider_event' });

    await queryInterface.createTable('refunds', {
      id: { ...uuid, primaryKey: true },
      payment_id: { ...uuid, references: { model: 'payments', key: 'id' }, onDelete: 'RESTRICT' },
      amount_poisha: { type: DataTypes.BIGINT, allowNull: false },
      reason_code: { type: DataTypes.STRING(40), allowNull: false },
      reason_text: { type: DataTypes.STRING(500), allowNull: true },
      kind: { type: DataTypes.ENUM('policy', 'manual', 'dispute', 'late_capture', 'amount_mismatch', 'goodwill'), allowNull: false },
      // Which account the money comes from: the escrow hold, the payee's released money (goodwill) or suspense.
      source: { type: DataTypes.ENUM('escrow', 'goodwill', 'suspense'), allowNull: false, defaultValue: 'escrow' },
      status: {
        type: DataTypes.ENUM('pending_master', 'approved', 'processing', 'succeeded', 'failed', 'manual_required', 'rejected'),
        allowNull: false,
      },
      initiated_by: { type: DataTypes.CHAR(36), allowNull: true },
      // FR-09: the staff cap counts what staff (not masters or the system) refunded on a payment.
      initiator_kind: { type: DataTypes.ENUM('system', 'staff', 'master'), allowNull: false },
      recommended_poisha: { type: DataTypes.BIGINT, allowNull: true },
      approved_by: { type: DataTypes.CHAR(36), allowNull: true },
      decision_note: { type: DataTypes.STRING(500), allowNull: true },
      provider_refund_id: { type: DataTypes.STRING(120), allowNull: true },
      attempts: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      last_error: { type: DataTypes.STRING(120), allowNull: true },
      idempotency_key: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      created_at: now,
      updated_at: now,
      completed_at: { type: DataTypes.DATE(3), allowNull: true },
    });
    await queryInterface.addIndex('refunds', ['payment_id'], { name: 'ix_refunds_payment' });
    await queryInterface.addIndex('refunds', ['status', 'created_at'], { name: 'ix_refunds_status' });
    await q('ALTER TABLE refunds ADD CONSTRAINT ck_refunds_amount CHECK (amount_poisha > 0)');
  },

  async down(queryInterface) {
    for (const t of ['refunds', 'provider_webhook_events', 'payment_attempts', 'payments', 'idempotency_keys', 'id_sequences']) {
      await queryInterface.dropTable(t);
    }
  },
};
