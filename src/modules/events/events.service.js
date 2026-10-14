'use strict';

/**
 * Domain event facade (M04-FR-12 interface). Modules call publish(transaction, event) inside
 * the transaction that made the change. Until M04 lands this only logs after commit; M04 will
 * insert into outbox_events in the same transaction and relay to BullMQ, without changing callers.
 * Nothing consumes events yet, so nothing is lost in the meantime.
 */
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../common/logger');

// Tests read published events from here; it is never filled outside NODE_ENV=test.
const recorded = [];

/**
 * @param {import('sequelize').Transaction|null} transaction
 * @param {object} e
 * @param {string} e.name           e.g. 'setting.changed'
 * @param {string} e.aggregateType  e.g. 'platform_setting'
 * @param {string} e.aggregateId
 * @param {object} e.payload        no PII, no secrets (CLAUDE.md)
 * @param {object} [e.actor]        principal
 */
async function publish(transaction, { name, aggregateType, aggregateId, payload, actor }) {
  const event = {
    id: crypto.randomUUID(),
    name,
    version: 1,
    aggregateType,
    aggregateId: String(aggregateId),
    payload,
    metadata: { actorId: actor?.id ?? null },
    occurredAt: new Date().toISOString(),
  };
  const emit = () => {
    if (config.isTest) recorded.push(event);
    logger.debug({ event: { id: event.id, name, aggregateType, aggregateId: event.aggregateId } }, 'domain event');
  };
  if (transaction) transaction.afterCommit(emit);
  else emit();
  return event;
}

module.exports = {
  publish,
  /** Test helpers. */
  recorded: () => recorded.slice(),
  clearRecorded: () => recorded.splice(0, recorded.length),
};
