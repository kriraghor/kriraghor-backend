'use strict';

/**
 * M18 actions (§5.2, FR-06 to FR-11). A person takes every action, with a reason (Q101); each one runs
 * in one transaction with the owning module's call and writes an append-only risk_actions row, an
 * audit row and risk.action_taken:
 *   freeze_payouts     M07 payee hold risk_freeze (items keep accruing; payouts wait)      master, step-up risk.manage
 *   request_documents  M02 document request due in risk.doc_request_days                  staff (manage_users)
 *   clear              the flag closes, snoozed for risk.clear_snooze_days                 staff
 *   suspend            M01 suspension (source risk); staff up to risk.staff_suspend_max_days staff / master
 *   ban                M01 ban (source risk)                                              master, step-up user.ban
 * Undo (FR-09) is a new row with the compensating action: unfreeze (lift the hold), cancel the request,
 * reopen the flag, restore the account. An action is undone at most once; undo rows are final.
 */
const { AppError, E } = require('../../common/errors');
const { uuid7 } = require('../../common/uuid7');
const { sequelize, RiskAction, RiskFlag } = require('../../models');
const settings = require('../settings').settings;
const audit = require('../audit').audit;
const events = require('../events').events;
const authz = require('../auth').authz;
const flags = require('./flags.service');
const rules = require('./risk.rules');

