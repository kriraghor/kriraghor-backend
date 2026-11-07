'use strict';

/**
 * M27 round 2: reward points (feature `points`, Standard plan). Bookkeeping only: points are the gym's own
 * loyalty scheme, never money and never the ledger.
 *  - Earned (append-only gym_point_entries, each once): gym_ops.points_per_checkin for each counted check-in
 *    (FR-55); gym_ops.points_streak_bonus each time the run of days in a row reaches a multiple of
 *    gym_ops.points_streak_days (FR-56); gym_ops.points_referral when a referred friend's first fee is
 *    recorded (FR-57). Points expire gym_ops.points_expire_days after they are earned (FR-60, the daily job,
 *    first in first out).
 *  - Rewards (FR-58): the owner's list, each extra days on the running membership or money off what the member
 *    owes (up to gym_ops.reward_discount_max_poisha). Staff with rewards.redeem redeem at the desk (FR-59);
 *    gym-manage applies it to its own tables (ops.extendIn, ops.waiveIn) in the same transaction.
 *  - The owner can adjust a balance with a note (FR-61).
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymReward, GymPointEntry, GymMemberReferral } = require('../../models');
const rules = require('./gym-ops.rules');
const c = require('./gym-ops.common');

const FEATURE = 'points';

async function balanceOf(memberId, { transaction } = {}) {
  return Number((await GymPointEntry.sum('points', { where: { memberId }, transaction })) ?? 0);
}

/** Add an entry once (a unique ref answers a duplicate with nothing). Returns the entry or null. */
async function earnIn(transaction, { gymId, memberId, kind, points, refId = null, localDate, note = null, by = null }) {
  if (!points) return null;
  try {
    return await sequelize.transaction({ transaction }, async (t) => {
      const e = await GymPointEntry.create(
        { gymId, memberId, kind, points, refId, localDate, expiresOn: points > 0 ? rules.addDays(localDate, c.cfg().pointsExpireDays) : null, note, byUser: by },
        { transaction: t }
      );
      return e;
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------- consumers (inbox transaction)

/** gym_attendance.recorded (a counted check-in): check-in points and, when a run completes, the streak bonus. */
async function onCheckIn(payload, { transaction }) {
  if (!(await c.ops.featureOn(payload.gymId, FEATURE))) return;
  const cfg = c.cfg();
  const got = await earnIn(transaction, { gymId: payload.gymId, memberId: payload.memberId, kind: 'checkin', points: cfg.pointsPerCheckin, refId: payload.attendanceId, localDate: payload.localDate });
  const dates = await c.ops.checkInDates(payload.memberId, rules.addDays(payload.localDate, -400), { transaction });
  let streak = null;
  if (cfg.pointsStreakBonus && rules.streakBonusDue(dates, payload.localDate, cfg.pointsStreakDays)) {
    streak = await earnIn(transaction, { gymId: payload.gymId, memberId: payload.memberId, kind: 'streak', points: cfg.pointsStreakBonus, refId: payload.attendanceId, localDate: payload.localDate });
  }
  const total = (got?.points ?? 0) + (streak?.points ?? 0);
  if (total) {
    await c.publish(transaction, 'gym_points.earned', 'gym_member', payload.memberId, { gymId: payload.gymId, memberId: payload.memberId, points: total, streak: Boolean(streak), balance: await balanceOf(payload.memberId, { transaction }) });
  }
}

/** gym_fee.recorded: a referred member's first positive fee rewards the member who referred them (once). */
async function onFee(payload, { transaction }) {
  if (!payload.amount || payload.amount <= 0) return;
  const r = await GymMemberReferral.findOne({ where: { referredMemberId: payload.memberId, status: 'pending' }, transaction, lock: transaction.LOCK.UPDATE });
  if (!r) return;
  if (!(await c.ops.featureOn(r.gymId, FEATURE))) return;
  const e = await earnIn(transaction, { gymId: r.gymId, memberId: r.referrerMemberId, kind: 'referral', points: c.cfg().pointsReferral, refId: r.id, localDate: c.today() });
  await r.update({ status: 'rewarded', rewardedAt: new Date() }, { transaction });
  if (e) await c.publish(transaction, 'gym_points.earned', 'gym_member', r.referrerMemberId, { gymId: r.gymId, memberId: r.referrerMemberId, points: e.points, streak: false, balance: await balanceOf(r.referrerMemberId, { transaction }) });
}

// ---------------------------------------------------------------- rewards (the owner's list)

const rewardView = (x) => ({ id: x.id, title: x.title, points: x.points, kind: x.kind, value: x.value, status: x.status });

/** GET …/rewards (owner, rewards.redeem or members.view): the gym's rewards. */
async function rewards(principal, gymId) {
  await c.access(principal, gymId, null, { feature: FEATURE, anyOf: ['rewards.redeem', 'members.view'] });
  return { items: (await GymReward.findAll({ where: { gymId }, order: [['status', 'ASC'], ['points', 'ASC']] })).map(rewardView) };
}

/** PUT …/rewards { rewards: [{ id?, title, points, kind, value, status }] } (owner): the whole list (FR-58). */
async function saveRewards(principal, gymId, { rewards: list }, req) {
  const a = await c.access(principal, gymId, 'owner.only', { feature: FEATURE, restricted: true });
  const cfg = c.cfg();
  if (list.filter((x) => x.status !== 'retired').length > cfg.rewardsMax) throw c.fail('GYM_REWARD_LIMIT');
  for (const x of list) {
    if (x.kind === 'discount' && x.value > cfg.rewardDiscountMax) throw E.validation([{ field: 'value', message: `At most ${cfg.rewardDiscountMax} poisha off` }]);
  }
  await sequelize.transaction(async (transaction) => {
    const have = new Map((await GymReward.findAll({ where: { gymId }, transaction })).map((x) => [x.id, x]));
    for (const x of list) {
      const fields = { title: x.title, points: x.points, kind: x.kind, value: x.value, status: x.status ?? 'active' };
      if (x.id) {
        const row = have.get(x.id);
        if (!row) throw c.fail('GYM_REWARD_UNAVAILABLE');
        await row.update(fields, { transaction });
      } else await GymReward.create({ gymId, ...fields }, { transaction });
    }
    await c.record({ action: 'gym_reward.saved', actor: a.actor, entityType: 'gym', entityId: gymId, after: { count: list.length }, meta: { gymId }, req }, transaction);
  });
  return rewards(principal, gymId);
}

// ---------------------------------------------------------------- a member's points

async function history(memberId, limit = 50) {
  const rows = await GymPointEntry.findAll({ where: { memberId }, order: [['createdAt', 'DESC']], limit });
  return rows.map((e) => ({ id: e.id, kind: e.kind, points: e.points, localDate: e.localDate, expiresOn: e.expiresOn ?? null, note: e.note ?? null, at: c.iso(e.createdAt) }));
}

async function expiringSoon(memberId) {
  const today = c.today();
  const soon = rules.addDays(today, 30);
  return Number((await GymPointEntry.sum('points', { where: { memberId, points: { [Op.gt]: 0 }, expiresOn: { [Op.between]: [today, soon] } } })) ?? 0);
}

/** GET …/members/:memberId/points (members.view or rewards.redeem): balance, history, the rewards to redeem. */
async function memberPoints(principal, gymId, memberId) {
  await c.access(principal, gymId, null, { feature: FEATURE, anyOf: ['rewards.redeem', 'members.view'] });
  const m = await c.ops.member(gymId, memberId);
  if (!m) throw c.fail('GYM_MEMBER_UNKNOWN');
  const referral = await GymMemberReferral.findOne({ where: { referredMemberId: memberId } });
  const referrer = referral ? await c.ops.member(gymId, referral.referrerMemberId) : null;
  return {
    memberId,
    balance: await balanceOf(memberId),
    expiringIn30Days: await expiringSoon(memberId),
    history: await history(memberId),
    rewards: (await GymReward.findAll({ where: { gymId, status: 'active' }, order: [['points', 'ASC']] })).map(rewardView),
    referredBy: referrer ? { id: referrer.id, memberCode: referrer.memberCode, displayName: referrer.displayName, status: referral.status } : null,
  };
}

/**
 * POST …/members/:memberId/redeem { rewardId } (rewards.redeem; Idempotency-Key): spend points on a reward.
 * Days → the running membership ends later (409 GYM_MEMBERSHIP_NEEDED without one); money off → waived from
 * what the member owes (409 GYM_REWARD_NOTHING when nothing is owed). Points short → 409 GYM_POINTS_SHORT.
 */
async function redeem(principal, gymId, memberId, { rewardId }, req) {
  const a = await c.access(principal, gymId, 'rewards.redeem', { feature: FEATURE, restricted: true });
  const result = await sequelize.transaction(async (transaction) => {
    const m = await c.ops.member(gymId, memberId, { transaction });
    if (!m || ['left', 'removed'].includes(m.status)) throw c.fail('GYM_MEMBER_UNKNOWN');
    // One redemption at a time per member: lock the member's entries by a row lock on the reward and a fresh sum.
    const reward = await GymReward.findOne({ where: { id: rewardId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `gym_points:${memberId}` }, transaction });
    const balance = await balanceOf(memberId, { transaction });
    const block = rules.redeemBlock({ balance, reward: reward ? { status: reward.status, points: reward.points } : null });
    if (block) throw c.fail(block, block === 'GYM_POINTS_SHORT' ? { balance, needs: reward.points } : undefined);
    const reason = `Reward: ${reward.title}`;
    let applied;
    if (reward.kind === 'days') {
      applied = await c.ops.extendIn(transaction, { gymId, memberId, days: reward.value, reason, actor: a.actor, req });
      if (!applied) throw c.fail('GYM_MEMBERSHIP_NEEDED');
      applied = { kind: 'days', days: reward.value, endsOn: applied.endsOn };
    } else {
      const waived = await c.ops.waiveIn(transaction, { gymId, memberId, amount: reward.value, reason, actor: a.actor, req });
      if (!waived) throw c.fail('GYM_REWARD_NOTHING');
      applied = { kind: 'discount', waivedPoisha: waived };
    }
    const entry = await GymPointEntry.create({ gymId, memberId, kind: 'redeem', points: -reward.points, refId: reward.id, localDate: c.today(), note: reward.title, byUser: principal.id }, { transaction });
    await c.publish(transaction, 'gym_points.redeemed', 'gym_member', memberId, { gymId, memberId, rewardId: reward.id, points: reward.points, kind: reward.kind }, a.actor);
    await c.record({ action: 'gym_points.redeemed', actor: a.actor, entityType: 'gym_member', entityId: memberId, entityCode: m.memberCode, after: { reward: reward.title, points: reward.points, ...applied }, meta: { gymId }, req }, transaction);
    return { entryId: entry.id, applied, balance: balance - reward.points };
  });
  return { memberId, ...result };
}

/** POST …/members/:memberId/points/adjust { points, note } (owner): add or take points with a note (FR-61). */
async function adjust(principal, gymId, memberId, { points, note }, req) {
  const a = await c.access(principal, gymId, 'owner.only', { feature: FEATURE, restricted: true });
  await sequelize.transaction(async (transaction) => {
    const m = await c.ops.member(gymId, memberId, { transaction });
    if (!m) throw c.fail('GYM_MEMBER_UNKNOWN');
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `gym_points:${memberId}` }, transaction });
    const balance = await balanceOf(memberId, { transaction });
    if (balance + points < 0) throw c.fail('GYM_POINTS_SHORT', { balance });
    await GymPointEntry.create({ gymId, memberId, kind: 'adjust', points, localDate: c.today(), expiresOn: points > 0 ? rules.addDays(c.today(), c.cfg().pointsExpireDays) : null, note, byUser: principal.id }, { transaction });
    await c.record({ action: 'gym_points.adjusted', actor: a.actor, entityType: 'gym_member', entityId: memberId, entityCode: m.memberCode, after: { points }, reason: note, meta: { gymId }, req }, transaction);
  });
  return memberPoints(principal, gymId, memberId);
}

/**
 * POST …/members/:memberId/referral { referrerMemberId } (members.edit): who brought this member (FR-57). The
 * referrer earns when this member's first fee is recorded; a member is referred once.
 */
async function setReferral(principal, gymId, memberId, { referrerMemberId }, req) {
  const a = await c.access(principal, gymId, 'members.edit', { feature: FEATURE, restricted: true });
  if (referrerMemberId === memberId) throw E.validation([{ field: 'referrerMemberId', message: 'A member cannot refer themselves' }]);
  await sequelize.transaction(async (transaction) => {
    const [m, by] = [await c.ops.member(gymId, memberId, { transaction }), await c.ops.member(gymId, referrerMemberId, { transaction })];
    if (!m || !by) throw c.fail('GYM_MEMBER_UNKNOWN');
    try {
      await GymMemberReferral.create({ gymId, referrerMemberId, referredMemberId: memberId, byUser: principal.id }, { transaction });
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw c.fail('GYM_REFERRAL_EXISTS');
      throw err;
    }
    await c.record({ action: 'gym_member.referred', actor: a.actor, entityType: 'gym_member', entityId: memberId, entityCode: m.memberCode, after: { referrer: by.memberCode }, meta: { gymId }, req }, transaction);
  });
  return memberPoints(principal, gymId, memberId);
}

/** GET /me/gym-points?memberId: my balance, history and the gym's rewards (FR-59). */
async function mine(principal, { memberId }) {
  const m = await c.ops.memberOfUser(memberId, principal.id);
  if (!m) throw E.notFound('Membership');
  const on = await c.ops.featureOn(m.gymId, FEATURE);
  return {
    memberId: m.id,
    gymId: m.gymId,
    on,
    balance: await balanceOf(m.id),
    expiringIn30Days: await expiringSoon(m.id),
    history: await history(m.id, 30),
    rewards: on ? (await GymReward.findAll({ where: { gymId: m.gymId, status: 'active' }, order: [['points', 'ASC']] })).map(rewardView) : [],
    earn: on ? { perCheckin: c.cfg().pointsPerCheckin, streakDays: c.cfg().pointsStreakDays, streakBonus: c.cfg().pointsStreakBonus, referral: c.cfg().pointsReferral } : null,
  };
}

/** Job gym-ops.points-expire (daily, FR-60): points past their date expire, first in first out. */
async function expire() {
  const today = c.today();
  const members = await GymPointEntry.findAll({ attributes: ['memberId', 'gymId'], where: { points: { [Op.gt]: 0 }, expiresOn: { [Op.lt]: today } }, group: ['memberId', 'gymId'], raw: true });
  let expired = 0;
  for (const { memberId, gymId } of members) {
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `gym_points:${memberId}` }, transaction });
      const earnedDue = Number((await GymPointEntry.sum('points', { where: { memberId, points: { [Op.gt]: 0 }, expiresOn: { [Op.lt]: today } }, transaction })) ?? 0);
      const consumed = -Number((await GymPointEntry.sum('points', { where: { memberId, points: { [Op.lt]: 0 } }, transaction })) ?? 0);
      const n = rules.pointsToExpire({ earnedDue, consumed });
      if (!n) return;
      await GymPointEntry.create({ gymId, memberId, kind: 'expire', points: -n, localDate: today, note: 'Expired' }, { transaction });
      expired += n;
    });
  }
  return { expired };
}


module.exports = { balanceOf, onCheckIn, onFee, rewards, saveRewards, memberPoints, redeem, adjust, setReferral, mine, expire };
