'use strict';

/**
 * Event consumers and the shared inbox (M04-FR-14, FR-16, FR-17).
 *
 *   onEvent('setting.changed', 'notifications.setting-changed', handler)
 *
 * registers a consumer at boot. The relay enqueues one BullMQ job per (event, consumer); the job runs
 * the handler through the inbox: a consumed_events row is inserted in the handler's own transaction,
 * so a duplicate delivery (at-least-once) is skipped and a failed handler leaves no row and is retried.
 * After events.consumer_max_attempts failures the pair is dead-lettered and outbox.event_dead_lettered
 * is published for the ops alert. Masters can replay a dead pair (step-up events.replay).
 */
const config = require('../../config');
const logger = require('../../common/logger');
const { AppError, E } = require('../../common/errors');
const { sequelize, OutboxEvent, ConsumedEvent } = require('../../models');
const settings = require('../settings').settings;
const audit = require('../audit').audit;
const events = require('./events.service');
const { definition } = require('./catalog');

const CONSUME_JOB = 'events.consume';
const registry = new Map(); // event name → Map(consumer → handler)

/** Register a consumer. Names are `<module>.<purpose>`, unique per event. */
function onEvent(name, consumer, handler) {
  if (!definition(name)) throw new Error(`onEvent: ${name} is not in the event registry`);
  if (!registry.has(name)) registry.set(name, new Map());
  if (registry.get(name).has(consumer)) throw new Error(`onEvent: ${consumer} already consumes ${name}`);
  registry.get(name).set(consumer, handler);
}

const consumersFor = (name) => [...(registry.get(name)?.keys() ?? [])];
const handlerFor = (name, consumer) => registry.get(name)?.get(consumer);

/** Test helper: forget every registration. */
const resetConsumers = () => registry.clear();

/** Where consumer jobs go: BullMQ in every process, an in-memory list in tests (tests run jobs directly). */
const testQueue = [];
let dispatcher = null;
function dispatch(job) {
  if (dispatcher) return dispatcher(job);
  if (config.isTest) {
    testQueue.push(job);
    return Promise.resolve();
  }
  const { getQueue, QUEUES } = require('../../jobs/queues');
  return getQueue(QUEUES.EVENTS).add(CONSUME_JOB, job.data, {
    jobId: job.jobId,
    attempts: settings.get('events.consumer_max_attempts'),
    backoff: { type: 'capped' },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}
const useDispatcher = (fn) => {
  dispatcher = fn;
};
const takeTestJobs = () => testQueue.splice(0, testQueue.length);

/** BullMQ job ids cannot contain ":". */
const jobIdFor = (eventId, consumer, suffix = '') => `${eventId}__${consumer}${suffix}`;

function toEnvelope(row) {
  const r = row.get({ plain: true });
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    aggregateType: r.aggregateType,
    aggregateId: r.aggregateId,
    aggregateVersion: r.aggregateVersion,
    occurredAt: r.occurredAt ? new Date(r.occurredAt).toISOString() : null,
    payload: r.payload,
    ...(r.metadata || {}),
  };
}

/**
 * Run one (event, consumer) under the inbox. Returns { status: 'processed' | 'skipped' }.
 * attemptsMade is BullMQ's count of earlier attempts for this job.
 */
async function processConsume({ eventId, consumer }, { attemptsMade = 0 } = {}) {
  const row = await OutboxEvent.findByPk(eventId);
  if (!row) throw new Error(`event ${eventId} not found`);
  const handler = handlerFor(row.name, consumer);
  if (!handler) {
    logger.warn({ eventId, name: row.name, consumer }, 'no handler for consumer; skipping');
    return { status: 'skipped' };
  }
  const event = toEnvelope(row);
  const max = settings.get('events.consumer_max_attempts');
  try {
    return await sequelize.transaction(async (transaction) => {
      const seen = await ConsumedEvent.findOne({ where: { consumer, eventId }, transaction, lock: transaction.LOCK.UPDATE });
      if (seen?.status === 'processed') return { status: 'skipped' };
      if (seen) await seen.update({ status: 'processed', attempts: seen.attempts + 1, lastError: null, processedAt: new Date() }, { transaction });
      else await ConsumedEvent.create({ consumer, eventId, eventName: row.name, status: 'processed', attempts: attemptsMade + 1 }, { transaction });
      await handler(event, { transaction });
      return { status: 'processed' };
    });
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') return { status: 'skipped' }; // a parallel delivery won
    if (attemptsMade + 1 >= max) await deadLetter(row, consumer, attemptsMade + 1, err);
    throw err;
  }
}

/** FR-16: record the dead pair and alert ops. Never throws (the job is failing anyway). */
async function deadLetter(row, consumer, attempts, err) {
  try {
    await sequelize.transaction(async (transaction) => {
      const message = String(err?.message ?? err).slice(0, 2000);
      const seen = await ConsumedEvent.findOne({ where: { consumer, eventId: row.id }, transaction, lock: transaction.LOCK.UPDATE });
      if (seen?.status === 'processed') return;
      if (seen) await seen.update({ status: 'dead', attempts, lastError: message, processedAt: new Date() }, { transaction });
      else await ConsumedEvent.create({ consumer, eventId: row.id, eventName: row.name, status: 'dead', attempts, lastError: message }, { transaction });
      await events.publish(transaction, {
        name: 'outbox.event_dead_lettered',
        aggregateType: 'outbox_event',
        aggregateId: row.id,
        payload: { eventId: row.id, eventType: row.name, consumer, attempts },
        causationId: row.id,
      });
    });
    logger.error({ eventId: row.id, name: row.name, consumer, attempts }, 'event dead-lettered');
  } catch (e) {
    logger.error({ err: e, eventId: row.id, consumer }, 'dead-letter write failed');
  }
}

/** FR-17: re-enqueue one (event, consumer). Only dead or never-delivered pairs can be replayed. */
async function replay(actor, eventId, consumer, req) {
  const row = await OutboxEvent.findByPk(eventId);
  if (!row) throw E.notFound('Event');
  if (!handlerFor(row.name, consumer)) throw new AppError(409, 'EVENT_NOT_REPLAYABLE', 'That consumer does not handle this event', { meta: { consumers: consumersFor(row.name) } });
  const seen = await ConsumedEvent.findOne({ where: { consumer, eventId } });
  if (seen?.status === 'processed') throw new AppError(409, 'EVENT_NOT_REPLAYABLE', 'This consumer already processed the event');
  await audit.record({ action: 'outbox.event_replayed', actor, entityType: 'outbox_event', entityId: eventId, meta: { name: row.name, consumer }, req });
  await dispatch({ jobId: jobIdFor(eventId, consumer, `__r${Date.now()}`), data: { eventId, consumer } });
  return { eventId, consumer, status: 'queued' };
}

module.exports = {
  CONSUME_JOB,
  onEvent,
  consumersFor,
  resetConsumers,
  dispatch,
  useDispatcher,
  takeTestJobs,
  jobIdFor,
  processConsume,
  replay,
  toEnvelope,
};
