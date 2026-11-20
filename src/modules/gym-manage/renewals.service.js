'use strict';

/**
 * M24 §19 (FR-121 to FR-127; product owner, 11 Nov 2026): a linked member renews their own membership,
 * from the app or a reminder link, and pays online or at the counter.
 *  - Allowed from `gym_manage.self_renew_days_before` days before the end (and after it), unless the gym
 *    switched member renewals off, its panel is read-only, the member left or was removed, or a renewal
 *    already waits (rules.selfRenewBlock).
 *  - The member picks their current package, or any active package the gym sells online. The dates come
 *    from the desk's own rule (rules.renewStart: continuous inside the grace days, else from today). The
 *    price is the package price: no admission fee and no discount, as a renewal at the desk.
 *  - It reuses the desk's membership and due (memberships.createIn, origin renewal, created_via member).
 *    "counter": the fee waits as an unpaid due and the gym is told. "online": the due's payment starts
 *    through the existing pay-link flow (M06); an abandoned payment leaves the due to pay later either way.
 *  - The member can cancel a renewal they made while it has not started and nothing is paid on it.
 * Counter money stays bookkeeping; online fees go through M06 unchanged. No table of another module is
 * written.
 */
const { Op } = require('sequelize');
const { sequelize, GymMember, GymMembership, GymDue } = require('../../models');
const { E } = require('../../common/errors');
const gymFacade = require('../gym').gyms;
const packagesFacade = require('../gym').packages;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const view = require('./gym-manage.serializer');
const memberships = require('./memberships.service');
const linksPay = require('./links-pay.service');

const { fail } = c;
const LIVE = ['upcoming', 'active', 'frozen', 'expired'];
const gymRef = (g) => ({ id: g.id, name: g.name, slug: g.slug });

/** My linked member row and its gym, or 404 (a past or someone else's membership cannot be renewed). */
async function mineWithGym(principal, memberId) {
  const m = await GymMember.findOne({ where: { id: memberId, userId: principal.id, status: { [Op.ne]: 'removed' } } });
  const gym = m ? await gymFacade.get(m.gymId) : null;
  if (!m || !gym) throw E.notFound('Membership');
  return { m, gym };
}

/** Where the member stands: the latest membership, a waiting renewal, and why they cannot renew (or null). */
async function stateOf(member, gym, { transaction } = {}) {
  const [settings, sub, rows] = await Promise.all([
    c.settingsOf(gym.id, { transaction }),
    c.subscriptionOf(gym.ownerId, { transaction }),
    GymMembership.findAll({ where: { memberId: member.id, status: LIVE }, order: [['startsOn', 'DESC']], transaction }),
  ]);
  const today = c.today();
  const upcoming = rows.find((r) => r.status === 'upcoming') ?? null;
  const latest = rows.find((r) => r.status !== 'upcoming') ?? null;
  const block = rules.selfRenewBlock({
    open: Boolean(settings?.selfRenewOpen) && gym.status !== 'suspended',
    restricted: sub.status === 'restricted',
    memberStatus: member.status,
    latest,
    upcoming,
    today,
    daysBefore: c.cfg().selfRenewDaysBefore,
  });
  return { today, latest, upcoming, block };
}

/** The packages a member may renew with: their current one while the gym still sells it, and those sold online. */
async function choices(gym, latest, today) {
  const start = rules.renewStart({ today, oldEndsOn: latest.endsOn, graceDays: c.cfg().renewGraceDays });
  return (await packagesFacade.forGym(gym.id))
    .filter((p) => p.id === latest.packageId || p.channel !== 'desk')
    .map((p) => ({
      packageId: p.id,
      title: p.title,
      kind: p.kind,
      days: p.days,
      pricePoisha: p.pricePoisha,
      startsOn: start.startsOn,
      endsOn: rules.endsOn({ startsOn: start.startsOn, days: p.days }),
      current: p.id === latest.packageId,
    }));
}

/** A waiting renewal as the member sees it, with its fee and whether they may still cancel it. */
async function renewalView(ms, { transaction } = {}) {
  const due = await GymDue.findOne({ where: { membershipId: ms.id }, transaction });
  const st = due ? rules.dueState({ amount: due.amountPoisha, paid: due.paidPoisha, waived: due.waivedPoisha, voided: due.status === 'void' }) : null;
  return {
    membershipId: ms.id,
    title: ms.title,
    packageKind: ms.packageKind,
    startsOn: ms.startsOn,
    endsOn: ms.endsOn,
    createdVia: ms.createdVia,
    dueId: due?.id ?? null,
    amountPoisha: due?.amountPoisha ?? 0,
    outstandingPoisha: st?.outstanding ?? 0,
    cancellable: !rules.selfRenewCancelBlock({ membership: ms, paidPoisha: due?.paidPoisha ?? 0 }),
  };
}

/**
 * GET /me/gym-memberships/:memberId/renewal (linked): can I renew, or why not; the packages with their
 * dates and price; a renewal that already waits; and whether the gym takes fees online.
 */
async function options(principal, memberId) {
  const { m, gym } = await mineWithGym(principal, memberId);
  const st = await stateOf(m, gym);
  const online = await c.onlineFees(gym);
  const cfg = c.cfg();
  return {
    memberId: m.id,
    gym: gymRef(gym),
    can: !st.block,
    reason: st.block?.code ?? null,
    opensOn: st.block?.code === 'GYM_RENEW_TOO_EARLY' ? st.block.meta.from : null,
    daysBefore: cfg.selfRenewDaysBefore,
    current: st.latest ? { title: st.latest.title, packageKind: st.latest.packageKind, endsOn: st.latest.endsOn, status: st.latest.status } : null,
    packages: st.block ? [] : await choices(gym, st.latest, st.today),
    renewal: st.upcoming ? await renewalView(st.upcoming) : null,
    onlineFees: online.ok,
    onlineFeesReason: online.reason,
  };
}

