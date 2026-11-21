'use strict';

/**
 * M24 §25 connected WhatsApp Business numbers (M24-FR-161 to FR-163; ADR-012). The owner connects the gym's
 * own number through Meta's embedded sign-up in the panel (coexistence: the gym keeps answering in its
 * WhatsApp Business phone app); the panel posts the code and ids the sign-up returns, and here:
 *  - the code becomes the account's token (stored encrypted, never returned or logged);
 *  - Kriraghor's app subscribes to the account's webhooks, and Kriraghor's credit line is shared with it
 *    (Kriraghor pays Meta and resells units, 21 Nov 2026);
 *  - Kriraghor's templates are created in English and Bangla (Meta approves them one by one);
 *  - branches without a number start sending from it.
 * Disconnecting stops sending from it; its branches send nothing until another number is chosen.
 * Everything here needs gym_whatsapp.api_enabled and a plan with the whatsapp feature.
 */
const { sequelize, GymWhatsappSender, GymWhatsappTemplate, GymWhatsappGym } = require('../../models');
const config = require('../../config');
const logger = require('../../common/logger');
const provider = require('../../providers/whatsapp');
const events = require('../events').events;
const gymFacade = require('../gym').gyms;
const TPL = require('./templates');
const c = require('./gym-whatsapp.common');

const LOCALES = ['en', 'bn'];

function senderView(s, templates = []) {
  const counts = { approved: 0, pending: 0, rejected: 0 };
  for (const t of templates) counts[t.status === 'approved' ? 'approved' : t.status === 'pending' ? 'pending' : 'rejected'] += 1;
  return {
    id: s.id,
    displayNumber: s.displayNumber,
    verifiedName: s.verifiedName ?? null,
    status: s.status,
    quality: s.quality ?? null,
    messagingLimit: s.messagingLimit ?? null,
    creditAttached: s.creditAttached,
    connectedAt: c.iso(s.connectedAt),
    templates: counts,
  };
}

/** The owner's live numbers with their template counts (the WhatsApp page). */
async function listFor(ownerId) {
  const rows = await GymWhatsappSender.findAll({ where: { ownerId, status: ['connected', 'restricted'] }, order: [['connectedAt', 'ASC']] });
  const templates = rows.length ? await GymWhatsappTemplate.findAll({ where: { senderId: rows.map((r) => r.id) } }) : [];
  return rows.map((s) => senderView(s, templates.filter((t) => t.senderId === s.id)));
}

/** The Meta app values the panel's sign-up button needs (public), or null while the API is off or not set up. */
const signUpConfig = () => (c.cfg().apiEnabled && config.whatsapp.appId && config.whatsapp.configId ? { appId: config.whatsapp.appId, configId: config.whatsapp.configId } : null);

/** 409 unless the platform switch is on and the owner's plan has the whatsapp feature. */
async function requireAvailable(ownerId) {
  if (!c.cfg().apiEnabled) throw c.fail('GYM_WHATSAPP_API_OFF');
  const v = await c.units().view(ownerId);
  if (!v.available) throw c.fail('GYM_WHATSAPP_UNAVAILABLE');
}

/** Run a Meta call; its failure becomes 502 GYM_WHATSAPP_META_FAILED { step, metaCode } (no token in the log). */
async function meta(step, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ step, code: err.code }, 'whatsapp cloud api call failed');
    throw c.fail('GYM_WHATSAPP_META_FAILED', { step, metaCode: err.code ?? null });
  }
}

/** Create Kriraghor's templates in an account (both languages); a failure leaves that one rejected with the reason. */
async function createTemplates(sender, token) {
  for (const code of Object.keys(TPL.TEMPLATES)) {
    for (const locale of LOCALES) {
      const existing = await GymWhatsappTemplate.findOne({ where: { senderId: sender.id, code, locale } });
      if (existing && existing.status !== 'rejected') continue;
      let made;
      try {
        made = await provider.createTemplate({ wabaId: sender.wabaId, token, body: TPL.createBody(code, locale) });
      } catch (err) {
        made = { metaId: null, status: 'rejected', category: TPL.TEMPLATES[code].category, reason: `create failed (${err.code ?? 'error'})` };
      }
      const row = { status: ['approved', 'pending', 'rejected', 'paused', 'disabled'].includes(made.status) ? made.status : 'pending', metaId: made.metaId, category: made.category === 'marketing' ? 'marketing' : 'utility', reason: made.reason ?? null };
      if (existing) await existing.update(row);
      else await GymWhatsappTemplate.create({ senderId: sender.id, code, locale, ...row });
    }
  }
}

/**
 * POST /manage/whatsapp/senders { code, wabaId, phoneNumberId } [Idempotency-Key] (owner): connect the number
 * the embedded sign-up returned. Reconnecting the same number refreshes its token.
 */
