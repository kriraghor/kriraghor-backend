'use strict';

/**
 * M11 and M17 reviews (M17-FR-30, M11-FR-06):
 *  - the review-sources port, source `hire_job`, subject `hire_profile`: the manager who paid rates the
 *    pro's profile once the job's money was released (status released; by the manager's confirm, the
 *    auto-release or a dispute decision), within reviews.window_days of the release. The pro replies.
 *  - the rating on the profile: the consumer of review.aggregate_updated reads the published figure
 *    from M17 at consume time (a late or replayed event never writes an old figure) and stores it in
 *    hire_profiles.rating_avg and rating_count. Public views show the average only from
 *    reviews.min_count_display reviews (FR-06: the 1–5 review average; the /10 match rating is separate).
 * Registered once per process (registry.registerAll).
 */
const { Op } = require('sequelize');
const { HireJob, HireProfile } = require('../../models');
const { onEvent } = require('../events').consumers;

async function source(jobId, { transaction } = {}) {
  const j = await HireJob.findByPk(jobId, { transaction });
  if (!j) return null;
  return { ref: j.code, subjectId: j.profileId, ownerId: j.proUserId, payerId: j.hirerId, doneAt: j.status === 'released' ? (j.releasedAt ?? j.updatedAt) : null };
}

async function reviewableBy(userId, since) {
  const rows = await HireJob.findAll({ where: { hirerId: userId, status: 'released', releasedAt: { [Op.gt]: since } }, order: [['releasedAt', 'DESC']], limit: 50 });
  return rows.map((j) => ({ sourceId: j.id, ref: j.code, subjectId: j.profileId, doneAt: j.releasedAt }));
}

/** The pro's public name and the profile's headline. */
async function subject(profileId) {
  const p = await HireProfile.findByPk(profileId, { attributes: ['userId', 'slug', 'headline', 'liveSnapshot'] });
  if (!p) return null;
  const name = (await require('../users').directory.publicNames([p.userId])).get(p.userId)?.displayName ?? null;
  return { name: name ?? p.liveSnapshot?.headline ?? p.headline, slug: p.slug, headline: p.liveSnapshot?.headline ?? p.headline };
}

function register() {
  require('../trust').reviewSources.register('hire_job', { subjectType: 'hire_profile', codes: { notPayer: 'NOT_YOUR_JOB', notDone: 'JOB_NOT_RELEASED' }, source, reviewableBy, subject });
}

/** M17: the rating from the published reviews (M11 owns the columns). */
async function setRating(profileId, { avg, count }, { transaction }) {
  const [n] = await HireProfile.update({ ratingAvg: avg, ratingCount: count }, { where: { id: profileId }, transaction, silent: true });
  return n;
}

function registerHireReviewConsumers() {
  onEvent('review.aggregate_updated', 'hire.rating', async (e, { transaction }) => {
    if (e.payload.subjectType !== 'hire_profile') return null;
    const r = await require('../trust').reviews.ratingOf('hire_profile', e.payload.subjectId, { transaction });
    return setRating(e.payload.subjectId, r, { transaction });
  });
}

module.exports = { register, source, reviewableBy, subject, setRating, registerHireReviewConsumers };
