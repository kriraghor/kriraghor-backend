'use strict';

/**
 * M12 and M17 reviews: the shop's rating follows its published reviews (buyers rate a shop after a
 * completed sub-order, M13's review source). The consumer of review.aggregate_updated reads the
 * figure from M17 at consume time (a late or replayed event never writes an old figure) and stores it
 * in shops.rating_avg and rating_count; public views show the average only from
 * reviews.min_count_display reviews. Registered once per process (registry.registerAll).
 */
const { Shop } = require('../../models');
const { onEvent } = require('../events').consumers;

/** M17: the rating from the published reviews (M12 owns the columns). */
async function setRating(shopId, { avg, count }, { transaction }) {
  const [n] = await Shop.update({ ratingAvg: avg, ratingCount: count }, { where: { id: shopId }, transaction, silent: true });
  return n;
}

function registerMarketReviewConsumers() {
  onEvent('review.aggregate_updated', 'market.shop-rating', async (e, { transaction }) => {
    if (e.payload.subjectType !== 'shop') return null;
    const r = await require('../trust').reviews.ratingOf('shop', e.payload.subjectId, { transaction });
    return setRating(e.payload.subjectId, r, { transaction });
  });
}

module.exports = { setRating, registerMarketReviewConsumers };
