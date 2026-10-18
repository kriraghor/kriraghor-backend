'use strict';

/** Canonical role model (docs/00-platform/03-roles-permissions.md). */
const ROLES = Object.freeze({
  MEMBER: 'member',
  PLAYER: 'player',
  PRO: 'pro',
  GROUND_OWNER: 'ground_owner',
  SHOP_OWNER: 'shop_owner',
  ORGANISER: 'organiser',
  GYM_OWNER: 'gym_owner',
  STAFF: 'staff',
  MASTER_ADMIN: 'master_admin',
});
const ROLE_LIST = Object.values(ROLES);

/** Roles a member can apply for themselves. Staff/master are granted by a master admin only. */
const SELF_SERVICE_ROLES = [ROLES.PLAYER, ROLES.PRO, ROLES.GROUND_OWNER, ROLES.SHOP_OWNER, ROLES.ORGANISER, ROLES.GYM_OWNER];
const ADMIN_ROLES = [ROLES.STAFF, ROLES.MASTER_ADMIN];

const ROLE_STATUS = Object.freeze({
  APPLIED: 'applied',
  IN_REVIEW: 'in_review',
  ACTIVE: 'active',
  CHANGES_REQUESTED: 'changes_requested',
  REJECTED: 'rejected',
  SUSPENDED: 'suspended',
});
const ROLE_STATUS_LIST = Object.values(ROLE_STATUS);

/** Allowed role-status transitions (anything else is rejected). */
const ROLE_TRANSITIONS = Object.freeze({
  applied: ['in_review', 'active', 'rejected'],
  in_review: ['active', 'changes_requested', 'rejected'],
  changes_requested: ['in_review', 'rejected'],
  active: ['suspended'],
  suspended: ['active'],
  rejected: ['applied'],
});

/** Staff permission flags (Panels v2 matrix + proposed additions). */
const PERMISSIONS = Object.freeze({
  APPROVE_LISTINGS: 'approve_listings',
  APPROVE_DOCUMENTS: 'approve_documents',
  RESOLVE_REPORTS: 'resolve_reports',
  REFUND_SMALL: 'refund_small',
  VIEW_PAYOUTS: 'view_payouts',
  RELEASE_PAYOUTS: 'release_payouts',
  MANAGE_USERS: 'manage_users',
  MANAGE_CATALOG: 'manage_catalog',
  MANAGE_ESPORTS: 'manage_esports', // M03 esports catalogue, M21 tournaments
  ENTER_RESULTS: 'enter_results', // M21 match results only
  MANAGE_ORGANISERS: 'manage_organisers', // M22 organisations, contracts and invoices
  VIEW_ANALYTICS: 'view_analytics', // M19 platform overview and its exports (Q104)
  EDIT_FEES: 'edit_fees', // master only
  MANAGE_STAFF: 'manage_staff', // master only
});
const PERMISSION_LIST = Object.values(PERMISSIONS);
const MASTER_ONLY_PERMISSIONS = [PERMISSIONS.EDIT_FEES, PERMISSIONS.MANAGE_STAFF];

const USER_STATUS = Object.freeze({ ACTIVE: 'active', SUSPENDED: 'suspended', BANNED: 'banned' });
const KYC_STATUS = Object.freeze({ UNVERIFIED: 'unverified', PENDING: 'pending', VERIFIED: 'verified', REJECTED: 'rejected' });

const OTP_PURPOSE = Object.freeze({ SIGNUP: 'signup', LOGIN: 'login', RESET: 'reset' });

const LOCALES = ['en', 'bn'];

module.exports = {
  ROLES,
  ROLE_LIST,
  SELF_SERVICE_ROLES,
  ADMIN_ROLES,
  ROLE_STATUS,
  ROLE_STATUS_LIST,
  ROLE_TRANSITIONS,
  PERMISSIONS,
  PERMISSION_LIST,
  MASTER_ONLY_PERMISSIONS,
  USER_STATUS,
  KYC_STATUS,
  OTP_PURPOSE,
  LOCALES,
};
