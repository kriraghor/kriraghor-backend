'use strict';

/**
 * M19 "Needs your action" (FR-11, FR-29): one item for one queue a module owns, so every provider
 * follows the same rules. An empty queue gives no item. The item is `high` when anything in the queue
 * is past its time limit (`overdue`) or the owner says so (`urgent`), and its `dueAt` is the earliest
 * time limit still in the queue (null when the queue has none). Pure, no database.
 */
function queueItem({ key, count, href, overdue = 0, urgent = false, dueAt = null }) {
  if (!count) return [];
  return [{ key, count, severity: overdue > 0 || urgent ? 'high' : 'normal', dueAt: dueAt ? new Date(dueAt).toISOString() : null, href }];
}

module.exports = { queueItem };
