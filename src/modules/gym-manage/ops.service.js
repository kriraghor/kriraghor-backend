'use strict';

/**
 * What M27 gym-ops reads from gym-manage (through index.js `ops`, ADR-007 §3): a member of a gym, and the
 * fee money a gym collected, for the cash drawer and profit and loss. Reads only; gym-ops never writes
 * gym-manage tables.
 */
const { QueryTypes } = require('sequelize');
const { sequelize, GymMember } = require('../../models');

/** A member of this gym (not removed) → { id, memberCode, displayName, status, linked } or null. */
async function member(gymId, memberId, { transaction } = {}) {
  const m = await GymMember.findOne({ where: { id: memberId, gymId }, transaction });
  if (!m || m.status === 'removed') return null;
  return { id: m.id, memberCode: m.memberCode, displayName: m.displayName, status: m.status, linked: Boolean(m.userId), userId: m.userId ?? null };
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
    { replacements: { gymId, from, to }, type: QueryTypes.SELECT }
  );
  return { counterPoisha: Number(row.counter), onlinePoisha: Number(row.online), providerChargePoisha: Number(row.providerCharge) };
}

/** Cash fee money of a gym on one Dhaka date, net of reversals: what went into the drawer (M27-FR-07). */
async function cashCollected(gymId, day, { transaction } = {}) {
  const [row] = await sequelize.query("SELECT COALESCE(SUM(amount_poisha), 0)::bigint AS cash FROM gym_fee_payments WHERE gym_id = :gymId AND paid_on = :day AND method = 'cash'", {
    replacements: { gymId, day },
    type: QueryTypes.SELECT,
    transaction,
  });
  return Number(row.cash);
}

module.exports = { member, collected, cashCollected };
