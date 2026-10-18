'use strict';

/**
 * M21 (owned here, used by M23 big events):
 *  - esports_tournaments.entry_policy: `open` (anyone eligible registers) or `invite` (only entries a
 *    registered entry-policy hook admits: M23 qualifications and staff invites). Locked after publish.
 *  - esports_streams.video_ref: the canonical video or channel reference parsed from the URL
 *    (`yt:v:<id>`, `yt:c:<channel>`, `fb:<page>/<video>`, `fb:watch:<id>`); NULL = link only. Embeds
 *    are built from it, never from the stored URL.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    await h.addColumn(queryInterface, 'esports_tournaments', 'entry_policy', { type: h.ENUM('open', 'invite'), allowNull: false, defaultValue: 'open' });
    await h.addColumn(queryInterface, 'esports_streams', 'video_ref', { type: DataTypes.STRING(120), allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('esports_streams', 'video_ref');
    await queryInterface.removeColumn('esports_tournaments', 'entry_policy');
  },
};
