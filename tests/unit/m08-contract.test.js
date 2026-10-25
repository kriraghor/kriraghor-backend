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

// M24-FR-103 (25 Oct 2026): gym owners and members use the gym app on gym.kriraghor.com, so their
// notification links are absolute gym URLs; the trainer's own links stay on kriraghor.com (Hire).
describe('gym notification links (M24-FR-103)', () => {
  const config = require('../../src/config');
  const { byCode, gymUrl } = require('../../src/modules/notifications/notify.catalogue');
  const gym = config.apps.gym;
  const link = (code, payload, ctx) => byCode.get(code).link({ payload }, ctx);

  it('gymUrl prefixes GYM_APP_URL (no trailing slash)', () => {
    expect(gym).not.toMatch(/\/$/);
    expect(gymUrl('/me/passes')).toBe(`${gym}/me/passes`);
  });

  it('owner listing news opens the gym editor in the gym app', () => {
    for (const code of ['GYM_LIVE', 'GYM_CHANGES_REQUESTED', 'GYM_REJECTED']) {
      expect([code, link(code, { gymId: 'g-1', ownerId: 'o-1' })]).toEqual([code, `${gym}/manage/g-1/edit`]);
    }
  });

  it('passes and the member side of trainer subscriptions open the gym app', () => {
    expect(link('GYM_PASS_READY', { code: 'GP-7K2M9Q' })).toBe(`${gym}/me/passes/GP-7K2M9Q`);
    expect(link('GYM_PASS_CANCELLED', { code: 'GP-7K2M9Q' })).toBe(`${gym}/me/passes`);
    expect(link('TRAINER_SUB_STARTED', { memberId: 'm-1' })).toBe(`${gym}/me/subscriptions`);
    expect(link('TRAINER_SUB_RENEWAL_DUE', { memberId: 'm-1' })).toBe(`${gym}/me/subscriptions`);
  });

  it('TRAINER_SUB_LAPSED links per recipient: the member to the gym app, the trainer to kriraghor.com', () => {
    const payload = { memberId: 'm-1', trainerId: 't-1', code: 'TS-1' };
    expect(link('TRAINER_SUB_LAPSED', payload, { userId: 'm-1' })).toBe(`${gym}/me/subscriptions`);
    expect(link('TRAINER_SUB_LAPSED', payload, { userId: 't-1' })).toBe(`${config.apps.web}/pro/subscriptions`);
    expect(link('TRAINER_SUB_LAPSED', payload)).toBe(`${gym}/me/subscriptions`);
  });

  it('TEAM_ADDED sends gym staff to the gym app and venue or shop staff to vendor', () => {
    expect(link('TEAM_ADDED', { businessType: 'gym', businessId: 'g-1' })).toBe(`${gym}/manage`);
    expect(link('TEAM_ADDED', { businessType: 'venue', businessId: 'v-1' })).toBe(`${config.apps.vendor}/`);
    expect(link('TEAM_ADDED', { businessType: 'shop', businessId: 's-1' })).toBe(`${config.apps.vendor}/`);
  });

  it('trainer-side links and gym reviews are unchanged', () => {
    expect(link('TRAINER_NEW_SUBSCRIBER', { trainerId: 't-1' })).toBe('/pro/subscriptions');
    expect(link('TRAINER_SUB_CANCELLED', { trainerId: 't-1' })).toBe('/pro/subscriptions');
    expect(link('TRAINER_SUB_PAID', { trainerId: 't-1' })).toBe('/me/payouts');
    expect(link('REVIEW_NEW', { subjectType: 'gym', ownerId: 'o-1' })).toBe(`${config.apps.vendor}/reviews`);
  });
});