/** The package to renew with: the one asked for (it must be on the member's list), else the current one. */
async function pickPackage(gym, latest, today, packageId) {
  const list = await choices(gym, latest, today);
  const chosen = list.find((p) => (packageId ? p.packageId === packageId : p.current));
  if (!chosen) throw fail('GYM_PACKAGE_UNAVAILABLE');
  return memberships.deskPackage(gym.id, chosen.packageId, { anyChannel: true });
}

/**
 * POST /me/gym-memberships/:memberId/renew { packageId?, pay } [Idempotency-Key] (gate join_gym, FR-123).
 * → 201 { membership, due, payment }: `payment` (the M06 payment to open) only when paying online.
 */
async function renew(principal, memberId, { packageId = null, pay }, idempotencyKey, req) {
  const { gym } = await mineWithGym(principal, memberId);
  c.refuseSuspended(gym);
  // Asked to pay online at a gym that cannot take fees online: refused before anything is made.
  if (pay === 'online') await c.requireOnlineFees(gym);
  const now = new Date();
  const made = await sequelize.transaction(async (transaction) => {
    const member = await memberships.lockedMember(gym.id, memberId, transaction);
    if (member.userId !== principal.id) throw E.notFound('Membership');
    const st = await stateOf(member, gym, { transaction });
    if (st.block) throw fail(st.block.code, st.block.meta);
    const pkg = await pickPackage(gym, st.latest, st.today, packageId);
    const start = rules.renewStart({ today: st.today, oldEndsOn: st.latest.endsOn, graceDays: c.cfg().renewGraceDays });
    const m = await memberships.createIn(transaction, { gym, member, pkg, startsOn: start.startsOn, origin: 'renewal', previousId: st.latest.id, actor: principal, today: st.today, createdVia: 'member' });
    const outstanding = rules.dueState({ amount: m.due.amountPoisha, paid: 0, waived: 0 }).outstanding;
    await c.record(
      { action: 'gym_membership.renewed_by_member', actor: principal, entityType: 'gym_membership', entityId: m.membership.id, entityCode: member.memberCode, after: { title: pkg.title, startsOn: m.membership.startsOn, endsOn: m.membership.endsOn, pay }, meta: { gymId: gym.id }, req },
      transaction
    );
    await c.publish(
      transaction,
      'gym_membership.self_renewed',
      'gym_membership',
      m.membership.id,
      { membershipId: m.membership.id, memberId: member.id, gymId: gym.id, ownerId: gym.ownerId, userId: principal.id, dueId: m.due.id, amount: m.due.amountPoisha, title: pkg.title, startsOn: m.membership.startsOn, endsOn: m.membership.endsOn, pay },
      principal
    );
    let payment = null;
    if (pay === 'online' && outstanding > 0) {
      const link = await linksPay.createLinkIn(transaction, { gym, due: m.due, member, origin: 'member', by: principal.id, actor: principal, now });
      payment = await linksPay.startPaymentIn(transaction, { link, gym, member, principal, idempotencyKey, linkAccount: false });
    }
    return { ...m, payment };
  });
  return {
    membership: view.membershipView(made.membership, { today: c.today(now), dueId: made.due.id }),
    due: { dueId: made.due.id, amountPoisha: made.due.amountPoisha, dueOn: made.due.dueOn, status: made.due.status },
    payment: made.payment ? { paymentId: made.payment.paymentId, payUrl: made.payment.payUrl, amountPoisha: made.payment.amountPoisha } : null,
  };
}

/**
 * POST /me/gym-memberships/:memberId/renewal/cancel (FR-125): the member takes back a renewal they made,
 * while it has not started and nothing is paid on it. The membership is cancelled and its due voided (the
 * desk's own cancel); an online payment that still arrives is refunded by M06 (the due no longer needs it).
 */
async function cancel(principal, memberId, req) {
  const { gym } = await mineWithGym(principal, memberId);
  const today = c.today();
  await sequelize.transaction(async (transaction) => {
    const member = await memberships.lockedMember(gym.id, memberId, transaction);
    if (member.userId !== principal.id) throw E.notFound('Membership');
    const ms = await GymMembership.findOne({ where: { memberId: member.id, status: 'upcoming' }, transaction, lock: transaction.LOCK.UPDATE });
    const due = ms ? await GymDue.findOne({ where: { membershipId: ms.id }, transaction }) : null;
    const block = rules.selfRenewCancelBlock({ membership: ms, paidPoisha: due?.paidPoisha ?? 0 });
    if (block) throw fail(block.code, block.meta);
    await memberships.cancelIn(transaction, { ms, member, reason: 'Cancelled by the member', today, actor: principal, by: principal.id });
    await c.record({ action: 'gym_membership.renewal_cancelled_by_member', actor: principal, entityType: 'gym_membership', entityId: ms.id, entityCode: member.memberCode, after: { status: 'cancelled' }, meta: { gymId: gym.id }, req }, transaction);
  });
  return options(principal, memberId);
}

module.exports = { options, renew, cancel };
