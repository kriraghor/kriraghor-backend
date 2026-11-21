'use strict';

/**
 * M24 §25 consumers (registered once per process by registry.registerAll): the automatic WhatsApp messages
 * follow the same events M08 sends their notices for (M24-FR-165). Each runs in the inbox transaction (a
 * duplicate delivery is skipped) and only queues: the send job sends after commit.
 */
const { onEvent } = require('../events').consumers;

const AUTOMATIC = Object.freeze({
  'gym_fee.recorded': 'receipt',
  'gym_membership.renewal_reminded': 'renewal_due',
  'gym_membership.end_reminded': 'ends_today',
  'gym_due.overdue_reminded': 'overdue',
  'gym_payment_link.created': 'pay_link',
});

function registerGymWhatsappConsumers() {
  for (const [name, kind] of Object.entries(AUTOMATIC)) {
    onEvent(name, `gym-whatsapp.${kind}`, (e, { transaction }) => require('./messages.service').onAutomatic(kind, e, { transaction }));
  }
}

module.exports = { registerGymWhatsappConsumers, AUTOMATIC };
