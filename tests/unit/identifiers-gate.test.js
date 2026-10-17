'use strict';

require('../env');
const { normalizePhone, parseIdentifier } = require('../../src/common/identifiers');
const gate = require('../../src/modules/auth/gate.service');
const { encrypt, decrypt, randomDigits } = require('../../src/common/crypto');

describe('normalizePhone', () => {
  it.each([
    ['01712345678', '+8801712345678'],
    ['1712 345 678', '+8801712345678'],
    ['+880 1712-345678', '+8801712345678'],
    ['8801912345678', '+8801912345678'],
  ])('%s → %s', (input, out) => expect(normalizePhone(input)).toBe(out));

  it.each(['01212345678', '0171234567', '+8801012345678', 'abc', ''])('rejects %s', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});

describe('parseIdentifier', () => {
  it('detects email and lower-cases it', () => {
    expect(parseIdentifier('Hello@Example.COM')).toEqual({ type: 'email', value: 'hello@example.com' });
  });
  it('returns null for junk', () => expect(parseIdentifier('not an id')).toBeNull());
});

describe('gate.evaluate', () => {
  const principal = (status, roles, kycStatus = 'unverified') => ({ user: { status, kycStatus }, roles });

  it('requires sign in', () => expect(gate.evaluateAction(null, 'hire')).toMatchObject({ allowed: false, code: 'AUTH_REQUIRED' }));
  it('blocks suspended accounts', () =>
    expect(gate.evaluateAction(principal('suspended', { member: 'active' }), 'hire').code).toBe('ACCOUNT_SUSPENDED'));
  it('asks for NID when member is not active', () =>
    expect(gate.evaluateAction(principal('active', { member: 'applied' }), 'hire').code).toBe('KYC_REQUIRED'));
  it('says pending while NID is in review', () =>
    expect(gate.evaluateAction(principal('active', { member: 'in_review' }), 'hire').code).toBe('KYC_PENDING'));
  it('allows verified members to book', () =>
    expect(gate.evaluateAction(principal('active', { member: 'active' }), 'hire')).toEqual({ allowed: true }));
  it('requires the business role for listing a ground', () => {
    expect(gate.evaluateAction(principal('active', { member: 'active' }), 'list_ground').code).toBe('ROLE_REQUIRED');
    expect(gate.evaluateAction(principal('active', { member: 'active', ground_owner: 'in_review' }), 'list_ground').code).toBe('ROLE_PENDING');
    expect(gate.evaluateAction(principal('active', { member: 'active', ground_owner: 'suspended' }), 'list_ground').code).toBe('ROLE_SUSPENDED');
    expect(gate.evaluateAction(principal('active', { member: 'active', ground_owner: 'active' }), 'list_ground').allowed).toBe(true);
  });
  it('accepts either player or pro for hire requests', () =>
    expect(gate.evaluateAction(principal('active', { member: 'active', pro: 'active' }), 'accept_hire').allowed).toBe(true));
});

describe('crypto', () => {
  it('round-trips AES-GCM', () => expect(decrypt(encrypt('JBSWY3DPEHPK3PXP'))).toBe('JBSWY3DPEHPK3PXP'));
  it('generates fixed-length digit codes', () => expect(randomDigits(6)).toMatch(/^\d{6}$/));
});

describe('gate: book_ground needs only a verified phone (M10, 17 Oct 2026)', () => {
  const p = (user, roles = {}) => ({ user: { status: 'active', kycStatus: 'unverified', ...user }, roles });
  it('allows a verified phone without NID', () =>
    expect(gate.evaluateAction(p({ phone: '+8801711000001', phoneVerifiedAt: new Date() }), 'book_ground')).toEqual({ allowed: true }));
  it('asks for a phone otherwise', () => expect(gate.evaluateAction(p({ phone: null }), 'book_ground').code).toBe('PHONE_REQUIRED'));
});
