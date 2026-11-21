'use strict';

/**
 * M24 §25 Meta's WhatsApp webhook (M24-FR-169, FR-170), for every connected account (Kriraghor's app is
 * subscribed to each):
 *   GET  /webhooks/whatsapp   Meta's check: hub.verify_token must match WHATSAPP_WEBHOOK_VERIFY_TOKEN
 *   POST /webhooks/whatsapp   X-Hub-Signature-256 over the raw body (the app secret); 401 otherwise
 * What it does with each change:
 *  - messages.statuses: the message moves forward (sent, delivered, read, failed; never back) and its units
 *    settle: delivered keeps them (Meta charged), failed gives them back;
 *  - messages.messages: a STOP (or বন্ধ) reply opts that number out of everything at the gyms of the
 *    account's owner (a stop_reply consent row); other replies stay in the gym's WhatsApp app;
 *  - message_template_status_update / template_category_update: the template's approval and category;
 *  - phone_number_quality_update: the number's quality and messaging limit;
 *  - account_update with the partner removed or the account banned or deleted: the number is disconnected.
 * Handling is idempotent (statuses only move forward, a consent row only when something changed), so Meta's
 * retries are harmless; no payload is stored (members' numbers and texts never are).
 */
const config = require('../../config');
const logger = require('../../common/logger');
const { AppError } = require('../../common/errors');
const provider = require('../../providers/whatsapp');
const { sequelize, GymWhatsappMessage, GymWhatsappSender, GymWhatsappTemplate, GymWhatsappConsent } = require('../../models');
const rules = require('./gym-whatsapp.rules');
const consents = require('./consents.service');
const messages = require('./messages.service');
const senders = require('./senders.service');
const c = require('./gym-whatsapp.common');

/** GET: Meta's subscription check → the challenge, or null (403). */
function verify(query) {
  const token = config.whatsapp.verifyToken;
  return token && query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === token ? String(query['hub.challenge'] ?? '') : null;
}

const STATUS = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };

async function onStatus(s) {
  const next = STATUS[s.status];
  if (!next || !s.id) return;
  await sequelize.transaction(async (transaction) => {
    const m = await GymWhatsappMessage.findOne({ where: { wamid: s.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!m) return;
    const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
    await messages.moveIn(transaction, m, next, { at, errorCode: next === 'failed' ? String(s.errors?.[0]?.code ?? 'failed').slice(0, 24) : null });
  });
}

/** A STOP reply from `from` (digits) to an account of `ownerId`: every member of that owner on that number opts out. */
async function onReply(ownerId, msg) {
  if (!rules.isStop(msg.text?.body)) return 0;
  const e164 = `+${msg.from}`;
  if (!rules.E164.test(e164)) return 0;
  const hash = c.phoneHash(e164);
  const rows = await GymWhatsappConsent.findAll({ where: { numberHash: hash }, attributes: ['memberId', 'gymId'], group: ['memberId', 'gymId'] });
  let n = 0;
  for (const { memberId, gymId } of rows) {
    const gym = await require('../gym').gyms.get(gymId);
    if (!gym || gym.ownerId !== ownerId) continue;
    const current = await consents.currentOf(memberId);
    // Only while this is still the member's number and they still receive something.
    if (!current || current.numberHash !== hash || (!current.service && !current.news)) continue;
    await sequelize.transaction(async (transaction) => {
      const r = await consents.writeIn(transaction, { gymId, memberId, number: e164, service: false, news: false, source: 'stop_reply', changedBy: null });
      if (r.changed) await c.record({ action: 'gym_whatsapp.consent_recorded', actor: null, entityType: 'gym_member', entityId: memberId, before: { service: current.service, news: current.news }, after: { service: false, news: false }, meta: { gymId, source: 'stop_reply' } }, transaction);
    });
    n += 1;
  }
  return n;
}

async function onTemplate(wabaId, v) {
  const senderIds = (await GymWhatsappSender.findAll({ where: { wabaId }, attributes: ['id'] })).map((s) => s.id);
  if (!senderIds.length) return;
  const where = { senderId: senderIds, ...(v.message_template_id ? { metaId: String(v.message_template_id) } : { code: v.message_template_name, locale: v.message_template_language }) };
  if (v.new_category) {
    await GymWhatsappTemplate.update({ category: String(v.new_category).toLowerCase() === 'marketing' ? 'marketing' : 'utility' }, { where });
    return;
  }
  const status = String(v.event ?? '').toLowerCase();
  if (!['approved', 'rejected', 'paused', 'disabled', 'pending'].includes(status)) return;
  await GymWhatsappTemplate.update({ status, reason: v.reason && v.reason !== 'NONE' ? String(v.reason).slice(0, 200) : null }, { where });
}

async function onAccount(wabaId, field, v) {
  const live = await GymWhatsappSender.findAll({ where: { wabaId, status: ['connected', 'restricted'] } });
  for (const s of live) {
    if (field === 'phone_number_quality_update') {
      await s.update({ quality: v.event ? String(v.event).slice(0, 12) : s.quality, messagingLimit: v.current_limit ? String(v.current_limit).slice(0, 24) : s.messagingLimit, status: v.event === 'FLAGGED' ? 'restricted' : s.status === 'restricted' && v.event === 'UNFLAGGED' ? 'connected' : s.status });
    } else if (['PARTNER_REMOVED', 'ACCOUNT_DELETED', 'DISABLED_UPDATE', 'ACCOUNT_VIOLATION'].includes(v.event)) {
      await sequelize.transaction((transaction) => senders.disconnectIn(transaction, s, { reason: String(v.event).toLowerCase() }));
    }
  }
}

/** POST: check the signature over the raw body, then handle every change. → number of changes handled. */
async function receive(raw, signature) {
  if (!provider.signatureValid(raw, signature)) throw new AppError(401, 'WEBHOOK_SIGNATURE_INVALID', 'The webhook signature is not valid');
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError(400, 'WEBHOOK_INVALID', 'The webhook body is not JSON');
  }
  let handled = 0;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      try {
        if (change.field === 'messages') {
          for (const s of v.statuses ?? []) await onStatus(s);
          if ((v.messages ?? []).length) {
            const sender = await GymWhatsappSender.findOne({ where: { phoneNumberId: String(v.metadata?.phone_number_id ?? '') } });
            if (sender) for (const msg of v.messages) await onReply(sender.ownerId, msg);
          }
        } else if (['message_template_status_update', 'template_category_update'].includes(change.field)) await onTemplate(String(entry.id), v);
        else if (['phone_number_quality_update', 'account_update'].includes(change.field)) await onAccount(String(entry.id), change.field, v);
        handled += 1;
      } catch (err) {
        // One bad change must not make Meta retry the others forever; it is logged without the payload.
        logger.error({ field: change.field, err: err.message }, 'whatsapp webhook change failed');
      }
    }
  }
  return handled;
}

module.exports = { verify, receive, onReply };
