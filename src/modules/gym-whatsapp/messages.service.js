'use strict';

/**
 * M24 §25 sending WhatsApp messages from the gym (M24-FR-164 to FR-170), built switched off
 * (gym_whatsapp.api_enabled). Every message:
 *  - goes from the branch's connected number with one of Kriraghor's approved templates, in the member's
 *    language (their account's, else the owner's);
 *  - needs the member's consent for its category (receipts and reminders: `service`; notices and wishes:
 *    `news`) and never goes to a member who opted out;
 *  - holds its units when queued (gym-manage whatsappUnits; Kriraghor pays Meta) and is sent by the
 *    gym-whatsapp.send job, at most gym_whatsapp.send_per_minute per number; marketing waits out quiet hours;
 *  - is one row in gym_whatsapp_messages with no phone number and no free text of the member.
 * Automatic messages (receipt, renewal due, ends today, overdue, payment link) follow the same events M08
 * uses, once each, when the branch switched the kind on; while a member is reached on WhatsApp for a kind,
 * gym-manage sends no SMS for it (willSend).
 */
const crypto = require('node:crypto');
const { Op, QueryTypes } = require('sequelize');
const { E } = require('../../common/errors');
const money = require('../../common/money');
const config = require('../../config');
const { sequelize, GymWhatsappGym, GymWhatsappSender, GymWhatsappTemplate, GymWhatsappSend, GymWhatsappMessage } = require('../../models');
const gymFacade = require('../gym').gyms;
const directory = require('../users').directory;
const TPL = require('./templates');
const rules = require('./gym-whatsapp.rules');
const consents = require('./consents.service');
const c = require('./gym-whatsapp.common');

const BULK_SEGMENTS = Object.freeze(['active', 'expiring', 'expired', 'not_seen', 'package']);

// ---------------------------------------------------------------- the branch's sending context

/** The branch's number and its templates → { gym, row, sender | null, templates: Map 'code:locale' → row }. */
async function contextOf(gym, { transaction } = {}) {
  const row = await GymWhatsappGym.findByPk(gym.id, { transaction });
  const sender = row?.senderId ? await GymWhatsappSender.findByPk(row.senderId, { transaction }) : null;
  const live = sender && sender.status === 'connected' && sender.ownerId === gym.ownerId ? sender : null;
  const templates = live ? await GymWhatsappTemplate.findAll({ where: { senderId: live.id }, transaction }) : [];
  return { gym, row, sender: live, templates: new Map(templates.map((t) => [`${t.code}:${t.locale}`, t])) };
}

/** The language a member reads: their account's, else the owner's (like M08's gym_member adapter). */
async function localeOf(member, ownerId) {
  const id = member.userId ?? ownerId;
  const contact = (await directory.contactFor([id])).get(id);
  return contact?.locale === 'bn' ? 'bn' : 'en';
}

