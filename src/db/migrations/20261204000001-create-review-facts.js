'use strict';

/**
 * M19-FR-32 (owned by analytics): kpi_fact_review, one row per moderation decision (approved, changes
 * requested, rejected), written from M05's decision events, which carry the submitted and decided times.
 * A master's reopen clears the decision on the submission, but the row here stays: the work was done.
 * The pair (submission_id, decided_at) is unique, so event replays, the apply watchdog's re-sent
 * approvals and the one-time backfill never count a decision twice. No foreign keys (a read model
 * never blocks its source). Expand-only; pg-v2 helpers (re-runnable).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const uuid = { type: DataTypes.UUID, allowNull: false };
    await h.ensureTable(queryInterface, 'kpi_fact_review', {
      id: { ...uuid, primaryKey: true },
      submission_id: uuid,
      kind: { type: DataTypes.STRING(30), allowNull: false },
      decision: { type: DataTypes.STRING(20), allowNull: false },
      reason_code: { type: DataTypes.STRING(40), allowNull: true },
      decided_by: uuid,
      submitted_at: { type: h.TS, allowNull: false },
      decided_at: { type: h.TS, allowNull: false },
      created_at: { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
    });
    await h.ensureCheck(queryInterface, 'kpi_fact_review', 'ck_kpi_fact_review_decision', "CHECK (decision IN ('approved', 'changes_requested', 'rejected'))");
    await h.ensureIndex(queryInterface, 'kpi_fact_review', ['submission_id', 'decided_at'], { name: 'uq_kpi_fact_review_decision', unique: true });
    await h.ensureIndex(queryInterface, 'kpi_fact_review', ['decided_by', 'decided_at'], { name: 'ix_kpi_fact_review_reviewer' });
    await h.ensureIndex(queryInterface, 'kpi_fact_review', ['kind', 'decided_at'], { name: 'ix_kpi_fact_review_kind' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('kpi_fact_review');
  },
};
