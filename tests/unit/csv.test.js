'use strict';

// The shared CSV helper (src/common/csv.js) used by every export: M19-FR-22 (UTF-8 with a BOM, taka
// with two decimals, +06:00 times), M04-FR-10 and M19-FR-23 (formula injection), M07 statements and
// the M14 registrations CSV (Round B2). 100% branch coverage (jest.config.js).
const C = require('../../src/common/csv');

describe('CSV cells (formula injection guard)', () => {
  it('quotes every cell and doubles quotes', () => {
    expect(C.cell('a "b"')).toBe('"a ""b"""');
    expect(C.cell('Dhanmondi, Road 5')).toBe('"Dhanmondi, Road 5"');
    expect(C.cell(42)).toBe('"42"');
    expect(C.cell(true)).toBe('"true"');
  });

  it('writes nothing for null and undefined, JSON for objects and ISO for dates', () => {
    expect(C.cell(null)).toBe('');
    expect(C.cell(undefined)).toBe('');
    expect(C.cell({ v: 1 })).toBe('"{""v"":1}"');
    expect(C.cell(new Date('2026-10-22T08:30:00Z'))).toBe('"2026-10-22T08:30:00.000Z"');
  });

  it('neutralises formulas but keeps plain numbers', () => {
    for (const bad of ['=1+1', '+cmd', '-cmd', '@SUM(A1)', '\tx', '\rx']) expect(C.cell(bad)).toBe(`"'${bad}"`);
    expect(C.cell('-5')).toBe('"-5"');
    expect(C.cell('-20.00')).toBe('"-20.00"');
    expect(C.cell('+5')).toBe(`"'+5"`); // a leading plus is not a plain number
  });

  it('rows, files with CRLF and the byte-order mark', () => {
    expect(C.row(['a', null, 1])).toBe('"a",,"1"');
    expect(C.csv([['h1', 'h2'], ['x', 'y']])).toBe('"h1","h2"\r\n"x","y"\r\n');
    const body = C.withBom('x');
    expect(body.charCodeAt(0)).toBe(0xfeff);
    expect(body.slice(1)).toBe('x');
    expect(C.BOM).toBe('﻿');
  });
});

describe('taka from poisha (no floating point)', () => {
  it('two decimals for numbers, numeric strings and bigints', () => {
    expect(C.taka(200000)).toBe('2000.00');
    expect(C.taka(5)).toBe('0.05');
    expect(C.taka(0)).toBe('0.00');
    expect(C.taka('123456789012345')).toBe('1234567890123.45');
    expect(C.taka(1999n)).toBe('19.99');
  });

  it('keeps the sign of refunds and reversals', () => {
    expect(C.taka(-5)).toBe('-0.05');
    expect(C.taka(-2000)).toBe('-20.00');
  });

  it('matches toFixed(2) on whole poisha (no behaviour change for the old copies)', () => {
    for (const p of [1, 10, 99, 100, 101, 1005, 45000, 1234567]) expect(C.taka(p)).toBe((p / 100).toFixed(2));
  });

  it('writes nothing for nothing', () => {
    expect(C.taka(null)).toBe('');
    expect(C.taka(undefined)).toBe('');
    expect(C.taka('')).toBe('');
  });
});

describe('Asia/Dhaka times and days', () => {
  it('an instant in +06:00 to the second', () => {
    expect(C.dhakaTime('2026-10-22T08:30:15.123Z')).toBe('2026-10-22T14:30:15+06:00');
    expect(C.dhakaTime(new Date('2026-10-21T18:00:00Z'))).toBe('2026-10-22T00:00:00+06:00');
    expect(C.dhakaTime(null)).toBe('');
    expect(C.dhakaTime(undefined)).toBe('');
    expect(C.dhakaTime('')).toBe('');
  });

  it('the Dhaka day of an instant; date-only strings stay as they are', () => {
    expect(C.dhakaDay('2026-10-21T17:59:59Z')).toBe('2026-10-21');
    expect(C.dhakaDay('2026-10-21T18:00:00Z')).toBe('2026-10-22');
    expect(C.dhakaDay(new Date('2026-10-21T18:00:00Z'))).toBe('2026-10-22');
    expect(C.dhakaDay('2026-10-22')).toBe('2026-10-22');
    expect(C.dhakaDay(null)).toBe('');
    expect(C.dhakaDay(undefined)).toBe('');
    expect(C.dhakaDay('')).toBe('');
  });
});
