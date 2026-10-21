'use strict';

// The Round B1 demo content (scripts/demo/data.js, steps/availability.js): reviews and replies that
// publish straight away (no link or phone number, M17-FR-32 and FR-34), stars 1–5, demo accounts
// only, one item of each kind left for the demo member to rate, and calendars inside the next two
// weeks (the PUT range) with a Friday repeat.
const D = require('../../scripts/demo/data');
const { bodyFor } = require('../../scripts/demo/steps/availability');
const rules = require('../../src/modules/trust/trust.rules');

const DAY = 86400000;
const players = new Set(D.PLAYERS.map((p) => p.n));
const reviews = [...D.HIRE_HISTORY, ...D.SHOP_REVIEWS, ...D.GYM_REVIEWS, D.MEMBER_SHOP_REVIEW].filter((x) => x.review);

describe('Round B1 demo reviews', () => {
  it('publish straight away: stars 1 to 5, no link or phone number in a review or a reply', () => {
    expect(reviews.length).toBeGreaterThanOrEqual(15);
    for (const x of reviews) {
      const [stars, text] = x.review;
      expect(Number.isInteger(stars) && stars >= 1 && stars <= 5).toBe(true);
      expect(rules.contentFlag(text)).toBeNull();
      if (x.reply) expect(rules.replyBlock(x.reply)).toBeNull();
    }
  });

  it('come from demo players or the demo member, each once per pro, shop or gym', () => {
    const authors = [...D.HIRE_HISTORY.map((h) => [h.pro, h.hirer]), ...D.SHOP_REVIEWS.map((s) => [s.shop, s.buyer]), ...D.GYM_REVIEWS.map((g) => [g.gym, g.member])];
    for (const [, n] of authors) expect(players.has(n) || n === D.MEMBER.n).toBe(true);
    expect(new Set(authors.map((a) => a.join(':'))).size).toBe(authors.length);
    // Players 40–43 already have an order from steps/full.js, which makes one order per buyer.
    for (const s of D.SHOP_REVIEWS) expect(s.buyer).toBeGreaterThan(43);
  });

  it('give the referee, the umpire, a shop and a gym enough reviews to show a rating (reviews.min_count_display = 3)', () => {
    const count = (list, key, value) => list.filter((x) => x[key] === value && x.review).length;
    expect(count(D.HIRE_HISTORY, 'pro', 21)).toBeGreaterThanOrEqual(3);
    expect(count(D.HIRE_HISTORY, 'pro', 20)).toBeGreaterThanOrEqual(3);
    expect(count(D.SHOP_REVIEWS, 'shop', 'Iron Supply Tejgaon')).toBeGreaterThanOrEqual(3);
    expect(count(D.GYM_REVIEWS, 'gym', 'PowerHouse Gym Mirpur')).toBeGreaterThanOrEqual(3);
    // Inside reviews.window_days (30), and the member's hire job is left to rate.
    for (const x of [...D.HIRE_HISTORY, ...D.SHOP_REVIEWS]) expect(x.daysAgo).toBeLessThan(30);
    expect(D.HIRE_HISTORY.filter((h) => h.hirer === D.MEMBER.n && !h.review)).toHaveLength(1);
  });
});

describe('Round B1 demo calendars', () => {
  it('stay inside the saved range (today to 14 days on), with a Friday repeat and two one-off blocks each', () => {
    for (const spec of D.AVAILABILITY) {
      const b = bodyFor(spec);
      expect(Date.parse(b.to) - Date.parse(b.from)).toBe(14 * DAY);
      expect(b.blocks).toHaveLength(2);
      for (const x of b.blocks) {
        expect(Date.parse(x.start)).toBeGreaterThanOrEqual(Date.parse(b.from));
        expect(Date.parse(x.end)).toBeLessThanOrEqual(Date.parse(b.to));
        expect(Date.parse(x.end)).toBeGreaterThan(Date.parse(x.start));
        expect(x.reason).toBeTruthy();
      }
      expect(b.repeats).toEqual([expect.objectContaining({ weekdays: [5], from: '09:00', to: '13:00' })]);
    }
  });
});
