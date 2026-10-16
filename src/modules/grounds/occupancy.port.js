'use strict';

/**
 * M09 §2.3 OccupancyPort (dependency inversion). Closures and series must write occupancy in the
 * same transaction as their own rows, but the occupancy (booking slots) belongs to M10, which depends
 * on M09. So M09 defines the port and M10 registers the implementation at start-up:
 *
 *   occupancy.register({
 *     findConflicts({ courtIds, from, to, outsideHours?, ignore? }, { transaction }) → Conflict[],
 *     countUpcoming({ groundId?, courtIds? }, { transaction }) → number,   // pending_payment + confirmed
 *     openHalfHours(courtIds, day) → { [courtId]: number },
 *     reserveClosure, releaseClosure, materialiseSeries, setSeriesWeek, endSeries   // step 2
 *   })
 *
 * countUpcoming is an addition to the spec's port: the pricing footer (FR-11) and court retirement
 * (FR-06) need a count. Until M10 registers, the null implementation answers "nothing booked", so
 * step 1 runs the same checks and they pass.
 */
const NULL_PORT = {
  findConflicts: async () => [],
  countUpcoming: async () => 0,
  openHalfHours: async (courtIds) => Object.fromEntries(courtIds.map((id) => [id, 0])),
};

let port = NULL_PORT;

function register(impl) {
  for (const m of ['findConflicts', 'countUpcoming', 'openHalfHours']) {
    if (typeof impl?.[m] !== 'function') throw new Error(`OccupancyPort needs ${m}()`);
  }
  port = impl;
}

/** Back to the null implementation (tests). */
const reset = () => {
  port = NULL_PORT;
};

module.exports = {
  register,
  reset,
  findConflicts: (q, opts = {}) => port.findConflicts(q, opts),
  countUpcoming: (q, opts = {}) => port.countUpcoming(q, opts),
  openHalfHours: (courtIds, day) => port.openHalfHours(courtIds, day),
};
