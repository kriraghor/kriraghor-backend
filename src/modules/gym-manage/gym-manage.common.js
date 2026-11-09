'use strict';

/**
 * Shared bits of M24 (gym-manage): the error catalogue (§9.4), every number from M03 (read per call),
 * access to one gym through business-members actFor (M24-FR-05), the owner's subscription (tier gates
 * M24-FR-07 and restricted mode M24-FR-08), the gym's settings row and its counters (member codes and
 * receipt numbers under the row lock, M24-FR-10, FR-33), personal data at rest (M24-FR-11), signed
 * tokens, events and audit.
 */
const { QueryTypes } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const crypto = require('../../common/crypto');
const { uuid7 } = require('../../common/uuid7');
const config = require('../../config');
const { sequelize, GymManageSettings, GymOwnerSubscription, GymMember } = require('../../models');
const settings = require('../settings').settings;
const events = require('../events').events;
const audit = require('../audit').audit;
const access = require('../business-members').access;
const staffFacade = require('../business-members').members;
const gymFacade = require('../gym').gyms;
const directory = require('../users').directory;
const rules = require('./gym-manage.rules');

const ERRORS = {
  GYM_MEMBER_PHONE_TAKEN: [409, 'Another member of this gym has this phone'],
  GYM_MEMBER_STATE: [409, 'The member cannot do that in their current state'],
  GYM_LINK_REQUEST_PENDING: [409, 'A pending invite or join request already exists'],
  GYM_LINK_REQUEST_STATE: [409, 'This request is no longer pending'],
  GYM_ALREADY_LINKED: [409, 'This member or account is already linked'],
  GYM_PACKAGE_UNAVAILABLE: [422, 'Choose an active package sold at the desk'],
  GYM_MEMBERSHIP_OVERLAP: [409, 'The member already has a membership for those dates'],
  GYM_MEMBERSHIP_STATE: [409, 'The membership cannot do that now'],
  GYM_FREEZE_LIMIT: [422, 'That is more freezing than this membership allows'],
  GYM_DATE_OUT_OF_RANGE: [422, 'Choose a date in the allowed range'],
  GYM_DUE_STATE: [409, 'This due is already paid, waived or void'],
  GYM_PAYMENT_EXCEEDS_DUE: [422, 'The amount is more than what is still due'],
  GYM_PAYMENT_NOT_REVERSIBLE: [409, 'This payment cannot be reversed'],
  GYM_ENTRY_BLOCKED: [409, 'The gym’s entry policy does not let this member in'],
  GYM_CHECKIN_TOKEN_INVALID: [422, 'This check-in code is not valid here'],
  GYM_NOT_A_MEMBER: [403, 'You are not a linked member of this gym'],
  GYM_TIER_REQUIRED: [403, 'Your gym plan does not include this'],
  GYM_VISIT_CLOSED: [409, 'This visit is already checked out'],
  GYM_ACCOUNT_RESTRICTED: [403, 'The gym panel is read-only until the overdue invoice is paid'],
  GYM_SHORT_CODE_TAKEN: [409, 'Another of your gyms uses this short code'],
  GYM_SETUP_REQUIRED: [409, 'Choose the gym’s short code first'],
  GYM_IMPORT_INVALID: [422, 'Upload a CSV or Excel file on the template'],
  GYM_IMPORT_STATE: [409, 'The import cannot do that now'],
  GYM_IMPORT_UNDO_BLOCKED: [409, 'Some imported members already have later activity'],
  GYM_IMPORT_CONSENT_REQUIRED: [403, 'The owner has not allowed Kriraghor to upload for them'],
  FILE_EMPTY: [422, 'The file is empty'],
  FILE_TOO_LARGE: [413, 'The file is too large'],
  FILE_TYPE_NOT_ALLOWED: [415, 'Upload a JPEG, PNG or WebP photo'],
  FILE_TYPE_MISMATCH: [415, 'The file is not the type it says it is'],
  VERSION_CONFLICT: [409, 'Someone changed this member. Reload and try again'],
  // Prompt 2 (§9.4): online fees, billing, founding partners and fee overrides.
  GYM_ONLINE_FEES_UNAVAILABLE: [403, 'This gym cannot take fees online right now'],
  GYM_PAY_LINK_OPEN: [409, 'This due already has an open payment link'],
  GYM_PAY_LINK_EXPIRED: [410, 'This link has expired. Ask the gym for a new one'],
  GYM_REFUND_WINDOW_CLOSED: [409, 'This payment was already released to the gym; return the money directly and record a reversal'],
  GYM_REFUND_EXCEEDS_PAID: [422, 'That is more than can still be refunded on this payment'],
  GYM_INVOICE_STATE: [409, 'The invoice cannot do that in its current status'],
  GYM_FOUNDING_FULL: [409, 'All founding partner places are taken'],
  GYM_OVERRIDE_ACTIVE: [409, 'End the current override for this scope and fee first'],
  GYM_OVERRIDE_OUT_OF_BOUNDS: [422, 'The value is outside the fee setting’s bounds'],
  // Prompt 3 (§9.4): join requests, trainers, plans and diet charts.
  GYM_JOIN_NOT_OPEN: [409, 'This gym is not taking join requests right now'],
  GYM_TRAINER_INVALID: [422, 'Choose a staff member of this gym who trains members or writes plans'],
  GYM_PLAN_ASSIGN_SCOPE: [403, 'You can only give plans to members you can see'],
  GYM_PLAN_STATE: [409, 'The plan cannot do that in its current state'],
  GYM_PLAN_LOG_WINDOW: [422, 'You can tick today and a few days back only'],
  // Prompt 3b (§9.4): the SMS add-on.
  GYM_SMS_ADDON_UNAVAILABLE: [409, 'The SMS add-on is not available on this plan right now'],
  GYM_SMS_ADDON_OFF: [409, 'Switch the SMS add-on on first'],
  GYM_SMS_BALANCE_SHORT: [409, 'That would take the SMS balance below 0'],
};
const fail = (code, meta, detail) => new AppError(ERRORS[code][0], code, ERRORS[code][1], { ...(meta ? { meta } : {}), ...(detail ? { detail } : {}) });

