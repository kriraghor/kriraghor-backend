'use strict';

// M08 pure rules: SMS encoding (FR-09), quiet hours (FR-10), channels (FR-06), templates (FR-07),
// dedupe (FR-02), masking (FR-15). 100% branch coverage.
const r = require('../../src/modules/notifications/notify.rules');

describe('SMS encoding and segments (M08-FR-09)', () => {
  it('GSM-7: 160 in one part, 153 per part after that; extension characters count twice', () => {
    expect(r.smsSegments('')).toEqual({ encoding: 'gsm7', units: 0, segments: 1 });
    expect(r.smsSegments('a'.repeat(160))).toMatchObject({ encoding: 'gsm7', segments: 1 });
    expect(r.smsSegments('a'.repeat(161))).toMatchObject({ segments: 2 });
    expect(r.smsSegments('a'.repeat(306))).toMatchObject({ segments: 2 });
    expect(r.smsSegments('a'.repeat(307))).toMatchObject({ segments: 3 });
    expect(r.smsSegments('€'.repeat(80))).toEqual({ encoding: 'gsm7', units: 160, segments: 1 });
    expect(r.smsSegments('[x]')).toMatchObject({ units: 5 });
  });

  it('any non-GSM character (Bangla, ৳) forces UCS-2: 70 / 67', () => {
    expect(r.smsEncoding('Pay ৳500')).toBe('ucs2');
    expect(r.smsSegments('ক'.repeat(70))).toEqual({ encoding: 'ucs2', units: 70, segments: 1 });
    expect(r.smsSegments('ক'.repeat(71))).toMatchObject({ segments: 2 });
    expect(r.smsSegments('ক'.repeat(134))).toMatchObject({ segments: 2 });
    expect(r.smsSegments('ক'.repeat(135))).toMatchObject({ segments: 3 });
  });
});

describe('quiet hours (M08-FR-10, §6.4)', () => {
  // Dhaka is UTC+6: 22:00 Dhaka = 16:00 UTC, 08:00 Dhaka = 02:00 UTC.
  const at = (iso) => new Date(iso);
  const nextMorning = at('2026-10-16T02:00:00.000Z');
  it.each([
    ['21:59 Dhaka goes now', '2026-10-15T15:59:00Z', null],
    ['22:00 Dhaka waits for 08:00', '2026-10-15T16:00:00Z', nextMorning],
    ['02:00 Dhaka waits for 08:00 the same day', '2026-10-15T20:00:00Z', nextMorning],
    ['07:59 Dhaka waits one minute', '2026-10-16T01:59:00Z', nextMorning],
    ['08:00 Dhaka goes now', '2026-10-16T02:00:00Z', null],
  ])('%s', (_name, now, expected) => {
    const out = r.deliverAt({ now: at(now), channel: 'sms' });
    expect(out.toISOString()).toBe((expected ?? at(now)).toISOString());
  });

  it('in-app, urgent and opted-out users go now', () => {
    const night = at('2026-10-15T18:00:00Z');
    expect(r.deliverAt({ now: night, channel: 'in_app' })).toBe(night);
    expect(r.deliverAt({ now: night, channel: 'sms', urgent: true })).toBe(night);
    expect(r.deliverAt({ now: night, channel: 'email', quietEnabled: false })).toBe(night);
  });

  it('a window that does not wrap midnight', () => {
    const lunch = { quietStart: '13:00', quietEnd: '14:00', channel: 'email' };
    expect(r.deliverAt({ ...lunch, now: at('2026-10-15T07:30:00Z') }).toISOString()).toBe('2026-10-15T08:00:00.000Z'); // 13:30 Dhaka
    expect(r.deliverAt({ ...lunch, now: at('2026-10-15T08:30:00Z') }).toISOString()).toBe('2026-10-15T08:30:00.000Z'); // 14:30 Dhaka
    expect(r.deliverAt({ channel: 'sms' })).toBeInstanceOf(Date);
  });
});

describe('channels and mandatory cells (M08-FR-06, §6.3)', () => {
  it('drops channels the user turned off, except mandatory ones', () => {
    const prefs = new Map([
      ['security:sms', false],
      ['security:email', false],
      ['moderation:sms', false],
    ]);
    expect(r.resolveChannels({ category: 'security', channels: ['in_app', 'sms', 'email'], prefs })).toEqual(['in_app', 'sms']);
    expect(r.resolveChannels({ category: 'moderation', channels: ['in_app', 'sms'], prefs })).toEqual(['in_app']);
    expect(r.resolveChannels({ category: 'staff_ops', channels: ['email'] })).toEqual(['email']);
    expect(() => r.resolveChannels({ category: 'nope', channels: [] })).toThrow('Unknown notification category nope');
    expect(r.isMandatory('money', 'sms')).toBe(true);
    expect(r.isMandatory('reviews', 'in_app')).toBe(false);
    expect(r.isMandatory('nope', 'sms')).toBe(false);
  });
});

describe('templates (M08-FR-07, §6.2)', () => {
  const vars = [
    { name: 'amount', type: 'money' },
    { name: 'at', type: 'datetime' },
    { name: 'n', type: 'number' },
    { name: 'who', type: 'text', maxLen: 5 },
    { name: 'url', type: 'link' },
  ];
  const values = { amount: 210050, at: '2026-10-08T12:00:00Z', n: 12, who: 'Ayesha Siddiqua', url: 'https://x.test/a' };

  it('formats money, dates and numbers per locale and cuts long text', () => {
    const en = r.render('{{amount}} {{ at }} {{n}} {{who}} {{url}}', vars, values, 'en');
    expect(en).toBe(`৳2,100.50 ${r.formatValue('datetime', values.at, 'en')} 12 Ayes… https://x.test/a`);
    expect(en).toMatch(/Thu 8 Oct.*18:00|Thu, 8 Oct/);
    const bn = r.render('{{amount}} {{n}}', vars, values, 'bn');
    expect(bn).toBe('৳২,১০০.৫০ ১২');
    expect(r.formatValue('money', 500000, 'en')).toBe('৳5,000');
    expect(r.formatValue('datetime', values.at, 'bn')).toMatch(/[০-৯]/);
  });

  it('fails closed on missing or undeclared variables', () => {
    expect(() => r.render('{{amount}}', vars, { ...values, amount: null }, 'en')).toThrow(r.TemplateError);
    expect(() => r.render('{{other}}', [], {}, 'en')).toThrow('Undeclared variable other');
    expect(r.render('No variables', undefined, {}, 'en')).toBe('No variables');
  });
});

describe('dedupe and masking (M08-FR-02, FR-15)', () => {
  it('dedupe keys bucket by the window', () => {
    const a = r.dedupeKey({ code: 'X', subjectId: 's', userId: 'u', at: new Date('2026-10-15T00:00:00Z'), windowHours: 24 });
    const b = r.dedupeKey({ code: 'X', subjectId: 's', userId: 'u', at: new Date('2026-10-15T23:00:00Z'), windowHours: 24 });
    const c = r.dedupeKey({ code: 'X', subjectId: 's', userId: 'u', at: new Date('2026-10-16T00:00:00Z'), windowHours: 24 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(r.dedupeKey({ code: 'X', subjectId: 's', userId: 'u' })).toMatch(/^X:s:u:\d+$/);
  });

  it('masks phones and redacts codes', () => {
    expect(r.maskPhone('+8801711004321')).toBe('+8801•••••4321');
    expect(r.maskPhone('12345')).toBe('•••');
    expect(r.redactCodes('Your code is 123456. Expires in 5 minutes.')).toBe('Your code is ••••••. Expires in 5 minutes.');
  });
});
