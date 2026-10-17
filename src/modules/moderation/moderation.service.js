'use strict';

/**
 * M05 moderation lite: SubmissionService and the review desk (§5, §8).
 *
 *   submit ─▶ pending_review ─claim─▶ (held by one reviewer, TTL + heartbeat, hard cap)
 *          ─approve (all ticks, no hard fail or master override)─▶ approved ─▶ subject applies ─▶ submission.applied
 *          ─request changes / reject (reason)─▶ changes_requested | rejected
 *          ─newer version─▶ superseded         ─owner or system─▶ withdrawn
 *   approved | rejected ─master reopen─▶ pending_review
 *
 * Subject modules call submit() inside their own transaction and apply decisions in their consumers.
 * Staff only see kinds their permission allows; a forbidden kind is a 404 (FR-17).
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const { sequelize, Submission, SubmissionCheck, ReviewClaim, ReviewRubric, RejectionReason } = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const settings = require('../settings/settings.service');
const directory = require('../users/directory.service');
const adapters = require('./moderation.adapters');
const rules = require('./moderation.rules');

const ERRORS = {
  INVALID_STATE: [409, 'This submission cannot do that in its current state'],
  SELF_REVIEW_FORBIDDEN: [403, 'You cannot review your own submission'],
  CLAIM_REQUIRED: [403, 'Claim this item before deciding'],
  CLAIM_EXPIRED: [409, 'Your review lock expired; claim it again'],
  RUBRIC_INCOMPLETE: [422, 'Tick every review check before approving'],
  CHECK_FAILED: [422, 'A blocking automatic check failed'],
  CHECK_LOCKED: [422, 'This check cannot be overridden'],
  MASTER_REQUIRED: [403, 'Only a master admin can approve over a failing check'],
  REASON_REQUIRED: [422, 'Choose a reason (and explain when the reason is "Other")'],
  REASON_NOT_ALLOWED_FOR_KIND: [422, 'That reason does not apply to this kind of item'],
  WITHDRAW_NOT_ALLOWED: [409, 'This item is withdrawn from its own page'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

const DHAKA_MS = 6 * 3600000;
const startOfDhakaDay = (now) => new Date(Math.floor((now.getTime() + DHAKA_MS) / 86400000) * 86400000 - DHAKA_MS);

const eventBase = (s) => ({ submissionId: s.id, kind: s.kind, subjectId: s.subjectId, version: s.version, submittedBy: s.submittedBy });

async function activeClaim(submissionId, { transaction, lock = false } = {}) {
  return ReviewClaim.findOne({ where: { submissionId, releasedAt: null }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
}

async function releaseClaim(claim, reason, { transaction, now = new Date() }) {
  if (!claim || claim.releasedAt) return;
  await claim.update({ releasedAt: now, releasedReason: reason }, { transaction });
}

async function runChecks(submission, { transaction }) {
  const results = await adapters.get(submission.kind).checks(submission, { transaction });
  const last = await SubmissionCheck.max('runNo', { where: { submissionId: submission.id }, transaction });
  const runNo = (last ?? 0) + 1;
  await SubmissionCheck.bulkCreate(results.map((c) => ({ submissionId: submission.id, runNo, key: c.key, severity: c.severity, result: c.result, detail: c.detail ?? null })), { transaction });
  return results;
}

async function latestChecks(submissionId, transaction) {
  const last = await SubmissionCheck.max('runNo', { where: { submissionId }, transaction });
  if (!last) return [];
  const rows = await SubmissionCheck.findAll({ where: { submissionId, runNo: last }, order: [['key', 'ASC']], transaction });
  return rows.map((c) => ({ key: c.key, severity: c.severity, result: c.result, detail: c.detail ?? null }));
}

// ---------------------------------------------------------------- SubmissionService (§2.4, FR-01 to FR-03, FR-05)

/**
 * Create the next version of a subject's submission inside the caller's transaction. An open earlier
 * version is superseded (its claim released, the reviewer told). Returns the submission.
 */
