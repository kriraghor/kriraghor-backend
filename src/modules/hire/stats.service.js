'use strict';

/**
 * M11 pro stats (FR-52, M19 §6.3 Pro, Round B1), kept on hire_profiles for the directory and the
 * profile page:
 *   jobs_done            released jobs of the profile;
 *   acceptance_rate      accepted / (accepted + declined + expired), requests created in the trailing
 *                        hire.acceptance_window_days (hire.rules.requestStats);
 *   median_reply_minutes median(decided_at − created_at) over the same requests.
 * Recomputed (not incremented) by the hire consumers on hire_job.released and the request outcomes,
 * so a replayed event changes nothing. The nightly hire.stats-recompute job (recomputeAll) moves the
 * 90-day window on for profiles with no new activity. rating_avg / rating_count belong to the M17 review consumer and
 * are never written here.
 */
const { Op } = require('sequelize');
const { HireProfile, HireRequest, HireJob } = require('../../models');
const rules = require('./hire.rules');
const c = require('./hire.common');

const DAY = 86400000;

/** The stats of one profile now. */
async function statsOf(profileId, { now = new Date(), transaction } = {}) {
  const windowDays = c.config().acceptanceWindowDays;
  const [jobsDone, rows] = await Promise.all([
    HireJob.count({ where: { profileId, status: 'released' }, transaction }),
    HireRequest.findAll({ where: { profileId, createdAt: { [Op.gte]: new Date(now.getTime() - windowDays * DAY) } }, attributes: ['status', 'createdAt', 'decidedAt'], transaction }),
  ]);
  const s = rules.requestStats(rows, { now, windowDays });
  return { jobsDone, acceptanceRate: s.acceptanceRate, medianReplyMinutes: s.medianReplyMinutes };
}

/** Recompute and store a profile's stats (only these three columns). */
async function recompute(profileId, { transaction } = {}) {
  if (!profileId) return null;
  const s = await statsOf(profileId, { transaction });
  await HireProfile.update(s, { where: { id: profileId }, transaction, fields: ['jobsDone', 'acceptanceRate', 'medianReplyMinutes'] });
  return s;
}

/** hire_job.released: the job's profile. */
async function onJobReleased(jobId, { transaction } = {}) {
  const j = await HireJob.findByPk(jobId, { attributes: ['profileId'], transaction });
  return j ? recompute(j.profileId, { transaction }) : null;
}

/** Nightly: every profile, so requests that left the window stop counting. One small update per profile. */
async function recomputeAll() {
  const rows = await HireProfile.findAll({ attributes: ['id'], order: [['id', 'ASC']] });
  for (const { id } of rows) await recompute(id);
  return { profiles: rows.length };
}

module.exports = { statsOf, recompute, recomputeAll, onJobReleased };
