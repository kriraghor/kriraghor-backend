"use strict";

/**
 * M03 (for M16 player profiles): the positions a player can list for each sport, with EN/BN labels.
 * Fresh databases get them from the places seed; this fills the rows that already exist.
 */
const POSITIONS = {
  cricket: [
    {
      key: "batter",
      en: "Batter",
      bn: "ব্যাটার",
    },
    {
      key: "fast_bowler",
      en: "Fast bowler",
      bn: "পেস বোলার",
    },
    {
      key: "spin_bowler",
      en: "Spin bowler",
      bn: "স্পিন বোলার",
    },
    {
      key: "all_rounder",
      en: "All-rounder",
      bn: "অলরাউন্ডার",
    },
    {
      key: "wicketkeeper",
      en: "Wicketkeeper",
      bn: "উইকেটকিপার",
    },
  ],
  football: [
    {
      key: "goalkeeper",
      en: "Goalkeeper",
      bn: "গোলরক্ষক",
    },
    {
      key: "defender",
      en: "Defender",
      bn: "ডিফেন্ডার",
    },
    {
      key: "midfielder",
      en: "Midfielder",
      bn: "মিডফিল্ডার",
    },
    {
      key: "forward",
      en: "Forward",
      bn: "ফরোয়ার্ড",
    },
  ],
  futsal: [
    {
      key: "goalkeeper",
      en: "Goalkeeper",
      bn: "গোলরক্ষক",
    },
    {
      key: "defender",
      en: "Defender",
      bn: "ডিফেন্ডার",
    },
    {
      key: "midfielder",
      en: "Midfielder",
      bn: "মিডফিল্ডার",
    },
    {
      key: "forward",
      en: "Forward",
      bn: "ফরোয়ার্ড",
    },
  ],
  basketball: [
    {
      key: "guard",
      en: "Guard",
      bn: "গার্ড",
    },
    {
      key: "forward",
      en: "Forward",
      bn: "ফরোয়ার্ড",
    },
    {
      key: "center",
      en: "Center",
      bn: "সেন্টার",
    },
  ],
  volleyball: [
    {
      key: "setter",
      en: "Setter",
      bn: "সেটার",
    },
    {
      key: "outside_hitter",
      en: "Outside hitter",
      bn: "আউটসাইড হিটার",
    },
    {
      key: "middle_blocker",
      en: "Middle blocker",
      bn: "মিডল ব্লকার",
    },
    {
      key: "opposite",
      en: "Opposite",
      bn: "অপোজিট",
    },
    {
      key: "libero",
      en: "Libero",
      bn: "লিবেরো",
    },
  ],
  kabaddi: [
    {
      key: "raider",
      en: "Raider",
      bn: "রেইডার",
    },
    {
      key: "defender",
      en: "Defender",
      bn: "ডিফেন্ডার",
    },
    {
      key: "all_rounder",
      en: "All-rounder",
      bn: "অলরাউন্ডার",
    },
  ],
  badminton: [
    {
      key: "singles",
      en: "Singles",
      bn: "সিঙ্গেলস",
    },
    {
      key: "doubles",
      en: "Doubles",
      bn: "ডাবলস",
    },
  ],
  table_tennis: [
    {
      key: "singles",
      en: "Singles",
      bn: "সিঙ্গেলস",
    },
    {
      key: "doubles",
      en: "Doubles",
      bn: "ডাবলস",
    },
  ],
};

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("sports", "positions", {
      type: Sequelize.JSONB,
      allowNull: false,
      defaultValue: [],
    });
    for (const [key, list] of Object.entries(POSITIONS)) {
      await queryInterface.sequelize.query(
        "UPDATE sports SET positions = :list::jsonb WHERE key = :key",
        { replacements: { key, list: JSON.stringify(list) } },
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("sports", "positions");
  },
};
