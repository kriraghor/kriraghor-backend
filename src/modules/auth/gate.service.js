'use strict';

const { ROLES } = require('../../common/enums');

/**
 * The public "gate" (M01 §6.2): signed in → account active → member (NID) active → role active.
 * Action → requirement map. Keep in sync with the frontend contract.
 */
const ACTIONS = Object.freeze({
  book_ground: ROLES.MEMBER,
  hire: ROLES.MEMBER,
  buy: ROLES.MEMBER,
  offer: ROLES.MEMBER,
  sell_used: ROLES.MEMBER,
  register_team: ROLES.MEMBER,
  join_open_game: ROLES.MEMBER,
  list_ground: ROLES.GROUND_OWNER,
  list_product: ROLES.SHOP_OWNER,
  publish_tournament: ROLES.ORGANISER,
  accept_hire: [ROLES.PLAYER, ROLES.PRO],
  // M02 v3: withdrawing esports winnings needs NID KYC (M07, M21).
  withdraw_winnings: ROLES.MEMBER,
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

function evaluateAction(principal, action) {
  const need = ACTIONS[action];
  if (!need) return null;
  return evaluate(principal, need);
}

module.exports = { ACTIONS, evaluate, evaluateAction };
