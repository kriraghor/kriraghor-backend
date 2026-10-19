'use strict';

/**
 * M10 event consumers (§2.3). Each runs in the consumer transaction (M04, at-least-once, idempotent
 * by status):
 *   payment.failed / payment.expired (purpose ground_booking)  the hold ends, the court is free (FR-06, FR-08)
 *   ground.suspended / ground.removed (M09)                     upcoming bookings are cancelled by the platform, 100% refund
 * ground.paused keeps its bookings (M09 FR-05); only new holds stop (the ground is not bookable).
 * Registering the consumers also registers the occupancy port, so the worker has it too.
 */
const { onEvent } = require('../events').consumers;

function registerBookingsConsumers() {
  require('./occupancy.impl').register();
  require('./holds.service'); // the M06 purpose hook
  for (const name of ['payment.failed', 'payment.expired']) {
    onEvent(name, `bookings.release-${name.split('.')[1]}`, (e, { transaction }) =>
      e.payload.purpose === 'ground_booking' ? require('./holds.service').onPaymentClosed(e.payload.paymentId, { transaction }) : null
    );
  }
  for (const name of ['ground.suspended', 'ground.removed']) {
    onEvent(name, `bookings.platform-cancel-${name.split('.')[1]}`, (e, { transaction }) =>
      require('./bookings.service').cancelAllForGround(e.payload.groundId, name === 'ground.suspended' ? 'ground_suspended' : 'ground_removed', { transaction })
    );
  }
}

module.exports = { registerBookingsConsumers };
