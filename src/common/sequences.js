'use strict';

/**
 * Human-readable codes such as PAY-26-000123 (M06 §7). One counter row per name in id_sequences;
 * LAST_INSERT_ID(expr) makes the increment and the read atomic on the connection, so concurrent
 * callers never share a number. Always runs inside a transaction (one connection).
 */
const { sequelize } = require('../models');

async function nextValue(name, transaction) {
  const run = async (t) => {
    await sequelize.query('INSERT INTO id_sequences (name, next) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE next = LAST_INSERT_ID(next + 1)', {
      replacements: [name],
      transaction: t,
    });
    const [[row]] = await sequelize.query('SELECT LAST_INSERT_ID() AS v', { transaction: t });
    return Number(row.v);
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

/** Two-digit year in Asia/Dhaka (UTC+6, no DST). */
const dhakaYear = (at = new Date()) => new Date(at.getTime() + 6 * 3600 * 1000).getUTCFullYear();

/** "PAY-26-000123": prefix, two-digit year, six-digit yearly sequence (more digits past 999999). */
async function nextCode(prefix, transaction, at = new Date()) {
  const year = dhakaYear(at);
  const n = await nextValue(`${prefix.toLowerCase()}:${year}`, transaction);
  return `${prefix}-${String(year).slice(-2)}-${String(n).padStart(6, '0')}`;
}

module.exports = { nextValue, nextCode, dhakaYear };
