'use strict';

/**
 * M23 Esports big events, step 1 (owned by M23; M21 tournaments are referenced, never written):
 *  - esports_events: the event hub (draft, published, cancelled); upcoming, live and ended are worked
 *    out from the dates and the linked tournaments.
 *  - esports_event_stages: the M21 tournaments in an event (qualifiers feeding a final). A tournament is
 *    in one event at a time (partial unique index on active rows).
 *  - esports_event_qualifications: who may enter an invite-only final (top N of a qualifier, or a
 *    staff invite); one live row per (final, squad) and per (final, user).
 *  - esports_event_streams, esports_event_sponsors: the broadcast and the sponsor placements.
 *  - esports_event_polls, _poll_options, _poll_votes: free polls, one vote per member (final).
 *  - esports_event_follows: one row per (event, user), toggled.
 *  - esports_event_feed: the event's timeline (results, qualifications, announcements).
 *  - esports_event_alerts: follow alerts sent (cooldowns, idempotency, audit of the fan-out).
 */
const EVENT_STATUSES = ['draft', 'published', 'cancelled'];
const QUAL_STATUSES = ['qualified', 'invited', 'entered', 'missed', 'revoked'];
const FEED_KINDS = ['announcement', 'tournament_finalised', 'tournament_cancelled', 'qualified', 'final_live', 'stream_live', 'event_cancelled'];
const ALERT_KINDS = ['event_started', 'stream_live', 'final_soon'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const str = (n, allowNull = false) => ({ type: DataTypes.STRING(n), allowNull });
    const q = (sql) => queryInterface.sequelize.query(sql);

    await h.createTable(queryInterface, 'esports_events', {
      id: { ...uuid, primaryKey: true },
      slug: str(90),
      title_en: str(120),
      title_bn: str(160),
      tagline_en: str(160, true),
      tagline_bn: str(200, true),
      about_md_en: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      about_md_bn: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      banner_key: str(255, true),
      accent_hex: { type: DataTypes.STRING(7), allowNull: false, defaultValue: '#f2a33a' },
      starts_at: { type: h.TS, allowNull: false },
      ends_at: { type: h.TS, allowNull: false },
      status: { type: h.ENUM(...EVENT_STATUSES), allowNull: false, defaultValue: 'draft' },
      featured: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      published_at: at,
      published_by: optUuid,
      cancelled_at: at,
      cancelled_by: optUuid,
      cancel_reason: str(255, true),
      lock_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_by: uuid,
      updated_by: optUuid,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('esports_events', ['slug'], { unique: true, name: 'uq_esports_events_slug' });
    await queryInterface.addIndex('esports_events', ['status', 'starts_at'], { name: 'ix_esports_events_status' });
    await q("ALTER TABLE esports_events ADD CONSTRAINT chk_esports_events CHECK (accent_hex ~ '^#[0-9a-f]{6}$' AND ends_at > starts_at)");

    await h.createTable(queryInterface, 'esports_event_stages', {
      id: { ...uuid, primaryKey: true },
      event_id: fk('esports_events'),
      tournament_id: fk('esports_tournaments'),
      role: { type: h.ENUM('qualifier', 'final'), allowNull: false },
      label_en: str(80),
      label_bn: str(120),
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      qualify_count: { type: DataTypes.SMALLINT, allowNull: true },
      final_tournament_id: optFk('esports_tournaments'),
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      created_by: optUuid,
      created_at: now,
      updated_at: now,
    });
    await q("CREATE UNIQUE INDEX uq_esports_event_stages_tournament ON esports_event_stages (tournament_id) WHERE status = 'active'");
    await queryInterface.addIndex('esports_event_stages', ['event_id', 'status', 'sort'], { name: 'ix_esports_event_stages_event' });
    await q(
      "ALTER TABLE esports_event_stages ADD CONSTRAINT chk_esports_event_stages CHECK ((role = 'final' AND qualify_count IS NULL AND final_tournament_id IS NULL) OR (role = 'qualifier' AND qualify_count BETWEEN 1 AND 200 AND final_tournament_id IS NOT NULL AND final_tournament_id <> tournament_id))"
    );

    await h.createTable(queryInterface, 'esports_event_qualifications', {
      id: { ...uuid, primaryKey: true },
      event_id: fk('esports_events'),
      final_tournament_id: fk('esports_tournaments'),
      source_tournament_id: optFk('esports_tournaments'),
      source_registration_id: optFk('esports_registrations'),
      squad_id: optFk('esports_squads'),
      user_id: optFk('users'),
      players: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      rank: { type: DataTypes.SMALLINT, allowNull: true },
      status: { type: h.ENUM(...QUAL_STATUSES), allowNull: false },
      final_registration_id: optFk('esports_registrations'),
      reason: str(255, true),
      actor_id: optUuid,
      created_at: now,
      updated_at: now,
    });
    await q("CREATE UNIQUE INDEX uq_esports_event_quals_squad ON esports_event_qualifications (final_tournament_id, squad_id) WHERE squad_id IS NOT NULL AND status <> 'revoked'");
    await q("CREATE UNIQUE INDEX uq_esports_event_quals_user ON esports_event_qualifications (final_tournament_id, user_id) WHERE user_id IS NOT NULL AND status <> 'revoked'");
    await q('CREATE UNIQUE INDEX uq_esports_event_quals_source ON esports_event_qualifications (final_tournament_id, source_registration_id) WHERE source_registration_id IS NOT NULL');
    await queryInterface.addIndex('esports_event_qualifications', ['event_id', 'status'], { name: 'ix_esports_event_quals_event' });
    await q('ALTER TABLE esports_event_qualifications ADD CONSTRAINT chk_esports_event_quals CHECK ((squad_id IS NULL) <> (user_id IS NULL))');

    await h.createTable(queryInterface, 'esports_event_streams', {
      id: { ...uuid, primaryKey: true },
      event_id: fk('esports_events'),
      platform: { type: h.ENUM('youtube', 'facebook', 'tiktok'), allowNull: false },
      url: str(500),
      video_ref: str(120, true),
      title: str(120),
      is_live: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('esports_event_streams', ['event_id', 'status'], { name: 'ix_esports_event_streams_event' });

    await h.createTable(queryInterface, 'esports_event_sponsors', {
      id: { ...uuid, primaryKey: true },
      event_id: fk('esports_events'),
      name: str(80),
      tier: { type: h.ENUM('title', 'gold', 'partner'), allowNull: false },
      logo_key: str(255, true),
      url: str(500, true),
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      created_by: optUuid,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('esports_event_sponsors', ['event_id', 'status'], { name: 'ix_esports_event_sponsors_event' });

    await h.createTable(queryInterface, 'esports_event_polls', {
      id: { ...uuid, primaryKey: true },
      event_id: fk('esports_events'),
      question_en: str(160),
      question_bn: str(220),
      status: { type: h.ENUM('draft', 'open', 'closed'), allowNull: false, defaultValue: 'draft' },
      closes_at: at,
      opened_at: at,
      closed_at: at,
      created_by: optUuid,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('esports_event_polls', ['event_id', 'status'], { name: 'ix_esports_event_polls_event' });
    await h.createTable(queryInterface, 'esports_event_poll_options', {
      id: { ...uuid, primaryKey: true },
      poll_id: fk('esports_event_polls'),
      label_en: str(80),
      label_bn: str(120),
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      created_at: now,
    });
    await queryInterface.addIndex('esports_event_poll_options', ['poll_id', 'sort'], { name: 'ix_esports_event_poll_options_poll' });
    await h.createTable(queryInterface, 'esports_event_poll_votes', {
      id: { ...uuid, primaryKey: true },
      poll_id: fk('esports_event_polls'),
      option_id: fk('esports_event_poll_options'),
      user_id: fk('users'),
      created_at: now,
    });
    await queryInterface.addIndex('esports_event_poll_votes', ['poll_id', 'user_id'], { unique: true, name: 'uq_esports_event_poll_votes' });
    await queryInterface.addIndex('esports_event_poll_votes', ['poll_id', 'option_id'], { name: 'ix_esports_event_poll_votes_option' });
    await h.appendOnly(queryInterface, 'esports_event_poll_votes');

    await h.createTable(queryInterface, 'esports_event_follows', {
      id: { ...uuid, primaryKey: true },
      event_id: fk('esports_events'),
      user_id: fk('users'),
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('esports_event_follows', ['event_id', 'user_id'], { unique: true, name: 'uq_esports_event_follows' });
    await queryInterface.addIndex('esports_event_follows', ['event_id', 'status', 'user_id'], { name: 'ix_esports_event_follows_page' });
    await queryInterface.addIndex('esports_event_follows', ['user_id', 'status'], { name: 'ix_esports_event_follows_user' });

    await h.createTable(queryInterface, 'esports_event_feed', {
      id: { ...uuid, primaryKey: true },
      event_id: fk('esports_events'),
      kind: { type: h.ENUM(...FEED_KINDS), allowNull: false },
      tournament_id: optUuid,
      ref_id: optUuid,
      text_en: str(280, true),
      text_bn: str(400, true),
      data: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      actor_id: optUuid,
      created_at: now,
    });
    await queryInterface.addIndex('esports_event_feed', ['event_id', 'created_at'], { name: 'ix_esports_event_feed_event' });
    await h.appendOnly(queryInterface, 'esports_event_feed');

    await h.createTable(queryInterface, 'esports_event_alerts', {
      id: { ...uuid, primaryKey: true },
      event_id: fk('esports_events'),
      kind: { type: h.ENUM(...ALERT_KINDS), allowNull: false },
      key: str(160),
      follower_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      pages: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      sent_at: now,
    });
    await queryInterface.addIndex('esports_event_alerts', ['key'], { unique: true, name: 'uq_esports_event_alerts_key' });
    await queryInterface.addIndex('esports_event_alerts', ['event_id', 'kind', 'sent_at'], { name: 'ix_esports_event_alerts_event' });
  },

  async down(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.dropAppendOnly(queryInterface, 'esports_event_feed');
    await h.dropAppendOnly(queryInterface, 'esports_event_poll_votes');
    for (const t of [
      'esports_event_alerts',
      'esports_event_feed',
      'esports_event_follows',
      'esports_event_poll_votes',
      'esports_event_poll_options',
      'esports_event_polls',
      'esports_event_sponsors',
      'esports_event_streams',
      'esports_event_qualifications',
      'esports_event_stages',
      'esports_events',
    ])
      await queryInterface.dropTable(t);
  },
};
