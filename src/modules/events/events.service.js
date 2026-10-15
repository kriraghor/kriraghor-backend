'use strict';

/**
 * OutboxService (M04-FR-12). publish(transaction, event) inserts the event into outbox_events in
 * the caller's transaction, so a rolled-back change leaves no event and a committed change always
 * has one. After commit it nudges the relay (outbox.relay), which delivers the event at least once
 * to every registered consumer (events.consumers.js).
 */
const config = require('../../config');
const logger = require('../../common/logger');
const { AppError } = require('../../common/errors');
const { uuid7 } = require('../../common/uuid7');
const { OutboxEvent } = require('../../models');
const { definition, piiFields } = require('./catalog');

// Tests read published events from here as well as from the table; never filled outside NODE_ENV=test.
const recorded = [];

const invalid = (name, detail) => new AppError(500, 'EVENT_INVALID', `Event ${name} is invalid`, { detail });

/** Build and validate the envelope (M04 §6.4). Throws before anything is written. */
function envelope({ name, aggregateType, aggregateId, aggregateVersion, payload, actor, correlationId, causationId }) {
  const def = definition(name);
  if (!def) throw invalid(name, 'Not in the event registry (src/modules/events/catalog.js)');
  const parsed = def.schema.safeParse(payload);
  if (!parsed.success) throw invalid(name, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const pii = piiFields(payload);
  if (pii.length) throw invalid(name, `Personal data is not allowed in event payloads: ${pii.join(', ')}`);
  return {
    id: uuid7(),
    name,
    version: def.version,
    aggregateType,
    aggregateId: String(aggregateId),
    aggregateVersion: aggregateVersion ?? null,
    payload: parsed.data,
    metadata: {
      actor: actor ? { type: actorTypeOf(actor), id: actor.id ?? null } : { type: 'system', id: null },
      correlationId: correlationId ?? null,
      causationId: causationId ?? null,
    },
  };
}

function actorTypeOf(actor) {
  if (!actor || !actor.id) return 'system';
  if (actor.isMaster) return 'master';
  if (actor.isStaff) return 'staff';
  return 'user';
}

/** Ask the relay to run soon (deduplicated by a fixed jobId). The 1 s scheduler is the backstop. */
function nudgeRelay() {
  if (config.isTest) return;
  const { getQueue, QUEUES } = require('../../jobs/queues');
  getQueue(QUEUES.OUTBOX)
    .add('outbox.relay', {}, { jobId: 'relay-nudge', removeOnComplete: true, removeOnFail: true })
    .catch((err) => logger.warn({ err: err.message }, 'outbox relay nudge failed; the scheduler will relay'));
}

/**
 * @param {import('sequelize').Transaction|null} transaction  the producer's transaction
 * @param {object} e  name, aggregateType, aggregateId, payload; optional aggregateVersion, actor,
 *                    correlationId (request id), causationId (the event that caused this one), availableAt
 */
async function publish(transaction, e) {
  const env = envelope({ ...e, correlationId: e.correlationId ?? e.req?.id });
  await OutboxEvent.create({ ...env, ...(e.availableAt ? { availableAt: e.availableAt } : {}) }, { transaction });
  const after = () => {
    if (config.isTest) recorded.push(env);
    nudgeRelay();
  };
  if (transaction) transaction.afterCommit(after);
  else after();
  return env;
}

module.exports = {
  publish,
  envelope,
  actorTypeOf,
  /** Test helpers. */
  recorded: () => recorded.slice(),
  clearRecorded: () => recorded.splice(0, recorded.length),
};
