'use strict';

/**
 * M17 disputes (§5, §8.1, FR-01 to FR-14).
 *
 *   open (payer, verified phone) ─▶ awaiting_response ─respond / respondent window ends─▶ under_review
 *   (no respondent: esports) ──────────────────────────────────────────────────────────▶ under_review
 *   under_review ─staff (claimed; refunds within the limit with refund_small)─▶ resolved
 *                ─escalate (with a recommendation)─▶ escalated ─master + step-up─▶ resolved
 *                                                              ─send back─▶ under_review
 *   any active state ─claimant withdraws─▶ withdrawn
 *
 * The source module answers through the targets port: opening snapshots what is paid and held and the
 * policy line, and freezes the source's escrow hold in the same transaction; the decision carries out
 * the money (refund from escrow, release the rest) in the decision transaction, so a case is never
 * resolved without its money moving, and money never moves twice (keys `dispute:{id}`).
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { nextCode } = require('../../common/sequences');
const { sequelize, Dispute, DisputeEvidence } = require('../../models');
const settings = require('../settings').settings;
const audit = require('../audit').audit;
const events = require('../events').events;
const authz = require('../auth').authz;
const targets = require('./targets.port');
const evidence = require('./evidence.service');
const { fail } = require('./trust.errors');
const rules = require('./trust.rules');

const iso = (d) => (d ? new Date(d).toISOString() : null);
const HOUR = 3600 * 1000;

// ---------------------------------------------------------------- helpers

const payload = (d, extra = {}) => ({ disputeId: d.id, code: d.code, sourceType: d.sourceType, sourceId: d.sourceId, category: d.category, claimantId: d.claimantId, respondentId: d.respondentId ?? null, ...extra });
const publish = (transaction, name, d, extra, actor = null) => events.publish(transaction, { name, aggregateType: 'dispute', aggregateId: d.id, payload: payload(d, extra), actor });

const partyOf = (d, userId) => (d.claimantId === userId ? 'claimant' : d.respondentId && d.respondentId === userId ? 'respondent' : null);

async function lockByCode(code, transaction) {
  const d = await Dispute.findOne({ where: { code }, transaction, lock: transaction.LOCK.UPDATE });
  if (!d) throw E.notFound('Dispute');
  return d;
}

/** A party's case, locked; anyone else gets a 404 (never confirm a case exists). */
async function lockAsParty(principal, code, transaction) {
  const d = await Dispute.findOne({ where: { code }, transaction, lock: transaction.LOCK.UPDATE });
  if (!d || !partyOf(d, principal.id)) throw fail('NOT_A_PARTY');
  return d;
}

const move = (d, action) => {
  const to = rules.next(action, d.status);
  if (!to) throw fail('DISPUTE_STATE', { status: d.status });
  return to;
};

const reviews = () => require('./reviews.service');

/** The staff view of a case is limited to sources the actor's permissions cover (else 404). */
function assertDesk(actor, d) {
  if (!actor.isMaster && !authz.hasPermission(actor, targets.get(d.sourceType).permission)) throw E.notFound('Dispute');
}

const zeroPlan = { refund: 0, release: 0, feeBase: 0, fee: 0, net: 0 };

function planFor(d, outcome, custom) {
  if (!rules.allowedOutcomes(d).includes(outcome)) throw fail('OUTCOME_NOT_ALLOWED', { allowed: rules.allowedOutcomes(d) });
  if (!d.money) return zeroPlan;
  try {
    return rules.outcomePlan({ outcome, held: d.heldPoisha, custom, feeBps: d.policy.feeBps, fullPrice: d.policy.fullPrice ?? null, feeBaseMax: d.policy.feeBaseMax ?? null });
  } catch (err) {
    if (err instanceof RangeError) throw fail('REFUND_INVALID', { held: d.heldPoisha });
    throw err;
  }
}

/** What each outcome would move (the desk shows these next to the buttons). */
function previews(d) {
  const out = {};
  for (const o of rules.allowedOutcomes(d)) if (o !== 'custom') out[o] = planFor(d, o, null);
  return out;
}

// ---------------------------------------------------------------- views

