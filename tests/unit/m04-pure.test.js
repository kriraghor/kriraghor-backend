'use strict';

// M04 pure helpers: redactor (FR-03), backoff (FR-16), event registry rules (FR-18, FR-19),
// canonical hashing (FR-05), summaries (FR-09), UUIDv7, IP masking and CSV cells (FR-10).
const { redact, maskPhone, maskEmail, REDACTED } = require('../../src/modules/audit/audit.redact');
const { backoffMs } = require('../../src/modules/events/events.backoff');
const { EVENTS, nameError, piiFields } = require('../../src/modules/events/catalog');
const { canonical, rowContent, hashRow } = require('../../src/modules/audit/audit.chain');
const { summarize, ACTIONS } = require('../../src/modules/audit/audit.actions');
const { uuid7 } = require('../../src/common/uuid7');

describe('redact (M04-FR-03)', () => {
  it('masks phones to the last 3 digits and emails to the first letter and domain', () => {
    expect(redact({ phone: '+8801711000123', email: 'fahim@example.com' })).toEqual({ phone: '**********123', email: 'f***@example.com' });
    expect(maskPhone('12')).toBe('***');
    expect(maskEmail('not-an-email')).toBe(REDACTED);
    expect(maskEmail('@x.com')).toBe(REDACTED);
  });

  it('removes NID, DOB, TIN, account numbers, tokens, secrets, passwords, hashes and file keys', () => {
    const out = redact({
      nid: '1990123456789',
      nidLast4: '6789',
      dob: '1990-01-01',
      tin: '123',
      accountNumber: '017',
      iban: 'X',
      refreshToken: 't',
      totpSecretEnc: 's',
      passwordHash: 'h',
      codeHash: 'c',
      fileKey: 'kyc/1.jpg',
      api_key: 'k',
    });
    expect(Object.values(out).every((v) => v === REDACTED)).toBe(true);
  });

  it('keeps setting keys, ids and plain values; walks nested objects and arrays', () => {
    const input = { key: 'fees.hire_pct', id: 'abc', value: 5, nested: { phones: ['01711000123'], role: 'staff' }, list: [{ secret: 'x' }], empty: null, missing: undefined };
    expect(redact(input)).toEqual({ key: 'fees.hire_pct', id: 'abc', value: 5, nested: { phones: ['********123'], role: 'staff' }, list: [{ secret: REDACTED }], empty: null, missing: undefined });
    expect(redact(null)).toBeNull();
    expect(redact('plain')).toBe('plain');
  });
});

describe('backoffMs (M04-FR-16)', () => {
  it('doubles from 2 s and stops at the cap', () => {
    expect(backoffMs(1, 900)).toBe(2000);
    expect(backoffMs(3, 900)).toBe(8000);
    expect(backoffMs(10, 900)).toBe(900000);
    expect(backoffMs(0, 900)).toBe(2000);
    expect(backoffMs(40, 900)).toBe(900000);
    expect(backoffMs(2, 0)).toBe(1000);
  });
});

describe('event registry rules (M04-FR-18, FR-19)', () => {
  it('every registered name is <aggregate>.<past_tense> in snake_case', () => {
    for (const name of Object.keys(EVENTS)) expect([name, nameError(name)]).toEqual([name, null]);
  });

  it('rejects bad names', () => {
    expect(nameError('Booking.Completed')).toBe('Use <aggregate>.<verb> in snake_case');
    expect(nameError('payout.needs_approval')).toBe('"needs_approval" is not past tense');
    expect(nameError('hire_request.sent')).toBeNull();
  });

  it('finds personal data field names at any depth, as any word of the key', () => {
    expect(piiFields({ userId: 'x', sanctionId: 'y', until: null })).toEqual([]);
    expect(piiFields({ displayName: 'a', meta: { user_email: 'b', phoneNumber: 'c' }, list: [{ nid: 1 }] })).toEqual(['displayName', 'meta.user_email', 'meta.phoneNumber', 'list[0].nid']);
    expect(piiFields('text')).toEqual([]);
  });
});

describe('canonical hashing (M04-FR-05)', () => {
  const row = { id: '7', createdAt: new Date('2026-10-15T00:00:00Z'), actorType: 'master', actorId: 'u', action: 'setting.changed', module: 'M03', severity: 'critical', stepUp: 1, before: { b: 1, a: 2 } };

  it('ignores key order and normalises values', () => {
    expect(canonical({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"c":null,"d":3}],"b":1}');
    expect(rowContent(row)).toMatchObject({ id: '7', occurredAt: '2026-10-15T00:00:00.000Z', stepUp: true, entityType: null, ip: null });
    expect(rowContent({ get: () => ({ ...row, createdAt: null }) }).occurredAt).toBeNull();
  });

  it('chains on the previous hash and changes when the row changes', () => {
    const h1 = hashRow(null, row);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRow(null, { ...row, before: { a: 2, b: 1 } })).toBe(h1);
    expect(hashRow(h1, row)).not.toBe(h1);
    expect(hashRow(null, { ...row, after: { value: 6 } })).not.toBe(h1);
  });
});

describe('summaries (M04-FR-09)', () => {
  it('renders EN and BN templates from the row', () => {
    const row = { action: 'setting.changed', entityId: 'fees.shop_commission_pct', before: { value: 5 }, after: { value: 6 } };
    expect(summarize(row)).toBe('Changed fees.shop_commission_pct from 5 to 6');
    expect(summarize(row, 'bn')).toBe('fees.shop_commission_pct 5 থেকে 6 করা হয়েছে');
  });

  it('drops empty placeholders and handles objects', () => {
    expect(summarize({ action: 'user.suspended', meta: {} })).toBe('Suspended the account');
    expect(summarize({ action: 'catalog_item.created', after: { key: { x: 1 } } })).toBe('Added {"x":1} to the catalogue');
  });

  it('falls back to the key and changed fields for unknown actions', () => {
    expect(summarize({ action: 'thing.done', before: { a: 1 }, after: { b: 2 } })).toBe('thing.done (a, b)');
    expect(summarize({ action: 'thing.done' })).toBe('thing.done');
  });

  it('every action has a module, a severity and both languages', () => {
    for (const [key, def] of Object.entries(ACTIONS)) {
      expect([key, /^M\d{2}$/.test(def.module), ['info', 'notice', 'critical'].includes(def.severity), Boolean(def.en && def.bn)]).toEqual([key, true, true, true]);
    }
  });
});

describe('uuid7', () => {
  it('is a version 7 UUID ordered by time', () => {
    const a = uuid7(1_700_000_000_000);
    const b = uuid7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe('IP masking and CSV cells (M04-FR-10)', () => {
  const { maskIp, cell } = require('../../src/modules/audit/audit.admin.service');
  it('masks IPs', () => {
    expect(maskIp('103.12.34.21')).toBe('103.***.***.21');
    expect(maskIp('::ffff:127.0.0.1')).toBe('127.***.***.1');
    expect(maskIp('2001:db8::1')).toBe('2001:****');
    expect(maskIp(null)).toBeNull();
  });
  it('quotes cells and neutralises formulas', () => {
    expect(cell('a "b"')).toBe('"a ""b"""');
    expect(cell('=1+1')).toBe(`"'=1+1"`);
    expect(cell({ v: 1 })).toBe('"{""v"":1}"');
    expect(cell(null)).toBe('');
    expect(cell(true)).toBe('"true"');
  });
});
