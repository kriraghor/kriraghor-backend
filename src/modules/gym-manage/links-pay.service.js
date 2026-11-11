'use strict';

/**
 * M24 online fee payments, no margin (§5.5, §6.3, §8.5): payment links, paying through M06, the capture
 * hook, the hold's release with the provider charge, owner refunds from the hold, and the member's dues.
 *  - A link (fees.collect, Idempotency-Key) needs the owner's gym_owner role (list_gym), the
 *    online_fees feature and no restriction (FR-02, FR-40: 403 GYM_ONLINE_FEES_UNAVAILABLE {reason});
 *    up to the outstanding (all of it by default), open for gym_manage.pay_link_hours, one open link per
 *    due (409 GYM_PAY_LINK_OPEN). It is sent in-app, by push and by email when channels are chosen.
 *  - Anyone signed in with a verified phone pays (gate join_gym, FR-41); M06 purpose gym_membership_fee,
 *    payee the owner. When the payer's phone matches the member's and they tick "Link this membership",
 *    the account is linked with the payment record (the consent travels on the payment).
 *  - Capture (M06 onCaptured, FR-42): a fee payment row (method online) with the provider charge
 *    snapshot (FR-43), the link paid with release_at = paid_at + gym_manage.online_fee_release_hours.
 *    When the due no longer needs the amount, M06 refunds the whole payment (late_capture) and nothing
 *    is recorded.
 *  - Release (job, FR-44, FR-45): the hold goes to the owner's payable less the provider charge, which
 *    is credited to provider_fee_expense; nothing reaches fee_revenue. Until then the owner may refund
 *    from the hold (once per payment); refund.succeeded writes the reversal row.
 */
const crypto = require('crypto');
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const config = require('../../config');
const logger = require('../../common/logger');
const { sequelize, GymPaymentLink, GymDue, GymMember, GymMembership, GymFeePayment, GymLinkRequest } = require('../../models');
const payments = require('../payments');
const settings = require('../settings').settings;
const directory = require('../users').directory;
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const view = require('./gym-manage.serializer');
const dues = require('./dues.service');
const notices = require('./notices.service');

const { fail } = c;
const PURPOSE = 'gym_membership_fee';
// Prompt 3b: sms when the staff choose it and the SMS add-on allows it (else the other channels carry it).
const CHANNELS = ['in_app', 'email', 'sms'];

// ---------------------------------------------------------------- links

const tokenOf = (l) => rules.payLinkToken({ linkId: l.id, nonce: l.tokenNonce }, c.sign);
const urlOf = (l) => `${config.apps.gym}/p/${tokenOf(l)}`;
/** The short link an SMS carries (prompt 3b): gym.kriraghor.com/p/<10 characters>; links made before have none. */
const shortUrlOf = (l) => (l.shortCode ? `${config.apps.gym}/p/${l.shortCode}` : urlOf(l));
/** The status a viewer sees: an open link past its expiry is expired (the job marks it). */
const statusOf = (l, now = new Date()) => (l.status === 'open' && new Date(l.expiresAt) <= now ? 'expired' : l.status);

function linkView(l, now = new Date()) {
  const url = urlOf(l);
  return {
    id: l.id,
    dueId: l.dueId,
    memberId: l.memberId,
    amountPoisha: l.amountPoisha,
    status: statusOf(l, now),
    origin: l.origin,
    channels: l.channels ?? [],
    expiresAt: c.iso(l.expiresAt),
    url,
    qr: url,
    paymentId: l.paymentId ?? null,
    paidAt: c.iso(l.paidAt),
    releaseAt: c.iso(l.releaseAt),
    releasedAt: c.iso(l.releasedAt),
    refundedPoisha: l.refundedPoisha,
    createdAt: c.iso(l.createdAt),
  };
}

/**
 * Create a link on a locked due (staff or the member area). Expires an open link that is past its time
 * first; another open link → 409 GYM_PAY_LINK_OPEN. Publishes gym_payment_link.created (the notice goes
 * out only when channels were chosen and the gym's reminders allow it, FR-55).
 */
