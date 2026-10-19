'use strict';

/**
 * M02 document requests (M18-FR-07). Staff, through the M18 risk desk, ask a member for a document (a
 * fresh NID upload or a business document) by a due date. The member sees it on
 * /account/verification and uploads through the usual flow; their next submission of that type
 * fulfils it. Past the due date the request is overdue, which M18 uses to raise its flag. M02 owns
 * document_requests; other modules call this service.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const { DocumentRequest } = require('../../models');
const events = require('../events').events;
const audit = require('../audit').audit;

const DAY = 24 * 3600 * 1000;
const iso = (d) => (d ? new Date(d).toISOString() : null);
const OPEN = ['open', 'overdue'];

const payload = (r) => ({ requestId: r.id, userId: r.userId, docType: r.docType, sourceRef: r.sourceRef ?? null });
const publish = (transaction, name, r, actor = null) => events.publish(transaction, { name, aggregateType: 'document_request', aggregateId: r.id, payload: { ...payload(r), dueAt: iso(r.dueAt) }, actor });

const view = (r) => ({ id: r.id, docType: r.docType, reason: r.reason, status: r.status, dueAt: iso(r.dueAt), createdAt: iso(r.createdAt), fulfilledAt: iso(r.fulfilledAt) });

/** Ask for a document inside the caller's transaction. One open request per user and type. */
async function createInTx({ userId, docType, reason, source, sourceRef = null, dueDays }, actor, { transaction }) {
  try {
    const r = await DocumentRequest.create({ userId, docType, reason, source, sourceRef, dueAt: new Date(Date.now() + dueDays * DAY), requestedBy: actor?.id ?? null }, { transaction });
    await publish(transaction, 'document_request.created', r, actor);
    await audit.record({ action: 'document_request.created', actor, entityType: 'user', entityId: userId, after: { docType, dueAt: iso(r.dueAt) }, reason }, { transaction });
    return r;
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw new AppError(409, 'DOCUMENT_ALREADY_REQUESTED', 'A request for this document is already open');
    throw err;
  }
}

async function cancelInTx(id, { reason }, actor, { transaction }) {
  const r = await DocumentRequest.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!r) throw E.notFound('Document request');
  if (!OPEN.includes(r.status)) return r;
  await r.update({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: actor?.id ?? null, cancelReason: reason }, { transaction });
  await publish(transaction, 'document_request.cancelled', r, actor);
  return r;
}

/** Consumer of document.submitted: the member's submission of that type fulfils their open request. */
async function fulfilOnSubmit({ userId, docType, documentId }, { transaction }) {
  const rows = await DocumentRequest.findAll({ where: { userId, docType, status: OPEN }, transaction, lock: transaction.LOCK.UPDATE });
  for (const r of rows) {
    await r.update({ status: 'fulfilled', fulfilledAt: new Date(), fulfilledDocumentId: documentId }, { transaction });
    await publish(transaction, 'document_request.fulfilled', r);
  }
  return rows.length;
}

/** Nightly: open requests past their due date become overdue (once). */
async function markOverdue(now = new Date()) {
  const { sequelize } = require('../../models');
  const due = await DocumentRequest.findAll({ where: { status: 'open', dueAt: { [Op.lte]: now } }, attributes: ['id'], limit: 500 });
  for (const { id } of due) {
    await sequelize.transaction(async (transaction) => {
      const r = await DocumentRequest.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (r.status !== 'open') return;
      await r.update({ status: 'overdue', overdueAt: now }, { transaction });
      await publish(transaction, 'document_request.overdue_marked', r);
    });
  }
  return due.length;
}

/** GET /me/document-requests: what we asked the member for (open, overdue and recent). */
async function listMine(principal) {
  const rows = await DocumentRequest.findAll({ where: { userId: principal.id }, order: [['createdAt', 'DESC']], limit: 20 });
  return { items: rows.map(view) };
}

const get = (id, { transaction } = {}) => DocumentRequest.findByPk(id, { transaction });

/** Display facts for notifications. */
async function facts(id) {
  const r = await DocumentRequest.findByPk(id);
  if (!r) throw E.notFound('Document request');
  return { docType: r.docType, dueAt: r.dueAt, reason: r.reason };
}

module.exports = { createInTx, cancelInTx, fulfilOnSubmit, markOverdue, listMine, get, facts, view };
