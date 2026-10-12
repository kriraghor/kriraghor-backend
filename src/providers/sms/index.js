'use strict';

const config = require('../../config');
const logger = require('../../common/logger');

/**
 * SMS provider facade. Drivers:
 *  - console: prints messages to stdout (local development only)
 *  - memory:  keeps messages in memory (automated tests)
 * A real BD gateway driver (SSL Wireless / Alpha SMS …) plugs in here with the same interface.
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

async function send({ to, text }) {
  const driver = drivers[config.sms.driver];
  try {
    await driver({ to, text });
  } catch (err) {
    logger.error({ err }, 'sms send failed');
  }
}

module.exports = {
  send,
  /** Test helper: last message sent to a number. */
  lastTo: (to) => [...outbox].reverse().find((m) => m.to === to),
  clear: () => outbox.splice(0, outbox.length),
};
