'use strict';

/**
 * Settings change requests (M03-FR-11, 12, 13, 15). Every write needs a master with step-up
 * `settings.write` (enforced by the routes). States:
 *
 *   create ── no four-eyes key, effective now ──────────────▶ applied
 *          ── no four-eyes key, effective later ────────────▶ approved ──(job)──▶ applied
 *          ── any four-eyes key ────────────────────────────▶ proposed
 *   proposed ── approve (another master) ── effective now ──▶ applied
 *                                       ── effective later ─▶ approved ──(job)──▶ applied
 *   proposed ── reject (another master) ───────────────────▶ rejected
 *   proposed | approved ── withdraw (proposer) ─────────────▶ withdrawn
 *   proposed | approved ── same key applied elsewhere ──────▶ superseded
 *
 * Applying writes settings_history, bumps the version, updates platform_settings, audits and
 * publishes setting.changed in one transaction; caches reload after commit.
 */
const { Op } = require('sequelize');
const config = require('../../config');
const logger = require('../../common/logger');
const { AppError, E } = require('../../common/errors');
const { sequelize, PlatformSetting, SettingsHistory, SettingsChangeRequest, User } = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const settings = require('./settings.service');
const { validateValue, assertCrossRules } = require('./settings.validate');
const { serializeRequest } = require('./settings.serializer');

const OPEN = ['proposed', 'approved'];
const APPLY_JOB = 'settings.apply-scheduled';

/** Stable JSON for comparing values (object key order does not matter). */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const sameValue = (a, b) => stable(a) === stable(b);

const closed = (status) => new AppError(409, 'CHANGE_REQUEST_CLOSED', 'This change request is already closed', { meta: { status } });

async function lockRequest(id, transaction) {
  const request = await SettingsChangeRequest.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!request) throw E.notFound('Change request');
  return request;
}

/** Definitions as of now, from the database inside the transaction (never a stale cache). */
async function loadDefinitions(transaction, lockKeys = []) {
  if (lockKeys.length) await PlatformSetting.findAll({ where: { key: lockKeys }, transaction, lock: transaction.LOCK.UPDATE });
  const rows = await PlatformSetting.findAll({ transaction });
  return new Map(rows.map((r) => [r.key, r]));
}

/** Type, bounds and cross-key checks for a set of {key, to} against the given definitions. */
function validateChanges(defs, changes) {
  for (const c of changes) {
    const def = defs.get(c.key);
    if (!def) throw new AppError(422, 'SETTING_UNKNOWN', 'Unknown setting', { errors: [{ field: c.key, message: `No setting called ${c.key}` }] });
    validateValue(def.get({ plain: true }), c.to);
  }
  const next = new Map(changes.map((c) => [c.key, c.to]));
  assertCrossRules((key) => (next.has(key) ? next.get(key) : defs.get(key)?.value), changes.map((c) => c.key));
}

function scheduleApply(request) {
  // Tests drive the job processor directly; the minutely sweep is the backstop everywhere.
  if (config.isTest) return;
  const { getQueue, QUEUES } = require('../../jobs/queues');
  const delay = Math.max(0, new Date(request.effectiveAt).getTime() - Date.now());
  getQueue(QUEUES.SETTINGS)
    .add(APPLY_JOB, { requestId: request.id }, { jobId: `apply-${request.id}`, delay, removeOnComplete: 100, removeOnFail: 500 })
    .catch((err) => logger.warn({ err: err.message, requestId: request.id }, 'could not queue scheduled settings apply; the sweep will apply it'));
}

/**
 * Apply an approved (or auto-approved) request inside `transaction`. Re-validates against the
 * locked current values, so a change approved yesterday cannot break a rule today.
 */
async function applyInTx(request, transaction, { actor = null, req } = {}) {
  const keys = request.changes.map((c) => c.key);
  const defs = await loadDefinitions(transaction, keys);
  validateChanges(defs, request.changes);

  const now = new Date();
  for (const c of request.changes) {
    const row = defs.get(c.key);
    const previous = row.version;
    const version = previous + 1;
    const oldValue = row.value;
    await SettingsHistory.create(
      {
        key: c.key,
        version,
        oldValue,
        newValue: c.to,
        effectiveAt: now,
        requestId: request.id,
        changedBy: request.proposedBy,
        approvedBy: request.approvedBy,
        reason: request.reason,
      },
      { transaction }
    );
    await row.update({ value: c.to, version, updatedBy: request.approvedBy ?? request.proposedBy }, { transaction });
    await audit.record(
      {
        action: 'setting.changed',
        actor: actor ?? { id: null, role: 'system' },
        entityType: 'platform_setting',
        entityId: c.key,
        before: { value: oldValue, version: previous },
        after: { value: c.to, version },
        meta: { severity: 'critical', stepUp: Boolean(actor), requestId: request.id, proposedBy: request.proposedBy, approvedBy: request.approvedBy },
        req,
      },
      { transaction }
    );
    await events.publish(transaction, {
      name: 'setting.changed',
      aggregateType: 'platform_setting',
      aggregateId: c.key,
      payload: { key: c.key, version, oldValue, newValue: c.to, effectiveAt: now.toISOString(), requestId: request.id },
      actor,
    });
  }
  await request.update({ status: 'applied', appliedAt: now }, { transaction });

  // Edge case §12: approving one request supersedes other open requests for the same keys.
  const others = await SettingsChangeRequest.findAll({ where: { status: OPEN, id: { [Op.ne]: request.id } }, transaction, lock: transaction.LOCK.UPDATE });
  for (const other of others.filter((o) => o.changes.some((c) => keys.includes(c.key)))) {
    await other.update({ status: 'superseded', decidedAt: now, decisionNote: `Superseded by request ${request.id}` }, { transaction });
    await audit.record({ action: 'setting.change_superseded', actor: actor ?? { id: null, role: 'system' }, entityType: 'settings_change_request', entityId: other.id, meta: { by: request.id } }, { transaction });
  }

}

