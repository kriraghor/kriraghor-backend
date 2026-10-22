'use strict';

/**
 * M17 review-sources port (ADR-007; M17-FR-30): what a member can review, and after what. M17 never
 * reads the source modules' tables; each one registers an adapter from its own module (M10 bookings
 * → `booking`, M11 hire → `hire_job`, M13 orders → `sub_order`, M20 gym → `gym_pass`):
 *
 *   subjectType                       what the review is about: ground, hire_profile, shop, gym
 *   codes { notPayer, notDone }       the source's own refusal codes (trust.errors)
 *   oneReviewPerSubject               true for gyms: a newer pass updates the member's one review
 *   source(sourceId, { transaction }) → null | { ref, subjectId, ownerId, payerId, doneAt }
 *                                     doneAt: when it became reviewable (null while not done)
 *   reviewableBy(userId, since)       → [{ sourceId, ref, subjectId, doneAt, extra? }] done after since
 *   subject(subjectId)                → null | { name, slug } (display only; no PII)
 *
 * describe() answers for one source: { sourceType, subjectType, subjectId, ownerId, payerId, ref,
 * eligible, reason, eligibleAt, subjectName }. The adapters load on first use, like the targets port.
 */
const settings = require('../settings').settings;
const rules = require('./trust.rules');

const sources = new Map();
let loaded = false;

function register(sourceType, impl) {
  sources.set(sourceType, impl);
}

function ensure() {
  if (loaded) return;
  loaded = true;
  require('../bookings').reviewSource.register();
  require('../hire').reviewSource.register();
  require('../orders').reviewSource.register();
  require('../gym').reviewSource.register();
}

function get(sourceType) {
  ensure();
  return sources.get(sourceType) ?? null;
}

/** [sourceType, adapter] pairs, in registration order. */
function all() {
  ensure();
  return [...sources.entries()];
}

/** The adapter for a subject type (one source per subject type today). */
function forSubject(subjectType) {
  return all().find(([, s]) => s.subjectType === subjectType)?.[1] ?? null;
}

async function subjectOf(subjectType, subjectId) {
  const s = forSubject(subjectType);
  return s ? s.subject(subjectId).catch(() => null) : null;
}

/** One source for one member: null when it does not exist. */
async function describe(sourceType, sourceId, userId, { now = new Date(), transaction } = {}) {
  const s = get(sourceType);
  if (!s) return null;
  const src = await s.source(sourceId, { transaction });
  if (!src) return null;
  const reason = rules.sourceReviewBlock({ isPayer: src.payerId === userId, doneAt: src.doneAt, now, windowDays: settings.get('reviews.window_days'), ...s.codes });
  const subject = await subjectOf(s.subjectType, src.subjectId);
  return {
    sourceType,
    subjectType: s.subjectType,
    subjectId: src.subjectId,
    ownerId: src.ownerId,
    payerId: src.payerId,
    ref: src.ref,
    eligible: reason === null,
    reason,
    eligibleAt: src.doneAt ?? null,
    subjectName: subject?.name ?? null,
    oneReviewPerSubject: Boolean(s.oneReviewPerSubject),
  };
}

module.exports = { register, get, all, forSubject, subjectOf, describe };
