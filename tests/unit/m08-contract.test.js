'use strict';

// M08 contract (spec §13, DoD): every catalogue code has active EN and BN templates for each default
// channel, every placeholder is declared, SMS stay within the segment cap at maximum variable length,
// and every catalogue event is a registered domain event.
const { CATALOGUE } = require('../../src/modules/notifications/notify.catalogue');
const { templatesSeed } = require('../../src/db/seed');
const { EVENTS } = require('../../src/modules/events/catalog');
const { render, smsSegments, CATEGORIES } = require('../../src/modules/notifications/notify.rules');

const find = (code, channel, locale) => templatesSeed.templates.find((t) => t.code === code && t.channel === channel && t.locale === locale);

/** The longest value each variable can take, in the template's script. */
function longest(variables, locale) {
  const ch = locale === 'bn' ? 'ক' : 'x';
  return Object.fromEntries(
    variables.map((v) => {
      if (v.type === 'money') return [v.name, 99999999];
      if (v.type === 'number') return [v.name, 999];
      if (v.type === 'datetime') return [v.name, '2026-12-31T23:59:00Z'];
      if (v.type === 'link') return [v.name, 'https://krg.bd/x/ABCDEFGH'];
      return [v.name, ch.repeat(v.maxLen ?? 40)];
    })
  );
}

describe('catalogue ↔ templates', () => {
  it('every catalogue channel has an EN and a BN template that renders', () => {
    const missing = [];
    for (const entry of CATALOGUE) {
      for (const channel of entry.channels) {
        for (const locale of ['en', 'bn']) {
          const t = find(entry.code, channel, locale);
          if (!t) {
            missing.push(`${entry.code}.${channel}.${locale}`);
            continue;
          }
          const values = longest(t.variables, locale);
          expect(() => render(t.body, t.variables, values, locale)).not.toThrow();
          if (t.subject) expect(() => render(t.subject, t.variables, values, locale)).not.toThrow();
          if (channel !== 'sms') expect(t.subject).toBeTruthy();
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('SMS templates stay within 3 segments even at maximum variable length (FR-09)', () => {
    const over = templatesSeed.templates
      .filter((t) => t.channel === 'sms')
      .map((t) => ({ key: `${t.code}.${t.locale}`, ...smsSegments(render(t.body, t.variables, longest(t.variables, t.locale), t.locale)) }))
      .filter((r) => r.segments > 3);
    expect(over).toEqual([]);
  });

  it('no template exists without a catalogue entry, and in-app titles fit (140)', () => {
    const codes = new Set(CATALOGUE.map((c) => c.code));
    expect(templatesSeed.templates.filter((t) => !codes.has(t.code)).map((t) => t.code)).toEqual([]);
    for (const t of templatesSeed.templates.filter((x) => x.channel === 'in_app')) {
      expect([t.code, render(t.subject, t.variables, longest(t.variables, t.locale), t.locale).length <= 140]).toEqual([t.code, true]);
    }
  });

  it('every catalogue event is a registered domain event; categories exist; codes are unique', () => {
    for (const entry of CATALOGUE) {
      for (const e of entry.events) expect([entry.code, e, Boolean(EVENTS[e])]).toEqual([entry.code, e, true]);
      expect(CATEGORIES[entry.category]).toBeDefined();
    }
    expect(new Set(CATALOGUE.map((c) => c.code)).size).toBe(CATALOGUE.length);
  });
});
