'use strict';

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const config = require('../../config');

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
    const info = await transport.sendMail({ from: config.email.from, ...msg });
    return info?.messageId;
  },
};

/** Returns { provider, messageId } and throws on failure, so M08 can retry. */
async function send({ to, subject, text, html }) {
  const messageId = (await drivers[config.email.driver]({ to, subject, text, html })) ?? crypto.randomUUID();
  return { provider: config.email.driver, messageId };
}

module.exports = {
  send,
  lastTo: (to) => [...outbox].reverse().find((m) => m.to === to),
  clear: () => outbox.splice(0, outbox.length),
};
