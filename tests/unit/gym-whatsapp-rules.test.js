'use strict';

// M24 §25 WhatsApp pure rules (M24-FR-157 to FR-160): every branch.
const r = require('../../src/modules/gym-whatsapp/gym-whatsapp.rules');

describe('M24 §25 WhatsApp rules', () => {
  it('chatNumber: the branch’s own number wins, else the owner’s; a hidden button shows nothing (M24-FR-157, FR-158)', () => {
    expect(r.chatNumber({ gymNumber: '+8801711111111', ownerNumber: '+8801822222222' })).toBe('+8801711111111');
    expect(r.chatNumber({ gymNumber: null, ownerNumber: '+8801822222222' })).toBe('+8801822222222');
    expect(r.chatNumber({ ownerNumber: '+8801822222222', showOnPage: false })).toBeNull();
    expect(r.chatNumber({})).toBeNull();
    expect(r.chatNumber()).toBeNull();
  });

  it('numberSource: own, owner or none', () => {
    expect(r.numberSource({ gymNumber: '+8801711111111', ownerNumber: '+8801822222222' })).toBe('own');
    expect(r.numberSource({ ownerNumber: '+8801822222222' })).toBe('owner');
    expect(r.numberSource({})).toBe('none');
    expect(r.numberSource()).toBe('none');
  });

  it('waDigits: the digits wa.me needs, only for a stored number', () => {
    expect(r.waDigits('+8801712345678')).toBe('8801712345678');
    expect(r.waDigits('01712345678')).toBeNull();
    expect(r.waDigits('+8801212345678')).toBeNull();
    expect(r.waDigits(null)).toBeNull();
    expect(r.E164.test('+8801912345678')).toBe(true);
  });

  it('last4', () => {
    expect(r.last4('+8801712345678')).toBe('5678');
  });

  it('currentConsent: the newest row, or nothing agreed (M24-FR-160)', () => {
    expect(r.currentConsent([])).toEqual({ service: false, news: false, source: null, at: null, numberLast4: null, consentVersion: null });
    expect(r.currentConsent(undefined)).toMatchObject({ service: false, news: false });
    const at = new Date('2026-11-21T10:00:00Z');
    expect(r.currentConsent([{ service: 1, news: 0, source: 'desk', createdAt: at, numberLast4: '5678', consentVersion: 1 }, { service: false }])).toEqual({
      service: true,
      news: false,
      source: 'desk',
      at,
      numberLast4: '5678',
      consentVersion: 1,
    });
    expect(r.currentConsent([{ service: true, news: true, source: 'member', numberLast4: '1111', consentVersion: 2 }]).at).toBeNull();
    expect(r.CONSENTS).toEqual(['service', 'news']);
  });

  it('consentChanged: a new row only when the number, a consent or the text version changed', () => {
    const cur = { numberHash: 'a', service: true, news: false, consentVersion: 1 };
    expect(r.consentChanged(null, cur)).toBe(true);
    expect(r.consentChanged(cur, { ...cur })).toBe(false);
    expect(r.consentChanged(cur, { ...cur, numberHash: 'b' })).toBe(true);
    expect(r.consentChanged(cur, { ...cur, service: false })).toBe(true);
    expect(r.consentChanged(cur, { ...cur, news: true })).toBe(true);
    expect(r.consentChanged(cur, { ...cur, consentVersion: 2 })).toBe(true);
  });
});