async function connect(principal, { code, wabaId, phoneNumberId }, req) {
  await requireAvailable(principal.id);
  const taken = await GymWhatsappSender.findOne({ where: { phoneNumberId, status: ['connected', 'restricted'] } });
  if (taken && taken.ownerId !== principal.id) throw c.fail('GYM_WHATSAPP_NUMBER_TAKEN');
  const { token } = await meta('exchange', () => provider.exchangeCode({ code }));
  const info = await meta('phone', () => provider.phoneInfo({ phoneNumberId, token }));
  await meta('subscribe', () => provider.subscribeApp({ wabaId, token }));
  const credit = await meta('credit', () => provider.attachCredit({ wabaId }));
  const now = new Date();
  const sender = await sequelize.transaction(async (transaction) => {
    const values = { wabaId, displayNumber: info.displayNumber, verifiedName: info.verifiedName, tokenEnc: c.enc(token), status: 'connected', quality: info.quality, messagingLimit: info.messagingLimit, creditAttached: Boolean(credit?.attached), disconnectedAt: null };
    const row = taken ? await taken.update(values, { transaction }) : await GymWhatsappSender.create({ ownerId: principal.id, phoneNumberId, connectedBy: principal.id, connectedAt: now, ...values }, { transaction });
    // Branches without a number send from this one.
    for (const g of await gymFacade.ofOwner(principal.id, { transaction })) {
      const gr = await GymWhatsappGym.findByPk(g.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!gr) await GymWhatsappGym.create({ gymId: g.id, ownerId: principal.id, senderId: row.id, updatedBy: principal.id }, { transaction });
      else if (!gr.senderId) await gr.update({ senderId: row.id, updatedBy: principal.id }, { transaction });
    }
    await c.record({ action: 'gym_whatsapp.connected', actor: principal, entityType: 'gym_whatsapp_sender', entityId: row.id, after: { displayNumber: row.displayNumber, creditAttached: row.creditAttached }, req }, transaction);
    return row;
  });
  await createTemplates(sender, token);
  return listFor(principal.id);
}

/** Stop sending from a number (owner, or Meta's account update): its branches send nothing until one is chosen. */
async function disconnectIn(transaction, sender, { by = null, reason, req = null }) {
  await sender.update({ status: 'disconnected', disconnectedAt: new Date() }, { transaction });
  await GymWhatsappGym.update({ senderId: null }, { where: { senderId: sender.id }, transaction });
  await events.publish(transaction, { name: 'gym_whatsapp.disconnected', aggregateType: 'gym_owner', aggregateId: sender.ownerId, payload: { ownerId: sender.ownerId, senderId: sender.id, reason } });
  await c.record({ action: 'gym_whatsapp.disconnected', actor: by, entityType: 'gym_whatsapp_sender', entityId: sender.id, before: { status: 'connected' }, after: { status: 'disconnected' }, reason, req }, transaction);
}

/** POST /manage/whatsapp/senders/:senderId/disconnect (owner). */
async function disconnect(principal, senderId, req) {
  await sequelize.transaction(async (transaction) => {
    const s = await GymWhatsappSender.findByPk(senderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!s || s.ownerId !== principal.id) throw require('../../common/errors').E.notFound('WhatsApp number');
    if (s.status === 'disconnected') throw c.fail('GYM_WHATSAPP_SENDER_STATE', { status: s.status });
    await disconnectIn(transaction, s, { by: principal, reason: 'owner', req });
  });
  return listFor(principal.id);
}

/** A live sender of this owner (the branch's choice is checked against it). */
async function liveOf(ownerId, senderId, { transaction } = {}) {
  const s = await GymWhatsappSender.findByPk(senderId, { transaction });
  return s && s.ownerId === ownerId && s.status !== 'disconnected' ? s : null;
}

/** gym-whatsapp.daily: templates still pending are checked with Meta (the webhook usually says first). */
async function syncTemplates() {
  if (!c.cfg().apiEnabled) return { checked: 0 };
  const pending = await GymWhatsappTemplate.findAll({ where: { status: 'pending' }, attributes: ['senderId'], group: ['senderId'] });
  let checked = 0;
  for (const { senderId } of pending) {
    const s = await GymWhatsappSender.findByPk(senderId);
    if (!s || s.status === 'disconnected') continue;
    let list;
    try {
      list = await provider.listTemplates({ wabaId: s.wabaId, token: c.dec(s.tokenEnc) });
    } catch (err) {
      logger.warn({ senderId, code: err.code }, 'whatsapp template sync failed');
      continue;
    }
    for (const t of list) {
      const row = await GymWhatsappTemplate.findOne({ where: { senderId, code: t.code, locale: t.locale } });
      if (row) await row.update({ status: t.status, category: t.category === 'marketing' ? 'marketing' : 'utility', reason: t.reason, metaId: t.metaId });
    }
    checked += 1;
  }
  return { checked };
}

module.exports = { listFor, signUpConfig, connect, disconnect, disconnectIn, liveOf, syncTemplates, senderView };
