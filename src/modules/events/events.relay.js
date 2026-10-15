'use strict';

/**
 * Outbox relay (M04-FR-13), MySQL edition. Claims due rows with SELECT … FOR UPDATE SKIP LOCKED, so
 * parallel relays (several worker pods, the 1 s scheduler and after-commit nudges) never claim the
 * same event. For each event it enqueues one job per registered consumer (jobId {eventId}__{consumer},
 * deduplicated by BullMQ) and marks the row published. A failed enqueue marks the row failed with a
 * backoff; it is claimed again when available_at passes.
 */
const logger = require('../../common/logger');
const { sequelize, OutboxEvent } = require('../../models');
const settings = require('../settings/settings.service');
const { backoffMs } = require('./events.backoff');
const consumers = require('./events.consumers');

async function relayOnce({ batch } = {}) {
  const size = batch ?? settings.get('events.relay_batch_size');
  return sequelize.transaction(async (transaction) => {
    const ids = await sequelize.query(
      "SELECT id FROM outbox_events WHERE status IN ('pending','failed') AND available_at <= UTC_TIMESTAMP(3) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",
      { replacements: [size], type: sequelize.QueryTypes.SELECT, transaction }
    );
    if (!ids.length) return { published: 0, failed: 0 };
    const rows = await OutboxEvent.findAll({ where: { id: ids.map((r) => r.id) }, order: [['id', 'ASC']], transaction });

    let published = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        for (const consumer of consumers.consumersFor(row.name)) {
          await consumers.dispatch({ jobId: consumers.jobIdFor(row.id, consumer), data: { eventId: row.id, consumer } });
        }
        await row.update({ status: 'published', publishedAt: new Date(), attempts: row.attempts + 1, lastError: null }, { transaction });
        published += 1;
      } catch (err) {
        const attempts = row.attempts + 1;
        const delay = backoffMs(attempts, settings.get('events.backoff_cap_sec'));
        await row.update({ status: 'failed', attempts, lastError: String(err?.message ?? err).slice(0, 2000), availableAt: new Date(Date.now() + delay) }, { transaction });
        logger.warn({ eventId: row.id, name: row.name, attempts, err: err?.message }, 'outbox relay could not enqueue; will retry');
        failed += 1;
      }
    }
    return { published, failed };
  });
}

/** Health numbers for the ops page and metrics. */
async function health() {
  const [[row]] = await sequelize.query(
    "SELECT COUNT(*) AS pending, MIN(occurred_at) AS oldest FROM outbox_events WHERE status IN ('pending','failed')"
  );
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return { pending: Number(row?.pending ?? 0), oldestPendingSeconds: oldest ? Math.max(0, Math.round((Date.now() - oldest.getTime()) / 1000)) : null };
}

module.exports = { relayOnce, health };