function evidenceView(e, { staff }) {
  return {
    id: e.id,
    party: e.party,
    kind: e.kind,
    text: e.hiddenReason && !staff ? null : (e.text ?? null),
    file: e.kind === 'file' && (!e.hiddenReason || staff) ? { mime: e.mime, sizeBytes: e.sizeBytes } : null,
    systemRef: e.systemRef ?? null,
    hidden: Boolean(e.hiddenReason),
    hiddenReason: staff ? (e.hiddenReason ?? null) : null,
    mine: false,
    createdAt: iso(e.createdAt),
  };
}

function caseView(d) {
  return {
    code: d.code,
    sourceType: d.sourceType,
    sourceId: d.sourceId,
    sourceRef: d.sourceRef,
    category: d.category,
    status: d.status,
    money: d.money,
    paid: d.paidPoisha,
    held: d.heldPoisha,
    policyKey: d.policyKey,
    policy: d.policy,
    outcome: d.outcome ?? null,
    refund: d.refundPoisha,
    released: d.releasedPoisha,
    fee: d.feePoisha,
    decisionReason: d.decisionReason ?? null,
    respondentDueAt: iso(d.respondentDueAt),
    respondedAt: iso(d.respondedAt),
    resolvedAt: iso(d.resolvedAt),
    withdrawnAt: iso(d.withdrawnAt),
    createdAt: iso(d.createdAt),
    version: d.version,
  };
}

async function partyView(d, principal) {
  const party = partyOf(d, principal.id);
  const rows = await DisputeEvidence.findAll({ where: { disputeId: d.id, party: { [Op.ne]: 'staff' } }, order: [['createdAt', 'ASC']] });
  const active = rules.isActive(d.status);
  const files = rows.filter((e) => e.party === party && e.kind === 'file').length;
  return {
    dispute: caseView(d),
    role: party,
    source: await targets.get(d.sourceType).describe(d.sourceId),
    evidence: rows.map((e) => ({ ...evidenceView(e, { staff: false }), mine: e.authorId === principal.id })),
    can: {
      respond: party === 'respondent' && d.status === 'awaiting_response',
      addEvidence: active && Boolean(party),
      filesLeft: Math.max(0, settings.get('disputes.evidence_max_files') - files),
      withdraw: party === 'claimant' && active,
    },
  };
}

// ---------------------------------------------------------------- open (FR-01 to FR-04)

/** Create a case inside the caller's transaction (sources call this directly: M21 result disputes). */
async function openFromSource(input, { actor, transaction }) {
  const now = new Date();
  const hasRespondent = Boolean(input.respondentId);
  const d = await Dispute.create(
    {
      code: await nextCode('DSP', transaction),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceRef: input.ref,
      category: input.category,
      claimantId: input.claimantId,
      respondentId: input.respondentId ?? null,
      status: rules.initialStatus({ hasRespondent }),
      money: input.money,
      paidPoisha: input.paid ?? 0,
      heldPoisha: input.held ?? 0,
      policyKey: input.policyKey,
      policy: input.policy,
      respondentDueAt: hasRespondent ? rules.after(now, settings.get('disputes.respondent_hours')) : null,
      slaDueAt: hasRespondent ? null : rules.after(now, settings.get('disputes.staff_sla_hours')),
      idempotencyKey: input.idempotencyKey ?? null,
    },
    { transaction }
  );
  await DisputeEvidence.create({ disputeId: d.id, party: 'claimant', kind: 'statement', authorId: input.claimantId, text: input.statement }, { transaction });
  await DisputeEvidence.create({ disputeId: d.id, party: 'system', kind: 'system', systemRef: { type: 'snapshot', policyKey: input.policyKey, paid: d.paidPoisha, held: d.heldPoisha, refs: input.systemRefs ?? [] } }, { transaction });
  if (input.money) await targets.get(d.sourceType).freeze({ sourceId: d.sourceId, ref: d.id, actor, transaction });
  await reviews().holdForSource(d.sourceType, d.sourceId, { transaction });
  await publish(transaction, 'dispute.opened', d, { money: d.money, held: d.heldPoisha }, actor);
  await audit.record({ action: 'dispute.opened', actor, entityType: 'dispute', entityId: d.id, entityCode: d.code, after: { status: d.status, category: d.category, held: d.heldPoisha } }, { transaction });
  return d;
}

