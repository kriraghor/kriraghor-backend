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

  it('consentFor and memberBlock: the consent a category needs, the number and template first (M24-FR-164)', () => {
    expect(r.consentFor('marketing')).toBe('news');
    expect(r.consentFor('utility')).toBe('service');
    const ok = { consent: { service: true, news: false }, category: 'utility', senderConnected: true, templateApproved: true };
    expect(r.memberBlock(ok)).toBeNull();
    expect(r.memberBlock({ ...ok, senderConnected: false })).toBe('no_sender');
    expect(r.memberBlock({ ...ok, templateApproved: false })).toBe('template');
    expect(r.memberBlock({ ...ok, category: 'marketing' })).toBe('no_consent');
    expect(r.memberBlock({ ...ok, consent: null })).toBe('no_consent');
  });

  it('sendAfter: utility now; marketing waits out quiet hours, wrapping midnight or not (M24-FR-168)', () => {
    const at = (iso) => new Date(iso);
    // 23:00 Dhaka = 17:00 UTC, inside 22:00–08:00 → 08:00 Dhaka next day (02:00 UTC).
    expect(r.sendAfter({ now: at('2026-11-21T17:00:00Z'), category: 'marketing', quietStart: '22:00', quietEnd: '08:00' }).toISOString()).toBe('2026-11-22T02:00:00.000Z');
    // 01:00 Dhaka (19:00 UTC the day before) → 08:00 Dhaka the same morning.
    expect(r.sendAfter({ now: at('2026-11-21T19:00:00Z'), category: 'marketing', quietStart: '22:00', quietEnd: '08:00' }).toISOString()).toBe('2026-11-22T02:00:00.000Z');
    // 12:00 Dhaka: outside → now.
    const noon = at('2026-11-21T06:00:00Z');
    expect(r.sendAfter({ now: noon, category: 'marketing', quietStart: '22:00', quietEnd: '08:00' })).toBe(noon);
    // A window that does not wrap: 13:00–15:00, at 14:00 → 15:00 the same day.
    expect(r.sendAfter({ now: at('2026-11-21T08:00:00Z'), category: 'marketing', quietStart: '13:00', quietEnd: '15:00' }).toISOString()).toBe('2026-11-21T09:00:00.000Z');
    expect(r.sendAfter({ now: noon, category: 'marketing', quietStart: '13:00', quietEnd: '15:00' })).toBe(noon);
    // Utility never waits; a default `now` is today.
    expect(r.sendAfter({ now: noon, category: 'utility', quietStart: '00:00', quietEnd: '23:59' })).toBe(noon);
    expect(r.sendAfter({ category: 'utility' })).toBeInstanceOf(Date);
  });

  it('isStop: English or Bangla, any case and spaces', () => {
    expect(r.isStop(' STOP ')).toBe(true);
    expect(r.isStop('Unsubscribe')).toBe(true);
    expect(r.isStop('বন্ধ')).toBe(true);
    expect(r.isStop('please stop')).toBe(false);
    expect(r.isStop(undefined)).toBe(false);
  });

  it('advances: statuses only move forward; failed only before delivery (M24-FR-170)', () => {
    expect(r.advances('queued', 'sending')).toBe(true);
    expect(r.advances('sent', 'delivered')).toBe(true);
    expect(r.advances('delivered', 'read')).toBe(true);
    expect(r.advances('read', 'delivered')).toBe(false);
    expect(r.advances('sent', 'failed')).toBe(true);
    expect(r.advances('delivered', 'failed')).toBe(false);
    expect(r.advances('failed', 'read')).toBe(false);
    expect(r.advances('expired', 'delivered')).toBe(false);
    expect(r.advances('sent', 'expired')).toBe(true);
    expect(r.advances('sent', 'bogus')).toBe(false);
    expect(r.advances('bogus', 'sent')).toBe(false);
  });

  it('bulkLeft', () => {
    expect(r.bulkLeft({ cap: 2, sentToday: 1 })).toBe(1);
    expect(r.bulkLeft({ cap: 2, sentToday: 5 })).toBe(0);
  });
});

describe('M24 §25 WhatsApp templates and the webhook signature', () => {
  const TPL = require('../../src/modules/gym-whatsapp/templates');
  const provider = require('../../src/providers/whatsapp');
  const crypto = require('crypto');

  it('every kind has a template in both languages with as many slots as values, and marketing carries STOP', () => {
    for (const [kind, code] of Object.entries(TPL.KIND_TEMPLATE)) {
      const t = TPL.TEMPLATES[code];
      expect(t).toBeTruthy();
      for (const locale of ['en', 'bn']) {
        const slots = new Set(t[locale].match(/\{\{(\d+)\}\}/g));
        expect(slots.size).toBe(t.params.length);
        expect(t.example).toHaveLength(t.params.length);
        if (t.category === 'marketing') expect(t[locale]).toMatch(/STOP/);
      }
      expect(kind).toBeTruthy();
    }
    expect(TPL.AUTO_KINDS).toEqual(['receipt', 'renewal_due', 'ends_today', 'overdue', 'pay_link']);
  });

  it('createBody, valuesOf and render', () => {
    expect(TPL.createBody('kg_receipt', 'bn')).toMatchObject({ name: 'kg_receipt', language: 'bn', category: 'UTILITY', components: [{ type: 'BODY' }] });
    const values = TPL.valuesOf('kg_receipt', { gym: 'Iron Yard', receiptNo: 'IY-R26-000001', amount: '৳2,500' });
    expect(values).toEqual(['Iron Yard', 'IY-R26-000001', '৳2,500', '']);
    expect(TPL.render('kg_receipt', 'en', values)).toBe('Iron Yard: we received ৳2,500, receipt IY-R26-000001. See your receipt: ');
    expect(TPL.render('kg_pay_link', 'en', [])).toBe(': pay  here: ');
  });

  it('signatureValid: HMAC-SHA256 of the raw body with the app secret, nothing else', () => {
    const raw = Buffer.from('{"entry":[]}');
    const sig = `sha256=${crypto.createHmac('sha256', 's3cret').update(raw).digest('hex')}`;
    expect(provider.signatureValid(raw, sig, 's3cret')).toBe(true);
    expect(provider.signatureValid(raw, sig, 'other')).toBe(false);
    expect(provider.signatureValid(raw, 'sha256=abc', 's3cret')).toBe(false);
    expect(provider.signatureValid(raw, sig.slice(7), 's3cret')).toBe(false);
    expect(provider.signatureValid('{"entry":[]}', sig, 's3cret')).toBe(false);
    expect(provider.signatureValid(raw, sig, null)).toBe(false);
  });
});