/** Every number from M03, read per call (CLAUDE.md: no magic numbers). */
const cfg = () => ({
  activeWindowDays: settings.get('gym_manage.active_window_days'),
  renewGraceDays: settings.get('gym_manage.renew_grace_days'),
  backdateDays: settings.get('gym_manage.backdate_days'),
  dueDaysAfterStart: settings.get('gym_manage.due_days_after_start'),
  maxFreezeDays: settings.get('gym_manage.max_freeze_days'),
  maxFreezes: settings.get('gym_manage.max_freezes'),
  entryPolicyDefault: settings.get('gym_manage.entry_policy_default'),
  absentAlertDays: settings.get('gym_manage.absent_alert_days'),
  requestExpiryDays: settings.get('gym_manage.request_expiry_days'),
  phoneRevealsPerHour: settings.get('gym_manage.phone_reveals_per_hour'),
  memberQrSeconds: settings.get('gym_manage.member_qr_seconds'),
  importMaxRows: settings.get('gym_manage.import_max_rows'),
  importMaxBytes: settings.get('gym_manage.import_max_bytes'),
  importUndoHours: settings.get('gym_manage.import_undo_hours'),
  importConsentDays: settings.get('gym_manage.import_consent_days'),
  importRetentionDays: settings.get('gym_manage.import_file_retention_days'),
  photoMaxBytes: settings.get('ground.photo_max_bytes'),
  // Prompt 2: reminders, payment links, online fees, referrals (§6.12).
  // M27-FR-29: renewal reminders at each of these days before the end (was one remind_before_days).
  renewalRemindDays: settings.get('gym_manage.renewal_remind_days'),
  vatMaxBps: settings.get('gym_manage.vat_max_bps'),
  expiringListDays: settings.get('gym_manage.expiring_list_days'),
  overdueRemindDays: settings.get('gym_manage.overdue_remind_days'),
  morningSummaryTime: settings.get('gym_manage.morning_summary_time'),
  reminderLogDays: settings.get('gym_manage.reminder_log_days'),
  payLinkHours: settings.get('gym_manage.pay_link_hours'),
  onlineFeeReleaseHours: settings.get('gym_manage.online_fee_release_hours'),
  providerPassthrough: settings.get('gym_manage.online_fee_provider_passthrough'),
  providerBps: settings.get('gym_manage.online_fee_provider_bps'),
  referralMatchDays: settings.get('gym_manage.referral_match_days'),
  // Prompt 3: the entrance tablet QR and plans (§6.12).
  entranceQrSeconds: settings.get('gym_manage.entrance_qr_seconds'),
  planMaxItems: settings.get('gym_manage.plan_max_items'),
  dietMaxMeals: settings.get('gym_manage.diet_max_meals'),
  planLogBackDays: settings.get('gym_manage.plan_log_back_days'),
});

