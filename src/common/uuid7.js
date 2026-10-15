'use strict';

const crypto = require('crypto');

/**
 * UUID version 7 (RFC 9562): 48-bit Unix milliseconds, then random bits. Time-ordered, so the
 * outbox relay can claim events in id order (M04 §7 "uuid v7").
 */
function uuid7(now = Date.now()) {
  const b = crypto.randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

module.exports = { uuid7 };