/**
 * After the apply transaction commits: reload this process before answering (so the caller
 * reads its own write), then tell every other process to reload.
 */
async function afterApply(request) {
  if (request.status !== 'applied') return;
  try {
    await settings.load();
  } catch (err) {
    logger.warn({ err }, 'settings reload after apply failed; the TTL refresh will catch up');
  }
  await settings.publishBust(request.changes.map((c) => c.key));
}

async function withNames(request) {
  const ids = [request.proposedBy, request.approvedBy, request.decidedBy].filter(Boolean);
  const users = ids.length ? await User.findAll({ where: { id: ids }, attributes: ['id', 'displayName'] }) : [];
  return serializeRequest(request, new Map(users.map((u) => [u.id, u.displayName])));
}

/** POST /admin/settings/change-requests */
async function create(actor, { changes, effectiveAt, reason, source = 'fees_screen', projection }, req) {
  const when = effectiveAt ? new Date(effectiveAt) : new Date();
  // Allow a little clock skew between the browser and the server; anything older is a mistake.
  if (when.getTime() < Date.now() - 60 * 1000) throw E.badRequest('EFFECTIVE_AT_PAST', 'Pick a time from now on');

  const request = await sequelize.transaction(async (transaction) => {
    const defs = await loadDefinitions(transaction);
    validateChanges(defs, changes);
    const unchanged = changes.filter((c) => sameValue(defs.get(c.key).value, c.to));
    if (unchanged.length) {
      throw new AppError(422, 'SETTING_UNCHANGED', 'Nothing to change', { errors: unchanged.map((c) => ({ field: c.key, message: 'Same as the current value' })) });
    }
    const needsFourEyes = changes.some((c) => defs.get(c.key).approval === 'four_eyes');
    const row = await SettingsChangeRequest.create(
      {
        status: 'proposed',
        source,
        changes: changes.map((c) => ({ key: c.key, from: defs.get(c.key).value, to: c.to })),
        projection: projection ?? null,
        reason,
        effectiveAt: when,
        needsFourEyes,
        proposedBy: actor.id,
      },
      { transaction }
    );
    await audit.record(
      { action: 'setting.change_proposed', actor, entityType: 'settings_change_request', entityId: row.id, after: { changes: row.changes, effectiveAt: when }, meta: { stepUp: true, needsFourEyes, source }, req },
      { transaction }
    );
    await events.publish(transaction, {
      name: 'setting.change_proposed',
      aggregateType: 'settings_change_request',
      aggregateId: row.id,
      payload: { requestId: row.id, keys: changes.map((c) => c.key), proposedBy: actor.id, source, needsFourEyes },
      actor,
    });

    if (!needsFourEyes) {
      if (when.getTime() <= Date.now()) {
        await applyInTx(row, transaction, { actor, req });
      } else {
        await row.update({ status: 'approved', decidedAt: new Date() }, { transaction });
        transaction.afterCommit(() => scheduleApply(row));
      }
    }
    return row;
  });
  await afterApply(request);
  return withNames(request);
}

/** POST /admin/settings/change-requests/:id/approve (four-eyes, M03-FR-12). */
async function approve(actor, id, { note } = {}, req) {
  const request = await sequelize.transaction(async (transaction) => {
    const row = await lockRequest(id, transaction);
    if (row.status !== 'proposed') throw closed(row.status);
    if (row.proposedBy === actor.id) throw E.forbidden('FOUR_EYES_REQUIRED', 'Another master must approve this change');
    const now = new Date();
    await row.update({ approvedBy: actor.id, decidedBy: actor.id, decidedAt: now, decisionNote: note ?? null }, { transaction });
    await audit.record({ action: 'setting.change_approved', actor, entityType: 'settings_change_request', entityId: row.id, meta: { stepUp: true }, req }, { transaction });
    if (new Date(row.effectiveAt).getTime() <= now.getTime()) {
      await applyInTx(row, transaction, { actor, req });
    } else {
      // Fail early: a change that already breaks a rule should not wait to fail at its time.
      validateChanges(await loadDefinitions(transaction), row.changes);
      await row.update({ status: 'approved' }, { transaction });
      transaction.afterCommit(() => scheduleApply(row));
    }
    return row;
  });
  await afterApply(request);
  return withNames(request);
}

