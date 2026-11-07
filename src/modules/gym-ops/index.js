'use strict';

/**
 * M27 gym operations: the public face of the module (ADR-007). Other modules use only this.
 *   consumers  registered by registry.registerAll (points from check-ins and fees)
 *   notices    M08 targets and values of a notice to members
 *   classes    session facts for notifications
 */
const lazy = (file, names) => Object.freeze(Object.fromEntries(names.map((n) => [n, (...args) => require(file)[n](...args)])));

module.exports = {
  consumers: lazy('./gym-ops.consumers', ['registerGymOpsConsumers']),
  notices: lazy('./notices.service', ['targets', 'facts']),
  classes: lazy('./classes.service', ['sessionFacts']),
};
