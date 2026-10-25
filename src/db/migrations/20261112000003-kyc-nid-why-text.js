'use strict';

/**
 * M02 NID requirement text (product owner, 25 Oct 2026): NID is needed only to sell used gear and make
 * offers, get hired, run a business (venue, shop, gym, sports events) and withdraw winnings, and only
 * from 18. Booking, buying and hiring someone are phone-only, so the old "needed to book, buy, hire"
 * text was wrong. The requirements seed is insert-only, so existing databases get the new words here,
 * only where the active member/nid row still carries the seed's text (staff edits are kept).
 */
const PAIRS = [
  {
    "column": "why_en",
    "from": "Front, back and a selfie holding it. Needed to book, buy, hire, sell and withdraw winnings.",
    "to": "Front, back and a selfie holding it. For people aged 18 and over. Needed to sell used gear, get hired, run a business on Kriraghor and withdraw winnings."
  },
  {
    "column": "why_bn",
    "from": "সামনে, পেছনে এবং হাতে ধরে একটি সেলফি। বুকিং, কেনা, হায়ার, বিক্রি ও পুরস্কার তোলার জন্য দরকার।",
    "to": "সামনে, পেছনে এবং হাতে ধরে একটি সেলফি। ১৮ বছর বা তার বেশি বয়সীদের জন্য। পুরনো পণ্য বিক্রি, হায়ার হওয়া, ক্রীড়াঘরে ব্যবসা চালানো ও পুরস্কার তোলার জন্য দরকার।"
  }
];

async function swap(queryInterface, dir) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    for (const p of PAIRS) {
      const [from, to] = dir === 'up' ? [p.from, p.to] : [p.to, p.from];
      await queryInterface.sequelize.query(
        `UPDATE document_requirements SET "${p.column}" = :to WHERE role = 'member' AND doc_type = 'nid' AND is_active AND "${p.column}" = :from`,
        { replacements: { from, to }, transaction }
      );
    }
  });
}

module.exports = {
  up: (queryInterface) => swap(queryInterface, 'up'),
  down: (queryInterface) => swap(queryInterface, 'down'),
};