async function createLinkIn(transaction, { gym, due, member, requested = null, channels = [], origin, by, actor, now = new Date() }) {
  const state = rules.dueState({ amount: due.amountPoisha, paid: due.paidPoisha, waived: due.waivedPoisha, voided: due.status === 'void' });
  const r = rules.linkAmount({ requested, status: state.status, outstanding: state.outstanding });
  if (r.block) throw fail(r.block, r.block === 'GYM_PAYMENT_EXCEEDS_DUE' ? { outstanding: state.outstanding } : { status: state.status });
  const open = await GymPaymentLink.findOne({ where: { dueId: due.id, status: 'open' }, transaction, lock: transaction.LOCK.UPDATE });
  if (open && new Date(open.expiresAt) > now) throw fail('GYM_PAY_LINK_OPEN', { linkId: open.id });
  if (open) await open.update({ status: 'expired' }, { transaction });
  const chosen = CHANNELS.filter((ch) => channels.includes(ch));
  const link = await GymPaymentLink.create(
    {
      dueId: due.id,
      memberId: member.id,
      gymId: gym.id,
      ownerId: gym.ownerId,
      amountPoisha: r.amount,
      tokenNonce: crypto.randomBytes(12).toString('base64url'),
      shortCode: rules.shortCode(crypto.randomBytes(10)),
      origin,
      channels: chosen,
      expiresAt: new Date(now.getTime() + c.cfg().payLinkHours * 3600000),
      createdBy: by,
    },
    { transaction }
  );
  const notice = chosen.length ? await notices.logImmediate(transaction, { kind: 'pay_link', member, gym, subjectType: 'link', subjectId: link.id, sms: chosen.includes('sms'), explicit: true }) : { notify: false, sms: null };
  const notify = notice.notify;
  await c.publish(
    transaction,
    'gym_payment_link.created',
    'gym_payment_link',
    link.id,
    { linkId: link.id, dueId: due.id, memberId: member.id, gymId: gym.id, ownerId: gym.ownerId, amount: link.amountPoisha, expiresAt: c.iso(link.expiresAt), origin, channels: notify ? chosen : [], sms: notice.sms },
    actor
  );
  return link;
}

/** POST /manage/gyms/:gymId/dues/:dueId/payment-links { amountPoisha?, channels[] } [Idempotency-Key] (fees.collect). */
async function create(principal, gymId, dueId, body, req) {
  const a = await c.gymAccess(principal, gymId, 'fees.collect');
  await c.requireOnlineFees(a.gym);
  const now = new Date();
  try {
    const link = await sequelize.transaction(async (transaction) => {
      const due = await dues.lockDue(gymId, dueId, transaction);
      if (!due) throw E.notFound('Due');
      const member = await GymMember.findByPk(due.memberId, { transaction });
      if (member.status === 'removed') throw fail('GYM_MEMBER_STATE', { reason: 'removed' });
      const l = await createLinkIn(transaction, { gym: a.gym, due, member, requested: body.amountPoisha ?? null, channels: body.channels ?? ['in_app', 'email'], origin: 'staff', by: principal.id, actor: a.actor, now });
      await c.record({ action: 'gym_payment_link.created', actor: a.actor, entityType: 'gym_payment_link', entityId: l.id, entityCode: member.memberCode, after: { amount: l.amountPoisha, dueId, channels: l.channels, expiresAt: c.iso(l.expiresAt) }, meta: { gymId }, req }, transaction);
      return l;
    });
    return c.shown(a, linkView(link, now));
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw fail('GYM_PAY_LINK_OPEN');
    throw err;
  }
}

/** GET /manage/gyms/:gymId/payment-links?dueId&status (fees.collect): newest first. */
async function list(principal, gymId, { dueId, status } = {}) {
  const a = await c.gymAccess(principal, gymId, 'fees.collect');
  const rows = await GymPaymentLink.findAll({ where: { gymId, ...(dueId ? { dueId } : {}), ...(status ? { status } : {}) }, order: [['createdAt', 'DESC']], limit: 200 });
  const now = new Date();
  return c.shown(a, { items: rows.map((l) => linkView(l, now)) });
}

