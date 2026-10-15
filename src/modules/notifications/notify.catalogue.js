'use strict';

/**
 * Notification catalogue (M08 §6.6), as code. Each entry maps a domain event to recipients, channels
 * and template variables. Template texts are versioned rows in message_templates (EN and BN for
 * every default channel; a contract test checks it). Built so far: the M01, M03, M04 and M06 events.
 *
 * Entry: { code, events[], category, channels[], urgent, roleContext?(e), recipients(e) → userIds,
 *          values(e, { locale, userId }) → template values, link(e) → in-app link }
 */
const config = require('../../config');
const directory = require('../users/directory.service');
const { formatValue } = require('./notify.rules');

const ROLE_LABELS = {
  en: { member: 'Member', player: 'Player', pro: 'Pro', ground_owner: 'Ground owner', shop_owner: 'Shop', organiser: 'Organiser', gym_owner: 'Gym owner' },
  bn: { member: 'সদস্য', player: 'খেলোয়াড়', pro: 'প্রো', ground_owner: 'মাঠ মালিক', shop_owner: 'দোকান', organiser: 'আয়োজক', gym_owner: 'জিম মালিক' },
};
const roleLabel = (role, locale) => ROLE_LABELS[locale]?.[role] ?? ROLE_LABELS.en[role] ?? role;
const reasonText = (code, locale) => (code ? code.replace(/_/g, ' ') : locale === 'bn' ? 'কারণ জানানো হয়নি' : 'no reason given');
const none = (locale) => (locale === 'bn' ? 'কিছু না' : 'none');
const adminUrl = (path) => `${config.apps.admin}${path}`;
const valueText = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
/** "fees.shop_commission_pct 5 → 6" for a proposed setting change. */
const changeText = (c) => `${c.key} ${valueText(c.from)} → ${valueText(c.to)}`;

async function nameOf(userId) {
  if (!userId) return 'System';
  return (await directory.contactFor([userId])).get(userId)?.displayName ?? 'Someone';
}

// Lazy requires: these services sit above M08 in the dependency order.
const settingsRequest = (id) => require('../settings/change-request.service').getOne(id);
const auditEntry = (id) => require('../audit/audit.admin.service').getOne(id);
const paymentFacts = (id) => require('../payments/payments.service').facts(id);
const refundFacts = (id) => require('../payments/refunds.service').facts(id);
async function holdFacts(holdId) {
  const hold = await require('../payments/escrow.service').getOne(holdId);
  return { ...hold, title: (await paymentFacts(hold.paymentId)).title };
}

