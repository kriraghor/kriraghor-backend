'use strict';

/**
 * M24 §25 jobs (src/jobs/definitions.js):
 *  - gym-whatsapp.send (every minute): queued messages whose time has come go out, at most
 *    gym_whatsapp.send_per_minute per connected number. A message is claimed (queued → sending) under a
 *    row lock with SKIP LOCKED, so two workers never send it twice. Its consent is checked again at the
 *    moment of sending; a member who opted out meanwhile gets nothing and the units go back.
 *  - gym-whatsapp.daily: messages not delivered within a day expire (units back); pending templates are
 *    checked with Meta.
 * While gym_whatsapp.api_enabled is off nothing is sent (queued messages expire with their units back).
 */
const { QueryTypes } = require('sequelize');
const logger = require('../../common/logger');
const provider = require('../../providers/whatsapp');
const { sequelize, GymWhatsappMessage, GymWhatsappSender } = require('../../models');
const rules = require('./gym-whatsapp.rules');
const consents = require('./consents.service');
const messages = require('./messages.service');
const senders = require('./senders.service');
const c = require('./gym-whatsapp.common');

/** Claim up to `limit` due messages of one sender → their ids (now `sending`). */
async function claim(senderId, limit, now) {
  return sequelize.transaction(async (transaction) => {
    const rows = await sequelize.query(
      `SELECT id FROM gym_whatsapp_messages WHERE sender_id = :senderId AND status = 'queued' AND send_after <= :now
        ORDER BY send_after, created_at LIMIT :limit FOR UPDATE SKIP LOCKED`,
      { replacements: { senderId, now, limit }, type: QueryTypes.SELECT, transaction }
    );
    if (rows.length) await GymWhatsappMessage.update({ status: 'sending' }, { where: { id: rows.map((r) => r.id) }, transaction });
    return rows.map((r) => r.id);
  });
}

/** Send one claimed message; its outcome is written in its own transaction. → 'sent' | 'failed'. */
async function deliver(id, sender, token) {
  const m = await GymWhatsappMessage.findByPk(id);
  const consent = await consents.currentOf(m.memberId);
  const fail = (code) =>
    sequelize.transaction(async (transaction) => {
      const row = await GymWhatsappMessage.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      await messages.moveIn(transaction, row, 'failed', { errorCode: code });
      return 'failed';
    });
  if (!consent || !consent[rules.consentFor(m.category)]) return fail('no_consent');
  const to = rules.waDigits(c.dec(consent.numberEnc));
  if (!to) return fail('number');
  let wamid;
  try {
    ({ wamid } = await provider.sendTemplate({ phoneNumberId: sender.phoneNumberId, token, to, template: m.template, locale: m.locale, values: m.params }));
  } catch (err) {
    logger.warn({ messageId: id, code: err.code }, 'whatsapp message not sent');
    return fail(String(err.code ?? 'error').slice(0, 24));
  }
  return sequelize.transaction(async (transaction) => {
    const row = await GymWhatsappMessage.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    await row.update({ wamid }, { transaction });
    await messages.moveIn(transaction, row, 'sent');
    return 'sent';
  });
}

/** gym-whatsapp.send → { sent, failed }. */
async function send(now = new Date()) {
  const out = { sent: 0, failed: 0 };
  if (!c.cfg().apiEnabled) return out;
  const due = await sequelize.query("SELECT DISTINCT sender_id AS \"senderId\" FROM gym_whatsapp_messages WHERE status = 'queued' AND send_after <= :now", { replacements: { now }, type: QueryTypes.SELECT });
  for (const { senderId } of due) {
    const sender = await GymWhatsappSender.findByPk(senderId);
    const ids = await claim(senderId, c.cfg().sendPerMinute, now);
    for (const id of ids) {
      const result = sender?.status === 'connected' ? await deliver(id, sender, c.dec(sender.tokenEnc)) : await sequelize.transaction(async (transaction) => {
        await messages.moveIn(transaction, await GymWhatsappMessage.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }), 'failed', { errorCode: 'sender' });
        return 'failed';
      });
      out[result] += 1;
    }
  }
  return out;
}

/** gym-whatsapp.daily → { expired, templates }. */
async function daily(now = new Date()) {
  const expired = await messages.expireOld(now);
  const { checked } = await senders.syncTemplates();
  return { expired, templates: checked };
}

module.exports = { send, daily };
