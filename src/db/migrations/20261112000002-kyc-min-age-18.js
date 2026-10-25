'use strict';

/**
 * M02 §6.3 age_ok (product owner, 25 Oct 2026): NID verification is for people aged 18 and over (it
 * was 16), with no guardian route for now. A data migration for databases seeded before the change;
 * new databases get 18 from settings.v1.json (seed v29). In one transaction:
 *  - read platform_settings kyc.min_age_years FOR UPDATE;
 *  - only while it still holds the seed's value (16, version 1): value 18, bounds 18 to 21, version 2,
 *    and the append-only settings_history row for version 2 (the shape change-request.service applyInTx
 *    writes, with no request, proposer or approver: the product owner decided it);
 *  - a value a master changed is left alone, with a warning naming the current value and version;
 *  - no row (a fresh database before its first seed): nothing to do.
 * The running settings cache reloads on the next start (Render restarts on every deploy).
 */
const crypto = require('crypto');

const KEY = 'kyc.min_age_years';
const FROM = 16;
const TO = 18;
const MIN = 18;
const MAX = 21;
const REASON = 'M02 25 Oct 2026: NID verification is 18+ (product owner)';

module.exports = {
  async up(queryInterface, Sequelize) {
    const { QueryTypes } = Sequelize;
    const db = queryInterface.sequelize;
    await db.transaction(async (transaction) => {
      const rows = await db.query('SELECT value, version FROM platform_settings WHERE key = :key FOR UPDATE', { type: QueryTypes.SELECT, replacements: { key: KEY }, transaction });
      if (!rows.length) return;
      const { value, version } = rows[0];
      if (value !== FROM || Number(version) !== 1) {
        // eslint-disable-next-line no-console -- migration output, like pg-v2's warnings (no PII: a setting value)
        console.warn(`[migration] ${KEY} left unchanged: it is ${JSON.stringify(value)} at version ${version}, not the seeded ${FROM} at version 1`);
        return;
      }
      await db.query(
        `UPDATE platform_settings SET value = '${TO}'::jsonb, min_value = :min, max_value = :max, version = 2, updated_at = CURRENT_TIMESTAMP(3) WHERE key = :key`,
        { replacements: { key: KEY, min: MIN, max: MAX }, transaction }
      );
      await db.query(
        `INSERT INTO settings_history (id, key, version, old_value, new_value, effective_at, request_id, changed_by, approved_by, reason, created_at)
         VALUES (:id, :key, 2, '${FROM}'::jsonb, '${TO}'::jsonb, CURRENT_TIMESTAMP(3), NULL, NULL, NULL, :reason, CURRENT_TIMESTAMP(3))`,
        { replacements: { id: crypto.randomUUID(), key: KEY, reason: REASON }, transaction }
      );
    });
  },

  // settings_history is append-only (M03-FR-11): the change is undone, if ever, as a new settings change
  // on the Fees and rules screen, not by rewriting history here.
  async down() {},
};
