'use strict';

/**
 * M24 prompt 3b, the SMS add-on (M24-FR-96 to FR-100, §6.7): the pure rules for when a notice may go by
 * SMS, what a settled hold gives back, the balance crossings, the allowance and bundle expiry, the bundle
 * invoice, the add-on line on the monthly invoice and the short pay-link code. Every branch is covered.
 */
const crypto = require('node:crypto');
const r = require('../../src/modules/gym-manage/gym-manage.rules');

describe('M24-FR-97, FR-99 smsBlock: may this notice go by SMS?', () => {
  const ok = { enabled: true, tier: 'basic', addonStatus: 'active', kind: 'receipt', kinds: ['receipt'], balance: 10, reserve: 2 };
  test('yes', () => expect(r.smsBlock(ok)).toBeNull());
  test('the platform switch is off', () => expect(r.smsBlock({ ...ok, enabled: false })).toBe('off'));
  test('the Free plan', () => expect(r.smsBlock({ ...ok, tier: 'free' })).toBe('tier'));
  test('the add-on is not active', () => {
    expect(r.smsBlock({ ...ok, addonStatus: undefined })).toBe('addon');
    expect(r.smsBlock({ ...ok, addonStatus: 'paused' })).toBe('addon');
  });
  test('the kind was not chosen, unless chosen for this one message', () => {
    expect(r.smsBlock({ ...ok, kind: 'pay_link' })).toBe('kind');
    expect(r.smsBlock({ ...ok, kind: 'pay_link', explicit: true })).toBeNull();
    expect(r.smsBlock({ ...ok, kinds: undefined })).toBe('kind');
  });
  test('the balance must cover the hold', () => {
    expect(r.smsBlock({ ...ok, balance: 2 })).toBeNull();
    expect(r.smsBlock({ ...ok, balance: 1 })).toBe('balance');
  });
});

describe('M24-FR-99 smsSettleUnits: what a settled hold gives back', () => {
  test('not sent: the whole hold', () => expect(r.smsSettleUnits({ reserve: 2, segments: 0, sent: false, balanceAfterReserve: 0 })).toBe(2));
  test('sent: the hold less the segments', () => {
    expect(r.smsSettleUnits({ reserve: 2, segments: 1, sent: true, balanceAfterReserve: 10 })).toBe(1);
    expect(r.smsSettleUnits({ reserve: 2, segments: 2, sent: true, balanceAfterReserve: 10 })).toBe(0);
  });
  test('more segments than held: charged from what is left, never below 0', () => {
    expect(r.smsSettleUnits({ reserve: 2, segments: 3, sent: true, balanceAfterReserve: 10 })).toBe(-1);
    expect(r.smsSettleUnits({ reserve: 2, segments: 3, sent: true, balanceAfterReserve: 0 })).toBe(0);
    expect(r.smsSettleUnits({ reserve: 2, segments: 3, sent: true, balanceAfterReserve: -1 })).toBe(0);
  });
  test('a nonsense segment count counts as 0', () => expect(r.smsSettleUnits({ reserve: 2, segments: -4, sent: true, balanceAfterReserve: 5 })).toBe(2));
});

describe('M24-FR-100 smsCrossing: once per crossing', () => {
  const at = { low: 50, reserve: 2 };
  test('falls below the low mark', () => expect(r.smsCrossing({ ...at, before: 51, after: 49 })).toBe('low'));
  test('from exactly the mark', () => expect(r.smsCrossing({ ...at, before: 50, after: 48 })).toBe('low'));
  test('already below: nothing new', () => expect(r.smsCrossing({ ...at, before: 49, after: 47 })).toBeNull());
  test('cannot hold another message: depleted', () => {
    expect(r.smsCrossing({ ...at, before: 3, after: 1 })).toBe('depleted');
    expect(r.smsCrossing({ ...at, before: 60, after: 0 })).toBe('depleted');
  });
  test('already empty: nothing new', () => expect(r.smsCrossing({ ...at, before: 1, after: 0 })).toBeNull());
  test('still above both', () => expect(r.smsCrossing({ ...at, before: 100, after: 98 })).toBeNull());
});

describe('§6.7 the allowance and bundles', () => {
  test('the allowance is spent first', () => {
    expect(r.smsAllowanceLeft({ granted: 100, used: 30 })).toBe(70);
    expect(r.smsAllowanceLeft({ granted: 100, used: 130 })).toBe(0);
    expect(r.smsAllowanceLeft({ granted: 100, used: -5 })).toBe(100);
  });
  test('an expiring bundle keeps what the newer bundles do not account for', () => {
    expect(r.smsBundleLeft({ units: 100, pool: 250, newer: 100 })).toBe(100);
    expect(r.smsBundleLeft({ units: 100, pool: 130, newer: 100 })).toBe(30);
    expect(r.smsBundleLeft({ units: 100, pool: 80, newer: 100 })).toBe(0);
  });
  test('a bundle invoice: bundles × price, VAT when on', () => {
    expect(r.bundleInvoiceLines({ bundles: 2, size: 100, price: 5000, vat: { enabled: false, pct: 15 } })).toMatchObject({ subtotal: 10000, vat: 0, total: 10000, units: 200, lines: [{ kind: 'sms_bundle', quantity: 2, unitPoisha: 5000, amountPoisha: 10000 }] });
    const withVat = r.bundleInvoiceLines({ bundles: 1, size: 100, price: 5000, vat: { enabled: true, pct: 15 } });
    expect(withVat).toMatchObject({ vat: 750, total: 5750 });
    expect(withVat.lines.map((l) => l.kind)).toEqual(['sms_bundle', 'vat']);
    expect(r.bundleInvoiceLines({ bundles: 1, size: 100, price: 5000 }).vat).toBe(0);
  });
  test('the monthly invoice bills the add-on when it has a price', () => {
    const base = { periodStart: '2026-11-01', periodEnd: '2026-11-30', tier: 'basic', prices: { basic: 79900, standard: 150000, pro: 250000 }, startedOn: '2026-01-01', founding: null, vat: { enabled: false, pct: 0 } };
    const on = r.invoiceLines({ ...base, smsAddon: { price: 20000 } });
    expect(on.lines.find((l) => l.kind === 'sms_addon')).toMatchObject({ amountPoisha: 20000 });
    expect(on.total).toBe(99900);
    expect(r.invoiceLines({ ...base, smsAddon: { price: 0 } }).lines.some((l) => l.kind === 'sms_addon')).toBe(false);
    expect(r.invoiceLines(base).total).toBe(79900);
  });
});

describe('the short pay-link code for an SMS', () => {
  test('10 Crockford characters', () => {
    for (let i = 0; i < 20; i += 1) expect(r.looksLikeShortCode(r.shortCode(crypto.randomBytes(10)))).toBe(true);
    expect(r.shortCode(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 31, 99]))).toBe('012345678Z');
  });
  test('a long token or anything else is not a short code', () => {
    expect(r.looksLikeShortCode('v1.abc.def.0123')).toBe(false);
    expect(r.looksLikeShortCode('ABCDEFGHIL')).toBe(false);
    expect(r.looksLikeShortCode(undefined)).toBe(false);
  });
});
