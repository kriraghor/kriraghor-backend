'use strict';

/**
 * M13 tick (one BullMQ job, orders.tick, every minute; §10). Every step locks the row and re-checks
 * its status, so a repeat or an overlap is harmless:
 *   unpaid orders past pay_by          cancelled, stock released (checkout.expireUnpaid)
 *   accept reminders                   once, market.shop_accept_reminder_hours before the deadline
 *   not accepted by accept_by          expired, 100% refund, stock released (FR-08)
 *   not shipped by auto_cancel_at      cancelled, 100% refund, stock released (FR-09)
 *   delivered past complete_by         completed, the shop's money released (FR-14)
 */
const { Op } = require('sequelize');
const { sequelize, SubOrder } = require('../../models');
const settings = require('../settings/settings.service');
const checkout = require('./checkout.service');
const settle = require('./orders.settle');
const rules = require('./orders.rules');
const c = require('./orders.common');

const BATCH = 200;
const HOUR = 3600 * 1000;

/** Run `fn` on each due sub-order in its own transaction, if it is still in `status`. */
async function each(where, status, fn) {
  const due = await SubOrder.findAll({ where: { ...where, status }, attributes: ['id'], order: [['id', 'ASC']], limit: BATCH });
  let n = 0;
  for (const { id } of due) {
    await sequelize.transaction(async (transaction) => {
      const s = await c.lockSub(id, transaction);
      if (s.status !== status) return;
      await fn(s, transaction);
      n += 1;
    });
  }
  return n;
}

async function closeWithRefund(s, action, { reason, transaction }) {
  const to = rules.next(action, s.status, 'system');
  await checkout.releaseStock(s, { transaction });
  const refunded = await settle.refundAll(s, { reasonCode: reason, key: `sub_order:${s.id}:${action}`, transaction });
  await s.update({ status: to, cancelledAt: new Date(), cancelledBy: 'system', cancelReason: reason }, { transaction });
  await c.publishSub(transaction, to === 'expired' ? 'sub_order.expired' : 'sub_order.cancelled', s, { reason, refund: refunded, by: 'system' });
  await c.syncOrder(s.orderId, { transaction });
}

const remindAccept = (now) =>
  each({ acceptRemindedAt: null, acceptBy: { [Op.lte]: new Date(now.getTime() + settings.get('market.shop_accept_reminder_hours') * HOUR), [Op.gt]: now } }, 'placed', async (s, transaction) => {
    await s.update({ acceptRemindedAt: now }, { transaction });
    await c.publishSub(transaction, 'sub_order.accept_reminded', s, { acceptBy: c.iso(s.acceptBy) });
  });

const expireAccept = (now) => each({ acceptBy: { [Op.lte]: now } }, 'placed', (s, transaction) => closeWithRefund(s, 'expire', { reason: 'not_accepted', transaction }));
const cancelOverdue = (now) => each({ autoCancelAt: { [Op.lte]: now } }, 'accepted', (s, transaction) => closeWithRefund(s, 'auto_cancel', { reason: 'not_shipped', transaction }));
const autoComplete = (now) => each({ completeBy: { [Op.lte]: now } }, 'delivered', (s, transaction) => settle.complete(s, 'auto', { transaction }));

async function tick(now = new Date()) {
  return {
    unpaid: await checkout.expireUnpaid(now),
    reminded: await remindAccept(now),
    expired: await expireAccept(now),
    overdue: await cancelOverdue(now),
    completed: await autoComplete(now),
  };
}

module.exports = { tick };
