'use strict';

/**
 * M24 Gym Management, prompt 1 (Desk MVP, §7.2): the gym's own books, owned by the gym-manage module
 * (gym group, ADR-007). Eleven of the 24 tables:
 *  - gym_manage_settings: one row per gym that uses management (short code, member and receipt
 *    counters taken under the row lock, receipt details, entry policy, import consent);
 *  - gym_members (phone, email, emergency contact and health note encrypted; phone hash for matching,
 *    last 4 digits for display), gym_link_requests (gym invites; join requests in prompt 3);
 *  - gym_memberships (package snapshots), gym_freezes, gym_dues (one per membership);
 *  - gym_fee_payments (append-only; link_id without a FK until gym_payment_links exists in prompt 2),
 *    gym_attendance (append-only, one counted check-in per member and Dhaka day), gym_member_notes
 *    (append-only);
 *  - gym_imports (CSV or XLSX previews and their row report, no phone), gym_owner_subscriptions (one per
 *    owner: the tier chosen; invoices come in prompt 2).
 * Money is BIGINT poisha, calendar days are Dhaka dates, value lists are VARCHAR + named CHECK, "one
 * active row" is a partial unique index. Rows are never deleted.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const atReq = { type: h.TS, allowNull: false };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const money = { type: DataTypes.BIGINT, allowNull: false };
    const money0 = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    const date = { type: DataTypes.DATEONLY, allowNull: false };
    const optDate = { type: DataTypes.DATEONLY, allowNull: true };
    const str = (n, allowNull = true) => ({ type: DataTypes.STRING(n), allowNull });
    const ts = () => ({ created_at: now, updated_at: now });
    const created = () => ({ created_at: now });
    const index = (name, sql) => h.ensureIndexSql(queryInterface, name, sql);

    // ---------------- gym_manage_settings
    await h.ensureTable(queryInterface, 'gym_manage_settings', {
      gym_id: { ...uuid, primaryKey: true, references: { model: 'gyms', key: 'id' }, onDelete: 'RESTRICT' },
      owner_id: fk('users'),
      short_code: str(6, false),
      member_seq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      receipt_year: { type: DataTypes.SMALLINT, allowNull: false },
      receipt_seq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      tin: str(20),
      bin: str(20),
      receipt_footer: str(200),
      entry_policy: { type: h.ENUM('allow', 'warn', 'block'), allowNull: false, defaultValue: 'warn' },
      absent_alert_days: { type: DataTypes.SMALLINT, allowNull: true },
      join_requests_open: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      reminders_off: { type: DataTypes.JSONB, allowNull: false, defaultValue: Sequelize.literal("'[]'::jsonb") },
      sms_kinds: { type: DataTypes.JSONB, allowNull: false, defaultValue: Sequelize.literal("'[]'::jsonb") },
      import_consent_until: at,
      updated_by: optUuid,
      ...ts(),
    });
    await h.ensureCheck(
      queryInterface,
      'gym_manage_settings',
      'chk_gym_manage_settings',
      "CHECK (short_code ~ '^[A-Z]{2,6}$' AND member_seq >= 0 AND receipt_seq >= 0 AND jsonb_typeof(reminders_off) = 'array' AND jsonb_typeof(sms_kinds) = 'array')"
    );
    await index('uq_gym_manage_settings_code', 'CREATE UNIQUE INDEX uq_gym_manage_settings_code ON gym_manage_settings (owner_id, short_code)');

    // ---------------- gym_imports (before members and payments, which reference it)
    await h.ensureTable(queryInterface, 'gym_imports', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      owner_id: fk('users'),
      file_key: str(300),
      file_name: str(200, false),
      file_sha256: { type: DataTypes.CHAR(64), allowNull: false },
      file_bytes: { type: DataTypes.INTEGER, allowNull: false },
      rows_total: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      rows_ok: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      rows_failed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      report: { type: DataTypes.JSONB, allowNull: false, defaultValue: Sequelize.literal("'[]'::jsonb") },
      status: { type: h.ENUM('previewed', 'applied', 'undone', 'discarded'), allowNull: false, defaultValue: 'previewed' },
      uploaded_by: uuid,
      uploaded_as: { type: h.ENUM('owner', 'staff'), allowNull: false },
      applied_at: at,
      applied_by: optUuid,
      undo_until: at,
      undone_at: at,
      invites_sent_at: at,
      file_purged_at: at,
      ...ts(),
    });
    await h.ensureCheck(queryInterface, 'gym_imports', 'chk_gym_imports', "CHECK (rows_ok + rows_failed <= rows_total AND ((status = 'applied') = (applied_at IS NOT NULL AND undone_at IS NULL)))");
    await index('ix_gym_imports_gym', 'CREATE INDEX ix_gym_imports_gym ON gym_imports (gym_id, created_at)');
    await index('ix_gym_imports_purge', 'CREATE INDEX ix_gym_imports_purge ON gym_imports (created_at) WHERE file_purged_at IS NULL');

    // ---------------- gym_members
    await h.ensureTable(queryInterface, 'gym_members', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      owner_id: fk('users'),
      member_code: str(12, false),
      display_name: str(80, false),
      phone_enc: str(255, false),
      phone_hash: { type: DataTypes.CHAR(64), allowNull: false },
      phone_last4: { type: DataTypes.CHAR(4), allowNull: false },
      email_enc: str(255),
      gender: { type: h.ENUM('male', 'female', 'other'), allowNull: true },
      birth_date: optDate,
      photo_key: str(300),
      emergency_contact_enc: str(500),
      health_note_enc: { type: DataTypes.TEXT, allowNull: true },
      health_note_by: { type: h.ENUM('member', 'staff'), allowNull: true },
      health_note_at: at,
      source: { type: h.ENUM('desk', 'platform', 'import', 'pass'), allowNull: false },
      status: { type: h.ENUM('new', 'active', 'frozen', 'expired', 'left', 'removed'), allowNull: false, defaultValue: 'new' },
      user_id: optFk('users'),
      linked_at: at,
      unlinked_at: at,
      trainer_business_member_id: optUuid,
      joined_on: date,
      left_on: optDate,
      left_reason: { type: h.ENUM('price', 'moved', 'injury', 'other_gym', 'schedule', 'unknown', 'other'), allowNull: true },
      removed_at: at,
      removed_reason: str(300),
      import_id: optFk('gym_imports'),
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      created_by: optUuid,
      updated_by: optUuid,
      ...ts(),
    });
    await h.ensureCheck(queryInterface, 'gym_members', 'chk_gym_members_left', "CHECK ((status = 'left') = (left_on IS NOT NULL))");
    await h.ensureCheck(queryInterface, 'gym_members', 'chk_gym_members_removed', "CHECK ((status = 'removed') = (removed_at IS NOT NULL))");
    await h.ensureCheck(queryInterface, 'gym_members', 'chk_gym_members_link', 'CHECK (user_id IS NULL OR linked_at IS NOT NULL)');
    await index('uq_gym_members_code', 'CREATE UNIQUE INDEX uq_gym_members_code ON gym_members (gym_id, member_code)');
    await index('uq_gym_members_phone', "CREATE UNIQUE INDEX uq_gym_members_phone ON gym_members (gym_id, phone_hash) WHERE status <> 'removed'");
    await index('uq_gym_members_user', "CREATE UNIQUE INDEX uq_gym_members_user ON gym_members (gym_id, user_id) WHERE user_id IS NOT NULL AND status <> 'removed'");
    await index('ix_gym_members_list', 'CREATE INDEX ix_gym_members_list ON gym_members (gym_id, status, display_name)');
    await index('ix_gym_members_user', 'CREATE INDEX ix_gym_members_user ON gym_members (user_id) WHERE user_id IS NOT NULL');
    await index('ix_gym_members_owner', 'CREATE INDEX ix_gym_members_owner ON gym_members (owner_id, status)');
    await index('ix_gym_members_trainer', 'CREATE INDEX ix_gym_members_trainer ON gym_members (gym_id, trainer_business_member_id) WHERE trainer_business_member_id IS NOT NULL');
    await index('ix_gym_members_name_trgm', 'CREATE INDEX ix_gym_members_name_trgm ON gym_members USING GIN (display_name gin_trgm_ops)');

    // ---------------- gym_link_requests
    await h.ensureTable(queryInterface, 'gym_link_requests', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      owner_id: fk('users'),
      direction: { type: h.ENUM('gym_invite', 'join_request'), allowNull: false },
      member_id: optFk('gym_members'),
      user_id: optFk('users'),
      phone_hash: { type: DataTypes.CHAR(64), allowNull: true },
      package_id: optFk('gym_packages'),
      note: str(300),
      status: { type: h.ENUM('pending', 'accepted', 'declined', 'expired', 'cancelled'), allowNull: false, defaultValue: 'pending' },
      expires_at: atReq,
      decided_at: at,
      decided_by: optUuid,
      created_by: optUuid,
      ...ts(),
    });
    await h.ensureCheck(
      queryInterface,
      'gym_link_requests',
      'chk_gym_link_requests',
      "CHECK ((direction <> 'gym_invite' OR member_id IS NOT NULL) AND (direction <> 'join_request' OR user_id IS NOT NULL) AND (user_id IS NOT NULL OR phone_hash IS NOT NULL) AND ((status = 'pending') = (decided_at IS NULL)))"
    );
    await index('uq_gym_link_requests_invite', "CREATE UNIQUE INDEX uq_gym_link_requests_invite ON gym_link_requests (member_id) WHERE status = 'pending' AND direction = 'gym_invite'");
    await index('uq_gym_link_requests_join', "CREATE UNIQUE INDEX uq_gym_link_requests_join ON gym_link_requests (gym_id, user_id) WHERE status = 'pending' AND direction = 'join_request'");
    await index('ix_gym_link_requests_phone', "CREATE INDEX ix_gym_link_requests_phone ON gym_link_requests (phone_hash) WHERE status = 'pending' AND user_id IS NULL");
    await index('ix_gym_link_requests_gym', 'CREATE INDEX ix_gym_link_requests_gym ON gym_link_requests (gym_id, status, created_at)');
    await index('ix_gym_link_requests_user', 'CREATE INDEX ix_gym_link_requests_user ON gym_link_requests (user_id, status) WHERE user_id IS NOT NULL');
    await index('ix_gym_link_requests_expiry', "CREATE INDEX ix_gym_link_requests_expiry ON gym_link_requests (expires_at) WHERE status = 'pending'");
    await index('ix_gym_link_requests_match', "CREATE INDEX ix_gym_link_requests_match ON gym_link_requests (gym_id, phone_hash, created_at) WHERE direction = 'join_request'");

    // ---------------- gym_memberships
    await h.ensureTable(queryInterface, 'gym_memberships', {
      id: { ...uuid, primaryKey: true },
      member_id: fk('gym_members'),
      gym_id: fk('gyms'),
      package_id: fk('gym_packages'),
      package_kind: str(9, false),
      title: str(80, false),
      days: { type: DataTypes.SMALLINT, allowNull: false },
      price_poisha: money,
      admission_fee_poisha: money0,
      discount_poisha: money0,
      discount_reason: str(200),
      visit_limit: { type: DataTypes.SMALLINT, allowNull: true },
      origin: { type: h.ENUM('new', 'renewal', 'change', 'rejoin', 'import'), allowNull: false },
      previous_id: optFk('gym_memberships'),
      starts_on: date,
      ends_on: date,
      frozen_days: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      freezes_count: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      status: { type: h.ENUM('upcoming', 'active', 'frozen', 'expired', 'cancelled', 'changed'), allowNull: false },
      cancelled_at: at,
      cancel_reason: str(200),
      created_by: optUuid,
      updated_by: optUuid,
      ...ts(),
    });
    await h.ensureCheck(
      queryInterface,
      'gym_memberships',
      'chk_gym_memberships',
      "CHECK (price_poisha >= 0 AND admission_fee_poisha >= 0 AND discount_poisha BETWEEN 0 AND price_poisha AND days BETWEEN 1 AND 366 AND frozen_days >= 0 AND (ends_on >= starts_on OR status IN ('cancelled', 'changed')) AND (discount_poisha = 0 OR discount_reason IS NOT NULL))"
    );
    await index('uq_gym_memberships_current', "CREATE UNIQUE INDEX uq_gym_memberships_current ON gym_memberships (member_id) WHERE status IN ('active', 'frozen')");
    await index('uq_gym_memberships_upcoming', "CREATE UNIQUE INDEX uq_gym_memberships_upcoming ON gym_memberships (member_id) WHERE status = 'upcoming'");
    await index('ix_gym_memberships_gym_end', 'CREATE INDEX ix_gym_memberships_gym_end ON gym_memberships (gym_id, status, ends_on)');
    await index('ix_gym_memberships_gym_start', 'CREATE INDEX ix_gym_memberships_gym_start ON gym_memberships (gym_id, status, starts_on)');
    await index('ix_gym_memberships_member', 'CREATE INDEX ix_gym_memberships_member ON gym_memberships (member_id, starts_on)');

    // ---------------- gym_freezes
    await h.ensureTable(queryInterface, 'gym_freezes', {
      id: { ...uuid, primaryKey: true },
      membership_id: fk('gym_memberships'),
      from_on: date,
      to_on: date,
      ended_early_on: optDate,
      reason: str(200, false),
      status: { type: h.ENUM('scheduled', 'active', 'done', 'cancelled'), allowNull: false, defaultValue: 'scheduled' },
      created_by: optUuid,
      ...ts(),
    });
    await h.ensureCheck(queryInterface, 'gym_freezes', 'chk_gym_freezes', 'CHECK (to_on >= from_on AND (ended_early_on IS NULL OR ended_early_on BETWEEN from_on AND to_on))');
    await index('ix_gym_freezes_membership', 'CREATE INDEX ix_gym_freezes_membership ON gym_freezes (membership_id, status)');
    await index('ix_gym_freezes_dates', 'CREATE INDEX ix_gym_freezes_dates ON gym_freezes (status, from_on, to_on)');

    // ---------------- gym_dues
    await h.ensureTable(queryInterface, 'gym_dues', {
      id: { ...uuid, primaryKey: true },
      membership_id: { ...fk('gym_memberships'), unique: true },
      member_id: fk('gym_members'),
      gym_id: fk('gyms'),
      amount_poisha: money,
      paid_poisha: money0,
      waived_poisha: money0,
      due_on: date,
      status: { type: h.ENUM('unpaid', 'partial', 'paid', 'waived', 'void'), allowNull: false, defaultValue: 'unpaid' },
      overdue_at: at,
      waive_reason: str(300),
      voided_at: at,
      void_reason: str(40),
      ...ts(),
    });
    await h.ensureCheck(
      queryInterface,
      'gym_dues',
      'chk_gym_dues',
      "CHECK (amount_poisha >= 0 AND paid_poisha >= 0 AND waived_poisha >= 0 AND paid_poisha + waived_poisha <= amount_poisha AND ((status = 'void') = (voided_at IS NOT NULL)) AND (waived_poisha = 0 OR waive_reason IS NOT NULL))"
    );
    await index('ix_gym_dues_gym', 'CREATE INDEX ix_gym_dues_gym ON gym_dues (gym_id, status, due_on)');
    await index('ix_gym_dues_member', 'CREATE INDEX ix_gym_dues_member ON gym_dues (member_id, status)');

    // ---------------- gym_fee_payments (append-only)
    await h.ensureTable(queryInterface, 'gym_fee_payments', {
      id: { ...uuid, primaryKey: true },
      due_id: fk('gym_dues'),
      member_id: fk('gym_members'),
      gym_id: fk('gyms'),
      owner_id: fk('users'),
      amount_poisha: money,
      method: { type: h.ENUM('cash', 'owner_bkash', 'owner_nagad', 'card_counter', 'other', 'online', 'opening'), allowNull: false },
      paid_on: date,
      receipt_no: str(24),
      reverses_id: optFk('gym_fee_payments'),
      reason: str(300),
      note: str(300),
      received_by: optFk('users'),
      payer_user_id: optFk('users'),
      // gym_payment_links.id (prompt 2); the FK is added with that table.
      link_id: optUuid,
      payment_id: optFk('payments'),
      provider_charge_bps: { type: DataTypes.INTEGER, allowNull: true },
      provider_charge_poisha: { type: DataTypes.BIGINT, allowNull: true },
      provider_setting_version: { type: DataTypes.INTEGER, allowNull: true },
      import_id: optFk('gym_imports'),
      ...created(),
    });
    await h.ensureCheck(
      queryInterface,
      'gym_fee_payments',
      'chk_gym_fee_payments',
      "CHECK (amount_poisha <> 0 AND ((amount_poisha > 0) = (reverses_id IS NULL)) AND ((amount_poisha > 0) = (receipt_no IS NOT NULL)) AND ((method = 'online') = (payment_id IS NOT NULL)) AND (reverses_id IS NULL OR reason IS NOT NULL) AND (provider_charge_poisha IS NULL OR provider_charge_poisha BETWEEN 0 AND abs(amount_poisha)))"
    );
    await index('uq_gym_fee_payments_receipt', 'CREATE UNIQUE INDEX uq_gym_fee_payments_receipt ON gym_fee_payments (gym_id, receipt_no) WHERE receipt_no IS NOT NULL');
    await index('uq_gym_fee_payments_reverses', 'CREATE UNIQUE INDEX uq_gym_fee_payments_reverses ON gym_fee_payments (reverses_id) WHERE reverses_id IS NOT NULL');
    await index('uq_gym_fee_payments_online', 'CREATE UNIQUE INDEX uq_gym_fee_payments_online ON gym_fee_payments (payment_id) WHERE payment_id IS NOT NULL AND amount_poisha > 0');
    await index('ix_gym_fee_payments_day', 'CREATE INDEX ix_gym_fee_payments_day ON gym_fee_payments (gym_id, paid_on)');
    await index('ix_gym_fee_payments_due', 'CREATE INDEX ix_gym_fee_payments_due ON gym_fee_payments (due_id)');
    await index('ix_gym_fee_payments_member', 'CREATE INDEX ix_gym_fee_payments_member ON gym_fee_payments (member_id, paid_on)');
    await h.ensureAppendOnly(queryInterface, 'gym_fee_payments');

    // ---------------- gym_attendance (append-only)
    await h.ensureTable(queryInterface, 'gym_attendance', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      member_id: fk('gym_members'),
      local_date: date,
      checked_in_at: atReq,
      method: { type: h.ENUM('desk', 'member_qr', 'entrance_qr', 'pass'), allowNull: false },
      counted: { type: DataTypes.BOOLEAN, allowNull: false },
      decision: { type: h.ENUM('allow', 'warn', 'override'), allowNull: false },
      reasons: { type: DataTypes.JSONB, allowNull: false, defaultValue: Sequelize.literal("'[]'::jsonb") },
      override_reason: str(200),
      by_user: optFk('users'),
      pass_redemption_id: optFk('pass_redemptions'),
      ...created(),
    });
    await h.ensureCheck(queryInterface, 'gym_attendance', 'chk_gym_attendance', "CHECK ((decision = 'override') = (override_reason IS NOT NULL) AND ((method = 'pass') = (pass_redemption_id IS NOT NULL)))");
    await index('uq_gym_attendance_day', 'CREATE UNIQUE INDEX uq_gym_attendance_day ON gym_attendance (member_id, local_date) WHERE counted');
    await index('uq_gym_attendance_pass', 'CREATE UNIQUE INDEX uq_gym_attendance_pass ON gym_attendance (pass_redemption_id) WHERE pass_redemption_id IS NOT NULL');
    await index('ix_gym_attendance_gym_day', 'CREATE INDEX ix_gym_attendance_gym_day ON gym_attendance (gym_id, local_date)');
    await index('ix_gym_attendance_member', 'CREATE INDEX ix_gym_attendance_member ON gym_attendance (member_id, local_date DESC)');
    await h.ensureAppendOnly(queryInterface, 'gym_attendance');

    // ---------------- gym_member_notes (append-only)
    await h.ensureTable(queryInterface, 'gym_member_notes', {
      id: { ...uuid, primaryKey: true },
      member_id: fk('gym_members'),
      gym_id: fk('gyms'),
      body: str(2000, false),
      by_user: fk('users'),
      ...created(),
    });
    await index('ix_gym_member_notes_member', 'CREATE INDEX ix_gym_member_notes_member ON gym_member_notes (member_id, created_at)');
    await h.ensureAppendOnly(queryInterface, 'gym_member_notes');

    // ---------------- gym_owner_subscriptions
    const TIERS = ['free', 'basic', 'standard', 'pro'];
    await h.ensureTable(queryInterface, 'gym_owner_subscriptions', {
      id: { ...uuid, primaryKey: true },
      owner_id: { ...fk('users'), unique: true },
      chosen_tier: { type: h.ENUM(...TIERS), allowNull: false, defaultValue: 'free' },
      month_max_tier: { type: h.ENUM(...TIERS), allowNull: false, defaultValue: 'free' },
      month_of: date,
      status: { type: h.ENUM('active', 'past_due', 'restricted', 'closed'), allowNull: false, defaultValue: 'active' },
      started_on: date,
      paid_tier_since: optDate,
      founding_partner: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      founding_no: { type: DataTypes.SMALLINT, allowNull: true },
      founding_set_by: optUuid,
      founding_set_at: at,
      past_due_at: at,
      restricted_at: at,
      closed_at: at,
      ...ts(),
    });
    await h.ensureCheck(queryInterface, 'gym_owner_subscriptions', 'chk_gym_owner_subscriptions', "CHECK ((founding_partner = (founding_no IS NOT NULL)) AND ((status = 'restricted') = (restricted_at IS NOT NULL)))");
    await index('uq_gym_owner_subscriptions_founding', 'CREATE UNIQUE INDEX uq_gym_owner_subscriptions_founding ON gym_owner_subscriptions (founding_no) WHERE founding_no IS NOT NULL');
    await index('ix_gym_owner_subscriptions_status', 'CREATE INDEX ix_gym_owner_subscriptions_status ON gym_owner_subscriptions (status)');
  },

  async down(queryInterface) {
    for (const t of ['gym_member_notes', 'gym_attendance', 'gym_fee_payments', 'gym_dues', 'gym_freezes', 'gym_memberships', 'gym_link_requests', 'gym_members', 'gym_imports', 'gym_manage_settings', 'gym_owner_subscriptions']) {
      await queryInterface.dropTable(t);
    }
  },
};