async function submit({ kind, subjectId, payload, title, submittedBy, isEdit = false, mode = 'pre' }, { transaction }) {
  adapters.get(kind);
  const now = new Date();
  const prior = await Submission.findAll({ where: { kind, subjectId }, order: [['version', 'DESC']], transaction, lock: transaction.LOCK.UPDATE });
  for (const open of prior.filter((p) => rules.OPEN.includes(p.status))) {
    const claim = await activeClaim(open.id, { transaction, lock: true });
    await releaseClaim(claim, 'superseded', { transaction, now });
    await open.update({ status: 'superseded' }, { transaction });
    await events.publish(transaction, {
      name: 'submission.withdrawn',
      aggregateType: 'submission',
      aggregateId: open.id,
      payload: { ...eventBase(open), byOwner: false, superseded: true, claimedBy: claim?.staffId ?? null },
    });
  }
  const rubric = await ReviewRubric.findOne({ where: { kind, isActive: true }, transaction });
  const submission = await Submission.create(
    {
      kind,
      subjectId,
      version: (prior[0]?.version ?? 0) + 1,
      previousSubmissionId: prior[0]?.id ?? null,
      isEdit,
      mode,
      payload,
      title: title.slice(0, 200),
      submittedBy,
      submittedAt: now,
      slaDueAt: rules.slaDue(now, settings.get('moderation.review_sla_hours')),
      rubricId: rubric?.id ?? null,
    },
    { transaction }
  );
  await runChecks(submission, { transaction });
  await events.publish(transaction, {
    name: 'submission.created',
    aggregateType: 'submission',
    aggregateId: submission.id,
    payload: { ...eventBase(submission), isEdit, mode, slaDueAt: submission.slaDueAt.toISOString() },
  });
  return submission;
}

/** Latest submission of a subject (for the subject module's own views). */
const latestFor = (kind, subjectId, { transaction } = {}) => Submission.findOne({ where: { kind, subjectId }, order: [['version', 'DESC']], transaction });

/** Read one submission (consumers read the payload here, never from the table). */
const getById = (id, { transaction } = {}) => Submission.findByPk(id, { transaction });

async function withdrawInTx(s, { byOwner, actor, transaction }) {
  const claim = await activeClaim(s.id, { transaction, lock: true });
  await releaseClaim(claim, 'withdrawn', { transaction });
  const before = { status: s.status };
  await s.update({ status: 'withdrawn' }, { transaction });
  await audit.record({ action: 'submission.withdrawn', actor, entityType: 'submission', entityId: s.id, before, after: { status: 'withdrawn' }, meta: { byOwner } }, { transaction });
  await events.publish(transaction, {
    name: 'submission.withdrawn',
    aggregateType: 'submission',
    aggregateId: s.id,
    payload: { ...eventBase(s), byOwner, superseded: false, claimedBy: claim?.staffId ?? null },
  });
}