/** The owner's invoices, founding partners and VAT (§6.6, §6.12). */
const saasCfg = () => ({
  invoiceDueDays: settings.get('gym_saas.invoice_due_days'),
  graceDays: settings.get('gym_saas.grace_days'),
  foundingLimit: settings.get('gym_saas.founding_partner_limit'),
  foundingFreeMonths: settings.get('gym_saas.founding_free_months'),
  foundingDiscountPct: settings.get('gym_saas.founding_discount_pct'),
  foundingDiscountMonths: settings.get('gym_saas.founding_discount_months'),
  vatEnabled: settings.get('gym_saas.vat_enabled'),
  vatPct: settings.get('gym_saas.vat_pct'),
});

/** The plans (§3.5, §6.6): member limits, prices and the lowest plan of each feature. */
const tierCfg = () => ({
  freeMax: settings.get('gym_saas.tier_free_max_members'),
  basicMax: settings.get('gym_saas.tier_basic_max_members'),
  standardMax: settings.get('gym_saas.tier_standard_max_members'),
  basicPrice: settings.get('gym_saas.tier_basic_price_poisha'),
  standardPrice: settings.get('gym_saas.tier_standard_price_poisha'),
  proPrice: settings.get('gym_saas.tier_pro_price_poisha'),
  proMinGyms: settings.get('gym_saas.pro_min_gyms'),
  featureMinTiers: settings.get('gym_saas.feature_min_tiers'),
  noticePct: settings.get('gym_saas.tier_notice_pct'),
});

const iso = (d) => (d ? new Date(d).toISOString() : null);
const today = (now = new Date()) => rules.dhakaDate(now);

// ---------------------------------------------------------------- personal data at rest (M24-FR-11)

