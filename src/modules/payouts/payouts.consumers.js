'use strict';

/**
 * M07 event consumers (§2.3). Each runs once per event under the M04 inbox, in its transaction.
 *   refund.manual_required (M06)    → a refund payout to the payer (FR-15)
 *   user.suspended / user.banned    → payee-level account_suspended hold (edge case 10)
 *   user.restored                   → lift it
 * risk_freeze (M18), dispute (M17) and kyc (M02) holds are placed through PayoutHoldService when
 * those modules are built (§2.4), not from events.
 */
const { onEvent } = require('../events/events.consumers');
const holds = require('./holds.service');
const payouts = require('./payouts.service');

function registerPayoutConsumers() {
  onEvent('refund.manual_required', 'payouts.refund-payout', async (event, { transaction }) => {
    const { refundId, payerId, amount } = event.payload;
    await payouts.createRefundPayout({ refundId, payerId, amount }, { transaction });
  });

  for (const name of ['user.suspended', 'user.banned']) {
    onEvent(name, 'payouts.account-hold', async (event, { transaction }) => {
      const { userId, sanctionId } = event.payload;
      await holds.place({ payeeId: userId, scope: 'payee', type: 'account_suspended', refId: sanctionId, reason: name === 'user.banned' ? 'Account banned' : 'Account suspended' }, null, { transaction });
    });
  }

  onEvent('user.restored', 'payouts.account-hold-lift', async (event, { transaction }) => {
    await holds.liftAll(event.payload.userId, 'account_suspended', { reason: 'Account restored' }, null, { transaction });
  });
}

module.exports = { registerPayoutConsumers };
