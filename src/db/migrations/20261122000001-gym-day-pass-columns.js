'use strict';

/**
 * M20 §23, the contract step of the day-pass removal (2 Nov 2026; expand in 20261116000001): the last day
 * pass ran on 9 Nov 2026 and no code reads or writes these columns any more, so they go. Rows of kind 'day'
 * stay in gym_packages and gym_passes as history (their CHECK constraints keep the value).
 *  - gyms.public_day_price_poisha (cleared by 20261116000001)
 *  - gyms.daily_capacity and chk_gyms_capacity (never used by a service)
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE gyms DROP CONSTRAINT IF EXISTS chk_gyms_capacity');
    await q('ALTER TABLE gyms DROP COLUMN IF EXISTS daily_capacity');
    await q('ALTER TABLE gyms DROP COLUMN IF EXISTS public_day_price_poisha');
  },

  // Contract step: the columns held nothing in use; they are not brought back.
  async down() {},
};
