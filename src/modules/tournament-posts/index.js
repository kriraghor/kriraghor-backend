'use strict';

/**
 * The tournament-posts module's public interface (ADR-007 §3): other modules use only this file;
 * everything else is internal (tests/unit/boundaries.test.js). Functions delegate lazily, so requiring
 * the index never changes load order and cannot create a require cycle at load time.
 */
const lazy = (file, names) => Object.freeze(Object.fromEntries(names.map((n) => [n, (...args) => require(file)[n](...args)])));

module.exports = {
  posts: lazy('./posts.service', ['facts', 'removeInTx']),
  comments: lazy('./comments.service', ['facts', 'removeInTx']),
};