/** POST /me/submissions/:id/withdraw (FR-14). */
async function withdrawByOwner(principal, id) {
  return sequelize.transaction(async (transaction) => {
    const s = await Submission.findOne({ where: { id, submittedBy: principal.user.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!s) throw E.notFound('Submission');
    if (!adapters.get(s.kind).ownerWithdraw) throw fail('WITHDRAW_NOT_ALLOWED');
    if (!rules.OPEN.includes(s.status)) throw fail('INVALID_STATE');
    await withdrawInTx(s, { byOwner: true, actor: principal, transaction });
    return serializeOwn(s);
  });
}

/** The subject module withdraws its subject's open submission (for example an unlinked M21 UID). */
async function withdrawSubject(kind, subjectId, { transaction }) {
  const open = await Submission.findAll({ where: { kind, subjectId, status: rules.OPEN }, transaction, lock: transaction.LOCK.UPDATE });
  for (const s of open) await withdrawInTx(s, { byOwner: false, actor: null, transaction });
  return open.length;
}

/** user.suspended / user.banned: open submissions of that user are withdrawn (edge case 6). */
async function withdrawAllOf(userId, { transaction }) {
  const open = await Submission.findAll({ where: { submittedBy: userId, status: rules.OPEN }, transaction, lock: transaction.LOCK.UPDATE });
  for (const s of open) await withdrawInTx(s, { byOwner: false, actor: null, transaction });
  return open.length;
}

const serializeOwn = (s) => ({
  id: s.id,
  kind: s.kind,
  subjectId: s.subjectId,
  version: s.version,
  title: s.title,
  status: s.status,
  reasonCode: s.reasonCode ?? null,
  reasonText: s.reasonText ?? null,
  submittedAt: s.submittedAt,
  decidedAt: s.decidedAt ?? null,
  appliedAt: s.appliedAt ?? null,
});

/** GET /me/submissions */
async function listMine(userId, { kind, status } = {}) {
  const rows = await Submission.findAll({ where: { submittedBy: userId, ...(kind ? { kind } : {}), ...(status ? { status } : {}) }, order: [['submittedAt', 'DESC']], limit: 100 });
  return { items: rows.map(serializeOwn) };
}

// ---------------------------------------------------------------- the desk (FR-07 to FR-12, FR-21)

/** Load a submission a staff member may see; forbidden kinds look absent (404, FR-17). */
async function loadPermitted(principal, id, { transaction, lock = false } = {}) {
  const s = await Submission.findByPk(id, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!s || !adapters.permittedKinds(principal).includes(s.kind)) throw E.notFound('Submission');
  return s;
}

async function names(ids, transaction) {
  const map = await directory.contactFor(ids, { transaction });
  return (id) => (id ? map.get(id)?.displayName ?? null : null);
}

function serializeRow(s, claim, nameOf, viewerId, now) {
  const mine = Boolean(claim && claim.staffId === viewerId);
  return {
    id: s.id,
    kind: s.kind,
    subjectId: s.subjectId,
    version: s.version,
    isEdit: s.isEdit,
    title: s.title,
    status: s.status,
    submittedBy: { id: s.submittedBy, name: nameOf(s.submittedBy) },
    submittedAt: s.submittedAt,
    slaDueAt: s.slaDueAt,
    sla: s.status === 'pending_review' ? rules.slaState(s.slaDueAt, now, settings.get('moderation.review_sla_warn_hours')) : null,
    claim: claim && rules.claimActive(claim, now) ? { staffId: claim.staffId, name: nameOf(claim.staffId), mine, expiresAt: claim.expiresAt, hardExpiresAt: claim.hardExpiresAt } : null,
    reasonCode: s.reasonCode ?? null,
    decidedAt: s.decidedAt ?? null,
    decidedBy: s.decidedBy ? { id: s.decidedBy, name: nameOf(s.decidedBy) } : null,
  };
}

/** GET /admin/submissions?status&kind&claimed&overdue&q (the oldest 100 waiting, or the latest 100 decided). */
async function list(principal, { status = 'pending_review', kind, claimed, overdue, q, limit = 100 } = {}) {
  const kinds = adapters.permittedKinds(principal).filter((k) => !kind || k === kind);
  const now = new Date();
  const where = {
    status,
    kind: kinds,
    ...(overdue ? { slaDueAt: { [Op.lt]: now } } : {}),
    ...(q ? { title: { [Op.iLike]: `%${q}%` } } : {}),
  };
  const order = status === 'pending_review' ? [['slaDueAt', 'ASC'], ['id', 'ASC']] : [['decidedAt', 'DESC'], ['id', 'DESC']];
  let rows = await Submission.findAll({ where, order, limit: 500 });
  const claims = await ReviewClaim.findAll({ where: { submissionId: rows.map((r) => r.id), releasedAt: null } });
  const claimOf = new Map(claims.filter((c) => rules.claimActive(c, now)).map((c) => [c.submissionId, c]));
  if (claimed === 'me') rows = rows.filter((r) => claimOf.get(r.id)?.staffId === principal.id);
  if (claimed === 'others') rows = rows.filter((r) => claimOf.has(r.id) && claimOf.get(r.id).staffId !== principal.id);
  if (claimed === 'none') rows = rows.filter((r) => !claimOf.has(r.id));
  const page = rows.slice(0, limit);
  const nameOf = await names([...page.map((r) => r.submittedBy), ...page.map((r) => r.decidedBy), ...claims.map((c) => c.staffId)]);
  return { items: page.map((s) => serializeRow(s, claimOf.get(s.id), nameOf, principal.id, now)) };
}

/** GET /admin/submissions/stats: the queue KPIs over the kinds the viewer may see. */
async function stats(principal) {
  const kinds = adapters.permittedKinds(principal);
  const now = new Date();
  const [queue, overdue, decidedToday] = await Promise.all([
    Submission.count({ where: { status: 'pending_review', kind: kinds } }),
    Submission.count({ where: { status: 'pending_review', kind: kinds, slaDueAt: { [Op.lt]: now } } }),
    Submission.count({ where: { kind: kinds, decidedAt: { [Op.gte]: startOfDhakaDay(now) } } }),
  ]);
  const mine = await ReviewClaim.findAll({ where: { staffId: principal.id, releasedAt: null } });
  return { inQueue: queue, overdue, claimedByYou: mine.filter((c) => rules.claimActive(c, now)).length, decidedToday };
}

async function detailInTx(principal, s, transaction) {
  const now = new Date();
  const claim = await activeClaim(s.id, { transaction });
  const rubric = s.rubricId ? await ReviewRubric.findByPk(s.rubricId, { transaction }) : null;
  const history = await Submission.findAll({ where: { kind: s.kind, subjectId: s.subjectId }, order: [['version', 'DESC']], transaction });
  const reasons = await RejectionReason.findAll({ where: { isActive: true }, order: [['sort', 'ASC']], transaction });
  const nameOf = await names([s.submittedBy, s.decidedBy, claim?.staffId, s.checkOverrideBy, ...history.map((h) => h.decidedBy)], transaction);
  const mine = claim && claim.staffId === principal.id && rules.claimActive(claim, now);
  return {
    ...serializeRow(s, claim, nameOf, principal.id, now),
    payload: s.payload,
    reasonText: s.reasonText ?? null,
    checks: await latestChecks(s.id, transaction),
    rubric: rubric ? { id: rubric.id, version: rubric.version, items: rubric.items } : null,
    ticks: mine ? claim.ticks : [],
    rubricResult: s.rubricResult ?? null,
    override: s.checkOverrideBy ? { by: nameOf(s.checkOverrideBy), reason: s.checkOverrideReason } : null,
    appliedAt: s.appliedAt ?? null,
    reasons: reasons.filter((r) => r.kinds.includes(s.kind)).map((r) => ({ code: r.code, labelEn: r.labelEn, labelBn: r.labelBn, requiresText: r.requiresText })),
    history: history.map((h) => ({ id: h.id, version: h.version, status: h.status, reasonCode: h.reasonCode ?? null, decidedBy: nameOf(h.decidedBy), decidedAt: h.decidedAt ?? null, submittedAt: h.submittedAt })),
  };
}

/** GET /admin/submissions/:id */
const detail = async (principal, id) => detailInTx(principal, await loadPermitted(principal, id));

/** POST /admin/submissions/:id/claim: one active claim per submission; checks re-run (FR-05, FR-07). */
async function claim(principal, id, req) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const s = await loadPermitted(principal, id, { transaction, lock: true });
      if (s.status !== 'pending_review') throw fail('INVALID_STATE');
      if (s.submittedBy === principal.id) throw fail('SELF_REVIEW_FORBIDDEN');
      const now = new Date();
      const current = await activeClaim(s.id, { transaction, lock: true });
      if (current && rules.claimActive(current, now)) {
        if (current.staffId === principal.id) return detailInTx(principal, s, transaction);
        const holder = (await directory.contactFor([current.staffId], { transaction })).get(current.staffId);
        throw new AppError(409, 'ALREADY_CLAIMED', `${holder?.displayName ?? 'Someone'} is reviewing this item`, { meta: { holder: { id: current.staffId, name: holder?.displayName ?? null }, expiresAt: current.expiresAt } });
      }
      await releaseClaim(current, 'ttl', { transaction, now });
      const window = rules.claimWindow(now, settings.get('moderation.claim_ttl_min'), settings.get('moderation.claim_max_min'));
      await ReviewClaim.create({ submissionId: s.id, staffId: principal.id, claimedAt: now, ...window, ticks: [] }, { transaction });
      await runChecks(s, { transaction });
      await audit.record({ action: 'submission.claimed', actor: principal, entityType: 'submission', entityId: s.id, meta: { kind: s.kind }, req }, { transaction });
      return detailInTx(principal, s, transaction);
    });
  } catch (err) {
    // A concurrent claim won the partial unique index.
    if (err instanceof UniqueConstraintError) throw new AppError(409, 'ALREADY_CLAIMED', 'Someone else just claimed this item');
    throw err;
  }
}