const DAY = 24 * 3600 * 1000;
const ERRORS = {
  PERMISSION_REQUIRED: [403, 'You do not have permission to do this'],
  MASTER_REQUIRED: [403, 'Only a master admin can do this'],
  SUSPENSION_TOO_LONG: [422, 'Staff can suspend for a limited number of days; a master can do more'],
  ALREADY_FROZEN: [409, 'Payouts to this account are already frozen'],
  FLAG_STATE: [409, 'The flag cannot do that in its current state'],
  FLAG_REQUIRED: [422, 'Choose the flag this action is about'],
  ACTION_NOT_REVERSIBLE: [409, 'This action cannot be undone'],
  ACTION_ALREADY_REVERSED: [409, 'This action was already undone'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

const holds = () => require('../payouts').holds;
const requests = () => require('../kyc').requests;
const users = () => require('../admin').adminUsers;

const roleOf = (actor) => (actor.isMaster ? 'master' : 'staff');
const iso = (d) => (d ? new Date(d).toISOString() : null);

async function record(actor, row, { transaction, req, flag }) {
  const a = await RiskAction.create({ ...row, actorId: actor?.id ?? null, actorRole: actor ? roleOf(actor) : 'system' }, { transaction });
  await audit.record(
    { action: 'risk.action_taken', actor, entityType: 'user', entityId: row.userId, after: { action: row.action, flagId: row.flagId ?? null, reverses: row.reversesActionId ?? null }, reason: row.reason, stepUp: Boolean(req?.stepUp), req },
    { transaction }
  );
  await events.publish(transaction, { name: 'risk.action_taken', aggregateType: 'risk_action', aggregateId: a.id, payload: { actionId: a.id, userId: row.userId, action: row.action, flagId: row.flagId ?? null, reversesActionId: row.reversesActionId ?? null }, actor });
  if (flag) await flags.publish(transaction, 'risk.flag_updated', flag, { status: flag.status });
  return a;
}

async function lockFlag(userId, flagId, transaction) {
  if (!flagId) return null;
  const f = await RiskFlag.findByPk(flagId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!f || f.userId !== userId) throw E.notFound('Flag');
  return f;
}

async function moveFlag(f, action, transaction) {
  if (!f) return;
  const to = rules.flagAfter(action, f.status);
  if (!to) throw fail('FLAG_STATE', { status: f.status });
  if (to === 'cleared') {
    await f.update({ status: to, clearedValue: f.metricValue, snoozeUntil: new Date(Date.now() + settings.get('risk.clear_snooze_days') * DAY), closedAt: new Date() }, { transaction });
  } else {
    await f.update({ status: to, ...(to === 'open' ? { snoozeUntil: null, closedAt: null, firstSeenAt: new Date() } : {}) }, { transaction });
  }
}

const actorFacts = (actor) => ({ id: actor.id, isMaster: actor.isMaster, canManageUsers: authz.hasPermission(actor, 'manage_users') });

/** POST /admin/risk/accounts/:userId/actions { action, flagId?, reason, params? } (step-up checked by the route). */
async function take(actor, userId, { action, flagId = null, reason, params = {} }, req) {
  const block = rules.actionBlock({ action, actor: actorFacts(actor), days: params.days ?? null, staffSuspendMaxDays: settings.get('risk.staff_suspend_max_days') });
  if (block) throw fail(block, block === 'SUSPENSION_TOO_LONG' ? { maxDays: settings.get('risk.staff_suspend_max_days') } : undefined);
  if (action === 'clear' && !flagId) throw fail('FLAG_REQUIRED');
  return sequelize.transaction(async (transaction) => {
    const flag = await lockFlag(userId, flagId, transaction);
    const id = uuid7();
    const row = { id, userId, flagId, action, reason, params };
    if (action === 'freeze_payouts') {
      const active = (await holds().activeFor(userId, { transaction })).filter((h) => h.type === 'risk_freeze');
      if (active.length) throw fail('ALREADY_FROZEN');
      const { hold } = await holds().place({ payeeId: userId, scope: 'payee', type: 'risk_freeze', refId: id, reason: 'risk_review' }, actor, { transaction });
      row.payoutHoldId = hold.id;
    } else if (action === 'request_documents') {
      const r = await requests().createInTx({ userId, docType: params.docType ?? 'nid', reason, source: 'risk', sourceRef: flagId, dueDays: settings.get('risk.doc_request_days') }, actor, { transaction });
      row.documentRequestId = r.id;
    } else if (action === 'suspend') {
      const until = params.days ? new Date(Date.now() + params.days * DAY).toISOString() : null;
      const s = await users().suspendInTx(actor, userId, { reasonCode: 'risk_flag', note: reason, until, source: 'risk' }, { transaction, req });
      row.sanctionId = s.sanctionId;
    } else if (action === 'ban') {
      const s = await users().banInTx(actor, userId, { reasonCode: 'risk_flag', note: reason, source: 'risk' }, { transaction, req });
      row.sanctionId = s.sanctionId;
    }
    await moveFlag(flag, action, transaction);
    if (action === 'clear') await flags.publish(transaction, 'risk.flag_cleared', flag, { lapsed: false });
    const a = await record(actor, row, { transaction, req, flag: action === 'clear' ? null : flag });
    return view(a);
  });
}

/** POST /admin/risk/actions/:id/undo { reason } (FR-09): the compensating action, once. */
async function undo(actor, actionId, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const a = await RiskAction.findByPk(actionId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!a) throw E.notFound('Action');
    const reversed = Boolean(await RiskAction.findOne({ where: { reversesActionId: a.id }, transaction }));
    const ub = rules.undoBlock({ action: a.action, reversed });
    if (ub) throw fail(ub);
    const undoAction = rules.undoOf(a.action);
    const block = rules.actionBlock({ action: undoAction, actor: actorFacts(actor), staffSuspendMaxDays: settings.get('risk.staff_suspend_max_days'), restoringBan: a.action === 'ban' });
    if (block) throw fail(block);
    const flag = await lockFlag(a.userId, a.flagId, transaction);
    const row = { userId: a.userId, flagId: a.flagId, action: undoAction, reason, reversesActionId: a.id };
    if (a.action === 'freeze_payouts') {
      await holds().lift(a.payoutHoldId, { reason: 'risk_unfrozen' }, actor, { transaction });
      row.payoutHoldId = a.payoutHoldId;
    } else if (a.action === 'request_documents') {
      await requests().cancelInTx(a.documentRequestId, { reason }, actor, { transaction });
      row.documentRequestId = a.documentRequestId;
    } else if (a.action === 'suspend' || a.action === 'ban') {
      await users().restoreInTx(actor, a.userId, { note: reason }, { transaction, req, allowBan: actor.isMaster });
    }
    if (flag && a.action === 'clear') await moveFlag(flag, 'reopen', transaction);
    // The flag goes back to open when the action undone was the only one still in force (§8.1).
    if (flag && a.action !== 'clear' && flag.status === 'actioned' && (await flags.activeActionsOn(flag.id, { transaction, except: a.id })) === 0) {
      await flag.update({ status: 'open', firstSeenAt: new Date() }, { transaction });
    }
    const out = await record(actor, row, { transaction, req, flag });
    return view(out);
  });
}

function view(a) {
  return { id: a.id, userId: a.userId, flagId: a.flagId ?? null, action: a.action, reason: a.reason, actorRole: a.actorRole, actorId: a.actorId ?? null, reversesActionId: a.reversesActionId ?? null, params: a.params ?? null, createdAt: iso(a.createdAt) };
}

/** The account's actions, newest first, with whether each was undone. */
async function forUser(userId) {
  const rows = await RiskAction.findAll({ where: { userId }, order: [['createdAt', 'DESC']], limit: 200 });
  const undone = new Set(rows.filter((r) => r.reversesActionId).map((r) => r.reversesActionId));
  return rows.map((r) => ({ ...view(r), undone: undone.has(r.id), undoable: !rules.undoBlock({ action: r.action, reversed: undone.has(r.id) }) }));
}

module.exports = { take, undo, forUser, view, ERRORS };
