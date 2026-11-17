'use strict';

/**
 * Settings only: gym_saas.feature_min_tiers gains two features that reached the reference seed but not live
 * databases (the seed inserts missing keys and never changes an existing value):
 *  - progress: standard  (body progress, M24 §20, 11 Nov 2026)
 *  - desk_mode: basic    (desk mode with a PIN, M24 §21, ADR-010, 17 Nov 2026)
 * A feature missing from the map falls back to the top tier, so on live both were Pro-only. Values a master
 * already set are kept; the change is written to settings_history like the earlier rounds' migrations.
 */
const crypto = require('node:crypto');
const { QueryTypes } = require('sequelize');

const NEW_FEATURES = { progress: 'standard', desk_mode: 'basic' };

module.exports = {
  async up(queryInterface) {
    const db = queryInterface.sequelize;
    await db.transaction(async (transaction) => {
      const rows = await db.query("SELECT value, version FROM platform_settings WHERE key = 'gym_saas.feature_min_tiers' FOR UPDATE", { type: QueryTypes.SELECT, transaction });
      if (!rows.length) return;
      const { value, version } = rows[0];
      const next = { ...NEW_FEATURES, ...(value ?? {}) };
      if (JSON.stringify(next) === JSON.stringify(value)) return;
      await db.query("UPDATE platform_settings SET value = CAST(:next AS jsonb), version = :v, updated_at = CURRENT_TIMESTAMP(3) WHERE key = 'gym_saas.feature_min_tiers'", {
        replacements: { next: JSON.stringify(next), v: Number(version) + 1 },
        transaction,
      });
      await db.query(
        `INSERT INTO settings_history (id, key, version, old_value, new_value, effective_at, request_id, changed_by, approved_by, reason, created_at)
         VALUES (:id, 'gym_saas.feature_min_tiers', :v, CAST(:old AS jsonb), CAST(:next AS jsonb), CURRENT_TIMESTAMP(3), NULL, NULL, NULL, :reason, CURRENT_TIMESTAMP(3))`,
        {
          replacements: {
            id: crypto.randomUUID(),
            v: Number(version) + 1,
            old: JSON.stringify(value),
            next: JSON.stringify(next),
            reason: 'Body progress (standard) and desk mode (basic) into the tier map; values already set were kept',
          },
          transaction,
        }
      );
    });
  },

  // Settings only: nothing to undo (a master can change the map in Fees and rules).
  async down() {},
};
