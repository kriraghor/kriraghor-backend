'use strict';

/**
 * M11 messages (v3: contact is in-app): one thread per request between the manager and the pro.
 * Until the request is paid, contact details (phones, long numbers, emails, links) are refused
 * (CONTACT_NOT_ALLOWED), so the deal stays on the platform; once paid, the request shows both phones.
 * At most hire.messages_per_hour per person per request; the other party gets an in-app notice (M08).
 */
const { Op } = require('sequelize');
const { sequelize, HireMessage } = require('../../models');
const events = require('../events/events.service');
const directory = require('../users/directory.service');
const requests = require('./requests.service');
const rules = require('./hire.rules');
const c = require('./hire.common');

const { fail } = c;
const PAID = ['confirmed', 'completed', 'cancelled'];

async function list(principal, requestId, { cursor } = {}) {
  const r = await requests.party(principal, requestId);
  const rows = await HireMessage.findAll({ where: { requestId: r.id, ...(cursor ? { createdAt: { [Op.gt]: new Date(cursor) } } : {}) }, order: [['createdAt', 'ASC']], limit: 200 });
  const names = await directory.publicNames([r.hirerId, r.proUserId]);
  return {
    items: rows.map((m) => ({ id: m.id, mine: m.authorId === principal.id, author: names.get(m.authorId)?.displayName ?? '', body: m.body, at: c.iso(m.createdAt) })),
    contactAllowed: PAID.includes(r.status) && Boolean(r.confirmedAt),
  };
}

async function post(principal, requestId, { body }) {
  return sequelize.transaction(async (transaction) => {
    const r = await requests.party(principal, requestId, { transaction, lock: true });
    if (['declined', 'expired', 'withdrawn', 'lapsed'].includes(r.status)) throw fail('REQUEST_STATE', { status: r.status });
    const paid = PAID.includes(r.status) && Boolean(r.confirmedAt);
    if (!paid && rules.hasContact(body)) throw fail('CONTACT_NOT_ALLOWED');
    const recent = await HireMessage.count({ where: { requestId: r.id, authorId: principal.id, createdAt: { [Op.gt]: new Date(Date.now() - 3600000) } }, transaction });
    if (recent >= c.config().messagesPerHour) throw fail('MESSAGES_RATE_LIMITED');
    const m = await HireMessage.create({ requestId: r.id, authorId: principal.id, body }, { transaction });
    const to = principal.id === r.hirerId ? r.proUserId : r.hirerId;
    await events.publish(transaction, { name: 'hire_message.posted', aggregateType: 'hire_request', aggregateId: r.id, payload: { requestId: r.id, code: r.code, messageId: m.id, authorId: principal.id, recipientId: to }, actor: principal });
    return { id: m.id, mine: true, body: m.body, at: c.iso(m.createdAt) };
  });
}

module.exports = { list, post };