/** The same keyed hash M01, sms_log and teams use, so an invite matches the account with that phone. */
const phoneHash = (e164) => crypto.hmac(`phone:${e164}`);
const enc = (v) => (v === null || v === undefined || v === '' ? null : crypto.encrypt(String(v)));
const dec = (v) => (v ? crypto.decrypt(v) : null);
const decJson = (v) => {
  const s = dec(v);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- tokens (M24-FR-37, FR-50, FR-51)

const sign = (text) => crypto.hmac(text);
const equal = (a, b) => crypto.timingSafeEqualHex(a, b);
const receiptTokenOf = (feePaymentId) => rules.receiptToken(feePaymentId, sign);
const receiptUrlOf = (feePaymentId) => `${config.apps.gym}/r/${receiptTokenOf(feePaymentId)}`;
const parseReceipt = (token) => rules.parseReceiptToken(token, { sign, equal });
const memberTokenOf = (memberId, now = new Date()) => {
  const seconds = cfg().memberQrSeconds;
  const window = rules.windowOf(now.getTime(), seconds);
  return { token: rules.memberToken({ memberId, window }, sign), expiresAt: rules.memberTokenExpiry(window, seconds).toISOString(), seconds };
};
const parseMemberToken = (token, now = new Date()) => rules.parseMemberToken(token, { sign, equal, nowMs: now.getTime(), seconds: cfg().memberQrSeconds });
/** The entrance tablet QR of a gym (M24-FR-51): rotates every gym_manage.entrance_qr_seconds. */
const entranceTokenOf = (gymId, now = new Date()) => {
  const seconds = cfg().entranceQrSeconds;
  const window = rules.windowOf(now.getTime(), seconds);
  return { token: rules.entranceToken({ gymId, window }, sign), expiresAt: rules.memberTokenExpiry(window, seconds).toISOString(), seconds, secondsLeft: rules.secondsLeft(now.getTime(), seconds) };
};
const parseEntranceToken = (token, now = new Date()) => rules.parseEntranceToken(token, { sign, equal, nowMs: now.getTime(), seconds: cfg().entranceQrSeconds });

// ---------------------------------------------------------------- events and audit

const publish = (transaction, name, aggregateType, aggregateId, payload, actor = null) => events.publish(transaction, { name, aggregateType, aggregateId, payload, actor });
const record = (entry, transaction) => audit.record(entry, { transaction });

// ---------------------------------------------------------------- the owner's subscription (M24-FR-81)

/**
 * The owner's one subscription row (tier free), created with their first gym (M20 calls this through
 * the facade) or lazily on first use here, for gyms made before prompt 1. Idempotent.
 */
async function ensureSubscription(ownerId, { transaction, now = new Date() } = {}) {
  const day = today(now);
  await sequelize.query(
    `INSERT INTO gym_owner_subscriptions (id, owner_id, chosen_tier, month_max_tier, month_of, status, started_on, created_at, updated_at)
     VALUES (:id, :ownerId, 'free', 'free', :monthOf, 'active', :day, NOW(), NOW()) ON CONFLICT (owner_id) DO NOTHING`,
    { replacements: { id: uuid7(), ownerId, monthOf: rules.firstOfMonth(day), day }, type: QueryTypes.INSERT, transaction }
  );
  return GymOwnerSubscription.findOne({ where: { ownerId }, transaction });
}

const subscriptionOf = (ownerId, opts) => ensureSubscription(ownerId, opts);

/** M24-FR-07: a feature above the owner's tier answers 403 GYM_TIER_REQUIRED { feature, minTier }. */
function requireFeature(sub, feature) {
  const map = tierCfg().featureMinTiers;
  if (!rules.hasFeature(sub.chosenTier, feature, map)) throw fail('GYM_TIER_REQUIRED', { feature, minTier: rules.minTierOf(map, feature) });
}

/** M24-FR-08: while the subscription is restricted only reads, check-ins, counter payments and billing work. */
function refuseRestricted(sub) {
  if (sub.status === 'restricted') throw fail('GYM_ACCOUNT_RESTRICTED');
}

// ---------------------------------------------------------------- access (M24-FR-05, FR-06)

/**
 * One gym for this caller: the gym (via the M20 facade; a missing or removed gym is 404 Gym), the acting
 * context from actFor (owner, or staff holding `permission`; 'owner.only' refuses staff; null checks
 * membership only), and, when asked, the owner's subscription with the restricted and tier checks.
 */
async function gymAccess(principal, gymId, permission, { restricted = false, feature = null, anyOf = null } = {}) {
  const gym = await gymFacade.get(gymId);
  if (!gym) throw E.notFound('Gym');
  const ctx = access.actFor(principal, 'gym', gymId, anyOf ? null : permission, { ownerId: gym.ownerId, notFound: 'Gym' });
  if (anyOf && !anyOf.some((p) => access.can(ctx, p))) {
    throw new AppError(403, 'PERMISSION_REQUIRED', 'The owner has not given you this permission', { meta: { permission: anyOf[0], businessType: 'gym', businessId: gymId } });
  }
  const sub = restricted || feature ? await subscriptionOf(gym.ownerId) : null;
  if (restricted) refuseRestricted(sub);
  if (feature) requireFeature(sub, feature);
  const can = (p) => access.can(ctx, p);
  // A trainer-only caller (members.trainer without members.view) sees only the members assigned to them (M24-FR-23).
  const workplace = ctx.staff ? access.workplaceAt(principal, 'gym', gymId) : null;
  const trainerOnly = ctx.staff && !can('members.view') && can('members.trainer');
  return { gym, ctx, sub, can, actor: ctx.actor, owner: ctx.as === 'owner', trainerScope: trainerOnly ? workplace?.id ?? null : undefined };
}

/** The two permissions that make a staff member a trainer (M24-FR-21, §3.1). */
const TRAINER_PERMISSIONS = Object.freeze(['members.trainer', 'plans.manage']);

/**
 * The gym's trainers: active staff holding members.trainer or plans.manage (M01 staffWith), with their
 * display names → [{ businessMemberId, memberId, displayName, permissions }].
 */
async function trainersOf(gymId) {
  const rows = await staffFacade.staffWith('gym', gymId, TRAINER_PERMISSIONS);
  const names = await directory.displayNames(rows.map((r) => r.memberId));
  return rows.map((r) => ({ ...r, displayName: names.get(r.memberId) ?? null }));
}

/** Assert a further permission inside a route (e.g. a discount needs fees.adjust, M24-FR-26). */
function needs(a, permission) {
  if (!a.can(permission)) throw new AppError(403, 'PERMISSION_REQUIRED', 'The owner has not given you this permission', { meta: { permission, businessType: 'gym', businessId: a.gym.id } });
}

/** What a staff member may see of a body (STAFF_HIDDEN_KEYS stripped). */
const shown = (a, body) => (a.ctx.staff ? access.forStaff(body) : body);

// ---------------------------------------------------------------- the gym's settings row and counters

const settingsOf = (gymId, { transaction, lock = false } = {}) => GymManageSettings.findByPk(gymId, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });

async function requireSetup(gymId, { transaction, lock = false } = {}) {
  const s = await settingsOf(gymId, { transaction, lock });
  if (!s) throw fail('GYM_SETUP_REQUIRED', { step: 'short_code' });
  return s;
}

/**
 * The next member code under the settings row lock (M24-FR-10): {SHORT}-{0001}, skipping a code an
 * imported member already holds, so codes stay continuous and never collide.
 */
async function nextMemberCode(s, transaction) {
  let seq = s.memberSeq;
  let code;
  do {
    seq += 1;
    code = rules.memberCode(s.shortCode, seq);
  } while (await GymMember.findOne({ where: { gymId: s.gymId, memberCode: code }, attributes: ['id'], transaction }));
  await s.update({ memberSeq: seq }, { transaction });
  return code;
}

