'use strict';

/**
 * M18 reliability (§6.3, FR-14, Q102), step 1: ground owners and bookers. Facts come from M10
 * (bookings.reads.reliabilityFacts) and M17 (disputes decided against the owner) over
 * trust.window_days; incidents are weighted by trust.w.*; a score is shown once its sample reaches
 * trust.min_sample. Recomputed on events (debounced with the risk evaluation) and nightly.
 *   owner   sample: app bookings confirmed at their grounds; incidents: penalised owner cancels
 *           (weather exempt, Q22) × trust.w.owner_cancel + disputes lost × trust.w.owner_dispute_lost
 *   booker  sample: their confirmed bookings; incidents: no-shows a dispute did not overturn ×
 *           trust.w.booker_no_show + member cancels within trust.booker_late_cancel_hours × trust.w.booker_late_cancel
 */
const { TrustScore } = require('../../models');
const settings = require('../settings').settings;
const events = require('../events').events;
const rules = require('./risk.rules');

const DAY = 24 * 3600 * 1000;
const KINDS = ['owner', 'booker'];
const iso = (d) => (d ? new Date(d).toISOString() : null);
const bookings = () => require('../bookings').reads;
const disputes = () => require('../trust').disputes;

const weights = () => ({
  owner_cancel: settings.get('trust.w.owner_cancel'),
  owner_dispute_lost: settings.get('trust.w.owner_dispute_lost'),
  booker_no_show: settings.get('trust.w.booker_no_show'),
  booker_late_cancel: settings.get('trust.w.booker_late_cancel'),
});

/** Recompute both kinds for one user; returns the scores. Rows exist only once there is a sample. */
async function recompute(userId, now = new Date()) {
  const { sequelize } = require('../../models');
  const since = new Date(now.getTime() - settings.get('trust.window_days') * DAY);
  const facts = await bookings().reliabilityFacts(userId, since, { lateHours: settings.get('trust.booker_late_cancel_hours') });
  const lost = (await disputes().statsFor(userId, since)).lost;
  const w = weights();
  const counts = {
    owner: { sample: facts.owner.sample, detail: { owner_cancel: facts.owner.cancels, owner_dispute_lost: lost } },
    booker: { sample: facts.booker.sample, detail: { booker_no_show: facts.booker.noShows, booker_late_cancel: facts.booker.lateCancels } },
  };
  const out = {};
  await sequelize.transaction(async (transaction) => {
    for (const kind of KINDS) {
      const c = counts[kind];
      const before = await TrustScore.findOne({ where: { userId, kind }, transaction, lock: transaction.LOCK.UPDATE });
      if (!before && c.sample === 0) continue;
      const incidents = rules.weighted(c.detail, w);
      const r = rules.reliability({ sample: c.sample, incidents, minSample: settings.get('trust.min_sample'), minDenominator: settings.get('trust.min_denominator') });
      const next = { userId, kind, score: r.score, sample: c.sample, incidents, shown: r.shown, detail: c.detail, computedAt: now };
      const changed = !before || before.score !== r.score || before.shown !== r.shown || before.sample !== c.sample;
      if (before) await before.update(next, { transaction });
      else await TrustScore.create(next, { transaction });
      out[kind] = { score: r.score, shown: r.shown, sample: c.sample };
      if (!changed) continue;
      await events.publish(transaction, { name: 'trust.score_updated', aggregateType: 'trust_score', aggregateId: userId, payload: { userId, kind, score: r.score, shown: r.shown, sample: c.sample } });
      if (rules.lowCrossed({ before: before ? { score: before.score, shown: before.shown } : null, after: r, line: settings.get('trust.low_alert') })) {
        await events.publish(transaction, { name: 'trust.low_crossed', aggregateType: 'trust_score', aggregateId: userId, payload: { userId, kind, score: r.score } });
      }
    }
  });
  return out;
}

const view = (t, { full }) => ({ kind: t.kind, score: t.shown || full ? t.score : null, shown: t.shown, sample: t.sample, ...(full ? { detail: t.detail ?? null, minSample: settings.get('trust.min_sample') } : {}), computedAt: iso(t.computedAt) });

/** GET /me/trust: my own scores, with the counts behind them (shown or not yet). */
async function mine(principal) {
  const rows = await TrustScore.findAll({ where: { userId: principal.id } });
  return { items: rows.map((t) => view(t, { full: true })) };
}

/** GET /trust/:userId: shown scores only (public: a ground's owner, a booker for the owner). */
async function publicFor(userId) {
  const rows = await TrustScore.findAll({ where: { userId, shown: true } });
  return { items: rows.map((t) => view(t, { full: false })) };
}

/** The desk: every score of a user. */
const forUser = async (userId) => (await TrustScore.findAll({ where: { userId } })).map((t) => view(t, { full: true }));

module.exports = { recompute, mine, publicFor, forUser };
