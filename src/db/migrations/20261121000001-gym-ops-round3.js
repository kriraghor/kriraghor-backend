'use strict';

/**
 * M27 Gym operations, round 3a (approved 7 Nov 2026): staff and equipment. Bookkeeping only, like rounds 1
 * and 2: payroll is the gym's own record; Kriraghor never pays staff (M27 open question 4).
 *
 * gym-ops (gym group, ADR-007):
 *  - gym_staff_shifts: weekly shifts per staff member (M27-FR-72);
 *  - gym_staff_times (append-only): clock in and out, at the desk, by the entrance QR or by the auto-close
 *    job (M27-FR-73..75);
 *  - gym_staff_pay: each staff member's pay terms (M27-FR-76);
 *  - gym_payroll_runs, gym_payroll_lines: a month's payroll, draft → approved → paid; a paid line is a
 *    salary expense (M27-FR-77..81);
 *  - gym_assets, gym_asset_logs (append-only): the equipment register with services and repairs
 *    (M27-FR-82..86).
 * Settings: gym_saas.feature_min_tiers gains staff_attendance and equipment (standard) and payroll (pro),
 * keeping what a master changed. Value lists are VARCHAR + named CHECK; nothing is deleted.
 */
const crypto = require('node:crypto');

const NEW_FEATURES = { staff_attendance: 'standard', equipment: 'standard', payroll: 'pro' };
const METHODS = ['cash', 'owner_bkash', 'owner_nagad', 'card_counter', 'bank', 'other'];
const ASSET_STATUS = ['working', 'needs_service', 'out_of_order', 'retired'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes, QueryTypes } = Sequelize;
    const db = queryInterface.sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const atReq = { type: h.TS, allowNull: false };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const str = (n, allowNull = true) => ({ type: DataTypes.STRING(n), allowNull });
    const int = (allowNull = false) => ({ type: DataTypes.INTEGER, allowNull });
    const small = (allowNull = false) => ({ type: DataTypes.SMALLINT, allowNull });
    const day = (allowNull = false) => ({ type: DataTypes.DATEONLY, allowNull });
    const money = (allowNull = false) => ({ type: DataTypes.BIGINT, allowNull });
    const money0 = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    const index = (name, sql) => h.ensureIndexSql(queryInterface, name, sql);
    const HHMM = "'^([01][0-9]|2[0-3]):[0-5][0-9]$'";

    // ---------------- staff attendance
    await h.ensureTable(queryInterface, 'gym_staff_shifts', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      business_member_id: fk('business_members'),
      dow: small(),
      start_time: str(5, false),
      end_time: str(5, false),
      status: { type: h.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
      created_by: fk('users'),
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_staff_shifts', 'chk_gym_staff_shifts', `CHECK (dow BETWEEN 0 AND 6 AND start_time ~ ${HHMM} AND end_time ~ ${HHMM} AND end_time > start_time)`);
    await index('uq_gym_staff_shifts_slot', "CREATE UNIQUE INDEX uq_gym_staff_shifts_slot ON gym_staff_shifts (business_member_id, dow, start_time) WHERE status = 'active'");
    await index('ix_gym_staff_shifts_gym', 'CREATE INDEX ix_gym_staff_shifts_gym ON gym_staff_shifts (gym_id, dow)');

    await h.ensureTable(queryInterface, 'gym_staff_times', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      business_member_id: fk('business_members'),
      user_id: fk('users'),
      kind: { type: h.ENUM('in', 'out'), allowNull: false },
      at: atReq,
      local_date: day(),
      method: { type: h.ENUM('desk', 'entrance_qr', 'auto'), allowNull: false },
      by_user: optFk('users'),
      note: str(200),
      created_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_staff_times', 'chk_gym_staff_times', "CHECK (method <> 'auto' OR kind = 'out')");
    await index('ix_gym_staff_times_gym', 'CREATE INDEX ix_gym_staff_times_gym ON gym_staff_times (gym_id, local_date)');
    await index('ix_gym_staff_times_staff', 'CREATE INDEX ix_gym_staff_times_staff ON gym_staff_times (business_member_id, at DESC)');
    await h.ensureAppendOnly(queryInterface, 'gym_staff_times');

    // ---------------- payroll
    await h.ensureTable(queryInterface, 'gym_staff_pay', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      business_member_id: fk('business_members'),
      base_poisha: money0,
      pt_commission_bps: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      sales_commission_bps: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      note: str(200),
      updated_by: fk('users'),
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_staff_pay', 'chk_gym_staff_pay', 'CHECK (base_poisha >= 0 AND pt_commission_bps BETWEEN 0 AND 10000 AND sales_commission_bps BETWEEN 0 AND 10000)');
    await index('uq_gym_staff_pay_member', 'CREATE UNIQUE INDEX uq_gym_staff_pay_member ON gym_staff_pay (business_member_id)');

    await h.ensureTable(queryInterface, 'gym_payroll_runs', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      period: str(7, false),
      status: { type: h.ENUM('draft', 'approved', 'paid', 'void'), allowNull: false, defaultValue: 'draft' },
      created_by: fk('users'),
      approved_by: optFk('users'),
      approved_at: at,
      paid_at: at,
      voided_by: optFk('users'),
      voided_at: at,
      void_reason: str(300),
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(
      queryInterface,
      'gym_payroll_runs',
      'chk_gym_payroll_runs',
      "CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND ((status IN ('approved', 'paid')) = (approved_at IS NOT NULL) OR status = 'void') AND ((status = 'paid') = (paid_at IS NOT NULL)) AND ((status = 'void') = (voided_at IS NOT NULL)))"
    );
    await index('uq_gym_payroll_runs_period', "CREATE UNIQUE INDEX uq_gym_payroll_runs_period ON gym_payroll_runs (gym_id, period) WHERE status <> 'void'");

    await h.ensureTable(queryInterface, 'gym_payroll_lines', {
      id: { ...uuid, primaryKey: true },
      run_id: fk('gym_payroll_runs'),
      gym_id: fk('gyms'),
      business_member_id: fk('business_members'),
      user_id: fk('users'),
      base_poisha: money0,
      pt_base_poisha: money0,
      pt_commission_bps: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      pt_commission_poisha: money0,
      sales_base_poisha: money0,
      sales_commission_bps: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      sales_commission_poisha: money0,
      bonus_poisha: money0,
      deduction_poisha: money0,
      net_poisha: money(),
      worked_minutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      late_count: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      missed_count: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      note: str(200),
      status: { type: h.ENUM('unpaid', 'paid'), allowNull: false, defaultValue: 'unpaid' },
      paid_method: { type: h.ENUM(...METHODS), allowNull: true },
      paid_on: day(true),
      expense_id: optFk('gym_expenses'),
      paid_by: optFk('users'),
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(
      queryInterface,
      'gym_payroll_lines',
      'chk_gym_payroll_lines',
      'CHECK (base_poisha >= 0 AND pt_base_poisha >= 0 AND pt_commission_poisha >= 0 AND sales_base_poisha >= 0 AND sales_commission_poisha >= 0 AND bonus_poisha >= 0 AND deduction_poisha >= 0 AND net_poisha >= 0 ' +
        "AND net_poisha = base_poisha + pt_commission_poisha + sales_commission_poisha + bonus_poisha - deduction_poisha AND ((status = 'paid') = (paid_on IS NOT NULL AND paid_method IS NOT NULL)))"
    );
    await index('uq_gym_payroll_lines_member', 'CREATE UNIQUE INDEX uq_gym_payroll_lines_member ON gym_payroll_lines (run_id, business_member_id)');
    await index('ix_gym_payroll_lines_staff', 'CREATE INDEX ix_gym_payroll_lines_staff ON gym_payroll_lines (user_id, created_at DESC)');

    // ---------------- equipment
    await h.ensureTable(queryInterface, 'gym_assets', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      name: str(80, false),
      category: { type: h.ENUM('cardio', 'strength', 'free_weight', 'bench_rack', 'accessory', 'electrical', 'furniture', 'other'), allowNull: false },
      brand: str(60),
      serial: str(60),
      location: str(60),
      bought_on: day(true),
      cost_poisha: money(true),
      status: { type: h.ENUM(...ASSET_STATUS), allowNull: false, defaultValue: 'working' },
      service_every_days: int(true),
      last_service_on: day(true),
      next_service_on: day(true),
      service_alerted_on: day(true),
      note: str(300),
      created_by: fk('users'),
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(
      queryInterface,
      'gym_assets',
      'chk_gym_assets',
      'CHECK ((cost_poisha IS NULL OR cost_poisha >= 0) AND (service_every_days IS NULL OR service_every_days BETWEEN 1 AND 3650) AND ((service_every_days IS NULL) = (next_service_on IS NULL)))'
    );
    await index('ix_gym_assets_gym', 'CREATE INDEX ix_gym_assets_gym ON gym_assets (gym_id, status)');
    await index('ix_gym_assets_service', "CREATE INDEX ix_gym_assets_service ON gym_assets (next_service_on) WHERE status <> 'retired' AND next_service_on IS NOT NULL");

    await h.ensureTable(queryInterface, 'gym_asset_logs', {
      id: { ...uuid, primaryKey: true },
      asset_id: fk('gym_assets'),
      gym_id: fk('gyms'),
      kind: { type: h.ENUM('service', 'repair', 'status', 'note'), allowNull: false },
      done_on: day(),
      cost_poisha: money(true),
      status_after: { type: h.ENUM(...ASSET_STATUS), allowNull: true },
      note: str(300),
      expense_id: optFk('gym_expenses'),
      by_user: fk('users'),
      created_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_asset_logs', 'chk_gym_asset_logs', "CHECK ((cost_poisha IS NULL OR cost_poisha > 0) AND (kind <> 'status' OR status_after IS NOT NULL) AND (expense_id IS NULL OR cost_poisha IS NOT NULL))");
    await index('ix_gym_asset_logs_asset', 'CREATE INDEX ix_gym_asset_logs_asset ON gym_asset_logs (asset_id, done_on DESC, created_at DESC)');
    await h.ensureAppendOnly(queryInterface, 'gym_asset_logs');


    // ---------------- settings: new features into the tier map (values a master set are kept)
    await db.transaction(async (transaction) => {
      const rows = await db.query("SELECT value, version FROM platform_settings WHERE key = 'gym_saas.feature_min_tiers' FOR UPDATE", { type: QueryTypes.SELECT, transaction });
      if (!rows.length) return;
      const { value, version } = rows[0];
      const next = { ...NEW_FEATURES, ...(value ?? {}) };
      if (JSON.stringify(next) === JSON.stringify(value)) return;
      await db.query("UPDATE platform_settings SET value = CAST(:next AS jsonb), version = :v, updated_at = CURRENT_TIMESTAMP(3) WHERE key = 'gym_saas.feature_min_tiers'", {
        replacements: { next: JSON.stringify(next), v: Number(version) + 1 },
        transaction,
      });
      await db.query(
        `INSERT INTO settings_history (id, key, version, old_value, new_value, effective_at, request_id, changed_by, approved_by, reason, created_at)
         VALUES (:id, 'gym_saas.feature_min_tiers', :v, CAST(:old AS jsonb), CAST(:next AS jsonb), CURRENT_TIMESTAMP(3), NULL, NULL, NULL, :reason, CURRENT_TIMESTAMP(3))`,
        {
          replacements: { id: crypto.randomUUID(), v: Number(version) + 1, old: JSON.stringify(value), next: JSON.stringify(next), reason: 'M27 round 3 (7 Nov 2026): new gym features; values already set were kept' },
          transaction,
        }
      );
    });
  },

  // Tables stay (expand and contract); settings history is append-only.
  async down() {},
};
