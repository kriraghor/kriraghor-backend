'use strict';

/**
 * M08 REVIEW_NEW wording (Round B1): the text said "You can reply on vendor.kriraghor.com", but pros
 * reply on their kriraghor.com desk (/pro/reviews). The notification's link already opens the right
 * place, so the text no longer names a site. Same method as 20261106000001-venues-events-wording: a new
 * active version per (code, channel, locale), the old one kept, and only where the active text is
 * still the seed's (staff edits are left alone). The seed file carries the same words for new databases.
 */
const PAIRS = [
  {
    "code": "REVIEW_NEW",
    "channel": "in_app",
    "locale": "en",
    "bodyFrom": "A member rated {{ground}} {{stars}} stars. You can reply on vendor.kriraghor.com.",
    "bodyTo": "A member rated {{ground}} {{stars}} stars. Open this to read it and reply."
  },
  {
    "code": "REVIEW_NEW",
    "channel": "in_app",
    "locale": "bn",
    "bodyFrom": "একজন সদস্য {{ground}}-কে {{stars}} তারা দিয়েছেন। vendor.kriraghor.com থেকে উত্তর দিতে পারেন।",
    "bodyTo": "একজন সদস্য {{ground}}-কে {{stars}} তারা দিয়েছেন। পড়তে ও উত্তর দিতে এটি খুলুন।"
  }
];

async function templates(queryInterface, transaction, dir) {
  const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements, transaction, type: queryInterface.sequelize.QueryTypes.SELECT });
  for (const p of PAIRS) {
    const [fromBody, toBody] = dir === 'up' ? [p.bodyFrom, p.bodyTo] : [p.bodyTo, p.bodyFrom];
    const [active] = await q('SELECT * FROM message_templates WHERE code = :code AND channel = :channel AND locale = :locale AND is_active', p);
    if (!active || active.body !== fromBody) continue;
    await q('UPDATE message_templates SET is_active = false WHERE id = :id', { id: active.id });
    if (dir === 'down') {
      const [previous] = await q('SELECT id FROM message_templates WHERE code = :code AND channel = :channel AND locale = :locale AND body = :body AND id <> :id ORDER BY version DESC LIMIT 1', { ...p, body: toBody, id: active.id });
      if (previous) {
        await q('UPDATE message_templates SET is_active = true WHERE id = :id', { id: previous.id });
        continue;
      }
    }
    const [{ next }] = await q('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM message_templates WHERE code = :code AND channel = :channel AND locale = :locale', p);
    await q(
      `INSERT INTO message_templates (id, code, channel, locale, version, subject, body, variables, is_active, max_sms_segments, created_at)
       SELECT gen_random_uuid(), code, channel, locale, :next, subject, :body, variables, true, max_sms_segments, now() FROM message_templates WHERE id = :id`,
      { next, body: toBody, id: active.id }
    );
  }
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => templates(queryInterface, transaction, 'up'));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => templates(queryInterface, transaction, 'down'));
  },
};
