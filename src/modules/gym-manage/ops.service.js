"use strict";

/**
 * What M27 gym-ops asks of gym-manage (through index.js `ops`, ADR-007 §3): a member of a gym, the fee money
 * a gym collected (the cash drawer, profit and loss), and since round 2 the members of a notice segment, how
 * to reach them, and two writes gym-manage makes on its own tables for a reward: extend the running
 * membership, or take money off what the member owes. gym-ops never writes gym-manage tables.
 */
const { Op, QueryTypes } = require("sequelize");
const { sequelize, GymMember, GymMembership, GymDue, GymFeePayment } = require("../../models");
const rules = require("./gym-manage.rules");
const c = require("./gym-manage.common");

/** A member of this gym (not removed) → { id, memberCode, displayName, status, linked } or null. */
async function member(gymId, memberId, { transaction } = {}) {
  const m = await GymMember.findOne({
    where: { id: memberId, gymId },
    transaction,
  });
  if (!m || m.status === "removed") return null;
  return {
    id: m.id,
    memberCode: m.memberCode,
    displayName: m.displayName,
    status: m.status,
    linked: Boolean(m.userId),
    userId: m.userId ?? null,
  };
}

/**
 * Fee money of a gym between two Dhaka dates (inclusive), for profit and loss (M27-FR-27):
 * counter = counter payments net of reversals (opening balances from imports left out);
 * online = online fees, and the provider charge passed through on them.
 */
