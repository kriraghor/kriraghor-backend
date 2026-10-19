'use strict';

/**
 * M23 tick (job esports_events.tick, every minute, queue esports_events). Every step is keyed or
 * status-guarded, so a repeat or an overlap is harmless:
 *   a published event has started            follow alert event_started (key started:{event})
 *   a final starts within the reminder window follow alert final_soon (key final_soon:{final})
 *   a final is live                           one final_live feed item
 *   open polls past closes_at                 closed
 *   a final's registration closed             qualified and invited places nobody took → missed
 */
const { Op } = require('sequelize');
const models = require('../../models');
const reads = require('../esports').reads;
const rules = require('./events.rules');
const c = require('./events.common');
const alerts = require('./alerts.service');
const feed = require('./feed.service');
const audience = require('./audience.service');
const qualifications = require('./qualifications.service');

const { sequelize, EsportsEvent, EsportsEventStage } = models;
const DAY = 24 * 3600 * 1000;

async function tick(now = new Date()) {
  const out = { started: 0, finalSoon: 0, finalLive: 0, pollsClosed: 0, missed: 0 };
  const events = await EsportsEvent.findAll({ where: { status: 'published', startsAt: { [Op.lte]: new Date(now.getTime() + DAY) }, endsAt: { [Op.gte]: new Date(now.getTime() - DAY) } } });
  for (const e of events) {
    const stages = await EsportsEventStage.findAll({ where: { eventId: e.id, status: 'active' } });
    const summaries = await reads.tournamentSummary(stages.map((s) => s.tournamentId));
    const tournaments = stages.map((s) => summaries.get(s.tournamentId)).filter(Boolean);
    if (rules.phase(e, tournaments, now) === 'live' && now >= e.startsAt) {
      const sent = await sequelize.transaction(async (transaction) => {
        const a = await alerts.send(e.id, 'event_started', `started:${e.id}`, { transaction, now });
        if (a) c.ping(transaction, e.id, 'esports_event.phase_changed');
        return a;
      });
      if (sent) out.started += 1;
    }
    for (const s of stages.filter((x) => x.role === 'final')) {
      const f = summaries.get(s.tournamentId);
      if (!f || f.status === 'cancelled') continue;
      if (rules.finalReminderDue(f.startsAt, now, c.config().reminderMinutes)) {
        const sent = await sequelize.transaction((transaction) => alerts.send(e.id, 'final_soon', `final_soon:${f.id}`, { transaction, now }));
        if (sent) out.finalSoon += 1;
      }
      if (f.status === 'live' && !(await feed.has(e.id, 'final_live', f.id))) {
        await sequelize.transaction((transaction) => feed.add(transaction, e.id, { kind: 'final_live', tournamentId: f.id }));
        out.finalLive += 1;
      }
    }
  }
  out.pollsClosed = await audience.closeDue(now);
  out.missed = await qualifications.sweepMissed(now);
  return out;
}

module.exports = { tick };
