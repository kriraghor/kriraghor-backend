'use strict';

/**
 * M22 contracts (FR-01, FR-02, FR-13, §8). Signed offline; staff with manage_organisers enter them:
 *
 *   draft ─activate (org verified, signed PDF, step-up)─▶ active ─suspend─▶ suspended ─reinstate─▶ active
 *   draft | active | suspended ─end─▶ ended          (ends_on passed: the tick ends it)
 *
 * One active contract per organisation (partial unique index). A percentage contract charges
 * fees.esports_saas_pct (or its own pct) per tournament at finalise; a flat contract is invoiced each
 * month or quarter (invoices.service). Suspending blocks new submits; running tournaments finish.
 */
const crypto = require('crypto');
const { UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const storage = require('../../common/storage');
const { sniffMime } = require('../../common/filetype');
const { sequelize, Organisation, OrganiserContract } = require('../../models');
const audit = require('../audit/audit.service');
const rules = require('./saas.rules');
const c = require('./saas.common');

const { fail } = c;
const MAX_PDF = 10 * 1024 * 1024;

function view(k) {
  return {
    id: k.id,
    organisationId: k.organisationId,
    model: k.model,
    pct: k.pct ?? null,
    flatFee: k.flatFeePoisha ?? null,
    billingCycle: k.billingCycle,
    startsOn: k.startsOn,
    endsOn: k.endsOn ?? null,
    status: k.status,
    hasSignedDocument: Boolean(k.signedDocumentKey),
    notes: k.notes ?? null,
    activatedAt: c.iso(k.activatedAt),
    suspendedAt: c.iso(k.suspendedAt),
    suspendReason: k.suspendReason ?? null,
    endedAt: c.iso(k.endedAt),
    endReason: k.endReason ?? null,
    effectivePct: k.model === 'percentage' ? (k.pct ?? c.config().feePct) : null,
  };
}

function checkFields(b) {
  const ok = b.model === 'percentage' ? b.flatFee == null && (b.pct == null || (b.pct >= 0 && b.pct <= 100)) : b.flatFee > 0 && b.pct == null && b.billingCycle !== 'per_tournament';
  if (!ok || (b.endsOn && b.endsOn < b.startsOn)) throw fail('CONTRACT_FIELDS_INVALID');
}

/** The organisation's active contract (or null). */
async function activeFor(organisationId, { transaction } = {}) {
  return OrganiserContract.findOne({ where: { organisationId, status: 'active' }, transaction });
}

/** The contract that governs submits today: active, or the suspended one (to say why). */
async function currentFor(organisationId, { transaction } = {}) {
  return (await activeFor(organisationId, { transaction })) ?? OrganiserContract.findOne({ where: { organisationId, status: 'suspended' }, order: [['updatedAt', 'DESC']], transaction });
}

async function listFor(organisationId) {
  const rows = await OrganiserContract.findAll({ where: { organisationId }, order: [['createdAt', 'DESC']] });
  return { items: rows.map(view) };
}

/** POST /admin/organisers/:orgId/contracts (manage_organisers): a draft. */
async function create(actor, organisationId, body, req) {
  checkFields(body);
  return sequelize.transaction(async (transaction) => {
    const o = await Organisation.findByPk(organisationId, { transaction });
    if (!o) throw E.notFound('Organisation');
    const k = await OrganiserContract.create(
      { organisationId, model: body.model, pct: body.pct ?? null, flatFeePoisha: body.flatFee ?? null, billingCycle: body.billingCycle, startsOn: body.startsOn, endsOn: body.endsOn ?? null, notes: body.notes ?? null, status: 'draft', createdBy: actor.id, updatedBy: actor.id },
      { transaction }
    );
    await audit.record({ action: 'organiser_contract.created', actor, entityType: 'organiser_contract', entityId: k.id, after: { organisationId, model: k.model, pct: k.pct, flatFee: k.flatFeePoisha, cycle: k.billingCycle }, req }, { transaction });
    return view(k);
  });
}

async function lock(id, transaction) {
  const k = await OrganiserContract.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!k) throw E.notFound('Contract');
  return k;
}

/** PATCH /admin/organiser-contracts/:id: a draft's terms (an active contract is replaced, not edited). */
async function update(actor, id, body, req) {
  return sequelize.transaction(async (transaction) => {
    const k = await lock(id, transaction);
    if (k.status !== 'draft') throw fail('CONTRACT_STATE');
    const next = { model: body.model ?? k.model, pct: body.pct !== undefined ? body.pct : k.pct, flatFee: body.flatFee !== undefined ? body.flatFee : k.flatFeePoisha, billingCycle: body.billingCycle ?? k.billingCycle, startsOn: body.startsOn ?? k.startsOn, endsOn: body.endsOn !== undefined ? body.endsOn : k.endsOn };
    checkFields(next);
    await k.update({ model: next.model, pct: next.pct, flatFeePoisha: next.flatFee, billingCycle: next.billingCycle, startsOn: next.startsOn, endsOn: next.endsOn, notes: body.notes !== undefined ? body.notes : k.notes, updatedBy: actor.id }, { transaction });
    await audit.record({ action: 'organiser_contract.updated', actor, entityType: 'organiser_contract', entityId: k.id, after: next, req }, { transaction });
    return view(k);
  });
}

