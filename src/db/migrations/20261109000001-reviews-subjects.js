'use strict';

/**
 * M17 reviews for pros, shops and gyms (M17-FR-30, M11-FR-06, M20-FR-10; Round B1):
 *  - subjects `hire_profile`, `shop` and `gym` next to `ground`; sources `hire_job`, `sub_order` and
 *    `gym_pass` next to `booking` (the columns were sized to their single value at creation, so they
 *    widen to VARCHAR(20) first);
 *  - `subject_owner_id`: who may reply (the venue owner, the pro, the seller, the gym owner), taken
 *    from the source when the review is posted. Existing ground reviews are backfilled from their
 *    ground (a migration may read another module's table; services never do);
 *  - gyms: one review per (author, gym) whatever the pass (a newer pass updates it, M20-FR-10);
 *  - the owner's list reads by subject_owner_id.
 * Report subjects do not change: a review is reported as subject `review` whatever it is about.
 * Expand-only: down refuses (keeps the schema) once a row uses a new subject or source.
 */
const SUBJECTS_BEFORE = ['ground'];
const SUBJECTS_AFTER = ['ground', 'hire_profile', 'shop', 'gym'];
const SOURCES_BEFORE = ['booking'];
const SOURCES_AFTER = ['booking', 'hire_job', 'sub_order', 'gym_pass'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE reviews ALTER COLUMN subject_type TYPE VARCHAR(20)');
    await q('ALTER TABLE reviews ALTER COLUMN source_type TYPE VARCHAR(20)');
    await h.replaceEnumCheck(queryInterface, 'reviews', 'subject_type', SUBJECTS_AFTER);
    await h.replaceEnumCheck(queryInterface, 'reviews', 'source_type', SOURCES_AFTER);
    await queryInterface.addColumn('reviews', 'subject_owner_id', { type: Sequelize.DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' });
    await q("UPDATE reviews r SET subject_owner_id = g.owner_id FROM grounds g WHERE r.subject_type = 'ground' AND g.id = r.subject_id AND r.subject_owner_id IS NULL");
    await q("CREATE UNIQUE INDEX uq_reviews_author_gym ON reviews (author_id, subject_id) WHERE subject_type = 'gym'");
    await q('CREATE INDEX ix_reviews_subject_owner ON reviews (subject_owner_id, created_at DESC) WHERE subject_owner_id IS NOT NULL');
  },

  async down(queryInterface, Sequelize) {
    const [[{ n }]] = await queryInterface.sequelize.query("SELECT COUNT(*) AS n FROM reviews WHERE subject_type <> 'ground' OR source_type <> 'booking'");
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP INDEX IF EXISTS ix_reviews_subject_owner');
    await q('DROP INDEX IF EXISTS uq_reviews_author_gym');
    await queryInterface.removeColumn('reviews', 'subject_owner_id');
    await h.replaceEnumCheck(queryInterface, 'reviews', 'source_type', SOURCES_BEFORE);
    await h.replaceEnumCheck(queryInterface, 'reviews', 'subject_type', SUBJECTS_BEFORE);
    await q('ALTER TABLE reviews ALTER COLUMN source_type TYPE VARCHAR(7)');
    await q('ALTER TABLE reviews ALTER COLUMN subject_type TYPE VARCHAR(6)');
  },
};
