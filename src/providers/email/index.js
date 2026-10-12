'use strict';

const nodemailer = require('nodemailer');
const config = require('../../config');
const logger = require('../../common/logger');

/**
 * Email provider facade. Drivers:
 *  - console: print to stdout (development without a mail server)
 *  - memory:  keep in memory (automated tests)
 *  - smtp:    real delivery (Mailpit locally; SES / Resend / Postmark SMTP in production)
 */
const outbox = [];
let transport;

const drivers = {
  async console(msg) {
    // eslint-disable-next-line no-console
    console.log(`\n[email:console] to=${msg.to}\nsubject: ${msg.subject}\n${msg.text}\n`);
  },
  async memory(msg) {
    outbox.push({ ...msg, at: new Date() });
  },
  async smtp(msg) {
    transport ??= nodemailer.createTransport(config.email.smtp);
    await transport.sendMail({ from: config.email.from, ...msg });
  },
};

async function send({ to, subject, text, html }) {
  try {
    await drivers[config.email.driver]({ to, subject, text, html });
  } catch (err) {
    logger.error({ err }, 'email send failed');
  }
}

module.exports = {
  send,
  lastTo: (to) => [...outbox].reverse().find((m) => m.to === to),
  clear: () => outbox.splice(0, outbox.length),
};
