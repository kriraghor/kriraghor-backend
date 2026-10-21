'use strict';

/**
 * M20 and M17 reviews (M20-FR-10):
 *  - the review-sources port, source `gym_pass`, subject `gym`: the member who bought a pass rates the
 *    gym once the pass was used at the front desk (first_redeemed_at set), within reviews.window_days
 *    of the pass's latest visit. A member keeps ONE review per gym: posting again from a newer pass
 *    updates that review (new stars and text, the content checks run again, the edit window restarts)
 *    instead of adding a second one; "waiting to review" lists a gym only until the member has
 *    reviewed it. The gym owner replies.
 *  - the rating on the gym: the consumer of review.aggregate_updated reads the published figure from
 *    M17 at consume time and stores it in gyms.rating_avg and rating_count; public views show the
 *    average only from reviews.min_count_display reviews.
 * Registered once per process (registry.registerAll).
 */
const { Op } = require('sequelize');
const { Gym, GymPass } = require('../../models');
const { onEvent } = require('../events').consumers;

// A refunded or void pass was never really used: it cannot be reviewed.
const USED = ['active', 'redeemed', 'expired'];

const visitOf = (p) => (p.firstRedeemedAt ? (p.lastRedeemedAt ?? p.firstRedeemedAt) : null);

async function source(passId, { transaction } = {}) {
  const p = await GymPass.findByPk(passId, { transaction });
  if (!p) return null;
  return { ref: p.code, subjectId: p.gymId, ownerId: p.ownerId, payerId: p.holderId, doneAt: USED.includes(p.status) ? visitOf(p) : null };
}

/** The latest used pass per gym, its latest visit after `since`. */
async function reviewableBy(userId, since) {
  const rows = await GymPass.findAll({ where: { holderId: userId, status: USED, firstRedeemedAt: { [Op.ne]: null } }, order: [['lastRedeemedAt', 'DESC NULLS LAST']], limit: 100 });
  const seen = new Set();
  const out = [];
  for (const p of rows) {
    const at = visitOf(p);
    if (seen.has(p.gymId) || !(at > since)) continue;
    seen.add(p.gymId);
    out.push({ sourceId: p.id, ref: p.code, subjectId: p.gymId, doneAt: at });
  }
  return out;
}

async function subject(gymId) {
  const g = await Gym.findByPk(gymId, { attributes: ['name', 'slug', 'liveSnapshot'] });
  return g ? { name: g.liveSnapshot?.name ?? g.name, slug: g.slug } : null;
}

function register() {
  require('../trust').reviewSources.register('gym_pass', { subjectType: 'gym', oneReviewPerSubject: true, codes: { notPayer: 'NOT_YOUR_PASS', notDone: 'PASS_NOT_REDEEMED' }, source, reviewableBy, subject });
}

/** M17: the rating from the published reviews (M20 owns the columns). */
async function setRating(gymId, { avg, count }, { transaction }) {
  const [n] = await Gym.update({ ratingAvg: avg, ratingCount: count }, { where: { id: gymId }, transaction, silent: true });
  return n;
}

function registerGymReviewConsumers() {
  onEvent('review.aggregate_updated', 'gym.rating', async (e, { transaction }) => {
    if (e.payload.subjectType !== 'gym') return null;
    const r = await require('../trust').reviews.ratingOf('gym', e.payload.subjectId, { transaction });
    return setRating(e.payload.subjectId, r, { transaction });
  });
}

module.exports = { register, source, reviewableBy, subject, setRating, registerGymReviewConsumers };
