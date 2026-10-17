'use strict';

/**
 * M17 Disputes, Reports and Reviews, step 1 (§7, decided 17 Oct 2026).
 *
 *  - disputes: one case per contested booking or esports result. The source module answers through
 *    the targets port (M10 bookings, M21 results) and the case snapshots what was paid and still
 *    held, and the policy line, when it opens. One active case per source (partial unique index).
 *  - dispute_evidence: statements, files (private bucket, streamed) and system facts. Never deleted;
 *    staff can hide an item with a reason.
 *  - reports: one row per reporter and subject; auto-hide counts eligible reporters only (Q99).
 *  - reviews: one per played booking (Q98, one-sided); review_aggregates is a rebuildable projection.
 *  - bookings.settle_due_at (M10): a no-show keeps the retained advance in escrow until the dispute
 *    window closes; the M10 tick releases it then.
 *  - Open M21 result disputes become M17 cases (source esports_result, the M21 row id); the M21 table
 *    stays as the esports module's own record.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const TS = 'TIMESTAMP(3) WITH TIME ZONE';
    const now = { type: TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const money = { type: DataTypes.BIGINT, allowNull: true };
    const q = (sql) => queryInterface.sequelize.query(sql);
    const OUTCOMES = ['all', 'half', 'none', 'custom', 'upheld', 'rejected', 'corrected'];

    await h.addColumn(queryInterface, 'bookings', 'settle_due_at', at);
    await q('CREATE INDEX ix_bookings_settle_due ON bookings (settle_due_at) WHERE settle_due_at IS NOT NULL');

    await h.createTable(queryInterface, 'disputes', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(20), allowNull: false },
      source_type: { type: h.ENUM('booking', 'esports_result'), allowNull: false },
      source_id: uuid,
      source_ref: { type: DataTypes.STRING(40), allowNull: false },
      category: { type: h.ENUM('no_show_contest', 'venue_problem', 'cash_problem', 'result_wrong'), allowNull: false },
      claimant_id: fk('users'),
      respondent_id: optFk('users'),
      status: { type: h.ENUM('awaiting_response', 'under_review', 'escalated', 'resolved', 'withdrawn'), allowNull: false },
      money: { type: DataTypes.BOOLEAN, allowNull: false },
      paid_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      held_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      policy_key: { type: DataTypes.STRING(60), allowNull: false },
      policy: { type: DataTypes.JSONB, allowNull: false },
      claimed_by: optFk('users'),
      claim_expires_at: at,
      recommended_outcome: { type: h.ENUM(...OUTCOMES), allowNull: true },
      recommended_refund_poisha: money,
      recommended_by: optFk('users'),
      escalation_note: { type: DataTypes.STRING(1000), allowNull: true },
      outcome: { type: h.ENUM(...OUTCOMES), allowNull: true },
      refund_poisha: money,
      released_poisha: money,
      fee_poisha: money,
      decided_by: optFk('users'),
      decided_role: { type: h.ENUM('staff', 'master'), allowNull: true },
      decision_reason: { type: DataTypes.STRING(1000), allowNull: true },
      respondent_due_at: at,
      respondent_reminded_at: at,
      sla_due_at: at,
      master_due_at: at,
      sla_breached_at: at,
      responded_at: at,
      escalated_at: at,
      resolved_at: at,
      withdrawn_at: at,
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      idempotency_key: { type: DataTypes.STRING(80), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('disputes', ['code'], { unique: true, name: 'uq_disputes_code' });
    await q("CREATE UNIQUE INDEX uq_disputes_active_source ON disputes (source_type, source_id) WHERE status IN ('awaiting_response', 'under_review', 'escalated')");
    await q('CREATE UNIQUE INDEX uq_disputes_idempotency ON disputes (claimant_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
    await queryInterface.addIndex('disputes', ['status', 'sla_due_at'], { name: 'ix_disputes_queue' });
    await queryInterface.addIndex('disputes', ['claimant_id', 'created_at'], { name: 'ix_disputes_claimant' });
    await q('CREATE INDEX ix_disputes_respondent ON disputes (respondent_id, created_at) WHERE respondent_id IS NOT NULL');
    await q(
      'ALTER TABLE disputes ADD CONSTRAINT chk_disputes_money CHECK (paid_poisha >= 0 AND held_poisha BETWEEN 0 AND paid_poisha ' +
        'AND (refund_poisha IS NULL OR refund_poisha BETWEEN 0 AND held_poisha) AND (money OR COALESCE(refund_poisha, 0) = 0) ' +
        "AND (status <> 'resolved' OR (outcome IS NOT NULL AND decided_by IS NOT NULL AND resolved_at IS NOT NULL)) " +
        "AND ((source_type = 'booking') = (respondent_id IS NOT NULL)))"
    );

    await h.createTable(queryInterface, 'dispute_evidence', {
      id: { ...uuid, primaryKey: true },
      dispute_id: fk('disputes'),
      party: { type: h.ENUM('claimant', 'respondent', 'staff', 'system'), allowNull: false },
      kind: { type: h.ENUM('statement', 'file', 'system'), allowNull: false },
      author_id: optFk('users'),
      text: { type: DataTypes.STRING(2000), allowNull: true },
      file_key: { type: DataTypes.STRING(200), allowNull: true },
      mime: { type: DataTypes.STRING(60), allowNull: true },
      size_bytes: { type: DataTypes.INTEGER, allowNull: true },
      sha256: { type: DataTypes.CHAR(64), allowNull: true },
      system_ref: { type: DataTypes.JSONB, allowNull: true },
      hidden_reason: { type: DataTypes.STRING(200), allowNull: true },
      hidden_by: optFk('users'),
      created_at: now,
    });
    await queryInterface.addIndex('dispute_evidence', ['dispute_id', 'created_at'], { name: 'ix_dispute_evidence_dispute' });
    await q("ALTER TABLE dispute_evidence ADD CONSTRAINT chk_dispute_evidence_kind CHECK ((kind = 'file') = (file_key IS NOT NULL) AND (kind <> 'statement' OR text IS NOT NULL))");

    await h.createTable(queryInterface, 'reports', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(20), allowNull: false },
      subject_type: { type: h.ENUM('ground', 'booking', 'user', 'review', 'esports_tournament'), allowNull: false },
      subject_id: uuid,
      reporter_id: fk('users'),
      reason_code: { type: h.ENUM('fake_listing', 'wrong_info', 'unsafe', 'harassment', 'fraud', 'spam', 'offensive', 'cheating', 'other'), allowNull: false },
      note: { type: DataTypes.STRING(500), allowNull: true },
      eligible: { type: DataTypes.BOOLEAN, allowNull: false },
      status: { type: h.ENUM('open', 'escalated', 'resolved', 'dismissed'), allowNull: false, defaultValue: 'open' },
      resolution_action: { type: h.ENUM('no_violation', 'content_removed', 'owner_warned', 'user_suspended', 'converted_to_dispute', 'dismissed'), allowNull: true },
      resolution_note: { type: DataTypes.STRING(500), allowNull: true },
      resolved_by: optFk('users'),
      resolved_at: at,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('reports', ['code'], { unique: true, name: 'uq_reports_code' });
    await q("CREATE UNIQUE INDEX uq_reports_open_per_reporter ON reports (reporter_id, subject_type, subject_id) WHERE status IN ('open', 'escalated')");
    await queryInterface.addIndex('reports', ['subject_type', 'subject_id', 'status'], { name: 'ix_reports_subject' });
    await queryInterface.addIndex('reports', ['status', 'created_at'], { name: 'ix_reports_queue' });

    await h.createTable(queryInterface, 'reviews', {
      id: { ...uuid, primaryKey: true },
      subject_type: { type: h.ENUM('ground'), allowNull: false },
      subject_id: uuid,
      source_type: { type: h.ENUM('booking'), allowNull: false },
      source_id: uuid,
      author_id: fk('users'),
      stars: { type: DataTypes.SMALLINT, allowNull: false },
      text: { type: DataTypes.STRING(1000), allowNull: true },
      status: { type: h.ENUM('held', 'published', 'hidden'), allowNull: false },
      held_reason: { type: h.ENUM('dispute', 'content'), allowNull: true },
      hidden_reason: { type: DataTypes.STRING(200), allowNull: true },
      hidden_by: optFk('users'),
      hidden_at: at,
      reply_text: { type: DataTypes.STRING(1000), allowNull: true },
      replied_by: optFk('users'),
      replied_at: at,
      edit_until: { type: TS, allowNull: false },
      edited_at: at,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('reviews', ['author_id', 'source_type', 'source_id'], { unique: true, name: 'uq_reviews_author_source' });
    await q("CREATE INDEX ix_reviews_subject_published ON reviews (subject_type, subject_id, created_at DESC) WHERE status = 'published'");
    await queryInterface.addIndex('reviews', ['status', 'created_at'], { name: 'ix_reviews_status' });
    await q("ALTER TABLE reviews ADD CONSTRAINT chk_reviews_stars CHECK (stars BETWEEN 1 AND 5 AND ((status = 'held') = (held_reason IS NOT NULL)))");

    await queryInterface.createTable('review_aggregates', {
      subject_type: { type: DataTypes.STRING(20), allowNull: false, primaryKey: true },
      subject_id: { ...uuid, primaryKey: true },
      review_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      stars_sum: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      stars_hist: { type: DataTypes.JSONB, allowNull: false, defaultValue: Sequelize.literal("'[0,0,0,0,0]'::jsonb") },
      updated_at: now,
    });

    // Open M21 result disputes move onto the M17 desk (claimant = the player who raised it).
    await q(`
      INSERT INTO disputes (id, code, source_type, source_id, source_ref, category, claimant_id, status, money, paid_poisha, held_poisha, policy_key, policy, sla_due_at, created_at, updated_at)
      SELECT d.id, 'DSP-M21-' || upper(substr(replace(d.id::text, '-', ''), 25, 8)), 'esports_result', d.id, 'MATCH-' || m.seq, 'result_wrong', d.raised_by, 'under_review', false, 0, 0,
             'esports.result_dispute', jsonb_build_object('matchId', m.id, 'tournamentId', m.tournament_id, 'registrationId', d.registration_id),
             d.created_at + interval '72 hours', d.created_at, d.created_at
        FROM esports_result_disputes d JOIN esports_matches m ON m.id = d.match_id
       WHERE d.status = 'open'`);
    await q(`
      INSERT INTO dispute_evidence (id, dispute_id, party, kind, author_id, text, created_at)
      SELECT gen_random_uuid(), d.id, 'claimant', 'statement', d.raised_by, d.reason, d.created_at FROM esports_result_disputes d WHERE d.status = 'open'`);
  },

  async down(queryInterface) {
    for (const t of ['review_aggregates', 'reviews', 'reports', 'dispute_evidence', 'disputes']) await queryInterface.dropTable(t);
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS ix_bookings_settle_due');
    await queryInterface.removeColumn('bookings', 'settle_due_at');
  },
};
