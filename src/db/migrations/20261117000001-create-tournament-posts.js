'use strict';

/**
 * M26 Tournament feed (product owner, 3 Nov 2026; ADR-008): nobody organises tournaments on Kriraghor
 * any more, people post about the ones they run.
 *  - tournament_posts: every detail of a tournament, with a status (open, closed, expired, removed);
 *  - tournament_post_photos: poster and photos (public storage, removal is a status);
 *  - tournament_post_comments: public, flat, removal is a status;
 *  - tournament_post_threads and tournament_post_messages: one private thread per post and player.
 * M17 report subjects gain tournament_post and tournament_comment. No money moves here.
 * Value lists are VARCHAR + named CHECK; rows are never deleted.
 */
const SUBJECTS_BEFORE = ['ground', 'booking', 'user', 'review', 'esports_tournament', 'shop', 'product', 'hire_profile'];
const SUBJECTS_AFTER = [...SUBJECTS_BEFORE, 'tournament_post', 'tournament_comment'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const v1 = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ type: DataTypes.UUID, allowNull: true, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const index = (name, sql) => h.ensureIndexSql(queryInterface, name, sql);

    // ---------------- tournament_posts
    await h.ensureTable(queryInterface, 'tournament_posts', {
      id: { ...uuid, primaryKey: true },
      slug: { type: DataTypes.STRING(110), allowNull: false },
      author_id: fk('users'),
      title: { type: DataTypes.STRING(120), allowNull: false },
      sport_id: fk('sports'),
      format: { type: h.ENUM('league', 'knockout', 'group_knockout', 'round_robin', 'other'), allowNull: false },
      division_id: fk('divisions'),
      district_id: fk('districts'),
      area_id: optFk('areas'),
      venue_name: { type: DataTypes.STRING(120), allowNull: false },
      address: { type: DataTypes.STRING(240), allowNull: true },
      map_link: { type: DataTypes.STRING(300), allowNull: true },
      start_date: { type: DataTypes.DATEONLY, allowNull: false },
      end_date: { type: DataTypes.DATEONLY, allowNull: true },
      registration_deadline: { type: DataTypes.DATEONLY, allowNull: false },
      entry_fee_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      prize_pool_poisha: { type: DataTypes.BIGINT, allowNull: true },
      prize_details: { type: DataTypes.STRING(500), allowNull: true },
      team_limit: { type: DataTypes.INTEGER, allowNull: true },
      players_per_team: { type: DataTypes.INTEGER, allowNull: true },
      gender: { type: h.ENUM('open', 'men', 'women'), allowNull: false, defaultValue: 'open' },
      age_group: { type: DataTypes.STRING(40), allowNull: true },
      skill_level: { type: h.ENUM('any', 'beginner', 'intermediate', 'advanced'), allowNull: true },
      organiser_name: { type: DataTypes.STRING(120), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: false },
      rules: { type: DataTypes.TEXT, allowNull: true },
      status: { type: h.ENUM('open', 'closed', 'expired', 'removed'), allowNull: false, defaultValue: 'open' },
      status_before_removal: { type: DataTypes.STRING(10), allowNull: true },
      removed_reason: { type: DataTypes.STRING(300), allowNull: true },
      removed_by: { type: DataTypes.UUID, allowNull: true },
      removed_at: at,
      closed_at: at,
      expired_at: at,
      comment_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      last_activity_at: at,
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(
      queryInterface,
      'tournament_posts',
      'chk_tournament_posts_values',
      'CHECK (entry_fee_poisha >= 0 AND (prize_pool_poisha IS NULL OR prize_pool_poisha >= 0) AND comment_count >= 0 ' +
        'AND registration_deadline <= start_date AND (end_date IS NULL OR end_date >= start_date) ' +
        'AND (team_limit IS NULL OR team_limit > 0) AND (players_per_team IS NULL OR players_per_team > 0))'
    );
    await index('uq_tournament_posts_slug', 'CREATE UNIQUE INDEX uq_tournament_posts_slug ON tournament_posts (slug)');
    await index('ix_tournament_posts_feed', 'CREATE INDEX ix_tournament_posts_feed ON tournament_posts (status, created_at DESC)');
    await index('ix_tournament_posts_start', 'CREATE INDEX ix_tournament_posts_start ON tournament_posts (status, start_date)');
    await index('ix_tournament_posts_deadline', 'CREATE INDEX ix_tournament_posts_deadline ON tournament_posts (status, registration_deadline)');
    await index('ix_tournament_posts_author', 'CREATE INDEX ix_tournament_posts_author ON tournament_posts (author_id, status, created_at DESC)');
    await index('ix_tournament_posts_sport', 'CREATE INDEX ix_tournament_posts_sport ON tournament_posts (sport_id, status)');
    await index('ix_tournament_posts_place', 'CREATE INDEX ix_tournament_posts_place ON tournament_posts (district_id, area_id, status)');

    // ---------------- tournament_post_photos
    await h.ensureTable(queryInterface, 'tournament_post_photos', {
      id: { ...uuid, primaryKey: true },
      post_id: fk('tournament_posts'),
      storage_key: { type: DataTypes.STRING(255), allowNull: false },
      mime: { type: DataTypes.STRING(40), allowNull: false },
      size_bytes: { type: DataTypes.INTEGER, allowNull: false },
      sha256: { type: DataTypes.STRING(64), allowNull: false },
      sort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      created_by: uuid,
      created_at: now,
      updated_at: now,
    });
    await index('ix_tournament_post_photos_post', 'CREATE INDEX ix_tournament_post_photos_post ON tournament_post_photos (post_id, status, sort)');

    // ---------------- tournament_post_comments
    await h.ensureTable(queryInterface, 'tournament_post_comments', {
      id: { ...uuid, primaryKey: true },
      post_id: fk('tournament_posts'),
      author_id: fk('users'),
      body: { type: DataTypes.TEXT, allowNull: false },
      status: { type: h.ENUM('visible', 'removed'), allowNull: false, defaultValue: 'visible' },
      removed_by: { type: DataTypes.UUID, allowNull: true },
      removed_at: at,
      created_at: now,
      updated_at: now,
    });
    await index('ix_tournament_post_comments_post', 'CREATE INDEX ix_tournament_post_comments_post ON tournament_post_comments (post_id, status, created_at)');

    // ---------------- tournament_post_threads
    await h.ensureTable(queryInterface, 'tournament_post_threads', {
      id: { ...uuid, primaryKey: true },
      post_id: fk('tournament_posts'),
      organiser_id: fk('users'),
      player_id: fk('users'),
      last_message_at: at,
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'tournament_post_threads', 'chk_tournament_post_threads_parties', 'CHECK (organiser_id <> player_id)');
    await index('uq_tournament_post_threads_player', 'CREATE UNIQUE INDEX uq_tournament_post_threads_player ON tournament_post_threads (post_id, player_id)');
    await index('ix_tournament_post_threads_organiser', 'CREATE INDEX ix_tournament_post_threads_organiser ON tournament_post_threads (organiser_id, last_message_at DESC)');
    await index('ix_tournament_post_threads_player', 'CREATE INDEX ix_tournament_post_threads_player ON tournament_post_threads (player_id, last_message_at DESC)');

    // ---------------- tournament_post_messages
    await h.ensureTable(queryInterface, 'tournament_post_messages', {
      id: { ...uuid, primaryKey: true },
      thread_id: fk('tournament_post_threads'),
      sender_id: fk('users'),
      body: { type: DataTypes.TEXT, allowNull: false },
      read_at: at,
      created_at: now,
      updated_at: now,
    });
    await index('ix_tournament_post_messages_thread', 'CREATE INDEX ix_tournament_post_messages_thread ON tournament_post_messages (thread_id, created_at)');

    // ---------------- M17 reports
    await v1.replaceEnumCheck(queryInterface, 'reports', 'subject_type', SUBJECTS_AFTER);
  },

  async down() {
    // Expand only: posts, comments and reports are records, never deleted.
  },
};