async function collected(gymId, from, to) {
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(amount_poisha) FILTER (WHERE method NOT IN ('online', 'opening')), 0)::bigint AS counter,
            COALESCE(SUM(amount_poisha) FILTER (WHERE method = 'online'), 0)::bigint AS online,
            COALESCE(SUM(provider_charge_poisha) FILTER (WHERE method = 'online'), 0)::bigint AS "providerCharge"
       FROM gym_fee_payments WHERE gym_id = :gymId AND paid_on BETWEEN :from AND :to`,
    { replacements: { gymId, from, to }, type: QueryTypes.SELECT },
  );
  return {
    counterPoisha: Number(row.counter),
    onlinePoisha: Number(row.online),
    providerChargePoisha: Number(row.providerCharge),
  };
}

/** Cash fee money of a gym on one Dhaka date, net of reversals: what went into the drawer (M27-FR-07). */
async function cashCollected(gymId, day, { transaction } = {}) {
  const [row] = await sequelize.query(
    "SELECT COALESCE(SUM(amount_poisha), 0)::bigint AS cash FROM gym_fee_payments WHERE gym_id = :gymId AND paid_on = :day AND method = 'cash'",
    {
      replacements: { gymId, day },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  return Number(row.cash);
}

// ---------------------------------------------------------------- round 3

/**
 * M27-FR-78: fee money of a month by the trainer each member has now (members.trainer, M24-FR-21): counter
 * fees plus online fees less the provider charge, net of reversals, never the opening balance →
 * Map(businessMemberId → poisha).
 */
async function feesByTrainer(gymId, from, to) {
  const rows = await sequelize.query(
    `SELECT m.trainer_business_member_id AS "trainerId",
            COALESCE(SUM(p.amount_poisha - CASE WHEN p.method = 'online' THEN COALESCE(p.provider_charge_poisha, 0) ELSE 0 END), 0)::bigint AS total
       FROM gym_fee_payments p JOIN gym_members m ON m.id = p.member_id
      WHERE p.gym_id = :gymId AND p.paid_on BETWEEN :from AND :to AND p.method <> 'opening' AND m.trainer_business_member_id IS NOT NULL
      GROUP BY m.trainer_business_member_id`,
    { replacements: { gymId, from, to }, type: QueryTypes.SELECT },
  );
  return new Map(rows.map((r) => [r.trainerId, Math.max(0, Number(r.total))]));
}

/**
 * M27-FR-88 (the conversion report in gym-ops): the free trial visits dated in [from, to] and the join requests
 * received in it (Dhaka dates) by what became of them, and the members who joined in it by source. Counts and
 * member ids only (the ids let gym-ops count how many came from an enquiry); no names, no phones.
 */
async function conversionFacts(gymId, { from, to }) {
  const q = (sql) => sequelize.query(sql, { replacements: { gymId, from, to }, type: QueryTypes.SELECT });
  const [[visits], [joinRequests], members] = await Promise.all([
    q(`SELECT COUNT(*)::int AS booked,
              COUNT(*) FILTER (WHERE status = 'attended')::int AS attended,
              COUNT(*) FILTER (WHERE status = 'no_show')::int AS missed,
              COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              COUNT(*) FILTER (WHERE status = 'booked')::int AS waiting,
              COUNT(*) FILTER (WHERE member_id IS NOT NULL)::int AS joined
         FROM gym_visits WHERE gym_id = :gymId AND visit_date BETWEEN :from AND :to`),
    q(`SELECT COUNT(*)::int AS received,
              COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
              COUNT(*) FILTER (WHERE status IN ('declined', 'expired', 'cancelled'))::int AS closed,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS waiting
         FROM gym_link_requests WHERE gym_id = :gymId AND direction = 'join_request' AND (created_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN :from AND :to`),
    q(`SELECT m.id, m.source, EXISTS (SELECT 1 FROM gym_visits v WHERE v.member_id = m.id) AS "fromVisit"
         FROM gym_members m WHERE m.gym_id = :gymId AND m.joined_on BETWEEN :from AND :to AND m.status <> 'removed'`),
  ]);
  const count = (source) => members.filter((m) => m.source === source).length;
  return {
    visits,
    joinRequests,
    members: { total: members.length, bySource: { desk: count('desk'), platform: count('platform'), import: count('import') }, fromVisit: members.filter((m) => m.fromVisit).length },
    newMemberIds: members.map((m) => m.id),
  };
}

// ---------------------------------------------------------------- round 2

/**
 * M27-FR-59: a reward of extra days. The member's running membership (active or frozen) ends `days` later
 * and an upcoming one moves with it; audited as gym_membership.extended. No running membership → null.
 */
async function extendIn(
  transaction,
  { gymId, memberId, days, reason, actor = null, req = null },
) {
  const ms = await GymMembership.findOne({
    where: { gymId, memberId, status: ["active", "frozen"] },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!ms) return null;
  const before = ms.endsOn;
  await ms.update({ endsOn: rules.addDays(ms.endsOn, days) }, { transaction });
  const up = await GymMembership.findOne({
    where: { memberId, status: "upcoming" },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (up)
    await up.update(
      {
        startsOn: rules.addDays(up.startsOn, days),
        endsOn: rules.addDays(up.endsOn, days),
      },
      { transaction },
    );
  await c.record(
    {
      action: "gym_membership.extended",
      actor,
      entityType: "gym_membership",
      entityId: ms.id,
      before: { endsOn: before },
      after: { endsOn: ms.endsOn, days },
      reason,
      meta: { gymId },
      req,
    },
    transaction,
  );
  return { membershipId: ms.id, endsOn: ms.endsOn };
}

/**
 * M27-FR-59: a money-off reward. Up to `amount` is waived across the member's unpaid dues, oldest first
 * (like the desk's waive, M24-FR-35); returns the amount waived (0 when nothing is owed).
 */
async function waiveIn(
  transaction,
  { gymId, memberId, amount, reason, actor = null, req = null },
) {
  const dues = await GymDue.findAll({
    where: { gymId, memberId, status: ["unpaid", "partial"] },
    order: [
      ["dueOn", "ASC"],
      ["createdAt", "ASC"],
    ],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  let left = amount;
  for (const due of dues) {
    if (!left) break;
    const state = rules.dueState({
      amount: due.amountPoisha,
      paid: due.paidPoisha,
      waived: due.waivedPoisha,
    });
    const take = Math.min(left, state.outstanding);
    if (!take) continue;
    const waived = due.waivedPoisha + take;
    const next = rules.dueState({
      amount: due.amountPoisha,
      paid: due.paidPoisha,
      waived,
    });
    await due.update(
      {
        waivedPoisha: waived,
        status: next.status,
        waiveReason: (due.waiveReason
          ? `${due.waiveReason}; ${reason}`
          : reason
        ).slice(0, 300),
      },
      { transaction },
    );
    if (next.outstanding === 0) {
      await c.publish(
        transaction,
        next.status === "paid" ? "gym_due.paid" : "gym_due.waived",
        "gym_due",
        due.id,
        { dueId: due.id, memberId, gymId, amount: due.amountPoisha },
        actor,
      );
    }
    await c.record(
      {
        action: "gym_due.waived",
        actor,
        entityType: "gym_due",
        entityId: due.id,
        after: { waived, status: next.status },
        reason,
        meta: { gymId, amount: take },
        req,
      },
      transaction,
    );
    left -= take;
  }
  return amount - left;
}

/**
 * M27-FR-62: the members of a notice segment (not removed or left), by id:
 *   active                       active members
 *   expiring { days }            a running membership ends within days, not renewed
 *   expired { days }             expired members whose last membership ended within days
 *   not_seen { days }            active members without a counted check-in in days
 *   package { packageId }        a running membership on that package
 *   members { memberIds }        these members (gym-ops: a class's bookings)
 */
async function segmentMemberIds(gymId, segment, today = c.today()) {
  const days = Number(segment.days ?? 0);
  const q = (sql, replacements) =>
    sequelize.query(sql, {
      replacements: { gymId, today, ...replacements },
      type: QueryTypes.SELECT,
    });
  let rows;
  switch (segment.kind) {
    case "active":
      rows = await q(
        "SELECT id FROM gym_members WHERE gym_id = :gymId AND status = 'active'",
      );
      break;
    case "expiring":
      rows = await q(
        `SELECT DISTINCT m.id FROM gym_members m JOIN gym_memberships ms ON ms.member_id = m.id
          WHERE m.gym_id = :gymId AND m.status IN ('active', 'frozen') AND ms.status IN ('active', 'frozen') AND ms.ends_on BETWEEN :today AND :until
            AND NOT EXISTS (SELECT 1 FROM gym_memberships up WHERE up.member_id = m.id AND up.status = 'upcoming')`,
        { until: rules.addDays(today, days) },
      );
      break;
    case "expired":
      rows = await q(
        `SELECT m.id FROM gym_members m WHERE m.gym_id = :gymId AND m.status = 'expired'
            AND (SELECT MAX(ms.ends_on) FROM gym_memberships ms WHERE ms.member_id = m.id AND ms.status NOT IN ('cancelled', 'changed')) >= :since`,
        { since: rules.addDays(today, -days) },
      );
      break;
    case "not_seen":
      rows = await q(
        `SELECT m.id FROM gym_members m WHERE m.gym_id = :gymId AND m.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM gym_attendance a WHERE a.member_id = m.id AND a.counted AND a.local_date > :since)`,
        { since: rules.addDays(today, -days) },
      );
      break;
    case "package":
      rows = await q(
        `SELECT DISTINCT m.id FROM gym_members m JOIN gym_memberships ms ON ms.member_id = m.id
          WHERE m.gym_id = :gymId AND m.status IN ('active', 'frozen') AND ms.status IN ('active', 'frozen') AND ms.package_id = :packageId`,
        { packageId: segment.packageId },
      );
      break;
    case "members":
      rows = segment.memberIds?.length
        ? await q(
            "SELECT id FROM gym_members WHERE gym_id = :gymId AND id IN (:ids) AND status NOT IN ('removed', 'left')",
            { ids: segment.memberIds },
          )
        : [];
      break;
    default:
      rows = [];
  }
  return rows.map((r) => r.id);
}

/**
 * How to reach members (M08, §11.1): linked → their account (in-app, push); unlinked with an email in the
 * gym's record → email through the recipient adapter `gym_member`; neither → not reachable. Counts for the
 * notice estimate (M27-FR-62).
 */
async function reachOf(gymId, memberIds) {
  if (!memberIds.length)
    return { userIds: [], external: [], counts: { app: 0, email: 0, none: 0 } };
  const rows = await GymMember.findAll({
    where: { gymId, id: memberIds, status: { [Op.notIn]: ["removed"] } },
    attributes: ["id", "userId", "emailEnc"],
  });
  const userIds = [];
  const external = [];
  let none = 0;
  for (const m of rows) {
    if (m.userId) userIds.push(m.userId);
    else if (m.emailEnc) external.push({ type: "gym_member", id: m.id });
    else none += 1;
  }
  return {
    userIds,
    external,
    counts: { app: userIds.length, email: external.length, none },
  };
}

/** A member by the linked account (M27 member-side classes and points): { id, gymId, memberCode, status } or null. */
/**
 * M24 §25 (gym-whatsapp): a member's phone in the gym's record, decrypted, the default WhatsApp number of
 * their consent. Only for the member themselves or the desk recording their answer; never shown to staff.
 */
async function memberPhone(gymId, memberId, { transaction } = {}) {
  const m = await GymMember.findOne({ where: { id: memberId, gymId }, attributes: ['id', 'status', 'phoneEnc'], transaction });
  if (!m || m.status === "removed" || !m.phoneEnc) return null;
  return c.dec(m.phoneEnc);
}

/** M24 §25 (gym-whatsapp): a counter or online fee payment of this gym, for sending its receipt; null otherwise. */
async function feePayment(gymId, feePaymentId) {
  const p = await GymFeePayment.findOne({ where: { id: feePaymentId, gymId }, attributes: ['id', 'memberId', 'amountPoisha', 'method', 'receiptNo'] });
  if (!p || !p.receiptNo || p.method === "opening" || Number(p.amountPoisha) <= 0) return null;
  return { id: p.id, memberId: p.memberId, amountPoisha: Number(p.amountPoisha), receiptNo: p.receiptNo };
}

async function memberOfUser(memberId, userId) {
  const m = await GymMember.findOne({ where: { id: memberId, userId } });
  if (!m || m.status === "removed") return null;
  return {
    id: m.id,
    gymId: m.gymId,
    memberCode: m.memberCode,
    displayName: m.displayName,
    status: m.status,
    userId,
  };
}

/** Does this member hold a running membership today (classes and points need one)? */
async function hasRunningMembership(memberId, { transaction } = {}) {
  return Boolean(
    await GymMembership.count({
      where: { memberId, status: "active" },
      transaction,
    }),
  );
}

/** M27-FR-55: counted check-in dates of a member from `from` (YYYY-MM-DD) to today, ascending (streaks). */
async function checkInDates(memberId, from, { transaction } = {}) {
  const rows = await sequelize.query(
    "SELECT DISTINCT local_date AS d FROM gym_attendance WHERE member_id = :memberId AND counted AND local_date >= :from ORDER BY d",
    {
      replacements: { memberId, from },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  return rows.map((r) => String(r.d).slice(0, 10));
}

/** Is this feature on for the gym now (the owner's plan has it and the account is not restricted)? For jobs and consumers. */
async function featureOn(gymId, feature) {
  const gym = await require("../gym").gyms.get(gymId);
  if (!gym) return false;
  const sub = await c.subscriptionOf(gym.ownerId);
  return (
    sub.status !== "restricted" &&
    rules.hasFeature(sub.chosenTier, feature, c.tierCfg().featureMinTiers)
  );
}

module.exports = {
  conversionFacts,
  feesByTrainer,
  member,
  collected,
  cashCollected,
  featureOn,
  extendIn,
  waiveIn,
  segmentMemberIds,
  reachOf,
  memberOfUser,
  memberPhone,
  feePayment,
  hasRunningMembership,
  checkInDates,
};