/** The next receipt number of the gym under the settings row lock (M24-FR-33): {SHORT}-R{YY}-{000001}, yearly. */
/** M27-FR-28: the gym's VAT rate when VAT is on, else null (a payment or a sale keeps it). */
async function vatBpsOf(gymId, { transaction } = {}) {
  const s = await settingsOf(gymId, { transaction });
  return s?.vatEnabled && s.vatBps ? s.vatBps : null;
}

async function nextReceiptNo(gymId, transaction, now = new Date()) {
  const s = await requireSetup(gymId, { transaction, lock: true });
  const next = rules.nextReceipt({ receiptYear: s.receiptYear, receiptSeq: s.receiptSeq, year: rules.yearOf(today(now)) });
  await s.update(next, { transaction });
  return rules.receiptNo(s.shortCode, next.receiptYear, next.receiptSeq);
}

// ---------------------------------------------------------------- online fees (M24-FR-02, FR-40)

/**
 * Can this gym take fees online now? The owner's gym_owner role is active (documents approved, gate
 * list_gym), the plan has online_fees, the subscription is not restricted and the gym is not suspended.
 * → { ok, reason: role | tier | restricted | null }.
 */
async function onlineFees(gym, { sub = null } = {}) {
  const s = sub ?? (await subscriptionOf(gym.ownerId));
  const reason = rules.onlineFeesBlock({
    ownerRoleActive: (await directory.roleStatus(gym.ownerId, 'gym_owner')) === 'active',
    hasOnlineFees: rules.hasFeature(s.chosenTier, 'online_fees', tierCfg().featureMinTiers),
    restricted: s.status === 'restricted',
    gymSuspended: gym.status === 'suspended',
  });
  return { ok: !reason, reason };
}

/** 403 GYM_ONLINE_FEES_UNAVAILABLE { reason } unless the gym can take fees online. */
async function requireOnlineFees(gym, opts) {
  const r = await onlineFees(gym, opts);
  if (!r.ok) throw fail('GYM_ONLINE_FEES_UNAVAILABLE', { reason: r.reason });
}

// ---------------------------------------------------------------- the "sent once" reminder log (M24-FR-56)

/**
 * Insert the gym_reminders once-key first (ON CONFLICT DO NOTHING) and say whether this caller won it:
 * only the winner publishes. Runs in the caller's transaction.
 */
async function claimReminderId(transaction, { ownerId, gymId = null, kind, subjectType, subjectId, offsetKey, memberId = null, channels = [], status = 'published', skipReason = null }) {
  const [rows] = await sequelize.query(
    `INSERT INTO gym_reminders (id, owner_id, gym_id, kind, subject_type, subject_id, offset_key, member_id, channels, status, skip_reason, created_at)
     VALUES (:id, :ownerId, :gymId, :kind, :subjectType, :subjectId, :offsetKey, :memberId, CAST(:channels AS jsonb), :status, :skipReason, NOW())
     ON CONFLICT (kind, subject_id, offset_key) DO NOTHING RETURNING id`,
    { replacements: { id: uuid7(), ownerId, gymId, kind, subjectType, subjectId, offsetKey, memberId, channels: JSON.stringify(channels), status, skipReason }, transaction }
  );
  return rows[0]?.id ?? null;
}
/** The send-once claim as a yes or no (the row's id: claimReminderId). */
const claimReminder = async (transaction, args) => Boolean(await claimReminderId(transaction, args));

// ---------------------------------------------------------------- cursors

const cursorOf = (values) => Buffer.from(JSON.stringify(values)).toString('base64url');
function parseCursor(cursor) {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

module.exports = {
  ERRORS,
  fail,
  cfg,
  saasCfg,
  tierCfg,
  onlineFees,
  requireOnlineFees,
  claimReminder,
  claimReminderId,
  iso,
  today,
  phoneHash,
  enc,
  dec,
  decJson,
  sign,
  equal,
  receiptTokenOf,
  receiptUrlOf,
  parseReceipt,
  memberTokenOf,
  parseMemberToken,
  entranceTokenOf,
  parseEntranceToken,
  publish,
  record,
  ensureSubscription,
  subscriptionOf,
  requireFeature,
  refuseRestricted,
  gymAccess,
  TRAINER_PERMISSIONS,
  trainersOf,
  needs,
  shown,
  settingsOf,
  requireSetup,
  nextMemberCode,
  nextReceiptNo,
  vatBpsOf,
  cursorOf,
  parseCursor,
};