/** POST /admin/settings/change-requests/:id/reject */
async function reject(actor, id, { note }, req) {
  const request = await sequelize.transaction(async (transaction) => {
    const row = await lockRequest(id, transaction);
    if (row.status !== 'proposed') throw closed(row.status);
    if (row.proposedBy === actor.id) throw E.forbidden('FOUR_EYES_REQUIRED', 'Withdraw your own proposal instead of rejecting it');
    await row.update({ status: 'rejected', decidedBy: actor.id, decidedAt: new Date(), decisionNote: note }, { transaction });
    await audit.record({ action: 'setting.change_rejected', actor, entityType: 'settings_change_request', entityId: row.id, meta: { stepUp: true, note }, req }, { transaction });
    await events.publish(transaction, { name: 'setting.change_rejected', aggregateType: 'settings_change_request', aggregateId: row.id, payload: { requestId: row.id }, actor });
    return row;
  });
  return withNames(request);
}

/** POST /admin/settings/change-requests/:id/withdraw (proposer only, before it takes effect). */
async function withdraw(actor, id, { note } = {}, req) {
  const request = await sequelize.transaction(async (transaction) => {
    const row = await lockRequest(id, transaction);
    if (!OPEN.includes(row.status)) throw closed(row.status);
    if (row.proposedBy !== actor.id) throw E.forbidden('NOT_PROPOSER', 'Only the master who proposed this change can withdraw it');
    await row.update({ status: 'withdrawn', decidedBy: actor.id, decidedAt: new Date(), decisionNote: note ?? null }, { transaction });
    await audit.record({ action: 'setting.change_withdrawn', actor, entityType: 'settings_change_request', entityId: row.id, meta: { stepUp: true }, req }, { transaction });
    await events.publish(transaction, { name: 'setting.change_withdrawn', aggregateType: 'settings_change_request', aggregateId: row.id, payload: { requestId: row.id }, actor });
    return row;
  });
  return withNames(request);
}

/**
 * Job `settings.apply-scheduled`: apply one request (delayed job) or every due request (sweep).
 * Idempotent: only `approved` rows whose time has come are applied, under a row lock. A request
 * that now breaks a rule is rejected with a note instead of retried forever.
 */
async function applyDue({ requestId } = {}) {
  const where = { status: 'approved', effectiveAt: { [Op.lte]: sequelize.literal('clock_timestamp()') } };
  if (requestId) where.id = requestId;
  const due = await SettingsChangeRequest.findAll({ where, attributes: ['id'], order: [['effectiveAt', 'ASC']] });
  let applied = 0;
  let failed = 0;
  for (const { id } of due) {
    try {
      const done = await sequelize.transaction(async (transaction) => {
        const row = await lockRequest(id, transaction);
        if (row.status !== 'approved' || new Date(row.effectiveAt).getTime() > Date.now()) return null;
        await applyInTx(row, transaction);
        return row;
      });
      if (done) {
        await afterApply(done);
        applied += 1;
      }
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      failed += 1;
      await sequelize.transaction(async (transaction) => {
        const row = await lockRequest(id, transaction);
        if (row.status !== 'approved') return;
        const note = `Could not apply: ${err.detail || err.title}`;
        await row.update({ status: 'rejected', decidedAt: new Date(), decisionNote: note }, { transaction });
        await audit.record({ action: 'setting.change_rejected', actor: { id: null, role: 'system' }, entityType: 'settings_change_request', entityId: id, meta: { code: err.code, note } }, { transaction });
        await events.publish(transaction, { name: 'setting.change_rejected', aggregateType: 'settings_change_request', aggregateId: id, payload: { requestId: id, code: err.code } });
      });
    }
  }
  return { applied, failed };
}

async function list({ status, limit = 50 } = {}) {
  const rows = await SettingsChangeRequest.findAll({ where: status ? { status } : {}, order: [['createdAt', 'DESC']], limit });
  const ids = [...new Set(rows.flatMap((r) => [r.proposedBy, r.approvedBy, r.decidedBy]).filter(Boolean))];
  const users = ids.length ? await User.findAll({ where: { id: ids }, attributes: ['id', 'displayName'] }) : [];
  const names = new Map(users.map((u) => [u.id, u.displayName]));
  return { items: rows.map((r) => serializeRequest(r, names)) };
}

async function getOne(id) {
  const row = await SettingsChangeRequest.findByPk(id);
  if (!row) throw E.notFound('Change request');
  return withNames(row);
}

module.exports = { create, approve, reject, withdraw, applyDue, list, getOne, sameValue, APPLY_JOB };
