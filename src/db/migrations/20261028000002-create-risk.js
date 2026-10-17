'use strict';

/**
 * M18 Risk and Trust, step 1 (§7, decided 18 Oct 2026).
 *
 *  - risk_rules: the rules (seeded here); thresholds live in platform_settings (setting_key), never in
 *    the row. version goes up when the rule's meaning changes; each flag records the version it used.
 *  - risk_metrics: the latest computed value per user and metric (a rebuildable projection).
 *  - risk_flags: one open or actioned flag per user and rule (partial unique index).
 *  - risk_actions: append-only; an undo is a new row that reverses an earlier one.
 *  - trust_scores: reliability per user and kind (owner, booker), a rebuildable projection.
 * Only ids, keys and numbers are stored: no phone, NID or wallet numbers.
 */
const RULES = [
  ['accounts_per_nid', 'nid_attempts', 'gt', 'risk.max_accounts_per_nid', 'critical', 'Another account tried to verify with the same NID'],
  ['shared_payout_account', 'shared_wallets', 'gte', null, 'critical', 'A payout wallet is used by another verified account'],
  ['esports_uid_banned', 'esports_bans', 'gte', null, 'critical', 'A game UID of this account was banned'],
  ['refund_rate', 'payee_refund_pct', 'gte', 'risk.refund_rate_pct', 'high', 'Many payments to this account were refunded'],
  ['dispute_loss_rate', 'dispute_loss_pct', 'gte', 'risk.dispute_loss_pct', 'high', 'This account loses many of the disputes against it'],
  ['reports_upheld', 'reports_upheld', 'gte', 'risk.reports_upheld_max', 'high', 'Several reports against this account were upheld'],
  ['esports_disqualified', 'esports_dqs', 'gte', 'risk.esports_dq_max', 'high', 'Disqualified from several tournaments'],
  ['velocity_breaches', 'velocity_breaches', 'gte', 'risk.velocity_breaches_max', 'medium', 'Hit the rate limits many times in a day'],
  ['payout_account_change', 'payout_account_added', 'gte', null, 'info', 'Added a new payout account (payouts wait risk.payout_change_hold_hours)'],
];

module.exports = {
  RULES,
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const TS = 'TIMESTAMP(3) WITH TIME ZONE';
    const now = { type: TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const fk = (table, allowNull = false) => ({ type: DataTypes.UUID, allowNull, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const SEVERITY = ['info', 'medium', 'high', 'critical'];
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, replacements ? { replacements } : undefined);

    await h.createTable(queryInterface, 'risk_rules', {
      key: { type: DataTypes.STRING(40), allowNull: false, primaryKey: true },
      metric: { type: DataTypes.STRING(40), allowNull: false },
      comparator: { type: h.ENUM('gte', 'gt'), allowNull: false },
      setting_key: { type: DataTypes.STRING(80), allowNull: true },
      severity: { type: h.ENUM(...SEVERITY), allowNull: false },
      description: { type: DataTypes.STRING(200), allowNull: false },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: now,
      updated_at: now,
    });

    await queryInterface.createTable('risk_metrics', {
      user_id: { ...fk('users'), primaryKey: true },
      metric: { type: DataTypes.STRING(40), allowNull: false, primaryKey: true },
      value: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      sample: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      detail: { type: DataTypes.JSONB, allowNull: true },
      computed_at: now,
    });

    await h.createTable(queryInterface, 'risk_flags', {
      id: { ...uuid, primaryKey: true },
      user_id: fk('users'),
      rule_key: { type: DataTypes.STRING(40), allowNull: false, references: { model: 'risk_rules', key: 'key' }, onDelete: 'RESTRICT' },
      rule_version: { type: DataTypes.INTEGER, allowNull: false },
      metric_value: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      threshold: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      severity: { type: h.ENUM(...SEVERITY), allowNull: false },
      reason_text: { type: DataTypes.STRING(300), allowNull: false },
      status: { type: h.ENUM('open', 'actioned', 'cleared', 'lapsed'), allowNull: false, defaultValue: 'open' },
      escalated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      snooze_until: at,
      cleared_value: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      first_seen_at: now,
      last_seen_at: now,
      closed_at: at,
      created_at: now,
      updated_at: now,
    });
    await q("CREATE UNIQUE INDEX uq_risk_flags_active ON risk_flags (user_id, rule_key) WHERE status IN ('open', 'actioned')");
    await queryInterface.addIndex('risk_flags', ['status', 'severity', 'last_seen_at'], { name: 'ix_risk_flags_queue' });
    await queryInterface.addIndex('risk_flags', ['user_id', 'created_at'], { name: 'ix_risk_flags_user' });

    await h.createTable(queryInterface, 'risk_actions', {
      id: { ...uuid, primaryKey: true },
      user_id: fk('users'),
      flag_id: fk('risk_flags', true),
      action: { type: h.ENUM('freeze_payouts', 'unfreeze_payouts', 'request_documents', 'cancel_document_request', 'clear', 'reopen', 'suspend', 'ban', 'restore'), allowNull: false },
      reason: { type: DataTypes.STRING(500), allowNull: false },
      actor_id: fk('users', true),
      actor_role: { type: h.ENUM('staff', 'master', 'system'), allowNull: false },
      reverses_action_id: fk('risk_actions', true),
      payout_hold_id: { type: DataTypes.UUID, allowNull: true },
      document_request_id: { type: DataTypes.UUID, allowNull: true },
      sanction_id: { type: DataTypes.UUID, allowNull: true },
      params: { type: DataTypes.JSONB, allowNull: true },
      created_at: now,
    });
    await queryInterface.addIndex('risk_actions', ['user_id', 'created_at'], { name: 'ix_risk_actions_user' });
    await q('CREATE UNIQUE INDEX uq_risk_actions_reversal ON risk_actions (reverses_action_id) WHERE reverses_action_id IS NOT NULL');
    await q('ALTER TABLE risk_actions ADD CONSTRAINT chk_risk_actions_reason CHECK (char_length(reason) >= 10)');
    await h.appendOnly(queryInterface, 'risk_actions');

    await h.createTable(queryInterface, 'trust_scores', {
      user_id: { ...fk('users'), primaryKey: true },
      kind: { type: h.ENUM('owner', 'booker'), allowNull: false, primaryKey: true },
      score: { type: DataTypes.SMALLINT, allowNull: true },
      sample: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      incidents: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      shown: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      detail: { type: DataTypes.JSONB, allowNull: true },
      computed_at: now,
    });
    await q('ALTER TABLE trust_scores ADD CONSTRAINT chk_trust_scores_score CHECK (score IS NULL OR score BETWEEN 0 AND 100)');

    for (const [key, metric, comparator, settingKey, severity, description] of RULES) {
      await q('INSERT INTO risk_rules (key, metric, comparator, setting_key, severity, description) VALUES (?, ?, ?, ?, ?, ?)', [key, metric, comparator, settingKey, severity, description]);
    }
  },

  async down(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.dropAppendOnly(queryInterface, 'risk_actions');
    for (const t of ['trust_scores', 'risk_actions', 'risk_flags', 'risk_metrics', 'risk_rules']) await queryInterface.dropTable(t);
  },
};
