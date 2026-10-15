'use strict';

/**
 * Human-readable codes such as PAY-26-000123 (M06 §7). One counter row per name in id_sequences;
 * INSERT … ON CONFLICT … RETURNING increments and reads in one atomic statement, so concurrent
 * callers never share a number (the row lock serialises them).
 */
const { sequelize } = require('../models');

async function nextValue(name, transaction) {
  const [[row]] = await sequelize.query(
    'INSERT INTO id_sequences (name, next) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET next = id_sequences.next + 1 RETURNING next',
    { replacements: [name], transaction }
  );
  return Number(row.next);
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
