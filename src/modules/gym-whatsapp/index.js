'use strict';

/**
 * The gym-whatsapp module's public interface (ADR-007 §3, M24 §25): other modules use only this file;
 * everything else in gym-whatsapp is internal (tests/unit/boundaries.test.js). Functions delegate lazily,
 * so requiring the index never changes load order and cannot create a require cycle at load time.
 *
 *   contact  M20's gym page: the WhatsApp number a branch shows (M24-FR-158)
 */
const lazy = (file, names) => Object.freeze(Object.fromEntries(names.map((n) => [n, (...args) => require(file)[n](...args)])));

module.exports = {
  contact: lazy('./contacts.service', ['forGym']),
};