/** POST /manage/gyms/:gymId/payment-links/:linkId/cancel (fees.collect): an open link only. */
async function cancel(principal, gymId, linkId, req) {
  const a = await c.gymAccess(principal, gymId, 'fees.collect');
  const link = await sequelize.transaction(async (transaction) => {
    const l = await GymPaymentLink.findOne({ where: { id: linkId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!l) throw E.notFound('Payment link');
    if (l.status !== 'open') throw fail('GYM_PAY_LINK_EXPIRED', { status: l.status }, 'Only an open link can be cancelled');
    await l.update({ status: 'cancelled' }, { transaction });
    await c.record({ action: 'gym_payment_link.cancelled', actor: a.actor, entityType: 'gym_payment_link', entityId: l.id, before: { status: 'open' }, after: { status: 'cancelled' }, meta: { gymId, dueId: l.dueId }, req }, transaction);
    return l;
  });
  return c.shown(a, linkView(link));
}

// ---------------------------------------------------------------- paying (M24-FR-41)

/** The account's verified phone matches the member's (phone hash), so the payer may link (FR-41). */
async function phoneMatches(userId, member, { transaction } = {}) {
  const phone = await directory.verifiedPhoneOf(userId, { transaction });
  return Boolean(phone) && c.phoneHash(phone) === member.phoneHash;
}

/** May this payer be linked to this member (unlinked, phones match, no other member of the gym linked to them)? */
async function canLink(userId, member, { transaction } = {}) {
  if (member.userId || member.status === 'removed') return false;
  if (!(await phoneMatches(userId, member, { transaction }))) return false;
  const other = await GymMember.findOne({ where: { gymId: member.gymId, userId, status: { [Op.ne]: 'removed' } }, attributes: ['id'], transaction });
  return !other;
}

const PAYABLE = (l, now) => l.status === 'open' && new Date(l.expiresAt) > now;

/** Start the M06 payment of a payable link, inside the caller's transaction → { paymentId, payUrl, amountPoisha, willLink }. */
async function startPaymentIn(transaction, { link, gym, member, principal, idempotencyKey, linkAccount }) {
  const ms = await GymMembership.findOne({ where: { id: (await GymDue.findByPk(link.dueId, { attributes: ['membershipId'], transaction })).membershipId }, attributes: ['title'], transaction });
  const willLink = Boolean(linkAccount) && (await canLink(principal.id, member, { transaction }));
  const p = await payments.intents.createIntent(
    {
      purpose: PURPOSE,
      purposeId: link.id,
      payerId: principal.id,
      payeeId: gym.ownerId,
      amount: link.amountPoisha,
      title: `${ms?.title ?? 'Membership fee'} · ${gym.name}`.slice(0, 120),
      idempotencyKey: `gym_fee:${link.id}:${idempotencyKey}`,
      purposeData: { linkAccount: willLink },
    },
    { transaction }
  );
  return { paymentId: p.id, payUrl: payments.intents.payUrl(p.id, PURPOSE), amountPoisha: link.amountPoisha, willLink };
}

/** The link behind a public token, or 404 (a token for another link fails the HMAC). */
async function linkOfToken(token, { transaction, lock = false } = {}) {
  // Prompt 3b: the short code of an SMS link (10 Crockford characters, unique while set).
  if (rules.looksLikeShortCode(token)) {
    const short = await GymPaymentLink.findOne({ where: { shortCode: token }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!short) throw E.notFound('Payment link');
    return short;
  }
  const parsed = rules.parsePayLinkToken(token, { sign: c.sign, equal: require('../../common/crypto').timingSafeEqualHex });
  if (!parsed) throw E.notFound('Payment link');
  const link = await GymPaymentLink.findByPk(parsed.linkId, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!link || link.tokenNonce !== parsed.nonce) throw E.notFound('Payment link');
  return link;
}

/**
 * GET /gym-pay/:token (public, noindex): the gym, the package, the amount, the member's code and first
 * name, the status; for a signed-in viewer whether their phone matches (the "link" tick); a receipt once paid.
 */
async function summary(token, principal = null) {
  const link = await linkOfToken(token);
  const now = new Date();
  const [gym, member, due] = await Promise.all([gymFacade.get(link.gymId), GymMember.findByPk(link.memberId), GymDue.findByPk(link.dueId)]);
  const ms = due ? await GymMembership.findByPk(due.membershipId) : null;
  const status = statusOf(link, now);
  const paid = status === 'paid' ? await GymFeePayment.findOne({ where: { linkId: link.id, amountPoisha: { [Op.gt]: 0 } } }) : null;
  const online = gym ? await c.onlineFees(gym) : { ok: false, reason: 'restricted' };
  return {
    link: { id: link.id, status, amountPoisha: link.amountPoisha, expiresAt: c.iso(link.expiresAt) },
    gym: gym ? { id: gym.id, name: gym.name, slug: gym.slug } : null,
    member: { memberCode: member.memberCode, firstName: rules.firstName(member.displayName) },
    membership: ms ? { title: ms.title, packageKind: ms.packageKind, startsOn: ms.startsOn, endsOn: ms.endsOn } : null,
    dueOn: due?.dueOn ?? null,
    onlineFees: online.ok,
    receipt: paid ? { receiptNo: paid.receiptNo, url: c.receiptUrlOf(paid.id) } : null,
    viewer: principal ? { phoneMatches: await phoneMatches(principal.id, member), linked: member.userId === principal.id, canLink: await canLink(principal.id, member) } : null,
  };
}

/** POST /gym-pay/:token/pay { linkAccount } [Idempotency-Key] (gate join_gym) → { paymentId, payUrl, amountPoisha, willLink }. */
async function payLink(principal, token, { linkAccount = false }, idempotencyKey) {
  const now = new Date();
  return sequelize.transaction(async (transaction) => {
    const link = await linkOfToken(token, { transaction, lock: true });
    if (link.status === 'paid') throw fail('GYM_DUE_STATE', { status: 'paid' }, 'This link is already paid');
    if (!PAYABLE(link, now)) throw fail('GYM_PAY_LINK_EXPIRED');
    const gym = await gymFacade.get(link.gymId, { transaction });
    if (!gym) throw E.notFound('Payment link');
    await c.requireOnlineFees(gym);
    const member = await GymMember.findByPk(link.memberId, { transaction });
    const due = await dues.lockDue(gym.id, link.dueId, transaction);
    const state = rules.dueState({ amount: due.amountPoisha, paid: due.paidPoisha, waived: due.waivedPoisha, voided: due.status === 'void' });
    if (rules.captureDecision({ dueStatus: state.status, outstanding: state.outstanding, amount: link.amountPoisha, linkStatus: link.status }) !== 'record') throw fail('GYM_DUE_STATE', { status: state.status });
    return startPaymentIn(transaction, { link, gym, member, principal, idempotencyKey, linkAccount });
  });
}

// ---------------------------------------------------------------- the member's dues (/me)

/** The member rows linked to me (not removed). */
const myLinked = (principal) => GymMember.findAll({ where: { userId: principal.id, status: { [Op.ne]: 'removed' } } });

/** GET /me/gym-dues: outstanding dues across my gyms, whether each gym takes fees online, its open link. */
async function myDues(principal) {
  const members = await myLinked(principal);
  if (!members.length) return { items: [] };
  const today = c.today();
  const now = new Date();
  const rows = await GymDue.findAll({ where: { memberId: members.map((m) => m.id), status: ['unpaid', 'partial'] }, order: [['dueOn', 'ASC']] });
  const links = await GymPaymentLink.findAll({ where: { dueId: rows.map((d) => d.id), status: 'open' } });
  const mss = new Map((await GymMembership.findAll({ where: { id: rows.map((d) => d.membershipId) } })).map((m) => [m.id, m]));
  const byMember = new Map(members.map((m) => [m.id, m]));
  const gyms = new Map();
  for (const m of members) {
    if (gyms.has(m.gymId)) continue;
    const g = await gymFacade.get(m.gymId);
    gyms.set(m.gymId, { ref: g ? { id: g.id, name: g.name, slug: g.slug } : null, online: g ? await c.onlineFees(g) : { ok: false, reason: 'restricted' } });
  }
  return {
    items: rows.map((d) => {
      const m = byMember.get(d.memberId);
      const g = gyms.get(m.gymId);
      const st = rules.dueState({ amount: d.amountPoisha, paid: d.paidPoisha, waived: d.waivedPoisha });
      const ms = mss.get(d.membershipId);
      const l = links.find((x) => x.dueId === d.id && PAYABLE(x, now));
      return {
        dueId: d.id,
        memberId: m.id,
        memberCode: m.memberCode,
        gym: g.ref,
        membership: ms ? { title: ms.title, packageKind: ms.packageKind, startsOn: ms.startsOn, endsOn: ms.endsOn } : null,
        amountPoisha: d.amountPoisha,
        paidPoisha: d.paidPoisha,
        outstandingPoisha: st.outstanding,
        dueOn: d.dueOn,
        status: d.status,
        overdue: rules.isOverdue({ status: d.status, dueOn: d.dueOn, today }),
        onlineFees: g.online.ok,
        onlineFeesReason: g.online.reason,
        openLink: l ? { id: l.id, amountPoisha: l.amountPoisha, expiresAt: c.iso(l.expiresAt), url: urlOf(l) } : null,
      };
    }),
  };
}

/**
 * POST /me/gym-dues/:dueId/pay [Idempotency-Key] (gate join_gym, a due of a membership linked to me):
 * reuses the due's open link, or creates one for the outstanding (origin member), then starts the payment.
 */
async function payMyDue(principal, dueId, idempotencyKey) {
  const now = new Date();
  const d = await GymDue.findByPk(dueId);
  const member = d ? await GymMember.findOne({ where: { id: d.memberId, userId: principal.id, status: { [Op.ne]: 'removed' } } }) : null;
  if (!member) throw E.notFound('Due');
  const gym = await gymFacade.get(member.gymId);
  if (!gym) throw E.notFound('Due');
  await c.requireOnlineFees(gym);
  try {
    return await sequelize.transaction(async (transaction) => {
      const due = await dues.lockDue(gym.id, dueId, transaction);
      let link = await GymPaymentLink.findOne({ where: { dueId, status: 'open' }, transaction, lock: transaction.LOCK.UPDATE });
      if (!link || !PAYABLE(link, now)) link = await createLinkIn(transaction, { gym, due, member, origin: 'member', by: principal.id, actor: principal, now });
      return startPaymentIn(transaction, { link, gym, member, principal, idempotencyKey, linkAccount: false });
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw fail('GYM_PAY_LINK_OPEN');
    throw err;
  }
}

// ---------------------------------------------------------------- capture (M06 hook, M24-FR-42, FR-43)

/**
 * Link the payer to the member with the payment record (FR-41): an accepted gym_invite row keeps who
 * linked (the member area finds past links through it), then gym_member.linked.
 */
async function linkPayerIn(transaction, { member, userId, now }) {
  await GymLinkRequest.create({ gymId: member.gymId, ownerId: member.ownerId, direction: 'gym_invite', memberId: member.id, userId, status: 'accepted', expiresAt: now, decidedAt: now, decidedBy: userId, createdBy: userId }, { transaction });
  await member.update({ userId, linkedAt: now, unlinkedAt: null, version: member.version + 1 }, { transaction });
  await c.publish(transaction, 'gym_member.linked', 'gym_member', member.id, { memberId: member.id, gymId: member.gymId, ownerId: member.ownerId, userId, by: userId });
  await c.record({ action: 'gym_member.linked', actor: { id: userId }, entityType: 'gym_member', entityId: member.id, entityCode: member.memberCode, after: { linked: true, via: 'online_payment' }, meta: { gymId: member.gymId } }, transaction);
}

/**
 * M06 onCaptured for gym_membership_fee, inside the capture transaction: 'accept' records the online fee
 * payment and its receipt; 'reject' makes M06 refund the whole payment (late_capture) when the due no
 * longer needs it (paid at the counter meanwhile, waived, cancelled) or the link was cancelled.
 */
async function onCaptured({ payment, transaction }) {
  const now = new Date();
  const link = await GymPaymentLink.findByPk(payment.purposeId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!link || link.amountPoisha !== payment.amountPoisha) return 'reject';
  const gym = await gymFacade.get(link.gymId, { transaction });
  if (!gym) return 'reject';
  const member = await GymMember.findByPk(link.memberId, { transaction, lock: transaction.LOCK.UPDATE });
  const due = await dues.lockDue(gym.id, link.dueId, transaction);
  const state = rules.dueState({ amount: due.amountPoisha, paid: due.paidPoisha, waived: due.waivedPoisha, voided: due.status === 'void' });
  if (member.status === 'removed' || rules.captureDecision({ dueStatus: state.status, outstanding: state.outstanding, amount: payment.amountPoisha, linkStatus: link.status }) !== 'record') return 'reject';
  const cfg = c.cfg();
  const charge = rules.providerCharge({ amount: payment.amountPoisha, method: payment.method, passthrough: cfg.providerPassthrough, bpsMap: cfg.providerBps });
  const settingVersion = settings.snapshot(['gym_manage.online_fee_provider_bps'])['gym_manage.online_fee_provider_bps'].version;
  await dues.recordIn(transaction, {
    gym,
    member,
    due,
    amount: payment.amountPoisha,
    method: 'online',
    paidOn: c.today(now),
    receivedBy: null,
    actor: null,
    now,
    min: 1,
    online: { paymentId: payment.id, linkId: link.id, payerUserId: payment.payerId, providerChargeBps: charge.bps, providerChargePoisha: charge.charge, providerSettingVersion: settingVersion },
  });
  await link.update({ status: 'paid', paymentId: payment.id, paidAt: now, releaseAt: new Date(now.getTime() + cfg.onlineFeeReleaseHours * 3600000) }, { transaction });
  if (payment.escrow?.purposeData?.linkAccount && (await canLink(payment.payerId, member, { transaction }))) await linkPayerIn(transaction, { member, userId: payment.payerId, now });
  return 'accept';
}
payments.purposes.register(PURPOSE, { onCaptured });

// ---------------------------------------------------------------- release (job, M24-FR-44, FR-45)

/**
 * Job gym-manage.online-fee-release: paid links whose release time has come → M06 release of what the
 * hold still holds to the owner's payable, less the snapshotted provider charge (to
 * provider_fee_expense); released_at set in the same transaction. A hold refunded in full leaves
 * nothing to release (release_at cleared); a frozen hold waits.
 */
async function releaseDue(now = new Date()) {
  const rows = await GymPaymentLink.findAll({ where: { status: 'paid', releasedAt: null, releaseAt: { [Op.lte]: now } }, attributes: ['id'], order: [['releaseAt', 'ASC']], limit: 500 });
  let released = 0;
  for (const { id } of rows) {
    try {
      const done = await sequelize.transaction(async (transaction) => {
        const link = await GymPaymentLink.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
        if (link.status !== 'paid' || link.releasedAt || !link.releaseAt || new Date(link.releaseAt) > now) return false;
        const hold = await payments.escrow.lockHoldForPayment(link.paymentId, transaction);
        if (!hold || hold.status === 'frozen') return false;
        const available = hold.heldPoisha - hold.releasedPoisha - hold.refundedPoisha;
        if (available <= 0 || !['holding', 'partially_released'].includes(hold.status)) {
          await link.update({ releaseAt: null }, { transaction });
          return false;
        }
        const fee = await GymFeePayment.findOne({ where: { paymentId: link.paymentId, amountPoisha: { [Op.gt]: 0 } }, attributes: ['providerChargePoisha'], transaction });
        await payments.escrow.releaseInTx(hold, { transaction, kind: 'escrow.release_gym_fee', providerCharge: fee?.providerChargePoisha ?? 0 });
        await link.update({ releasedAt: now }, { transaction });
        return true;
      });
      if (done) released += 1;
    } catch (err) {
      logger.error({ err: err.message, linkId: id }, 'gym fee release failed');
    }
  }
  return { due: rows.length, released };
}

/** Job gym-manage.links-expire: open links past expires_at → expired (status guard). */
async function expireLinks(now = new Date()) {
  const [n] = await GymPaymentLink.update({ status: 'expired' }, { where: { status: 'open', expiresAt: { [Op.lte]: now } } });
  return { expired: n };
}

// ---------------------------------------------------------------- refunds (M24-FR-44)

/**
 * POST /manage/gyms/:gymId/fee-payments/:feePaymentId/refund { amountPoisha, reason } [Idempotency-Key]
 * (owner, gym_owner role active): an online payment, from the hold, before its release time, once.
 * M06 refunds it; refund.succeeded writes the reversal row.
 */
async function refund(principal, gymId, feePaymentId, { amountPoisha, reason }, req) {
  const a = await c.gymAccess(principal, gymId, 'owner.only');
  if ((await directory.roleStatus(a.gym.ownerId, 'gym_owner')) !== 'active') throw fail('GYM_ONLINE_FEES_UNAVAILABLE', { reason: 'role' });
  const now = new Date();
  const p = await GymFeePayment.findOne({ where: { id: feePaymentId, gymId, amountPoisha: { [Op.gt]: 0 } } });
  if (!p) throw E.notFound('Payment');
  if (p.method !== 'online' || !p.linkId) throw fail('GYM_PAYMENT_NOT_REVERSIBLE', { reason: 'not_online' });
  const out = await sequelize.transaction(async (transaction) => {
    const link = await GymPaymentLink.findByPk(p.linkId, { transaction, lock: transaction.LOCK.UPDATE });
    const reversed = await GymFeePayment.findOne({ where: { reversesId: p.id }, attributes: ['id'], transaction });
    const block = rules.refundBlock({ link, now, amount: amountPoisha, alreadyRefunded: Boolean(reversed) || link.refundedPoisha > 0 });
    if (block) throw fail(block, block === 'GYM_REFUND_EXCEEDS_PAID' ? { refundable: link.amountPoisha - link.refundedPoisha } : null);
    const r = await payments.refunds.refundPayment({ paymentId: p.paymentId, amount: amountPoisha, reasonCode: 'gym_owner_refund', reasonText: reason, idempotencyKey: `gym_refund:${p.id}`, actor: principal }, { transaction });
    if (!r) throw fail('GYM_PAYMENT_NOT_REVERSIBLE', { reason: 'not_captured' });
    await link.update({ refundedPoisha: link.refundedPoisha + amountPoisha }, { transaction });
    await c.record({ action: 'gym_fee.refunded', actor: a.actor, entityType: 'gym_fee_payment', entityId: p.id, entityCode: p.receiptNo, after: { amount: amountPoisha, refundId: r.id }, reason, meta: { gymId, paymentId: p.paymentId }, req }, transaction);
    return { refundId: r.id, status: r.status };
  });
  return { refund: { id: out.refundId, amountPoisha, status: out.status }, payment: view.paymentView(p), link: linkView(await GymPaymentLink.findByPk(p.linkId)) };
}

/**
 * refund.succeeded (M06) for a gym fee payment: the reversal row (method online) once, for an owner
 * refund or any other refund of a recorded payment. A late-capture refund of an unrecorded payment
 * does nothing.
 */
async function onRefundSucceeded(payload, { transaction }) {
  if (payload.purpose !== PURPOSE) return;
  const original = await GymFeePayment.findOne({ where: { paymentId: payload.paymentId, amountPoisha: { [Op.gt]: 0 } }, transaction });
  if (!original) return;
  if (await GymFeePayment.findOne({ where: { reversesId: original.id }, attributes: ['id'], transaction })) return;
  const gym = await gymFacade.get(original.gymId, { transaction });
  const due = await dues.lockDue(original.gymId, original.dueId, transaction);
  const amount = Math.min(payload.amount, original.amountPoisha);
  await dues.reverseIn(transaction, { gym: gym ?? { id: original.gymId, ownerId: original.ownerId }, due, original, reason: 'Refunded online', by: null, actor: null, today: c.today(), amount, online: { paymentId: payload.paymentId } });
  const link = original.linkId ? await GymPaymentLink.findByPk(original.linkId, { transaction, lock: transaction.LOCK.UPDATE }) : null;
  if (link && link.refundedPoisha < amount) await link.update({ refundedPoisha: amount }, { transaction });
}

// ---------------------------------------------------------------- reconcile and invariants (§10, §7.2)

/** No released_at without a matching M06 release (§7.2): each released link's hold has released money. */
async function releasedWithoutRelease({ limit = 1000 } = {}) {
  const rows = await GymPaymentLink.findAll({ where: { releasedAt: { [Op.ne]: null } }, attributes: ['id', 'paymentId'], order: [['releasedAt', 'DESC']], limit });
  const bad = [];
  for (const l of rows) {
    const holdId = await payments.escrow.holdIdForPayment(l.paymentId);
    const hold = holdId ? await payments.escrow.getOne(holdId) : null;
    if (!hold || hold.released <= 0) bad.push(l.id);
  }
  return bad;
}

module.exports = { PURPOSE, CHANNELS, linkView, urlOf, shortUrlOf, createLinkIn, startPaymentIn, create, list, cancel, summary, payLink, myDues, payMyDue, onCaptured, releaseDue, expireLinks, refund, onRefundSucceeded, releasedWithoutRelease };