/** POST /disputes { sourceType, sourceId, category, statement } (gate file_dispute, Idempotency-Key). */
async function open(principal, { sourceType, sourceId, category, statement }, idempotencyKey, req) {
  const again = () => Dispute.findOne({ where: { claimantId: principal.id, idempotencyKey } });
  const existing = await again();
  if (existing) return partyView(existing, principal);
  try {
    const d = await sequelize.transaction(async (transaction) => {
      const openCount = await Dispute.count({ where: { claimantId: principal.id, status: rules.ACTIVE }, transaction });
      const block = rules.openBlock({ openCount, max: settings.get('disputes.max_open_per_user') });
      if (block) throw fail(block);
      const target = targets.get(sourceType);
      const snap = await target.snapshot({ sourceId, category, principal, transaction });
      if (await Dispute.count({ where: { sourceType, sourceId, status: rules.ACTIVE }, transaction })) throw fail('DISPUTE_ALREADY_OPEN');
      void req;
      return openFromSource({ sourceType, sourceId, category, statement, idempotencyKey, ...snap }, { actor: principal, transaction });
    });
    return partyView(d, principal);
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const row = await again();
      if (row) return partyView(row, principal);
      throw fail('DISPUTE_ALREADY_OPEN');
    }
    throw err;
  }
}

/** GET /me/disputes/options?sourceType&sourceId: what the member can open now. */
async function options(principal, { sourceType, sourceId }) {
  const active = await Dispute.findOne({ where: { sourceType, sourceId, status: rules.ACTIVE } });
  const latest = await Dispute.findOne({ where: { sourceType, sourceId }, order: [['createdAt', 'DESC']] });
  const mine = latest && partyOf(latest, principal.id) ? latest.code : null;
  return { items: active ? [] : await targets.get(sourceType).options({ sourceId, principal }), dispute: mine };
}

// ---------------------------------------------------------------- the parties (FR-05 to FR-08)