async function ownClaim(principal, id, transaction) {
  const s = await loadPermitted(principal, id, { transaction, lock: true });
  const c = await activeClaim(s.id, { transaction, lock: true });
  if (!c || c.staffId !== principal.id) throw fail('CLAIM_REQUIRED');
  if (!rules.claimActive(c, new Date())) throw fail('CLAIM_EXPIRED');
  return { s, c };
}

/** POST /admin/submissions/:id/heartbeat: extend the lock (capped). */
async function heartbeat(principal, id) {
  return sequelize.transaction(async (transaction) => {
    const { c } = await ownClaim(principal, id, transaction);
    await c.update({ expiresAt: rules.heartbeatExpiry(c, new Date(), settings.get('moderation.claim_ttl_min')) }, { transaction });
    return { expiresAt: c.expiresAt, hardExpiresAt: c.hardExpiresAt };
  });
}

/** PUT /admin/submissions/:id/ticks: rubric ticks live on the claim (FR-09). */
async function setTicks(principal, id, ticks) {
  return sequelize.transaction(async (transaction) => {
    const { s, c } = await ownClaim(principal, id, transaction);
    const rubric = s.rubricId ? await ReviewRubric.findByPk(s.rubricId, { transaction }) : null;
    await c.update({ ticks: rules.cleanTicks(rubric?.items ?? [], ticks) }, { transaction });
    return { ticks: c.ticks, missing: rules.missingTicks(rubric?.items ?? [], c.ticks) };
  });
}