const dayText = (date, locale) => new Intl.DateTimeFormat(locale === 'bn' ? 'bn-BD' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dhaka' }).format(new Date(`${date}T00:00:00+06:00`));
const gymUrl = (path) => `${config.apps.gym}${path}`;

/**
 * Can this member get a message of `kind` from this branch now, ignoring units? → { block, template, locale,
 * category, consent } (block null when they can).
 */
async function eligibility(ctx, member, kind, { transaction } = {}) {
  const template = TPL.KIND_TEMPLATE[kind];
  const locale = await localeOf(member, ctx.gym.ownerId);
  const tpl = ctx.templates.get(`${template}:${locale}`);
  const category = tpl?.category ?? TPL.TEMPLATES[template].category;
  const consent = await consents.currentOf(member.id, { transaction });
  const block = rules.memberBlock({ consent, category, senderConnected: Boolean(ctx.sender), templateApproved: tpl?.status === 'approved' });
  return { block, template, locale, category, consent };
}

/**
 * Queue one message in the caller's transaction: units held (unless `held` already covers them) and the row
 * written; the send job picks it up. → { queued, reason, messageId }.
 */
async function queueIn(transaction, { ctx, member, kind, named, subjectId = null, sendId = null, plan = null }) {
  const el = await eligibility(ctx, member, kind, { transaction });
  if (el.block) return { queued: false, reason: el.block };
  if (subjectId && (await GymWhatsappMessage.findOne({ where: { kind, subjectId }, attributes: ['id'], transaction }))) return { queued: false, reason: 'duplicate' };
  const units = c.units().unitsFor(el.category);
  const p = plan ?? (await c.units().planIn(transaction, { ownerId: ctx.gym.ownerId, units }));
  if (!p.ok) return { queued: false, reason: p.reason };
  const billingRef = crypto.randomUUID();
  p.balance = await c.units().reserveIn(transaction, { ownerId: ctx.gym.ownerId, gymId: ctx.gym.id, units, balance: p.balance, billingRef });
  const cf = c.cfg();
  const row = await GymWhatsappMessage.create(
    {
      gymId: ctx.gym.id,
      ownerId: ctx.gym.ownerId,
      memberId: member.id,
      sendId,
      senderId: ctx.sender.id,
      kind,
      template: el.template,
      locale: el.locale,
      category: el.category,
      params: TPL.valuesOf(el.template, { ...named, gym: ctx.gym.name }),
      subjectId,
      units,
      billingRef,
      status: 'queued',
      sendAfter: rules.sendAfter({ category: el.category, quietStart: cf.quietStart, quietEnd: cf.quietEnd }),
    },
    { transaction }
  );
  return { queued: true, reason: null, messageId: row.id };
}

// ---------------------------------------------------------------- automatic messages (M24-FR-165)

/** The named values of an automatic kind from its event payload, in the member's language. */
async function namedOf(kind, payload, locale) {
  const f = require('../gym-manage').facts;
  const amount = (v) => money.format(Number(v ?? 0), locale);
  switch (kind) {
    case 'receipt':
      return { receiptNo: payload.receiptNo, amount: amount(payload.amount), link: f.receiptUrl(payload.feePaymentId) };
    case 'renewal_due':
      return { endsOn: dayText(payload.endsOn, locale), link: (await f.payLinkShortUrl(payload.linkId)) ?? gymUrl(`/me/memberships/${payload.memberId}?renew=1`) };
    case 'ends_today':
      return { link: gymUrl(`/me/memberships/${payload.memberId}?renew=1`) };
    case 'overdue':
      return { outstanding: amount(payload.outstanding), dueOn: dayText(payload.dueOn, locale), link: (await f.payLinkShortUrl(payload.linkId)) ?? gymUrl('/me/dues') };
    default:
      return { amount: amount(payload.amount), link: (await f.payLinkShortUrl(payload.linkId)) ?? gymUrl('/me/dues') };
  }
}

/** Is this automatic kind on for the branch, with the platform switch on? → the branch's context, or null. */
async function autoContext(gymId, kind, { transaction } = {}) {
  if (!c.cfg().apiEnabled) return null;
  const gym = await gymFacade.get(gymId, { transaction });
  if (!gym || gym.status === 'suspended') return null;
  const ctx = await contextOf(gym, { transaction });
  return ctx.sender && (ctx.row?.autoKinds ?? []).includes(kind) ? ctx : null;
}

/** An M04 consumer of an automatic kind (in the inbox transaction): queue the message once per event. */
async function onAutomatic(kind, event, { transaction }) {
  const p = event.payload;
  if (kind === 'receipt' && p.method === 'opening') return null;
  if (kind === 'pay_link' && !(p.channels ?? []).length) return null;
  const ctx = await autoContext(p.gymId, kind, { transaction });
  if (!ctx) return null;
  const member = await c.gymManage().member(p.gymId, p.memberId, { transaction });
  if (!member) return null;
  const locale = await localeOf(member, ctx.gym.ownerId);
  return queueIn(transaction, { ctx, member, kind, named: await namedOf(kind, p, locale), subjectId: kind === 'receipt' ? p.feePaymentId : event.id });
}

/**
 * Facade willSend (gym-manage, before an SMS): will this member get `kind` on WhatsApp? Then no SMS is held
 * for it. Read-only apart from the owner's subscription lock the caller already holds.
 */
async function willSend(transaction, { gymId, memberId, kind }) {
  const ctx = await autoContext(gymId, kind, { transaction });
  if (!ctx) return false;
  const member = await c.gymManage().member(gymId, memberId, { transaction });
  if (!member) return false;
  const el = await eligibility(ctx, member, kind, { transaction });
  if (el.block) return false;
  return (await c.units().planIn(transaction, { ownerId: ctx.gym.ownerId, units: c.units().unitsFor(el.category) })).ok;
}

// ---------------------------------------------------------------- from the panel (M24-FR-166, FR-167)

async function panelAccess(principal, gymId) {
  if (!c.cfg().apiEnabled) throw c.fail('GYM_WHATSAPP_API_OFF');
  const a = await c.gymManage().access(principal, gymId, 'whatsapp.send', { restricted: true, feature: 'whatsapp' });
  return { a, ctx: await contextOf(a.gym) };
}

const sentToday = async (gymId) => GymWhatsappSend.count({ where: { gymId, kind: ['notice', 'greeting'], localDate: c.gymManage().today() } });

function checkSegment(segment) {
  if (!BULK_SEGMENTS.includes(segment.kind)) throw E.validation([{ field: 'segment.kind', message: 'Choose who receives it' }]);
  const needsDays = ['expiring', 'expired', 'not_seen'].includes(segment.kind);
  if (needsDays && !(segment.days >= 1 && segment.days <= c.cfg().noticeDaysMax)) throw E.validation([{ field: 'segment.days', message: `Choose 1 to ${c.cfg().noticeDaysMax} days` }]);
  if (segment.kind === 'package' && !segment.packageId) throw E.validation([{ field: 'segment.packageId', message: 'Choose a package' }]);
}

/** The members of a bulk send and who of them can get it → { members, reach: [{ member, el }], counts }. */
async function audience(ctx, kind, segment) {
  checkSegment(segment);
  const ids = await c.gymManage().segmentMemberIds(ctx.gym.id, segment);
  const counts = { members: ids.length, reachable: 0, no_consent: 0, template: 0, no_sender: 0 };
  const reach = [];
  for (const id of ids) {
    const member = await c.gymManage().member(ctx.gym.id, id);
    if (!member) continue;
    const el = await eligibility(ctx, member, kind);
    if (el.block) counts[el.block] += 1;
    else {
      counts.reachable += 1;
      reach.push({ member, el });
    }
  }
  return { reach, counts };
}

/** POST …/whatsapp/estimate { kind, segment } (owner or whatsapp.send): who it reaches and what it holds. */
async function estimate(principal, gymId, { kind, segment }) {
  const { ctx } = await panelAccess(principal, gymId);
  const { reach, counts } = await audience(ctx, kind, segment);
  const units = await c.units().view(ctx.gym.ownerId);
  const need = reach.reduce((n, r) => n + c.units().unitsFor(r.el.category), 0);
  const left = rules.bulkLeft({ cap: c.cfg().bulkDailyCap, sentToday: await sentToday(gymId) });
  return { ...counts, unitsNeeded: need, balance: units.balance, bulkLeft: left, senderConnected: Boolean(ctx.sender), addonActive: units.status === 'active' };
}

/** Write the send row and queue each message under one hold check; 409 when the units do not cover it. */
async function sendIn(transaction, { principal, ctx, kind, template, params, segment = null, member = null, reach, targetCount }) {
  const need = reach.reduce((n, r) => n + c.units().unitsFor(r.el.category), 0);
  const plan = await c.units().planIn(transaction, { ownerId: ctx.gym.ownerId, units: need });
  if (!plan.ok) throw c.fail('GYM_WHATSAPP_BLOCKED', { reason: plan.reason, unitsNeeded: need, balance: plan.balance });
  const send = await GymWhatsappSend.create(
    { gymId: ctx.gym.id, ownerId: ctx.gym.ownerId, kind, template, params, segment, memberId: member?.id ?? null, targetCount, queuedCount: reach.length, unitsHeld: need, localDate: c.gymManage().today(), sentBy: principal.id },
    { transaction }
  );
  for (const r of reach) {
    const q = await queueIn(transaction, { ctx, member: r.member, kind, named: params, sendId: send.id, plan });
    if (!q.queued) throw c.fail('GYM_WHATSAPP_BLOCKED', { reason: q.reason });
  }
  return send;
}

/**
 * POST …/whatsapp/sends { kind: notice | greeting, segment, title?, message } or { kind: single, memberId,
 * message } [Idempotency-Key] (owner or whatsapp.send): queue it to everyone it can reach now.
 */
async function send(principal, gymId, body, req) {
  const { ctx } = await panelAccess(principal, gymId);
  if (!ctx.sender) throw c.fail('GYM_WHATSAPP_NO_SENDER');
  const params = body.kind === 'notice' ? { title: body.title, message: body.message } : { message: body.message };
  let reach;
  let targetCount;
  let member = null;
  if (body.kind === 'single') {
    member = await c.gymManage().member(gymId, body.memberId);
    if (!member) throw E.notFound('Member');
    const el = await eligibility(ctx, member, 'single');
    if (el.block) throw c.fail('GYM_WHATSAPP_BLOCKED', { reason: el.block });
    reach = [{ member, el }];
    targetCount = 1;
  } else {
    if (rules.bulkLeft({ cap: c.cfg().bulkDailyCap, sentToday: await sentToday(gymId) }) <= 0) throw c.fail('GYM_WHATSAPP_CAP', { cap: c.cfg().bulkDailyCap });
    const a = await audience(ctx, body.kind, body.segment);
    reach = a.reach;
    targetCount = a.counts.members;
    if (!reach.length) throw c.fail('GYM_WHATSAPP_BLOCKED', { reason: 'nobody', ...a.counts });
  }
  const row = await sequelize.transaction(async (transaction) => {
    const s = await sendIn(transaction, { principal, ctx, kind: body.kind, template: TPL.KIND_TEMPLATE[body.kind], params, segment: body.segment ?? null, member, reach, targetCount });
    await c.record({ action: 'gym_whatsapp.sent', actor: principal, entityType: 'gym_whatsapp_send', entityId: s.id, meta: { gymId, kind: body.kind, queued: reach.length, target: targetCount, units: s.unitsHeld }, req }, transaction);
    return s;
  });
  return sendView(row, {});
}

/** POST …/fee-payments/:feePaymentId/whatsapp (owner or whatsapp.send): send or resend this receipt now. */
async function sendReceipt(principal, gymId, feePaymentId, req) {
  const { ctx } = await panelAccess(principal, gymId);
  if (!ctx.sender) throw c.fail('GYM_WHATSAPP_NO_SENDER');
  const p = await c.gymManage().feePayment(gymId, feePaymentId);
  if (!p) throw c.fail('GYM_WHATSAPP_RECEIPT');
  const member = await c.gymManage().member(gymId, p.memberId);
  if (!member) throw E.notFound('Member');
  const locale = await localeOf(member, ctx.gym.ownerId);
  const named = await namedOf('receipt', { receiptNo: p.receiptNo, amount: p.amountPoisha, feePaymentId: p.id }, locale);
  const r = await sequelize.transaction(async (transaction) => {
    const q = await queueIn(transaction, { ctx, member, kind: 'receipt', named });
    if (q.queued) await c.record({ action: 'gym_whatsapp.sent', actor: principal, entityType: 'gym_member', entityId: member.id, meta: { gymId, kind: 'receipt', queued: 1, target: 1 }, req }, transaction);
    return q;
  });
  if (!r.queued) throw c.fail('GYM_WHATSAPP_BLOCKED', { reason: r.reason });
  return { queued: true, messageId: r.messageId };
}

// ---------------------------------------------------------------- history

function sendView(s, counts) {
  return {
    id: s.id,
    kind: s.kind,
    params: s.params,
    segment: s.segment ?? null,
    memberId: s.memberId ?? null,
    targetCount: s.targetCount,
    queuedCount: s.queuedCount,
    unitsHeld: s.unitsHeld,
    sentAt: c.iso(s.createdAt),
    status: { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, ...counts },
  };
}

/** GET …/whatsapp/sends (owner or whatsapp.send): the latest bulk and single sends with their delivery counts. */
async function sends(principal, gymId, { limit = 25 } = {}) {
  await c.gymManage().access(principal, gymId, 'whatsapp.send');
  const rows = await GymWhatsappSend.findAll({ where: { gymId }, order: [['createdAt', 'DESC']], limit });
  const counts = rows.length
    ? await sequelize.query("SELECT send_id AS \"sendId\", CASE WHEN status IN ('queued', 'sending') THEN 'queued' WHEN status = 'expired' THEN 'failed' ELSE status END AS status, COUNT(*)::int AS n FROM gym_whatsapp_messages WHERE send_id IN (:ids) GROUP BY 1, 2", { replacements: { ids: rows.map((r) => r.id) }, type: QueryTypes.SELECT })
    : [];
  const by = new Map();
  for (const r of counts) by.set(r.sendId, { ...(by.get(r.sendId) ?? {}), [r.status]: r.n });
  return { items: rows.map((r) => sendView(r, by.get(r.id) ?? {})), bulkLeft: rules.bulkLeft({ cap: c.cfg().bulkDailyCap, sentToday: await sentToday(gymId) }) };
}

/** GET …/whatsapp/messages?memberId= (owner or whatsapp.send): one member's messages, newest first, with their text. */
async function messages(principal, gymId, { memberId, limit = 50 }) {
  await c.gymManage().access(principal, gymId, 'whatsapp.send');
  const rows = await GymWhatsappMessage.findAll({ where: { gymId, memberId }, order: [['createdAt', 'DESC']], limit });
  return {
    items: rows.map((m) => ({
      id: m.id,
      kind: m.kind,
      category: m.category,
      text: TPL.render(m.template, m.locale, m.params),
      status: m.status,
      errorCode: m.errorCode ?? null,
      createdAt: c.iso(m.createdAt),
      sentAt: c.iso(m.sentAt),
      deliveredAt: c.iso(m.deliveredAt),
      readAt: c.iso(m.readAt),
    })),
  };
}

// ---------------------------------------------------------------- statuses (the job and the webhook)

/** Close a message's hold and move its status (no move backwards; M24-FR-170). */
async function moveIn(transaction, m, next, { at = new Date(), errorCode = null } = {}) {
  if (!rules.advances(m.status, next)) return false;
  const patch = { status: next };
  if (next === 'sent') patch.sentAt = at;
  if (next === 'delivered') patch.deliveredAt = at;
  if (next === 'read') {
    patch.readAt = at;
    if (!m.deliveredAt) patch.deliveredAt = at;
  }
  if (next === 'failed') Object.assign(patch, { failedAt: at, errorCode });
  await m.update(patch, { transaction });
  if (['delivered', 'read'].includes(next)) await c.units().settleIn(transaction, { billingRef: m.billingRef, delivered: true });
  if (['failed', 'expired'].includes(next)) await c.units().settleIn(transaction, { billingRef: m.billingRef, delivered: false, note: next });
  return true;
}

/** Messages queued, sending or sent more than a day ago that were never delivered: expired, units back. */
async function expireOld(now = new Date()) {
  const old = await GymWhatsappMessage.findAll({ where: { status: ['queued', 'sending', 'sent'], createdAt: { [Op.lt]: new Date(now.getTime() - 86400000) } }, attributes: ['id'], limit: 1000 });
  let n = 0;
  for (const { id } of old) {
    await sequelize.transaction(async (transaction) => {
      const m = await GymWhatsappMessage.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (await moveIn(transaction, m, 'expired', { at: now })) n += 1;
    });
  }
  return n;
}

module.exports = { BULK_SEGMENTS, contextOf, eligibility, queueIn, onAutomatic, willSend, estimate, send, sendReceipt, sends, messages, moveIn, expireOld, localeOf };
