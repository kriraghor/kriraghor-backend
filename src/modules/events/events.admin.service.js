'use strict';

/** Outbox health and dead letters for the ops page (M04 §4 /panel/admin/events, §9). */
const { OutboxEvent, ConsumedEvent } = require('../../models');
const relay = require('./events.relay');
const consumers = require('./events.consumers');

const iso = (d) => (d ? new Date(d).toISOString() : null);

function serializeEvent(row) {
  return {
    id: row.id,
    name: row.name,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    occurredAt: iso(row.occurredAt),
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError ?? null,
    consumers: consumers.consumersFor(row.name),
  };
}

/** GET /admin/events?status=pending|failed|dead&name= */
async function list({ status = 'dead', name, limit = 50 } = {}) {
  const health = await relay.health();
  if (status === 'dead') {
    const dead = await ConsumedEvent.findAll({ where: { status: 'dead', ...(name ? { eventName: name } : {}) }, order: [['processedAt', 'DESC']], limit });
    const rows = new Map((await OutboxEvent.findAll({ where: { id: dead.map((d) => d.eventId) } })).map((r) => [r.id, r]));
    return {
      health,
      items: dead.map((d) => ({
        ...serializeEvent(rows.get(d.eventId)),
        status: 'dead',
        consumer: d.consumer,
        attempts: d.attempts,
        lastError: d.lastError ?? null,
        deadAt: iso(d.processedAt),
      })),
    };
  }
  const rows = await OutboxEvent.findAll({ where: { status, ...(name ? { name } : {}) }, order: [['id', 'DESC']], limit });
  return { health, items: rows.map(serializeEvent) };
}

module.exports = { list };
