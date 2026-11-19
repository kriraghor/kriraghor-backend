'use strict';

/**
 * M11-FR-16 (tester feedback, 19 Nov 2026): a hire profile's intro video, given as a link (YouTube, Vimeo,
 * Facebook, Google Drive, OneDrive, Dropbox, an .mp4/.webm/.m4v file or an .m3u8 playlist) and never
 * uploaded to Kriraghor. The link is part of the working copy and goes through review like the bio; the
 * reviewed copy is in live_snapshot.introVideoUrl. The service checks the link (hire/video.rules); the
 * database only keeps it https and at most 500 characters.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    await h.ensureColumn(queryInterface, 'hire_profiles', 'intro_video_url', { type: DataTypes.STRING(500), allowNull: true });
    await h.ensureCheck(queryInterface, 'hire_profiles', 'chk_hire_profiles_intro_video', "CHECK (intro_video_url IS NULL OR intro_video_url LIKE 'https://%')");
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE hire_profiles DROP CONSTRAINT IF EXISTS chk_hire_profiles_intro_video');
    await queryInterface.removeColumn('hire_profiles', 'intro_video_url');
  },
};
