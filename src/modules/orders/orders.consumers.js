'use strict';

/**
 * M13 event consumers (§2.3). Each runs in the consumer transaction (M04, at-least-once, idempotent
 * by status):
 *   payment.failed / payment.expired (purpose market_order)  the unpaid order is cancelled, the stock freed
 * Registering the consumers also loads checkout.service, which registers the M06 purpose hook, so the
 * worker (payment polls) has it too.
 */
const { onEvent } = require('../events/events.consumers');

function registerOrdersConsumers() {
  require('./checkout.service'); // the M06 purpose hook
  for (const name of ['payment.failed', 'payment.expired']) {
    onEvent(name, `orders.cancel-unpaid-${name.split('.')[1]}`, (e, { transaction }) =>
      e.payload.purpose === 'market_order' ? require('./checkout.service').onPaymentClosed(e.payload.paymentId, { transaction }) : null
    );
  }
}

module.exports = { registerOrdersConsumers };