const CATALOGUE = [
  // ---------------- M04: critical audit actions → every other master (FR-11)
  {
    code: 'AUDIT_CRITICAL',
    events: ['audit.critical_recorded'],
    category: 'staff_ops',
    channels: ['in_app', 'email'],
    recipients: async (e) => (await directory.masters()).filter((id) => id !== e.payload.actorId),
    values: async (e, { locale }) => {
      const a = await auditEntry(e.payload.auditLogId);
      return { actor: a.actor.name ?? 'System', summary: locale === 'bn' ? a.summary.bn : a.summary.en, url: adminUrl(`/admin/audit?id=${a.id}`) };
    },
    link: (e) => `/admin/audit?id=${e.payload.auditLogId}`,
  },
  {
    code: 'EVENT_DEAD_LETTERED',
    events: ['outbox.event_dead_lettered'],
    category: 'staff_ops',
    channels: ['in_app', 'email'],
    recipients: () => directory.masters(),
    values: async (e) => ({ eventType: e.payload.eventType, consumer: e.payload.consumer, attempts: e.payload.attempts, url: adminUrl('/admin/events') }),
    link: () => '/admin/events',
  },

  // ---------------- M03: settings change requests (four-eyes)
  {
    code: 'SETTING_CHANGE_PROPOSED',
    events: ['setting.change_proposed'],
    category: 'staff_ops',
    channels: ['in_app', 'email'],
    recipients: async (e) => (e.payload.needsFourEyes ? (await directory.masters()).filter((id) => id !== e.payload.proposedBy) : []),
    values: async (e) => {
      const r = await settingsRequest(e.payload.requestId);
      return { proposer: await nameOf(e.payload.proposedBy), changes: r.changes.map(changeText).join(', '), effectiveAt: r.effectiveAt, reason: r.reason, url: adminUrl('/admin/fees') };
    },
    link: () => '/admin/fees',
  },
  {
    code: 'SETTING_CHANGE_REJECTED',
    events: ['setting.change_rejected'],
    category: 'staff_ops',
    channels: ['in_app'],
    recipients: async (e) => [(await settingsRequest(e.payload.requestId)).proposedBy?.id].filter(Boolean),
    values: async (e) => {
      const r = await settingsRequest(e.payload.requestId);
      return { keys: r.changes.map((c) => c.key).join(', '), note: r.decisionNote ?? '' };
    },
    link: () => '/admin/fees',
  },
  {
    code: 'SETTING_CHANGE_WITHDRAWN',
    events: ['setting.change_withdrawn'],
    category: 'staff_ops',
    channels: ['in_app'],
    // The masters who were asked to approve it; the proposer withdrew it themselves.
    recipients: async (e) => {
      const r = await settingsRequest(e.payload.requestId);
      return r.needsFourEyes ? (await directory.masters()).filter((id) => id !== r.proposedBy?.id) : [];
    },
    values: async (e) => {
      const r = await settingsRequest(e.payload.requestId);
      return { proposer: r.proposedBy?.displayName ?? 'A master', keys: r.changes.map((c) => c.key).join(', ') };
    },
    link: () => '/admin/fees',
  },

  // ---------------- M01: roles, account and staff
  {
    code: 'ROLE_ACTIVATED',
    events: ['user_role.activated', 'user_role.reinstated'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    roleContext: (e) => e.payload.role,
    recipients: (e) => [e.payload.userId],
    values: async (e, { locale }) => ({ role: roleLabel(e.payload.role, locale) }),
    link: () => '/account',
  },
  {
    code: 'ROLE_REJECTED',
    events: ['user_role.rejected'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    roleContext: (e) => e.payload.role,
    recipients: (e) => [e.payload.userId],
    values: async (e, { locale }) => ({ role: roleLabel(e.payload.role, locale), reason: reasonText(e.payload.reasonCode, locale) }),
    link: () => '/account',
  },
  {
    code: 'ROLE_SUSPENDED',
    events: ['user_role.suspended'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    roleContext: (e) => e.payload.role,
    recipients: (e) => [e.payload.userId],
    values: async (e, { locale }) => ({ role: roleLabel(e.payload.role, locale), reason: reasonText(e.payload.reasonCode, locale) }),
    link: () => '/account',
  },
  {
    code: 'ACCOUNT_SUSPENDED',
    events: ['user.suspended', 'user.banned'],
    category: 'security',
    channels: ['in_app', 'sms', 'email'],
    urgent: true,
    recipients: (e) => [e.payload.userId],
    values: async (e, { locale }) => ({
      until: e.payload.until ? (locale === 'bn' ? ` (${formatValue('datetime', e.payload.until, 'bn')} পর্যন্ত)` : ` until ${formatValue('datetime', e.payload.until, 'en')}`) : '',
    }),
    link: () => '/account',
  },
  {
    code: 'ACCOUNT_RESTORED',
    events: ['user.restored'],
    category: 'security',
    channels: ['in_app', 'sms', 'email'],
    recipients: (e) => [e.payload.userId],
    values: async () => ({}),
    link: () => '/account',
  },
  {
    code: 'STAFF_INVITED',
    events: ['staff.invited'],
    category: 'security',
    channels: ['in_app', 'email'],
    roleContext: () => 'staff',
    recipients: (e) => [e.payload.userId],
    values: async () => ({ url: adminUrl('/admin/sign-in') }),
    link: () => '/admin',
  },
  {
    code: 'STAFF_PERMISSIONS_CHANGED',
    events: ['staff.permissions_changed'],
    category: 'security',
    channels: ['in_app', 'email'],
    roleContext: () => 'staff',
    recipients: (e) => [e.payload.userId],
    values: async (e, { locale }) => ({
      added: e.payload.added.join(', ') || none(locale),
      removed: e.payload.removed.join(', ') || none(locale),
      url: adminUrl('/admin/sign-in'),
    }),
    link: () => '/admin',
  },

  // ---------------- M06: payer receipts and refunds (category money: in-app and SMS mandatory)
  {
    code: 'PAY_SUCCEEDED',
    events: ['payment.succeeded'],
    category: 'money',
    channels: ['in_app', 'sms'],
    // A capture the purpose rejected is refunded at once; the payer hears about the refund instead.
    recipients: (e) => (e.payload.accepted ? [e.payload.payerId] : []),
    values: async (e) => {
      const p = await paymentFacts(e.payload.paymentId);
      return { amount: e.payload.amount, title: p.title, code: p.code };
    },
    link: () => '/me/payments',
  },
  {
    code: 'PAY_FAILED',
    events: ['payment.failed'],
    category: 'money',
    channels: ['in_app'],
    recipients: (e) => [e.payload.payerId],
    values: async (e) => ({ amount: e.payload.amount, title: (await paymentFacts(e.payload.paymentId)).title }),
    link: (e) => `/pay/${e.payload.paymentId}`,
  },
  {
    code: 'REFUND_INITIATED',
    events: ['refund.approved'],
    category: 'money',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.payerId],
    values: async (e) => {
      const p = await paymentFacts(e.payload.paymentId);
      return { amount: e.payload.amount, title: p.title, method: p.methodDisplay };
    },
    link: () => '/me/payments',
  },
  {
    code: 'REFUND_SUCCEEDED',
    events: ['refund.succeeded'],
    category: 'money',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.payerId],
    values: async (e) => ({ amount: e.payload.amount, method: (await paymentFacts(e.payload.paymentId)).methodDisplay }),
    link: () => '/me/payments',
  },
  {
    code: 'REFUND_MANUAL',
    events: ['refund.manual_required'],
    category: 'money',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.payerId],
    values: async (e) => ({ amount: e.payload.amount, method: (await paymentFacts(e.payload.paymentId)).methodDisplay }),
    link: () => '/me/payments',
  },
  // ---------------- M06: payees
  {
    code: 'ESCROW_RELEASED',
    events: ['escrow.released'],
    category: 'money',
    channels: ['in_app'],
    recipients: (e) => [e.payload.payeeId],
    values: async (e) => ({ net: e.payload.net, fee: e.payload.fee, title: (await holdFacts(e.payload.holdId)).title }),
    link: () => '/me',
  },
  {
    code: 'ESCROW_FROZEN',
    events: ['escrow.frozen'],
    category: 'money',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.payeeId].filter(Boolean),
    values: async (e) => {
      const h = await holdFacts(e.payload.holdId);
      return { amount: h.available, title: h.title, reason: e.payload.reason };
    },
    link: () => '/me',
  },
  // ---------------- M06: finance staff and masters
  {
    code: 'REFUND_ESCALATED',
    events: ['refund.escalated'],
    category: 'staff_ops',
    channels: ['in_app', 'email'],
    recipients: () => directory.masters(),
    values: async (e) => {
      const r = await refundFacts(e.payload.refundId);
      return { actor: await nameOf(r.initiatedBy), amount: e.payload.amount, code: (await paymentFacts(e.payload.paymentId)).code, reason: r.reasonText ?? r.reasonCode, url: adminUrl('/admin/finance?tab=refunds') };
    },
    link: () => '/admin/finance?tab=refunds',
  },
  {
    code: 'REFUND_MANUAL_STAFF',
    events: ['refund.manual_required'],
    category: 'staff_ops',
    channels: ['in_app', 'email'],
    recipients: () => directory.withPermission('view_payouts'),
    values: async (e) => ({
      amount: e.payload.amount,
      code: (await paymentFacts(e.payload.paymentId)).code,
      attempts: (await refundFacts(e.payload.refundId)).attempts,
      url: adminUrl('/admin/finance?tab=refunds'),
    }),
    link: () => '/admin/finance?tab=refunds',
  },
  {
    code: 'RECON_EXCEPTION',
    events: ['reconciliation.run_completed'],
    category: 'staff_ops',
    channels: ['in_app', 'email'],
    recipients: async (e) => (e.payload.exceptions > 0 ? directory.withPermission('view_payouts') : []),
    values: async (e) => ({ exceptions: e.payload.exceptions, date: e.payload.businessDate, url: adminUrl('/admin/finance?tab=reconciliation') }),
    link: () => '/admin/finance?tab=reconciliation',
  },
  {
    code: 'LEDGER_INVARIANT_FAILED',
    events: ['ledger.invariant_failed'],
    category: 'staff_ops',
    channels: ['in_app', 'email'],
    urgent: true,
    recipients: () => directory.withPermission('view_payouts'),
    values: async (e) => ({ checks: e.payload.failed.join(', '), url: adminUrl('/admin/finance?tab=ledger') }),
    link: () => '/admin/finance?tab=ledger',
  },
];

const byCode = new Map(CATALOGUE.map((c) => [c.code, c]));

module.exports = { CATALOGUE, byCode, roleLabel };
