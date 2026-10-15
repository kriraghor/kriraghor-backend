'use strict';

const crypto = require('crypto');
const config = require('../../config');

/**
 * SMS provider facade. Drivers:
 *  - console: prints messages to stdout (local development only)
 *  - memory:  keeps messages in memory (automated tests)
 * A real BD gateway driver (SSL Wireless / Alpha SMS …) plugs in here with the same interface (Q59).
 * send() returns { provider, messageId, delivered } and throws on failure, so M08 can retry.
 * Sandbox drivers report delivered at once (no DLR).
 */
const outbox = [];

const drivers = {
  async console({ to, text }) {
    // eslint-disable-next-line no-console
    console.log(`\n[sms:console] to=${to}\n${text}\n`);
  },
  async memory({ to, text }) {
    outbox.push({ to, text, at: new Date() });
  },
};

async function send({ to, text, route = 'trans' }) {
  const driver = drivers[config.sms.driver];
  await driver({ to, text, route });
  return { provider: config.sms.driver, messageId: crypto.randomUUID(), delivered: true };
}

module.exports = {
  send,
  /** Test helper: last message sent to a number. */
  lastTo: (to) => [...outbox].reverse().find((m) => m.to === to),
  clear: () => outbox.splice(0, outbox.length),
};
