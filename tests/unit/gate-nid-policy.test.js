'use strict';

/**
 * Pins the gate map (M01 §6.2) to the product owner's NID policy of 25 Oct 2026: NID verification is
 * asked for only where it is needed today. Gym members, booking, hiring someone, shopping, esports and
 * teams stay phone-only; selling, being hired or paid, entering a tournament with a team, open games and
 * withdrawing winnings need the member (NID) role; listing a business needs its business role, which
 * itself needs an active member role. Changing who must show an NID is a product decision: update the
 * docs (M02 as-built, open questions) and this test together.
 */
require('../env');
const { ACTIONS, PHONE_VERIFIED } = require('../../src/modules/auth/gate.service');

const PHONE_ONLY = ['buy_gym_pass', 'subscribe_trainer', 'book_ground', 'hire', 'buy', 'join_esports', 'create_team', 'join_team', 'vote_poll', 'file_dispute'];
const MEMBER_NID = ['offer', 'sell_used', 'register_team', 'join_open_game', 'withdraw_winnings'];
const BUSINESS = { list_ground: 'ground_owner', list_gym: 'gym_owner', list_product: 'shop_owner', publish_tournament: 'organiser', accept_hire: ['player', 'pro'] };

describe('gate NID policy (M01 §6.2, product owner 25 Oct 2026)', () => {
  it.each(PHONE_ONLY)('%s needs a verified phone only (no NID)', (action) => {
    expect(ACTIONS[action]).toBe(PHONE_VERIFIED);
  });

  it.each(MEMBER_NID)('%s needs the member role (NID verified)', (action) => {
    expect(ACTIONS[action]).toBe('member');
  });

  it.each(Object.entries(BUSINESS))('%s needs the %p business role', (action, need) => {
    expect(ACTIONS[action]).toEqual(need);
  });

  it('has no action outside these three lists', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual([...PHONE_ONLY, ...MEMBER_NID, ...Object.keys(BUSINESS)].sort());
  });
});
