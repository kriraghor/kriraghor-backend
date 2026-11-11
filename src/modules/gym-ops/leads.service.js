'use strict';

/**
 * M27 round 2: enquiries from the gym page (feature `leads`, Basic plan; FR-66 to FR-69).
 *  - Anyone may send an enquiry on a published gym's page: name, phone, an optional message and best time.
 *    No sign-in, no CAPTCHA: a hidden trap field (filled → answered as accepted, nothing stored), at most
 *    gym_ops.lead_per_ip_hour per network and gym_ops.lead_per_phone_day per phone and gym (429). A gym whose
 *    plan lacks the feature answers 404, as if it had no form.
 *  - The phone is encrypted, kept with its last 4 digits and a keyed hash (repeat checks); never logged.
 *  - Staff with leads.manage (and the owner) list enquiries, mark them contacted or lost with a note, reveal
 *    the phone (audited) and mark one joined once it is a member. The owner and staff are told of a new one.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const crypto = require('../../common/crypto');
const velocity = require('../../common/velocity');
const { normalizePhone } = require('../../common/identifiers');
const { sequelize, GymLead } = require('../../models');
const gymFacade = require('../gym').gyms;
const c = require('./gym-ops.common');

const FEATURE = 'leads';
const MOVES = { new: ['contacted', 'lost', 'joined'], contacted: ['lost', 'joined'], lost: ['contacted'], joined: [] };

const view = (l) => ({
  id: l.id,
  name: l.name,
  phoneLast4: l.phoneLast4,
  message: l.message ?? null,
  bestTime: l.bestTime ?? null,
  status: l.status,
  note: l.note ?? null,
  memberId: l.memberId ?? null,
  source: l.source,
  createdAt: c.iso(l.createdAt),
  updatedAt: c.iso(l.updatedAt),
});

/**
 * POST /gym/gyms/:slug/enquiries { name, phone, message?, bestTime?, website? } (no sign-in): 202 accepted.
 * `website` is the hidden trap: a person never fills it.
 */
async function enquire(slug, input, req) {
  const gym = await gymFacade.publicBySlug(slug);
  if (!gym || !(await c.ops.featureOn(gym.id, FEATURE))) throw c.fail('GYM_LEADS_CLOSED');
  if (input.website) return { accepted: true };
  const phone = normalizePhone(input.phone);
  if (!phone) throw E.validation([{ field: 'phone', message: 'Enter a Bangladesh mobile number' }]);
  const cfg = c.cfg();
  const ip = await velocity.hit({ name: 'gym_lead_ip', scope: crypto.hmac(`ip:${req.ip ?? ''}`), limit: cfg.leadPerIpHour, windowMs: 3600000 });
  if (!ip.allowed) throw E.tooMany('RATE_LIMITED', 'Too many requests', 'Try again later.', { retryAfter: ip.retryAfter });
  const phoneHash = crypto.hmac(`phone:${phone}`);
  const byPhone = await velocity.hit({ name: 'gym_lead_phone', scope: `${gym.id}:${phoneHash}`, limit: cfg.leadPerPhoneDay, windowMs: 86400000 });
  if (!byPhone.allowed) throw E.tooMany('RATE_LIMITED', 'Too many requests', 'The gym already has your enquiry.', { retryAfter: byPhone.retryAfter });
  await sequelize.transaction(async (transaction) => {
    const l = await GymLead.create(
      { gymId: gym.id, name: input.name, phoneEnc: crypto.encrypt(phone), phoneLast4: phone.slice(-4), phoneHash, message: input.message ?? null, bestTime: input.bestTime ?? null, source: 'gym_page' },
      { transaction }
    );
    await c.publish(transaction, 'gym_lead.received', 'gym_lead', l.id, { leadId: l.id, gymId: gym.id, ownerId: gym.ownerId });
  });
  return { accepted: true };
}

/** GET …/leads?status (owner or leads.manage): the gym's enquiries, newest first. */
async function list(principal, gymId, { status } = {}) {
  await c.access(principal, gymId, 'leads.manage', { feature: FEATURE });
  const rows = await GymLead.findAll({ where: { gymId, ...(status ? { status } : {}) }, order: [['createdAt', 'DESC']], limit: 200 });
  const counts = await GymLead.count({ where: { gymId }, group: ['status'] });
  return { items: rows.map(view), counts: Object.fromEntries(['new', 'contacted', 'joined', 'lost'].map((k) => [k, Number(counts.find((x) => x.status === k)?.count ?? 0)])) };
}

/**
 * PATCH …/leads/:leadId { status?, note?, memberId? } (owner or leads.manage): contacted, lost, joined (with the
 * member it became) or back to contacted; a note. 409 GYM_LEAD_STATE for a move the list does not allow.
 */
async function update(principal, gymId, leadId, input, req) {
  const a = await c.access(principal, gymId, 'leads.manage', { feature: FEATURE, restricted: true });
  return sequelize.transaction(async (transaction) => {
    const l = await GymLead.findOne({ where: { id: leadId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!l) throw E.notFound('Enquiry');
    const patch = { updatedBy: principal.id };
    if (input.note !== undefined) patch.note = input.note;
    if (input.status && input.status !== l.status) {
      if (!MOVES[l.status].includes(input.status)) throw c.fail('GYM_LEAD_STATE', { from: l.status, to: input.status });
      if (input.status === 'joined') {
        const m = input.memberId ? await c.ops.member(gymId, input.memberId, { transaction }) : null;
        if (!m) throw c.fail('GYM_MEMBER_UNKNOWN');
        patch.memberId = m.id;
        patch.joinedAt = new Date();
      }
      patch.status = input.status;
    }
    const before = { status: l.status };
    await l.update(patch, { transaction });
    await c.record({ action: 'gym_lead.updated', actor: a.actor, entityType: 'gym_lead', entityId: l.id, before, after: { status: l.status }, meta: { gymId }, req }, transaction);
    return view(l);
  });
}

/** POST …/leads/:leadId/reveal-phone (owner or leads.manage): the full number, audited, rate-limited per person (as M24-FR-12). */
async function revealPhone(principal, gymId, leadId, req) {
  const a = await c.access(principal, gymId, 'leads.manage', { feature: FEATURE });
  const l = await GymLead.findOne({ where: { id: leadId, gymId } });
  if (!l) throw E.notFound('Enquiry');
  const hit = await velocity.hit({ name: 'gym_phone_reveal', scope: principal.id, limit: require('../settings').settings.get('gym_manage.phone_reveals_per_hour'), windowMs: 3600000 });
  if (!hit.allowed) throw E.tooMany('RATE_LIMITED', 'Too many requests', 'Slow down and try again shortly.', { retryAfter: hit.retryAfter });
  await c.record({ action: 'gym_lead.phone_revealed', actor: a.actor, entityType: 'gym_lead', entityId: l.id, meta: { gymId }, req });
  return { leadId: l.id, phone: crypto.decrypt(l.phoneEnc) };
}

/** New enquiries waiting, for the dashboard. */
async function waiting(gymId) {
  return GymLead.count({ where: { gymId, status: 'new', createdAt: { [Op.gte]: new Date(Date.now() - 30 * 86400000) } } });
}

module.exports = { enquire, list, update, revealPhone, waiting };