/** POST /admin/submissions/:id/release: the holder, or a master with force (audited). */
async function release(principal, id, { force = false }, req) {
  return sequelize.transaction(async (transaction) => {
    const s = await loadPermitted(principal, id, { transaction, lock: true });
    const c = await activeClaim(s.id, { transaction, lock: true });
    if (!c) return { released: false };
    if (c.staffId !== principal.id) {
      if (!force || !principal.isMaster) throw fail('CLAIM_REQUIRED');
      await releaseClaim(c, 'force', { transaction });
      await audit.record({ action: 'submission.released_forced', actor: principal, entityType: 'submission', entityId: s.id, meta: { holder: c.staffId }, req }, { transaction });
      return { released: true };
    }
    await releaseClaim(c, 'manual', { transaction });
    return { released: true };
  });
}

const EVENT_FOR = { approved: 'submission.approved', changes_requested: 'submission.changes_requested', rejected: 'submission.rejected' };

/** POST /admin/submissions/:id/decide (FR-10 to FR-12; Q46 override for masters with step-up). */
async function decide(principal, id, { decision, reasonCode, reasonText, override }, req) {
  return sequelize.transaction(async (transaction) => {
    const s = await loadPermitted(principal, id, { transaction, lock: true });
    const c = await activeClaim(s.id, { transaction, lock: true });
    const rubric = s.rubricId ? await ReviewRubric.findByPk(s.rubricId, { transaction }) : null;
    const checks = await latestChecks(s.id, transaction);
    const reason = reasonCode ? await RejectionReason.findOne({ where: { code: reasonCode, isActive: true }, transaction }) : null;
    const block = rules.decisionBlock({
      submission: s,
      claim: c,
      now: new Date(),
      actorId: principal.id,
      isMaster: principal.isMaster,
      decision,
      rubricItems: rubric?.items ?? [],
      checks,
      locked: adapters.get(s.kind).lockedChecks,
      reason,
      reasonText,
      override: override?.trim() || null,
    });
    if (block) throw fail(block.code, block.missing ? { missing: block.missing } : block.failing ? { failing: block.failing } : undefined);
    const status = rules.DECISION_STATUS[decision];
    const overridden = decision === 'approve' && rules.hardFailures(checks).length > 0;
    await s.update(
      {
        status,
        decidedBy: principal.id,
        decidedAt: new Date(),
        rubricResult: decision === 'approve' ? c.ticks.map((k) => ({ itemKey: k, ticked: true })) : null,
        reasonCode: decision === 'approve' ? null : reasonCode,
        reasonText: decision === 'approve' ? null : reasonText?.trim() || null,
        checkOverrideBy: overridden ? principal.id : null,
        checkOverrideReason: overridden ? override.trim() : null,
      },
      { transaction }
    );
    await releaseClaim(c, 'decided', { transaction });
    await audit.record(
      { action: 'submission.decided', actor: principal, entityType: 'submission', entityId: s.id, before: { status: 'pending_review' }, after: { status, reasonCode: s.reasonCode }, meta: { kind: s.kind, rubric: s.rubricResult }, req },
      { transaction }
    );
    if (overridden) {
      await audit.record(
        { action: 'submission.check_overridden', actor: principal, entityType: 'submission', entityId: s.id, reason: override.trim(), meta: { failing: rules.hardFailures(checks) }, req },
        { transaction }
      );
    }
    await events.publish(transaction, {
      name: EVENT_FOR[status],
      aggregateType: 'submission',
      aggregateId: s.id,
      payload: { ...eventBase(s), decidedBy: principal.id, ...(decision === 'approve' ? { overridden } : { reasonCode }) },
      actor: principal,
      req,
    });
    return detailInTx(principal, s, transaction);
  });
}

