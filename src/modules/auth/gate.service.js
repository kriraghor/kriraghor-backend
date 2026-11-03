'use strict';

const { ROLES } = require('../../common/enums');

/**
 * The public "gate" (M01 §6.2): signed in → account active → member (NID) active → role active.
 * Action → requirement map. Keep in sync with the frontend contract.
 * PHONE_VERIFIED (v3, M21): esports play needs a verified phone, not NID KYC; the verified game
 * profile for the tournament's game is checked by M21 itself (ESPORTS_GAME_PROFILE_REQUIRED).
 * Booking a ground (M10, 17 Oct 2026) also needs only a verified phone: the money is prepaid into
 * escrow, so NID adds friction without protecting anyone. Owners still need NID (list_ground).
 */
const PHONE_VERIFIED = 'phone_verified';
/**
 * M24 §3.4 (G1): running a private gym needs only a verified phone (no NID), but an owner whose
 * gym_owner role was suspended is refused (ROLE_SUSPENDED), exactly as M01-FR-46 does for listed gyms.
 */
const GYM_RUNNER = 'gym_runner';
const ACTIONS = Object.freeze({
  book_ground: PHONE_VERIFIED,
  // M11 (17 Oct 2026): hiring is prepaid into escrow, so a verified phone is enough, as for booking
  // and buying. Pros still need NID (the member role) to be listed and paid.
  hire: PHONE_VERIFIED,
  // M13 (17 Oct 2026): buying from a shop is prepaid into escrow, so a verified phone is enough, as
  // for booking. Selling (list_product, sell_used) and withdrawing still need NID.
  buy: PHONE_VERIFIED,
  offer: ROLES.MEMBER,
  sell_used: ROLES.MEMBER,
  register_team: ROLES.MEMBER,
  join_open_game: ROLES.MEMBER,
  list_ground: ROLES.GROUND_OWNER,
  list_product: ROLES.SHOP_OWNER,
  // M20 (18 Oct 2026, Q109): gyms are listed by their own gym_owner role (the ground owner's
  // documents). Passes and trainer subscriptions are prepaid into escrow, so a verified phone is
  // enough, as for booking a ground.
  list_gym: ROLES.GYM_OWNER,
  // M24-FR-01 (G1): a private gym (management only) needs a verified phone and a gym_owner role that is
  // not suspended; members accept gym invites and join gyms with a verified phone (never NID, D6).
  run_gym: GYM_RUNNER,
  // M26: posting a tournament, commenting and messaging need a verified phone; reading needs nothing.
  post_tournament: PHONE_VERIFIED,
  join_gym: PHONE_VERIFIED,
  buy_gym_pass: PHONE_VERIFIED,
  subscribe_trainer: PHONE_VERIFIED,
  publish_tournament: ROLES.ORGANISER,
  accept_hire: [ROLES.PLAYER, ROLES.PRO],
  // M02 v3: withdrawing esports winnings needs NID KYC (M07, M21).
  withdraw_winnings: ROLES.MEMBER,
  join_esports: PHONE_VERIFIED,
  // M23 (18 Oct 2026): free polls on big events need a verified phone (one vote per member, no stakes).
  vote_poll: PHONE_VERIFIED,
  // M16 (18 Oct 2026): creating and joining a sports team needs a verified phone; entering a
  // tournament (register_team, M14) still needs NID.
  create_team: PHONE_VERIFIED,
  join_team: PHONE_VERIFIED,
  // M17 (17 Oct 2026): the member who paid can dispute with a verified phone, like booking.
  file_dispute: PHONE_VERIFIED,
});

const PENDING = new Set(['applied', 'documents_pending', 'in_review']);

const NEXT = {
  AUTH_REQUIRED: '/signup',
  ACCOUNT_SUSPENDED: '/account',
  ACCOUNT_BANNED: '/help',
  KYC_REQUIRED: '/account/verification',
  KYC_PENDING: '/account/verification',
  ROLE_REQUIRED: '/account/roles',
  ROLE_PENDING: '/account/verification',
  ROLE_SUSPENDED: '/help',
  PHONE_REQUIRED: '/me',
};

/**
 * Evaluate the gate. Returns { allowed: true } or { allowed: false, code, role?, next }.
 * @param {object|null} principal
 * @param {string|string[]} need  role (or any-of roles) required
 */
function evaluate(principal, need) {
  const deny = (code, extra = {}) => ({ allowed: false, code, next: NEXT[code], ...extra });
  if (!principal) return deny('AUTH_REQUIRED');

  const { user, roles } = principal;
  if (user.status === 'suspended') return deny('ACCOUNT_SUSPENDED');
  if (user.status !== 'active') return deny('ACCOUNT_BANNED');
  if (need === PHONE_VERIFIED) return user.phone && user.phoneVerifiedAt ? { allowed: true } : deny('PHONE_REQUIRED');
  if (need === GYM_RUNNER) {
    if (!(user.phone && user.phoneVerifiedAt)) return deny('PHONE_REQUIRED');
    return roles?.[ROLES.GYM_OWNER] === 'suspended' ? deny('ROLE_SUSPENDED', { role: ROLES.GYM_OWNER }) : { allowed: true };
  }

  const member = roles[ROLES.MEMBER];
  if (member !== 'active') {
    if (member === 'in_review' || user.kycStatus === 'pending') return deny('KYC_PENDING');
    return deny('KYC_REQUIRED');
  }

  const needed = Array.isArray(need) ? need : [need];
  if (needed.length === 1 && needed[0] === ROLES.MEMBER) return { allowed: true };
  if (needed.some((r) => roles[r] === 'active')) return { allowed: true };
  if (needed.some((r) => roles[r] === 'suspended')) return deny('ROLE_SUSPENDED', { role: needed[0] });
  if (needed.some((r) => PENDING.has(roles[r]) || roles[r] === 'changes_requested')) return deny('ROLE_PENDING', { role: needed[0] });
  return deny('ROLE_REQUIRED', { role: needed[0] });
}

/**
 * Round B3 (Q169): the desks staff can use. The owner passes exactly as before (their list_* gate);
 * otherwise a member who works at a business of that type for a live owner passes with a verified
 * phone (no NID). Anyone else gets the owner gate's answer, unchanged. Which business and which
 * permission is checked by the owning module (business-members actFor: 404 for other businesses).
 */
const WORK = Object.freeze({
  work_ground: { owner: 'list_ground', type: 'venue' },
  // M24 §3.4: a gym owner passes with run_gym (a private gym needs no documents); staff as in Round B3.
  work_gym: { owner: 'run_gym', type: 'gym' },
  work_shop: { owner: 'list_product', type: 'shop' },
});

function evaluateWork(principal, { owner, type }) {
  const asOwner = evaluate(principal, ACTIONS[owner]);
  if (asOwner.allowed) return asOwner;
  if (!(principal?.workplaces ?? []).some((w) => w.businessType === type)) return asOwner;
  return evaluate(principal, PHONE_VERIFIED);
}

function evaluateAction(principal, action) {
  if (WORK[action]) return evaluateWork(principal, WORK[action]);
  const need = ACTIONS[action];
  if (!need) return null;
  return evaluate(principal, need);
}

module.exports = { ACTIONS, WORK, PHONE_VERIFIED, GYM_RUNNER, evaluate, evaluateAction };
