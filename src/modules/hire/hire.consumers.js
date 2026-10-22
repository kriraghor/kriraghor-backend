'use strict';

/**
 * M11 stats consumers (FR-52, Round B1): a released job and each request outcome recompute the
 * profile's jobs done, acceptance rate and median reply time (stats.service). Registered with the other
 * hire consumers (hire.moderation registerHireConsumers).
 */
const { onEvent } = require('../events').consumers;

/** Request events that change what the stats count (a reply, or a request leaving `pending`). */
const REQUEST_OUTCOMES = ['hire_request.accepted', 'hire_request.declined', 'hire_request.expired', 'hire_request.withdrawn', 'hire_request.lapsed'];

function registerHireStatsConsumers() {
  onEvent('hire_job.released', 'hire.stats-job-released', (e, { transaction }) => require('./stats.service').onJobReleased(e.payload.jobId, { transaction }));
  for (const name of REQUEST_OUTCOMES) {
    onEvent(name, `hire.stats-request-${name.split('.')[1]}`, (e, { transaction }) => require('./stats.service').recompute(e.payload.profileId, { transaction }));
  }
}

module.exports = { registerHireStatsConsumers, REQUEST_OUTCOMES };