/** POST /admin/submissions/:id/reopen (master + step-up, FR-21): a decided submission back in the queue. */
async function reopen(principal, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const s = await loadPermitted(principal, id, { transaction, lock: true });
    if (!rules.canTransition(s.status, 'pending_review')) throw fail('INVALID_STATE');
    const before = { status: s.status };
    const now = new Date();
    await s.update(
      { status: 'pending_review', slaDueAt: rules.slaDue(now, settings.get('moderation.review_sla_hours')), breachNotifiedAt: null, decidedBy: null, decidedAt: null, reasonCode: null, reasonText: null, rubricResult: null, checkOverrideBy: null, checkOverrideReason: null, appliedAt: null, applyAttempts: 0 },
      { transaction }
    );
    await audit.record({ action: 'submission.reopened', actor: principal, entityType: 'submission', entityId: s.id, before, after: { status: 'pending_review' }, reason, req }, { transaction });
    await events.publish(transaction, { name: 'submission.created', aggregateType: 'submission', aggregateId: s.id, payload: { ...eventBase(s), isEdit: s.isEdit, mode: s.mode, slaDueAt: s.slaDueAt.toISOString() } });
    return detailInTx(principal, s, transaction);
  });
}

// ---------------------------------------------------------------- acknowledgement and jobs (FR-13, FR-18, §10)

