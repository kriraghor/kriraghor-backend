'use strict';

/**
 * M17 reports.subject_owner_id (for M18 reports_upheld, 18 Oct 2026): the account behind the reported
 * subject (a member, a review's author, a ground's owner), stored when the report is filed. Expand only:
 * older rows stay null and do not count.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('reports', 'subject_owner_id', { type: Sequelize.DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' });
    await queryInterface.sequelize.query("CREATE INDEX ix_reports_subject_owner ON reports (subject_owner_id, resolved_at) WHERE subject_owner_id IS NOT NULL AND status = 'resolved'");
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS ix_reports_subject_owner');
    await queryInterface.removeColumn('reports', 'subject_owner_id');
  },
};
