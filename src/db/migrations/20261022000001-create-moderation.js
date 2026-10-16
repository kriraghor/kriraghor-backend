'use strict';

/**
 * M05 moderation lite (§7). One review pipeline for every public subject:
 *  - submissions: versioned snapshots; one open (pending_review / changes_requested) per subject
 *    (partial unique index, FR-02); kind is a CHECK list widened as subject modules arrive;
 *  - submission_checks: automatic checks per run (FR-05);
 *  - review_rubrics: versioned judgement checklists, one active per kind (FR-20);
 *  - review_claims: the review lock, one active per submission (FR-07), ticks stored on the claim (FR-09);
 *  - rejection_reasons: reason codes with the kinds they apply to (FR-11).
 */
const KINDS = ['document'];
const STATUSES = ['pending_review', 'changes_requested', 'approved', 'rejected', 'withdrawn', 'superseded'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const TS = 'TIMESTAMP(3) WITH TIME ZONE';
    const now = { type: TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const user = { references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' };

    await h.createTable(queryInterface, 'rejection_reasons', {
      code: { type: DataTypes.STRING(40), primaryKey: true },
      label_en: { type: DataTypes.STRING(120), allowNull: false },
      label_bn: { type: DataTypes.STRING(160), allowNull: false },
      kinds: { type: DataTypes.JSONB, allowNull: false },
      requires_text: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: now,
    });

    await h.createTable(queryInterface, 'review_rubrics', {
      id: { ...uuid, primaryKey: true },
      kind: { type: h.ENUM(...KINDS), allowNull: false },
      version: { type: DataTypes.INTEGER, allowNull: false },
      items: { type: DataTypes.JSONB, allowNull: false },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      created_by: optUuid,
      created_at: now,
    });
    await queryInterface.addConstraint('review_rubrics', { fields: ['kind', 'version'], type: 'unique', name: 'uq_review_rubrics_version' });
    await queryInterface.addIndex('review_rubrics', ['kind'], { unique: true, name: 'uq_review_rubrics_active', where: { is_active: true } });

    await h.createTable(queryInterface, 'submissions', {
      id: { ...uuid, primaryKey: true },
      kind: { type: h.ENUM(...KINDS), allowNull: false },
      subject_id: uuid,
      version: { type: DataTypes.INTEGER, allowNull: false },
      previous_submission_id: { ...optUuid, references: { model: 'submissions', key: 'id' }, onDelete: 'RESTRICT' },
      is_edit: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      mode: { type: h.ENUM('pre', 'post'), allowNull: false, defaultValue: 'pre' },
      // The proposed snapshot as the reviewer sees it (masked for documents: no NID, DOB or file keys).
      payload: { type: DataTypes.JSONB, allowNull: false },
      title: { type: DataTypes.STRING(200), allowNull: false },
      submitted_by: { ...uuid, ...user },
      submitted_at: now,
      status: { type: h.ENUM(...STATUSES), allowNull: false, defaultValue: 'pending_review' },
      sla_due_at: { type: TS, allowNull: false },
      breach_notified_at: { type: TS, allowNull: true },
      rubric_id: { ...optUuid, references: { model: 'review_rubrics', key: 'id' }, onDelete: 'RESTRICT' },
      rubric_result: { type: DataTypes.JSONB, allowNull: true },
      decided_by: optUuid,
      decided_at: { type: TS, allowNull: true },
      reason_code: { type: DataTypes.STRING(40), allowNull: true, references: { model: 'rejection_reasons', key: 'code' }, onDelete: 'RESTRICT' },
      reason_text: { type: DataTypes.STRING(500), allowNull: true },
      check_override_by: optUuid,
      check_override_reason: { type: DataTypes.STRING(500), allowNull: true },
      applied_at: { type: TS, allowNull: true },
      apply_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(
      "ALTER TABLE submissions ADD CONSTRAINT ck_submissions_reason CHECK (status NOT IN ('changes_requested', 'rejected') OR reason_code IS NOT NULL)"
    );
    await queryInterface.sequelize.query('ALTER TABLE submissions ADD CONSTRAINT ck_submissions_version CHECK (version >= 1)');
    await queryInterface.addConstraint('submissions', { fields: ['kind', 'subject_id', 'version'], type: 'unique', name: 'uq_submissions_version' });
    await queryInterface.addIndex('submissions', ['kind', 'subject_id'], {
      unique: true,
      name: 'uq_submissions_one_open',
      where: { status: ['pending_review', 'changes_requested'] },
    });
    await queryInterface.addIndex('submissions', ['status', 'kind', 'sla_due_at'], { name: 'ix_submissions_queue' });
    await queryInterface.addIndex('submissions', ['submitted_by', 'created_at'], { name: 'ix_submissions_owner' });

    await h.createTable(queryInterface, 'submission_checks', {
      id: { ...uuid, primaryKey: true },
      submission_id: { ...uuid, references: { model: 'submissions', key: 'id' }, onDelete: 'RESTRICT' },
      run_no: { type: DataTypes.INTEGER, allowNull: false },
      key: { type: DataTypes.STRING(60), allowNull: false },
      severity: { type: h.ENUM('hard', 'soft'), allowNull: false },
      result: { type: h.ENUM('pass', 'warn', 'fail', 'pending', 'not_computed'), allowNull: false },
      detail: { type: DataTypes.STRING(300), allowNull: true },
      computed_at: now,
    });
    await queryInterface.addConstraint('submission_checks', { fields: ['submission_id', 'run_no', 'key'], type: 'unique', name: 'uq_submission_checks_run_key' });

    await h.createTable(queryInterface, 'review_claims', {
      id: { ...uuid, primaryKey: true },
      submission_id: { ...uuid, references: { model: 'submissions', key: 'id' }, onDelete: 'RESTRICT' },
      staff_id: { ...uuid, ...user },
      claimed_at: now,
      expires_at: { type: TS, allowNull: false },
      hard_expires_at: { type: TS, allowNull: false },
      ticks: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      released_at: { type: TS, allowNull: true },
      released_reason: { type: h.ENUM('manual', 'decided', 'ttl', 'superseded', 'permission', 'force', 'withdrawn'), allowNull: true },
    });
    await queryInterface.addIndex('review_claims', ['submission_id'], { unique: true, name: 'uq_review_claims_active', where: { released_at: null } });
    await queryInterface.addIndex('review_claims', ['expires_at'], { name: 'ix_review_claims_expiry', where: { released_at: null } });
  },

  async down(queryInterface) {
    for (const table of ['review_claims', 'submission_checks', 'submissions', 'review_rubrics', 'rejection_reasons']) await queryInterface.dropTable(table);
  },
};
