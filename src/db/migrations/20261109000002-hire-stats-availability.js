'use strict';

/**
 * M11 Round B1 (owned by hire):
 *  - hire_profiles.acceptance_rate (numeric(5,2), %) and median_reply_minutes (int): the pro's reply
 *    stats over hire.acceptance_window_days, recomputed by the hire stats consumer (FR-52, M19 §6.3);
 *    jobs_done is backfilled from the released jobs (it was never written before).
 *  - availability_blocks (§7, FR-05, FR-14): time a person marks as not available. Per person
 *    (user_id; profile_id stays NULL for now, like the jobs' clash guard), one-off blocks are their own
 *    period; a weekly repeat (repeat_rule {weekdays [0-6], from 'HH:MM', to 'HH:MM', until?}) keeps its
 *    validity in period (upper bound open when there is no until). Removed blocks keep their row
 *    (status removed). Booked time is read from hire_jobs, never copied here.
 * Expand-only; pg-v2 helpers (re-runnable).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const q = (sql) => queryInterface.sequelize.query(sql);
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };

    await h.ensureColumn(queryInterface, 'hire_profiles', 'acceptance_rate', { type: DataTypes.DECIMAL(5, 2), allowNull: true });
    await h.ensureColumn(queryInterface, 'hire_profiles', 'median_reply_minutes', { type: DataTypes.INTEGER, allowNull: true });
    await h.ensureCheck(queryInterface, 'hire_profiles', 'chk_hire_profiles_reply_stats', 'CHECK ((acceptance_rate IS NULL OR acceptance_rate BETWEEN 0 AND 100) AND (median_reply_minutes IS NULL OR median_reply_minutes >= 0))');

    await h.ensureTable(queryInterface, 'availability_blocks', {
      id: { ...uuid, primaryKey: true },
      user_id: { ...uuid, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      profile_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'hire_profiles', key: 'id' }, onDelete: 'RESTRICT' },
      period: { type: DataTypes.RANGE(DataTypes.DATE), allowNull: false },
      reason: { type: DataTypes.STRING(120), allowNull: true },
      repeat_rule: { type: DataTypes.JSONB, allowNull: true },
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      created_by: { type: DataTypes.UUID, allowNull: true },
      removed_by: { type: DataTypes.UUID, allowNull: true },
      removed_at: at,
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'availability_blocks', 'chk_availability_blocks_period', "CHECK (NOT isempty(period) AND lower(period) IS NOT NULL AND (repeat_rule IS NOT NULL OR upper(period) IS NOT NULL))");
    await h.ensureCheck(queryInterface, 'availability_blocks', 'chk_availability_blocks_removed', "CHECK ((status = 'removed') = (removed_at IS NOT NULL))");
    await q('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await h.ensureIndexSql(queryInterface, 'ix_availability_blocks_user_period', "CREATE INDEX ix_availability_blocks_user_period ON availability_blocks USING gist (user_id, period) WHERE status = 'active'");
    await h.ensureIndexSql(queryInterface, 'ix_availability_blocks_user', 'CREATE INDEX ix_availability_blocks_user ON availability_blocks (user_id)');

    // jobs_done = released jobs per profile (FR-52); the stats consumer keeps it current from here on.
    await q("UPDATE hire_profiles p SET jobs_done = (SELECT count(*) FROM hire_jobs j WHERE j.profile_id = p.id AND j.status = 'released')");
  },

  async down(queryInterface) {
    await queryInterface.dropTable('availability_blocks');
    await queryInterface.sequelize.query('ALTER TABLE hire_profiles DROP CONSTRAINT IF EXISTS chk_hire_profiles_reply_stats');
    await queryInterface.removeColumn('hire_profiles', 'median_reply_minutes');
    await queryInterface.removeColumn('hire_profiles', 'acceptance_rate');
  },
};
