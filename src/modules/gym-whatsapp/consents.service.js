'use strict';

/**
 * M24 §25 a member's WhatsApp number and consents (M24-FR-159, FR-160).
 *  - Two separate yes/no answers: `service` (receipts and reminders, Meta's utility messages) and `news`
 *    (news and offers, marketing). A member who never answered agreed to neither.
 *  - The number defaults to the member's phone in the gym's record; a member may give another one.
 *  - Every change is a new row in gym_whatsapp_consents (append-only) with the consent text's version
 *    (gym_whatsapp.consent_version) and who made it: the member, the desk ("the member agreed", members.edit),
 *    or a STOP reply (step 2). Staff see the last 4 digits only.
 *   GET/PUT /manage/gyms/:gymId/members/:memberId/whatsapp   the desk (members.view / members.edit)
 *   GET/PUT /me/gym-whatsapp/:memberId                       the linked member themselves
 */
const { E } = require('../../common/errors');
const { sequelize, GymWhatsappConsent } = require('../../models');
const gymFacade = require('../gym').gyms;
const rules = require('./gym-whatsapp.rules');
const c = require('./gym-whatsapp.common');

/** The member's consent rows, newest first (the first is the current one). */
const rowsOf = (memberId, { transaction, limit = 1 } = {}) => GymWhatsappConsent.findAll({ where: { memberId }, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit, transaction });

async function currentOf(memberId, opts) {
  const [row] = await rowsOf(memberId, opts);
  return row ?? null;
}

function consentView(row) {
  const cur = rules.currentConsent(row ? [row] : []);
  return { ...cur, at: c.iso(cur.at), currentVersion: c.cfg().consentVersion };
}

/**
 * Write the member's consent when it changed (inside a transaction that holds no member lock: the latest row
 * wins). → the row now current.
 */
async function writeIn(transaction, { gymId, memberId, number, service, news, source, changedBy }) {
  const current = await currentOf(memberId, { transaction });
  const next = { numberHash: c.phoneHash(number), service, news, consentVersion: c.cfg().consentVersion };
  if (current && !rules.consentChanged(current, next)) return { row: current, changed: false };
  const row = await GymWhatsappConsent.create({ gymId, memberId, numberEnc: c.enc(number), numberLast4: rules.last4(number), ...next, source, changedBy }, { transaction });
  return { row, changed: true, before: current };
}

/** The number to store: the one given, or the member's phone in the gym's record (422 when neither). */
async function numberFor(gymId, memberId, given) {
  if (given !== null && given !== undefined) return c.phoneOf(given);
  const phone = await c.gymManage().memberPhone(gymId, memberId);
  if (!phone) throw E.validation([{ field: 'number', message: 'Enter the member’s WhatsApp number' }]);
  return phone;
}

const auditView = (row) => (row ? { service: row.service, news: row.news, numberLast4: row.numberLast4, consentVersion: row.consentVersion, source: row.source } : null);

// ---------------------------------------------------------------- the desk

async function deskMember(principal, gymId, memberId, permission) {
  const a = await c.gymManage().access(principal, gymId, permission);
  const m = await c.gymManage().member(gymId, memberId);
  if (!m) throw E.notFound('Member');
  return { a, m };
}

/** GET …/members/:memberId/whatsapp (members.view): the member's consents and the last 4 digits. */
async function forMember(principal, gymId, memberId) {
  await deskMember(principal, gymId, memberId, 'members.view');
  const phone = await c.gymManage().memberPhone(gymId, memberId);
  return { ...consentView(await currentOf(memberId)), phoneLast4: phone ? rules.last4(phone) : null };
}

/** PUT …/members/:memberId/whatsapp { number, service, news } (members.edit): the member agreed at the desk. */
async function setForMember(principal, gymId, memberId, body, req) {
  const { a } = await deskMember(principal, gymId, memberId, 'members.edit');
  const number = await numberFor(gymId, memberId, body.number);
  await sequelize.transaction(async (transaction) => {
    const r = await writeIn(transaction, { gymId, memberId, number, service: body.service, news: body.news, source: 'desk', changedBy: principal.id });
    if (r.changed) await c.record({ action: 'gym_whatsapp.consent_recorded', actor: principal, entityType: 'gym_member', entityId: memberId, before: auditView(r.before), after: auditView(r.row), meta: { gymId: a.gym.id, source: 'desk' }, req }, transaction);
  });
  return forMember(principal, gymId, memberId);
}

// ---------------------------------------------------------------- the member

async function myMember(principal, memberId) {
  const m = await c.gymManage().memberOfUser(memberId, principal.id);
  if (!m) throw E.notFound('Membership');
  return m;
}

/** GET /me/gym-whatsapp/:memberId: my WhatsApp number at this gym and what I agreed to. */
async function mine(principal, memberId) {
  const m = await myMember(principal, memberId);
  const row = await currentOf(memberId);
  const gym = await gymFacade.get(m.gymId);
  return { ...consentView(row), number: row ? c.dec(row.numberEnc) : null, phone: await c.gymManage().memberPhone(m.gymId, memberId), gymName: gym?.name ?? '' };
}

/** PUT /me/gym-whatsapp/:memberId { number, service, news }: the member answers for themselves. */
async function setMine(principal, memberId, body, req) {
  const m = await myMember(principal, memberId);
  await c.gymManage().refuseSuspendedId(m.gymId);
  const number = await numberFor(m.gymId, memberId, body.number);
  await sequelize.transaction(async (transaction) => {
    const r = await writeIn(transaction, { gymId: m.gymId, memberId, number, service: body.service, news: body.news, source: 'member', changedBy: principal.id });
    if (r.changed) await c.record({ action: 'gym_whatsapp.consent_recorded', actor: principal, entityType: 'gym_member', entityId: memberId, before: auditView(r.before), after: auditView(r.row), meta: { gymId: m.gymId, source: 'member' }, req }, transaction);
  });
  return mine(principal, memberId);
}

module.exports = { currentOf, writeIn, forMember, setForMember, mine, setMine };