/** GET /me/disputes?role=claimant|respondent&status=active|closed&sourceId */
async function listMine(principal, { role = 'claimant', status, sourceId, cursor, limit = 20 }) {
  const where = { [role === 'respondent' ? 'respondentId' : 'claimantId']: principal.id };
  if (status === 'active') where.status = rules.ACTIVE;
  if (status === 'closed') where.status = ['resolved', 'withdrawn'];
  if (sourceId) where.sourceId = sourceId;
  if (cursor) where.createdAt = { [Op.lt]: new Date(cursor) };
  const rows = await Dispute.findAll({ where, order: [['createdAt', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  return { items: page.map(caseView), nextCursor: rows.length > limit ? iso(page[page.length - 1].createdAt) : null };
}

async function getMine(principal, code) {
  const d = await Dispute.findOne({ where: { code } });
  if (!d || !partyOf(d, principal.id)) throw fail('NOT_A_PARTY');
  return partyView(d, principal);
}

/** POST /me/disputes/:code/statement { text } */
async function addStatement(principal, code, { text }, req) {
  return sequelize.transaction(async (transaction) => {
    const d = await lockAsParty(principal, code, transaction);
    if (!rules.isActive(d.status)) throw fail('DISPUTE_STATE', { status: d.status });
    const party = partyOf(d, principal.id);
    const n = await DisputeEvidence.count({ where: { disputeId: d.id, party, kind: 'statement' }, transaction });
    if (n >= settings.get('disputes.evidence_max_files')) throw fail('EVIDENCE_LIMIT');
    await DisputeEvidence.create({ disputeId: d.id, party, kind: 'statement', authorId: principal.id, text }, { transaction });
    await d.update({ version: d.version + 1 }, { transaction });
    await audit.record({ action: 'dispute.statement_added', actor: principal, entityType: 'dispute', entityId: d.id, entityCode: d.code, meta: { party }, req }, { transaction });
    return partyView(d, principal);
  });
}

/** POST /me/disputes/:code/evidence (raw body) */
async function addFile(principal, code, { body }, req) {
  return sequelize.transaction(async (transaction) => {
    const d = await lockAsParty(principal, code, transaction);
    if (!rules.isActive(d.status)) throw fail('DISPUTE_STATE', { status: d.status });
    const party = partyOf(d, principal.id);
    const e = await evidence.store(d, party, principal, { body }, { transaction });
    await d.update({ version: d.version + 1 }, { transaction });
    await audit.record({ action: 'dispute.evidence_added', actor: principal, entityType: 'dispute', entityId: d.id, entityCode: d.code, meta: { party, evidenceId: e.id, mime: e.mime }, req }, { transaction });
    return { evidence: { ...evidenceView(e, { staff: false }), mine: true } };
  });
}

/** POST /me/disputes/:code/respond { text } (the respondent's side, FR-06). */
async function respond(principal, code, { text }, req) {
  return sequelize.transaction(async (transaction) => {
    const d = await lockAsParty(principal, code, transaction);
    if (partyOf(d, principal.id) !== 'respondent') throw fail('NOT_A_PARTY');
    const to = move(d, 'respond');
    const now = new Date();
    await DisputeEvidence.create({ disputeId: d.id, party: 'respondent', kind: 'statement', authorId: principal.id, text }, { transaction });
    await d.update({ status: to, respondedAt: now, slaDueAt: rules.after(now, settings.get('disputes.staff_sla_hours')), version: d.version + 1 }, { transaction });
    await publish(transaction, 'dispute.response_submitted', d, {}, principal);
    await audit.record({ action: 'dispute.response_submitted', actor: principal, entityType: 'dispute', entityId: d.id, entityCode: d.code, after: { status: to }, req }, { transaction });
    return partyView(d, principal);
  });
}

/** POST /me/disputes/:code/withdraw { reason? }: the hold is unfrozen; the source settles as usual. */
async function withdraw(principal, code, { reason = null } = {}, req) {
  return sequelize.transaction(async (transaction) => {
    const d = await lockAsParty(principal, code, transaction);
    if (partyOf(d, principal.id) !== 'claimant') throw fail('NOT_A_PARTY');
    const to = move(d, 'withdraw');
    const target = targets.get(d.sourceType);
    if (d.money) await target.unfreeze({ sourceId: d.sourceId, actor: principal, transaction });
    if (target.withdrawn) await target.withdrawn({ sourceId: d.sourceId, actor: principal, transaction });
    await d.update({ status: to, withdrawnAt: new Date(), claimedBy: null, claimExpiresAt: null, version: d.version + 1 }, { transaction });
    if (reason) await DisputeEvidence.create({ disputeId: d.id, party: 'claimant', kind: 'statement', authorId: principal.id, text: reason }, { transaction });
    await reviews().releaseForSource(d.sourceType, d.sourceId, { transaction });
    await publish(transaction, 'dispute.withdrawn', d, {}, principal);
    await audit.record({ action: 'dispute.withdrawn', actor: principal, entityType: 'dispute', entityId: d.id, entityCode: d.code, after: { status: to }, reason, req }, { transaction });
    return partyView(d, principal);
  });
}

/** GET /me/disputes/:code/evidence/:eid/file and /admin/disputes/:code/evidence/:eid/file (audited). */
async function file(viewer, code, evidenceId, { staff }, req) {
  const d = await Dispute.findOne({ where: { code } });
  if (!d) throw E.notFound('Dispute');
  if (staff) assertDesk(viewer, d);
  else if (!partyOf(d, viewer.id)) throw fail('NOT_A_PARTY');
  const e = await DisputeEvidence.findOne({ where: { id: evidenceId, disputeId: d.id, kind: 'file' } });
  if (!e || (!staff && (e.party === 'staff' || e.hiddenReason))) throw E.notFound('Evidence');
  return evidence.read(d, e, viewer, req);
}

// ---------------------------------------------------------------- the staff desk (FR-09 to FR-12)

const QUEUE_ORDER = [
  [sequelize.literal("CASE status WHEN 'escalated' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END"), 'ASC'],
  [sequelize.literal('COALESCE(master_due_at, sla_due_at, respondent_due_at)'), 'ASC'],
  ['createdAt', 'ASC'],
];

/** GET /admin/disputes?status&sourceType&mine: the queue, most urgent first. */
async function adminList(actor, { status = 'active', sourceType, mine = false, code, cursor, limit = 50 }) {
  const visible = targets.visibleTo(actor, authz.hasPermission);
  const where = { sourceType: sourceType ? (visible.includes(sourceType) ? sourceType : []) : visible };
  if (status === 'active') where.status = rules.ACTIVE;
  else if (status !== 'all') where.status = status;
  if (mine) where.claimedBy = actor.id;
  if (code) where.code = code;
  const offset = cursor ? Number(cursor) : 0;
  const rows = await Dispute.findAll({ where, order: QUEUE_ORDER, offset, limit: limit + 1 });
  const now = new Date();
  const page = rows.slice(0, limit);
  return {
    items: page.map((d) => ({
      ...caseView(d),
      dueAt: iso(d.masterDueAt ?? d.slaDueAt ?? d.respondentDueAt),
      overdue: Boolean(rules.slaBreach({ ...d.get(), breachedAt: null, now })),
      claimedBy: rules.claimHeld({ ...d.get(), now }) ? d.claimedBy : null,
      claimedByMe: rules.claimHeld({ ...d.get(), now }) && d.claimedBy === actor.id,
    })),
    nextCursor: rows.length > limit ? String(offset + limit) : null,
  };
}

async function staffView(actor, d) {
  const rows = await DisputeEvidence.findAll({ where: { disputeId: d.id }, order: [['createdAt', 'ASC']] });
  const now = new Date();
  const claimed = rules.claimHeld({ ...d.get(), now });
  const names = await require('../users').directory.publicNames([d.claimantId, d.respondentId, d.claimedBy, d.decidedBy, d.recommendedBy, ...rows.map((e) => e.authorId)]);
  const who = (id) => (id ? { id, displayName: names.get(id)?.displayName ?? null } : null);
  return {
    dispute: {
      ...caseView(d),
      slaDueAt: iso(d.slaDueAt),
      masterDueAt: iso(d.masterDueAt),
      escalatedAt: iso(d.escalatedAt),
      recommendedOutcome: d.recommendedOutcome ?? null,
      recommendedRefund: d.recommendedRefundPoisha,
      escalationNote: d.escalationNote ?? null,
      decidedRole: d.decidedRole ?? null,
    },
    claimant: who(d.claimantId),
    respondent: who(d.respondentId),
    decidedBy: who(d.decidedBy),
    recommendedBy: who(d.recommendedBy),
    claim: claimed ? { by: who(d.claimedBy), expiresAt: iso(d.claimExpiresAt), mine: d.claimedBy === actor.id } : null,
    source: await targets.get(d.sourceType).describe(d.sourceId),
    evidence: rows.map((e) => ({ ...evidenceView(e, { staff: true }), author: who(e.authorId) })),
    outcomes: rules.allowedOutcomes(d),
    previews: previews(d),
    limits: { staffRefundPoisha: settings.get('refunds.staff_limit_poisha'), canRefund: authz.hasPermission(actor, 'refund_small') },
  };
}

async function adminGet(actor, code) {
  const d = await Dispute.findOne({ where: { code } });
  if (!d) throw E.notFound('Dispute');
  assertDesk(actor, d);
  return staffView(actor, d);
}

/** POST /admin/disputes/:code/claim (TTL moderation.claim_ttl_min, like M05). Parties cannot claim their own case. */
async function claim(actor, code, req) {
  return sequelize.transaction(async (transaction) => {
    const d = await lockByCode(code, transaction);
    assertDesk(actor, d);
    if (partyOf(d, actor.id)) throw fail('CONFLICT_OF_INTEREST');
    if (!rules.isActive(d.status)) throw fail('DISPUTE_STATE', { status: d.status });
    const now = new Date();
    const block = rules.claimBlock({ ...d.get(), actorId: actor.id, now });
    if (block) throw fail(block, { claimedBy: d.claimedBy });
    const fresh = d.claimedBy !== actor.id || !rules.claimHeld({ ...d.get(), now });
    await d.update({ claimedBy: actor.id, claimExpiresAt: rules.claimExpiry(now, settings.get('moderation.claim_ttl_min')) }, { transaction });
    if (fresh) await audit.record({ action: 'dispute.claimed', actor, entityType: 'dispute', entityId: d.id, entityCode: d.code, req }, { transaction });
    return staffView(actor, d);
  });
}

/** POST /admin/disputes/:code/heartbeat: keeps the claim. */
async function heartbeat(actor, code) {
  return sequelize.transaction(async (transaction) => {
    const d = await lockByCode(code, transaction);
    assertDesk(actor, d);
    const now = new Date();
    if (d.claimedBy !== actor.id || !rules.claimHeld({ ...d.get(), now })) throw fail('CLAIM_REQUIRED');
    await d.update({ claimExpiresAt: rules.claimExpiry(now, settings.get('moderation.claim_ttl_min')) }, { transaction });
    return { expiresAt: iso(d.claimExpiresAt) };
  });
}

async function releaseClaim(actor, code) {
  return sequelize.transaction(async (transaction) => {
    const d = await lockByCode(code, transaction);
    assertDesk(actor, d);
    if (d.claimedBy === actor.id) await d.update({ claimedBy: null, claimExpiresAt: null }, { transaction });
    return { released: true };
  });
}

/** POST /admin/disputes/:code/notes { text }: staff-only notes (never shown to the parties). */
async function addNote(actor, code, { text }, req) {
  return sequelize.transaction(async (transaction) => {
    const d = await lockByCode(code, transaction);
    assertDesk(actor, d);
    await DisputeEvidence.create({ disputeId: d.id, party: 'staff', kind: 'statement', authorId: actor.id, text }, { transaction });
    await audit.record({ action: 'dispute.note_added', actor, entityType: 'dispute', entityId: d.id, entityCode: d.code, req }, { transaction });
    return staffView(actor, d);
  });
}

/** POST /admin/disputes/:code/evidence/:eid/hide { reason }: hidden from the other party, kept for staff. */
async function hideEvidence(actor, code, evidenceId, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const d = await lockByCode(code, transaction);
    assertDesk(actor, d);
    const e = await DisputeEvidence.findOne({ where: { id: evidenceId, disputeId: d.id }, transaction });
    if (!e) throw E.notFound('Evidence');
    await e.update({ hiddenReason: reason, hiddenBy: actor.id }, { transaction });
    await audit.record({ action: 'dispute.evidence_hidden', actor, entityType: 'dispute', entityId: d.id, entityCode: d.code, reason, meta: { evidenceId }, req }, { transaction });
    return staffView(actor, d);
  });
}

/** The decision, in one transaction with the source's money (FR-11, FR-13). */
async function decideInTx(actor, d, { outcome, refund: custom = null, rows = [], reason, version, asMaster }, { transaction, req }) {
  if (version !== undefined && version !== d.version) throw fail('DISPUTE_VERSION', { version: d.version });
  const plan = planFor(d, outcome, custom);
  const block = rules.decideBlock({ actor: { id: actor.id, isMaster: actor.isMaster, canRefund: authz.hasPermission(actor, 'refund_small') }, dispute: d.get(), refund: plan.refund, staffLimit: settings.get('refunds.staff_limit_poisha'), now: new Date(), asMaster });
  if (block) throw fail(block, block === 'ESCALATION_REQUIRED' ? { limit: settings.get('refunds.staff_limit_poisha') } : undefined);
  if (outcome === 'corrected' && !rows.length) throw fail('CORRECTION_REQUIRED');
  const to = move(d, asMaster ? 'master_decide' : 'decide');
  await d.update({ decisionReason: reason }, { transaction });
  const moved = await targets.get(d.sourceType).applyOutcome({ sourceId: d.sourceId, dispute: d, outcome, plan, rows, actor, transaction });
  await d.update(
    {
      status: to,
      outcome,
      refundPoisha: d.money ? plan.refund : null,
      releasedPoisha: d.money ? plan.release : null,
      feePoisha: d.money ? plan.fee : null,
      decidedBy: actor.id,
      decidedRole: asMaster ? 'master' : 'staff',
      resolvedAt: new Date(),
      claimedBy: null,
      claimExpiresAt: null,
      version: d.version + 1,
    },
    { transaction }
  );
  await DisputeEvidence.create({ disputeId: d.id, party: 'system', kind: 'system', systemRef: { type: 'decision', outcome, refund: plan.refund, released: plan.release, fee: plan.fee } }, { transaction });
  await reviews().releaseForSource(d.sourceType, d.sourceId, { transaction });
  await publish(transaction, 'dispute.resolved', d, { outcome, refund: plan.refund }, actor);
  await audit.record(
    { action: 'dispute.decided', actor, entityType: 'dispute', entityId: d.id, entityCode: d.code, after: { outcome, refund: plan.refund, released: plan.release, fee: plan.fee, role: d.decidedRole }, reason, stepUp: Boolean(req?.stepUp), req },
    { transaction }
  );
  return moved;
}

/** POST /admin/disputes/:code/decide (staff, claimed). */
async function decide(actor, code, body, req) {
  return sequelize.transaction(async (transaction) => {
    const d = await lockByCode(code, transaction);
    assertDesk(actor, d);
    await decideInTx(actor, d, { ...body, asMaster: false }, { transaction, req });
    return staffView(actor, d);
  });
}

/** POST /admin/disputes/:code/master-decide (master + step-up refund.large). */
async function masterDecide(actor, code, body, req) {
  return sequelize.transaction(async (transaction) => {
    const d = await lockByCode(code, transaction);
    await decideInTx(actor, d, { ...body, asMaster: true }, { transaction, req });
    return staffView(actor, d);
  });
}

/** POST /admin/disputes/:code/escalate { outcome?, refund?, note }: to the master inbox with a recommendation. */
async function escalate(actor, code, { outcome = null, refund = null, note, version }, req) {
  return sequelize.transaction(async (transaction) => {
    const d = await lockByCode(code, transaction);
    assertDesk(actor, d);
    if (partyOf(d, actor.id)) throw fail('CONFLICT_OF_INTEREST');
    if (version !== undefined && version !== d.version) throw fail('DISPUTE_VERSION', { version: d.version });
    const to = move(d, 'escalate');
    const plan = outcome ? planFor(d, outcome, refund) : null;
    const now = new Date();
    await d.update(
      { status: to, escalatedAt: now, masterDueAt: rules.after(now, settings.get('disputes.master_sla_hours')), recommendedOutcome: outcome, recommendedRefundPoisha: plan ? plan.refund : null, recommendedBy: actor.id, escalationNote: note, claimedBy: null, claimExpiresAt: null, version: d.version + 1 },
      { transaction }
    );
    await publish(transaction, 'dispute.escalated', d, {}, actor);
    await audit.record({ action: 'dispute.escalated', actor, entityType: 'dispute', entityId: d.id, entityCode: d.code, after: { recommendedOutcome: outcome, recommendedRefund: plan?.refund ?? null }, reason: note, req }, { transaction });
    return staffView(actor, d);
  });
}

/** POST /admin/disputes/:code/send-back { note } (master): back to staff with a fresh SLA. */
async function sendBack(actor, code, { note }, req) {
  return sequelize.transaction(async (transaction) => {
    const d = await lockByCode(code, transaction);
    const to = move(d, 'send_back');
    await d.update({ status: to, masterDueAt: null, slaDueAt: rules.after(new Date(), settings.get('disputes.staff_sla_hours')), escalationNote: note, version: d.version + 1 }, { transaction });
    await DisputeEvidence.create({ disputeId: d.id, party: 'staff', kind: 'statement', authorId: actor.id, text: note }, { transaction });
    await publish(transaction, 'dispute.returned', d, {}, actor);
    await audit.record({ action: 'dispute.returned', actor, entityType: 'dispute', entityId: d.id, entityCode: d.code, reason: note, req }, { transaction });
    return staffView(actor, d);
  });
}

/**
 * The esports desk's resolve (M21 kept route): decide the active case of a source as the actor; a
 * staff member claims it first, a master decides it directly.
 */
async function decideForSource(actor, sourceType, sourceId, { outcome, rows = [], reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const d = await Dispute.findOne({ where: { sourceType, sourceId, status: rules.ACTIVE }, transaction, lock: transaction.LOCK.UPDATE });
    if (!d) throw fail('DISPUTE_STATE');
    assertDesk(actor, d);
    if (!actor.isMaster) {
      const now = new Date();
      const block = rules.claimBlock({ ...d.get(), actorId: actor.id, now });
      if (block) throw fail(block);
      await d.update({ claimedBy: actor.id, claimExpiresAt: rules.claimExpiry(now, settings.get('moderation.claim_ttl_min')) }, { transaction });
    }
    await decideInTx(actor, d, { outcome, rows, reason, asMaster: actor.isMaster }, { transaction, req });
    return caseView(d);
  });
}

// ---------------------------------------------------------------- tick (§10)

/** trust.tick: respondent reminders and timeouts, SLA breaches, expired claims. */
async function tick(now = new Date()) {
  const out = { reminded: 0, timedOut: 0, breached: 0, claimsExpired: 0 };
  const remindHours = settings.get('disputes.respondent_reminder_hours');
  const waiting = await Dispute.findAll({ where: { status: 'awaiting_response', respondentDueAt: { [Op.lte]: new Date(now.getTime() + remindHours * HOUR) } }, attributes: ['id'], limit: 500 });
  for (const { id } of waiting) {
    await sequelize.transaction(async (transaction) => {
      const d = await Dispute.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (rules.respondentTimedOut({ ...d.get(), now })) {
        await d.update({ status: move(d, 'respondent_timeout'), slaDueAt: rules.after(now, settings.get('disputes.staff_sla_hours')), version: d.version + 1 }, { transaction });
        await DisputeEvidence.create({ disputeId: d.id, party: 'system', kind: 'system', systemRef: { type: 'no_response' } }, { transaction });
        await publish(transaction, 'dispute.response_expired', d);
        out.timedOut += 1;
      } else if (rules.reminderDue({ ...d.get(), remindedAt: d.respondentRemindedAt, now, hours: remindHours })) {
        await d.update({ respondentRemindedAt: now }, { transaction });
        await publish(transaction, 'dispute.respondent_reminded', d, { dueAt: iso(d.respondentDueAt) });
        out.reminded += 1;
      }
    });
  }
  const late = await Dispute.findAll({ where: { [Op.or]: [{ status: 'under_review', slaDueAt: { [Op.lte]: now } }, { status: 'escalated', masterDueAt: { [Op.lte]: now } }] }, attributes: ['id'], limit: 500 });
  for (const { id } of late) {
    await sequelize.transaction(async (transaction) => {
      const d = await Dispute.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      const level = rules.slaBreach({ ...d.get(), breachedAt: d.slaBreachedAt, now });
      if (!level) return;
      await d.update({ slaBreachedAt: now }, { transaction });
      await publish(transaction, 'dispute.sla_breached', d, { level });
      out.breached += 1;
    });
  }
  const [n] = await Dispute.update({ claimedBy: null, claimExpiresAt: null }, { where: { claimExpiresAt: { [Op.lte]: now } } });
  out.claimsExpired = n;
  return out;
}

/** Display facts for notifications (M08 reads them here). */
async function facts(disputeId) {
  const d = await Dispute.findByPk(disputeId);
  if (!d) throw E.notFound('Dispute');
  return { code: d.code, ref: d.sourceRef, category: d.category, outcome: d.outcome, refund: d.refundPoisha ?? 0, held: d.heldPoisha, respondentDueAt: d.respondentDueAt, sourceType: d.sourceType };
}

/** M18 dispute_loss_rate and owner reliability: cases decided against this user as the respondent since `since`. */
async function statsFor(userId, since) {
  const rows = await Dispute.findAll({ where: { respondentId: userId, status: 'resolved', resolvedAt: { [Op.gte]: since } }, attributes: ['outcome', 'refundPoisha'] });
  const lost = rows.filter((d) => d.outcome === 'upheld' || (d.refundPoisha ?? 0) > 0).length;
  return { decided: rows.length, lost };
}

/** M18 and the reviews: is a case open about this source? */
const activeFor = async (sourceType, sourceId, { transaction } = {}) => (await Dispute.count({ where: { sourceType, sourceId, status: rules.ACTIVE }, transaction })) > 0;

module.exports = {
  openFromSource,
  open,
  options,
  listMine,
  getMine,
  addStatement,
  addFile,
  respond,
  withdraw,
  file,
  adminList,
  adminGet,
  claim,
  heartbeat,
  releaseClaim,
  addNote,
  hideEvidence,
  decide,
  masterDecide,
  escalate,
  sendBack,
  decideForSource,
  tick,
  facts,
  activeFor,
  statsFor,
  partyOf,
};
