'use strict';

/**
 * Gyms sell subscriptions only (product owner, 2 Nov 2026; M24-FR-24): no gym sells a day pass any more.
 *  - gym_packages: every active `day` package is retired (never deleted; running memberships keep their snapshot).
 *  - gyms.live_snapshot: `day` packages and the old daily capacity leave the public version, because
 *    POST /gym/passes sells from the snapshot; the public day price is cleared.
 *  - platform_settings: the two day pass limits are no longer read; their labels say so (rows stay, with their history).
 * Day passes already sold keep running out their dates, and old rows keep kind `day`, so the CHECK
 * constraints stay. public_day_price_poisha and daily_capacity go in a later migration (expand and contract).
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run("UPDATE gym_packages SET status = 'retired', updated_at = NOW() WHERE kind = 'day' AND status = 'active'");
      await run(`
        UPDATE gyms
           SET live_snapshot = jsonb_set(
                 live_snapshot - 'dailyCapacity',
                 '{packages}',
                 COALESCE(
                   (SELECT jsonb_agg(p ORDER BY o) FROM jsonb_array_elements(live_snapshot -> 'packages') WITH ORDINALITY AS e(p, o) WHERE p ->> 'kind' <> 'day'),
                   '[]'::jsonb
                 )
               ),
               public_day_price_poisha = NULL,
               updated_at = NOW()
         WHERE live_snapshot IS NOT NULL`);
      await run("UPDATE gyms SET public_day_price_poisha = NULL WHERE live_snapshot IS NULL AND public_day_price_poisha IS NOT NULL");
    });
    // Labels only, and only where the row exists: a fresh database never seeds these keys.
    await q(`
      UPDATE platform_settings
         SET label_en = 'No longer used: ' || label_en, label_bn = 'আর ব্যবহার হয় না: ' || label_bn
       WHERE key IN ('gym.day_pass_min_poisha', 'gym.day_pass_max_poisha') AND label_en NOT LIKE 'No longer used:%'`);
  },

  // Nothing to undo: a retired package stays retired, and a gym sets its packages again through the desk.
  async down() {},
};