/** POST /admin/organiser-contracts/:id/document (raw PDF): the signed contract, private bucket. */
async function attachDocument(actor, id, { contentType, body }, req) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!buf.length) throw fail('FILE_EMPTY');
  if (buf.length > MAX_PDF) throw fail('FILE_TOO_LARGE');
  if (declared !== 'application/pdf') throw fail('FILE_TYPE_NOT_ALLOWED');
  if (sniffMime(buf) !== 'application/pdf') throw fail('FILE_TYPE_MISMATCH');
  return sequelize.transaction(async (transaction) => {
    const k = await lock(id, transaction);
    if (k.status === 'ended') throw fail('CONTRACT_STATE');
    const key = `contracts/${k.organisationId}/${k.id}-${crypto.randomBytes(6).toString('hex')}.pdf`;
    await storage.putPrivate(key, buf, 'application/pdf');
    await k.update({ signedDocumentKey: key, updatedBy: actor.id }, { transaction });
    await audit.record({ action: 'organiser_contract.document_attached', actor, entityType: 'organiser_contract', entityId: k.id, meta: { sizeBytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }, req }, { transaction });
    return view(k);
  });
}

/** POST /admin/organiser-contracts/:id/activate (step-up esports.money). A flat contract is invoiced at once. */
async function activate(actor, id, req) {
  return sequelize.transaction(async (transaction) => {
    const k = await lock(id, transaction);
    if (!rules.canContract(k.status, 'active')) throw fail('CONTRACT_STATE');
    const o = await Organisation.findByPk(k.organisationId, { transaction });
    if (o.status !== 'verified') throw fail('ORG_NOT_VERIFIED');
    if (!k.signedDocumentKey) throw fail('CONTRACT_DOCUMENT_REQUIRED');
    const from = k.status;
    try {
      await sequelize.transaction({ transaction }, (sp) => k.update({ status: 'active', activatedAt: k.activatedAt ?? new Date(), suspendedAt: null, suspendReason: null, updatedBy: actor.id }, { transaction: sp }));
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw fail('CONTRACT_ACTIVE_EXISTS');
      throw err;
    }
    await audit.record({ action: from === 'draft' ? 'organiser_contract.activated' : 'organiser_contract.reinstated', actor, entityType: 'organiser_contract', entityId: k.id, after: { status: 'active' }, req }, { transaction });
    await c.publish(transaction, 'organiser_contract.activated', 'organiser_contract', k.id, { contractId: k.id, organisationId: k.organisationId, model: k.model, reinstated: from === 'suspended' }, actor);
    if (from === 'draft') await require('./invoices.service').issueDueInTx(k, { actor, transaction });
    return view(k);
  });
}

/** POST /admin/organiser-contracts/:id/suspend | end (step-up esports.money), with a reason. */
async function stop(actor, id, to, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const k = await lock(id, transaction);
    if (!rules.canContract(k.status, to)) throw fail('CONTRACT_STATE');
    await endInTx(k, to, reason, { actor, transaction });
    await audit.record({ action: `organiser_contract.${to}`, actor, entityType: 'organiser_contract', entityId: k.id, after: { status: to }, reason, req }, { transaction });
    return view(k);
  });
}

async function endInTx(k, to, reason, { actor = null, transaction }) {
  const now = new Date();
  await k.update(to === 'suspended' ? { status: 'suspended', suspendedAt: now, suspendReason: reason } : { status: 'ended', endedAt: now, endReason: reason }, { transaction });
  await c.publish(transaction, `organiser_contract.${to}`, 'organiser_contract', k.id, { contractId: k.id, organisationId: k.organisationId, reason }, actor);
}

/** Tick: contracts past ends_on end; the expiry reminder goes saas.contract_expiry_notice_days before. */
async function sweep(now = new Date()) {
  const day = c.today(now);
  const { noticeDays } = c.config();
  const out = { ended: 0, notified: 0 };
  const rows = await OrganiserContract.findAll({ where: { status: ['active', 'suspended'] }, attributes: ['id', 'endsOn', 'expiryNotifiedAt', 'status'] });
  for (const r of rows) {
    if (rules.expired(r, day)) {
      await sequelize.transaction(async (transaction) => {
        const k = await lock(r.id, transaction);
        if (!['active', 'suspended'].includes(k.status) || !rules.expired(k, day)) return;
        await endInTx(k, 'ended', 'ends_on', { transaction });
        out.ended += 1;
      });
    } else if (r.status === 'active' && rules.noticeDue(r, day, noticeDays)) {
      await sequelize.transaction(async (transaction) => {
        const k = await lock(r.id, transaction);
        if (k.expiryNotifiedAt) return;
        await k.update({ expiryNotifiedAt: now }, { transaction });
        await c.publish(transaction, 'organiser_contract.expiry_notified', 'organiser_contract', k.id, { contractId: k.id, organisationId: k.organisationId, endsOn: k.endsOn });
        out.notified += 1;
      });
    }
  }
  return out;
}

module.exports = { view, activeFor, currentFor, listFor, create, update, attachDocument, activate, stop, sweep };