/** submission.applied (from the subject module): the decision is live. Idempotent. */
async function markApplied(submissionId, { transaction }) {
  const s = await Submission.findByPk(submissionId, { transaction, lock: transaction.LOCK.UPDATE });
  if (s && !s.appliedAt) await s.update({ appliedAt: new Date() }, { transaction });
}

/** Job moderation.claim-expire (every minute): release locks past their TTL or hard cap. */
async function expireClaims(now = new Date()) {
  const due = await ReviewClaim.findAll({ where: { releasedAt: null, [Op.or]: [{ expiresAt: { [Op.lte]: now } }, { hardExpiresAt: { [Op.lte]: now } }] } });
  for (const c of due) await c.update({ releasedAt: now, releasedReason: 'ttl' });
  return { released: due.length };
}

/** Job moderation.sla-breach (hourly at :05 Dhaka): each overdue item is reported once. */
async function reportBreaches(now = new Date()) {
  const due = await Submission.findAll({ where: { status: 'pending_review', slaDueAt: { [Op.lt]: now }, breachNotifiedAt: null } });
  for (const s of due) {
    await sequelize.transaction(async (transaction) => {
      const claim = await activeClaim(s.id, { transaction });
      await s.update({ breachNotifiedAt: now }, { transaction });
      await events.publish(transaction, {
        name: 'submission.sla_breached',
        aggregateType: 'submission',
        aggregateId: s.id,
        payload: { ...eventBase(s), overdueMinutes: Math.floor((now - s.slaDueAt) / 60000), claimedBy: claim?.staffId ?? null },
      });
    });
  }
  return { breached: due.length };
}

/**
 * Job moderation.apply-watchdog (every minute, FR-13): an approval the subject module has not applied
 * after moderation.apply_timeout_minutes is published again, up to moderation.apply_max_attempts;
 * then submission.apply_failed (once).
 */
async function watchApplies(now = new Date()) {
  const timeoutMs = settings.get('moderation.apply_timeout_minutes') * 60000;
  const max = settings.get('moderation.apply_max_attempts');
  const waiting = await Submission.findAll({ where: { status: 'approved', appliedAt: null, applyAttempts: { [Op.lte]: max } } });
  let resent = 0;
  let failed = 0;
  for (const s of waiting) {
    const since = s.applyAttempts === 0 ? s.decidedAt : s.updatedAt;
    if (now - since < timeoutMs) continue;
    await sequelize.transaction(async (transaction) => {
      if (s.applyAttempts < max) {
        await s.update({ applyAttempts: s.applyAttempts + 1 }, { transaction });
        await events.publish(transaction, { name: 'submission.approved', aggregateType: 'submission', aggregateId: s.id, payload: { ...eventBase(s), decidedBy: s.decidedBy, overridden: Boolean(s.checkOverrideBy) } });
        resent += 1;
      } else {
        await s.update({ applyAttempts: s.applyAttempts + 1 }, { transaction });
        await events.publish(transaction, { name: 'submission.apply_failed', aggregateType: 'submission', aggregateId: s.id, payload: { ...eventBase(s), attempts: s.applyAttempts - 1 } });
        failed += 1;
      }
    });
  }
  return { resent, failed };
}

module.exports = {
  submit,
  latestFor,
  getById,
  withdrawByOwner,
  withdrawAllOf,
  withdrawSubject,
  listMine,
  list,
  stats,
  detail,
  claim,
  heartbeat,
  setTicks,
  release,
  decide,
  reopen,
  markApplied,
  expireClaims,
  reportBreaches,
  watchApplies,
};
