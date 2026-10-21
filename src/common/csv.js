'use strict';

/**
 * Shared CSV helpers (M19-FR-22, M04-FR-10, M07 statements, M14 registrations): one place for how
 * Kriraghor writes a spreadsheet file.
 *  - cell(v): always quoted; a value that a spreadsheet would run as a formula (= + - @ tab CR at the
 *    start) gets a leading apostrophe (CSV injection), but a plain number such as -20.00 stays a
 *    number; objects are written as JSON, dates as ISO instants.
 *  - csv(rows): CRLF line ends, a final CRLF.
 *  - withBom(body): UTF-8 byte-order mark first, so Excel reads Bangla headings correctly.
 *  - taka(poisha): two decimals from integer poisha (no floating point), '' for nothing.
 *  - dhakaTime(at) / dhakaDay(at): an instant in Asia/Dhaka (+06:00, no DST) as
 *    2026-10-22T14:30:00+06:00 or 2026-10-22; '' for nothing.
 * Pure; 100% branch coverage (jest.config.js).
 */
const BOM = String.fromCharCode(0xfeff);
const DHAKA_MS = 6 * 60 * 60 * 1000;
const FORMULA = /^[=+\-@\t\r]/;
const NUMBER = /^-?\d+(\.\d+)?$/;

function cell(v) {
  if (v === null || v === undefined) return '';
  let s;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (FORMULA.test(s) && !NUMBER.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const row = (values) => values.map(cell).join(',');
const csv = (rows) => `${rows.map(row).join('\r\n')}\r\n`;
const withBom = (body) => `${BOM}${body}`;

/** Poisha (number, numeric string or bigint) → "1234.50"; negative amounts keep their sign. */
function taka(poisha) {
  if (poisha === null || poisha === undefined || poisha === '') return '';
  const p = BigInt(poisha);
  const neg = p < 0n;
  const abs = neg ? -p : p;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

const shifted = (at) => new Date(new Date(at).getTime() + DHAKA_MS).toISOString();

/** An instant as Dhaka local time with the offset, to the second. */
const dhakaTime = (at) => (at === null || at === undefined || at === '' ? '' : `${shifted(at).slice(0, 19)}+06:00`);

/** The Dhaka calendar day of an instant; a date-only string ('2026-10-22') is returned as it is. */
function dhakaDay(at) {
  if (at === null || at === undefined || at === '') return '';
  if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  return shifted(at).slice(0, 10);
}

module.exports = { BOM, cell, row, csv, withBom, taka, dhakaTime, dhakaDay };
