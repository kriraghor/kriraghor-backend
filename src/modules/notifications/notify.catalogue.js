'use strict';

/**
 * Notification catalogue (M08 §6.6), as code. Each entry maps a domain event to recipients, channels
 * and template variables. Template texts are versioned rows in message_templates (EN and BN for
 * every default channel; a contract test checks it). Built so far: the M01, M02, M03, M04, M05, M06, M07, M09, M10, M17, M18, M19 and M21 events.
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
const webUrl = (path) => `${config.apps.web}${path}`;
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
const documentFacts = (id) => require('../kyc/kyc.service').facts(id);
// M05 reason codes for the document kind (moderation.v1.json), worded for the member.
const KYC_REASONS = {
  en: { docs_mismatch_nid: 'the details do not match the NID', unreadable: 'the photos are unclear or cut off', expired: 'the NID looks expired', duplicate: 'this NID is already on another account', info_incomplete: 'some required information is missing', breaks_rules: 'it breaks our rules', other: 'see the note from our team' },
  bn: { docs_mismatch_nid: 'তথ্য NID-এর সাথে মেলে না', unreadable: 'ছবি অস্পষ্ট বা কাটা', expired: 'NID-এর মেয়াদ শেষ মনে হচ্ছে', duplicate: 'এই NID অন্য অ্যাকাউন্টে আছে', info_incomplete: 'প্রয়োজনীয় তথ্য নেই', breaks_rules: 'এটি আমাদের নিয়ম ভঙ্গ করে', other: 'আমাদের টিমের নোট দেখুন' },
};
const reviewersOf = (kind) => directory.withPermission(require('../moderation/moderation.adapters').get(kind).permission);
const KIND_LABELS = {
  en: { document: 'identity document', game_profile: 'game UID', esports_tournament: 'esports tournament', ground: 'ground listing', shop: 'shop', product: 'shop product' },
  bn: { document: 'পরিচয় ডকুমেন্ট', game_profile: 'গেম UID', esports_tournament: 'এস্পোর্টস টুর্নামেন্ট', ground: 'মাঠের তালিকা', shop: 'দোকান', product: 'দোকানের পণ্য' },
};
const kindLabel = (kind, locale) => KIND_LABELS[locale]?.[kind] ?? KIND_LABELS.en[kind] ?? kind;
const es = () => require('../esports/esports.facts');
// M09: grounds and the ground owner's business documents.
const groundFacts = (id) => require('../grounds/grounds.service').facts(id);
const vendorUrl = (p) => `${config.apps.vendor}${p}`;
const isNid = (e) => !e.payload.role || e.payload.role === 'member';
const DOC_LABELS = {
  en: { trade_license: 'trade licence', deed_or_lease: 'land deed or lease', tin: 'TIN certificate', bin: 'VAT registration (BIN)' },
  bn: { trade_license: 'ট্রেড লাইসেন্স', deed_or_lease: 'জমির দলিল বা লিজ', tin: 'টিআইএন সনদ', bin: 'ভ্যাট নিবন্ধন (বিআইএন)' },
};
const docLabel = (type, locale) => DOC_LABELS[locale]?.[type] ?? DOC_LABELS.en[type] ?? type;
const GROUND_REASONS = {
  en: { photos_unclear: 'the photos are unclear or not of this ground', price_wrong: 'the price looks wrong', duplicate: 'this ground is already listed', info_incomplete: 'some information is missing', breaks_rules: 'it breaks our rules', location_wrong: 'the address or map pin is wrong', not_a_venue: 'it is not a bookable sports venue', other: 'see the note from our team' },
  bn: { photos_unclear: 'ছবি অস্পষ্ট বা এই মাঠের নয়', price_wrong: 'দাম ঠিক মনে হচ্ছে না', duplicate: 'এই মাঠ আগেই তালিকায় আছে', info_incomplete: 'কিছু তথ্য নেই', breaks_rules: 'এটি আমাদের নিয়ম ভঙ্গ করে', location_wrong: 'ঠিকানা বা ম্যাপ পিন ভুল', not_a_venue: 'এটি বুকিংযোগ্য খেলার মাঠ নয়', other: 'আমাদের টিমের নোট দেখুন' },
};
const groundReason = (code, locale) => GROUND_REASONS[locale]?.[code] ?? GROUND_REASONS.en[code] ?? reasonText(code, locale);
const esportsUrl = (p) => `${config.apps.esports}${p}`;
// M12: shops, products and stock (the shop owner), saved items (members).
const shopFacts = (id) => require('../market/shops.service').facts(id);
const productFacts = (id) => require('../market/products.service').facts(id);
const variantFacts = (id) => require('../market/products.service').variantFacts(id);
const MARKET_REASONS = {
  en: { photos_unclear: 'the photos are unclear or not of this item', price_wrong: 'the price looks wrong', duplicate: 'it is already listed', info_incomplete: 'some information is missing', breaks_rules: 'it breaks our rules', specs_wrong: 'the details or sizes do not match the item', supplement_details: 'the importer, BSTI or expiry details are missing', shop_details: 'the shop name, type or address is not right', other: 'see the note from our team' },
  bn: { photos_unclear: 'ছবি অস্পষ্ট বা এই পণ্যের নয়', price_wrong: 'দাম ঠিক মনে হচ্ছে না', duplicate: 'এটি আগেই তালিকায় আছে', info_incomplete: 'কিছু তথ্য নেই', breaks_rules: 'এটি আমাদের নিয়ম ভঙ্গ করে', specs_wrong: 'তথ্য বা সাইজ পণ্যের সাথে মেলে না', supplement_details: 'আমদানিকারক, BSTI বা মেয়াদের তথ্য নেই', shop_details: 'দোকানের নাম, ধরন বা ঠিকানা ঠিক নয়', other: 'আমাদের টিমের নোট দেখুন' },
};
const marketReason = (code, locale) => MARKET_REASONS[locale]?.[code] ?? MARKET_REASONS.en[code] ?? reasonText(code, locale);
const variantValues = async (e, locale) => {
  const f = await variantFacts(e.payload.variantId);
  return { product: f.title, variant: locale === 'bn' ? f.labelBn : f.labelEn };
};
const webProduct = async (productId) => webUrl(`/shop/p/${(await productFacts(productId)).slug}`);
const bookingFacts = (id) => require('../bookings/bookings.reads').facts(id);
const bookingValues = async (e) => {
  const f = await bookingFacts(e.payload.bookingId);
  return { code: f.code, ground: f.groundName, start: f.start, paid: f.paidOnline, due: f.dueAtVenue, refund: f.refund, retained: f.retained };
};
const toBooker = (e) => (e.payload.bookerUserId ? [e.payload.bookerUserId] : []);
const myBooking = (e) => `/me/bookings/${e.payload.bookingId}`;
const tTitle = async (id, locale) => es().title(await es().tournament(id), locale);
const payoutFacts = (id) => require('../payouts/payouts.service').facts(id);
const accountFacts = (id) => require('../payouts/payout-accounts.service').facts(id);
const settingsHours = () => require('../settings/settings.service').get('risk.payout_change_hold_hours');
const HOLD_REASONS = {
  en: { manual: 'our finance team is checking it', account_change: 'your payout account changed recently', account_suspended: 'your account is suspended', kyc: 'your verification needs renewing' },
  bn: { manual: 'আমাদের ফিনান্স টিম যাচাই করছে', account_change: 'সম্প্রতি আপনার পেআউট অ্যাকাউন্ট বদলেছে', account_suspended: 'আপনার অ্যাকাউন্ট স্থগিত', kyc: 'আপনার যাচাই নবায়ন দরকার' },
};
function holdNote(until, locale) {
  const when = formatValue('datetime', until, locale);
  return locale === 'bn' ? `নিরাপত্তার জন্য ${when} পর্যন্ত পেআউট বন্ধ থাকবে।` : `For your safety, payouts to it start after ${when}.`;
}
async function holdFacts(holdId) {
  const hold = await require('../payments/escrow.service').getOne(holdId);
  return { ...hold, title: (await paymentFacts(hold.paymentId)).title };
}

// M17 disputes, reports and reviews.
const disputeFacts = (id) => require('../trust/disputes.service').facts(id);
const reviewFacts = (id) => require('../trust/reviews.service').facts(id);
const OUTCOMES = {
  en: { all: 'full refund', half: 'half refunded', none: 'no refund', custom: 'part refunded', upheld: 'upheld', rejected: 'not upheld', corrected: 'results corrected' },
  bn: { all: 'পুরো টাকা ফেরত', half: 'অর্ধেক ফেরত', none: 'ফেরত নেই', custom: 'আংশিক ফেরত', upheld: 'আপনার পক্ষে', rejected: 'গ্রহণযোগ্য নয়', corrected: 'ফলাফল সংশোধিত' },
};
const outcomeText = (o, locale) => OUTCOMES[locale]?.[o] ?? OUTCOMES.en[o] ?? o;
const REPORT_OUTCOMES = {
  en: { no_violation: 'we found nothing against our rules', content_removed: 'we removed it', owner_warned: 'we warned the owner', user_suspended: 'we suspended the account', converted_to_dispute: 'please open a dispute from the booking' },
  bn: { no_violation: 'নিয়মবিরোধী কিছু পাইনি', content_removed: 'আমরা এটি সরিয়ে দিয়েছি', owner_warned: 'মালিককে সতর্ক করেছি', user_suspended: 'অ্যাকাউন্ট স্থগিত করেছি', converted_to_dispute: 'বুকিং থেকে বিরোধ খুলুন' },
};
const SUBJECT_LABELS = {
  en: { ground: 'ground', booking: 'booking', user: 'member', review: 'review', esports_tournament: 'tournament' },
  bn: { ground: 'মাঠ', booking: 'বুকিং', user: 'সদস্য', review: 'রিভিউ', esports_tournament: 'টুর্নামেন্ট' },
};
const subjectLabel = (t, locale) => SUBJECT_LABELS[locale]?.[t] ?? SUBJECT_LABELS.en[t] ?? t;
const disputeValues = async (e, { locale }) => {
  const f = await disputeFacts(e.payload.disputeId);
  return { code: f.code, ref: f.ref, dueAt: f.respondentDueAt, outcome: outcomeText(f.outcome, locale), refund: f.refund };
};
const myDispute = (e) => `/me/disputes/${e.payload.code}`;
const vendorDispute = (e) => vendorUrl(`/vendor/disputes/${e.payload.code}`);
const adminDispute = (e) => `/admin/disputes?code=${e.payload.code}`;

// M18 risk and trust.
const RULE_LABELS = {
  en: { accounts_per_nid: 'the same NID on several accounts', shared_payout_account: 'a payout wallet shared with another account', esports_uid_banned: 'a banned game UID', refund_rate: 'many refunds', dispute_loss_rate: 'many lost disputes', reports_upheld: 'upheld reports', esports_disqualified: 'esports disqualifications', velocity_breaches: 'many rate-limit hits', payout_account_change: 'a new payout account' },
  bn: { accounts_per_nid: 'একাধিক অ্যাকাউন্টে একই NID', shared_payout_account: 'অন্য অ্যাকাউন্টের সাথে একই পেআউট ওয়ালেট', esports_uid_banned: 'নিষিদ্ধ গেম UID', refund_rate: 'অনেক রিফান্ড', dispute_loss_rate: 'অনেক বিরোধে হার', reports_upheld: 'সঠিক প্রমাণিত রিপোর্ট', esports_disqualified: 'এস্পোর্টস থেকে বাদ', velocity_breaches: 'বারবার সীমা ছোঁয়া', payout_account_change: 'নতুন পেআউট অ্যাকাউন্ট' },
};
const SEVERITY_LABELS = { en: { info: 'info', medium: 'medium', high: 'high', critical: 'critical' }, bn: { info: 'তথ্য', medium: 'মাঝারি', high: 'উচ্চ', critical: 'গুরুতর' } };
const DOC_REQUEST_LABELS = { en: { nid: 'NID', trade_license: 'trade licence', deed_or_lease: 'land deed or lease', tin: 'TIN certificate' }, bn: { nid: 'NID', trade_license: 'ট্রেড লাইসেন্স', deed_or_lease: 'জমির দলিল বা লিজ', tin: 'টিআইএন সনদ' } };
const TRUST_KINDS = { en: { owner: 'ground owner', booker: 'booking' }, bn: { owner: 'মাঠ মালিক', booker: 'বুকিং' } };
const pick = (table, locale, key) => table[locale]?.[key] ?? table.en[key] ?? key;
const riskDesk = (e) => `/admin/risk/accounts/${e.payload.userId}`;
const riskDeskStaff = async () => [...new Set([...(await directory.withPermission('manage_users'))])];
const actionIs = (name) => (e) => e.payload.action === name;

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
  // ---------------- M02: identity verification (approval and rejection reach the member through ROLE_ACTIVATED / ROLE_REJECTED)
  {
    code: 'DOCUMENT_SUBMITTED',
    events: ['document.submitted'],
    category: 'moderation',
    channels: ['in_app'],
    recipients: (e) => (isNid(e) ? [e.payload.userId] : []),
    values: () => ({}),
    link: () => '/account/verification',
  },
  {
    code: 'DOCUMENT_CHANGES_REQUESTED',
    events: ['document.changes_requested'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => (isNid(e) ? [e.payload.userId] : []),
    values: (e, { locale }) => ({ reason: KYC_REASONS[locale]?.[e.payload.reasonCode] ?? KYC_REASONS.en[e.payload.reasonCode] ?? e.payload.reasonCode }),
    link: () => '/account/verification',
  },
  {
    code: 'KYC_REVIEW_NEEDED',
    events: ['document.submitted'],
    category: 'staff_ops',
    channels: ['in_app'],
    recipients: (e) => (isNid(e) ? directory.withPermission('approve_documents') : []),
    values: async (e) => ({ masked: (await documentFacts(e.payload.documentId)).numberMasked }),
    link: () => '/admin/moderation?kind=document',
  },
  // ---------------- M02 business documents (ground owners, with M09)
  {
    code: 'BUSINESS_DOC_SUBMITTED',
    events: ['document.submitted'],
    category: 'moderation',
    channels: ['in_app'],
    recipients: (e) => (isNid(e) ? [] : [e.payload.userId]),
    values: (e, { locale }) => ({ doc: docLabel(e.payload.docType, locale) }),
    link: () => '/account/business',
  },
  {
    code: 'BUSINESS_DOC_CHANGES_REQUESTED',
    events: ['document.changes_requested', 'document.rejected'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => (isNid(e) ? [] : [e.payload.userId]),
    values: (e, { locale }) => ({ doc: docLabel(e.payload.docType, locale), reason: KYC_REASONS[locale]?.[e.payload.reasonCode] ?? KYC_REASONS.en[e.payload.reasonCode] ?? reasonText(e.payload.reasonCode, locale) }),
    link: () => '/account/business',
  },
  {
    code: 'BUSINESS_DOC_REVIEW_NEEDED',
    events: ['document.submitted'],
    category: 'staff_ops',
    channels: ['in_app'],
    recipients: (e) => (isNid(e) ? [] : directory.withPermission('approve_documents')),
    values: (e, { locale }) => ({ doc: docLabel(e.payload.docType, locale) }),
    link: () => '/admin/moderation?kind=document',
  },
  // ---------------- M09 grounds (the owner; reviewers on the Moderation desk)
  {
    code: 'GROUND_LIVE',
    events: ['ground.published'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e) => ({ name: (await groundFacts(e.payload.groundId)).name, url: vendorUrl(`/grounds/${e.payload.groundId}`) }),
    link: (e) => `/vendor/grounds/${e.payload.groundId}`,
  },
  {
    code: 'GROUND_CHANGES_REQUESTED',
    events: ['ground.changes_requested'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e, { locale }) => ({ name: (await groundFacts(e.payload.groundId)).name, reason: groundReason(e.payload.reasonCode, locale) }),
    link: (e) => `/vendor/grounds/${e.payload.groundId}`,
  },
  {
    code: 'GROUND_REJECTED',
    events: ['ground.rejected'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e, { locale }) => ({ name: (await groundFacts(e.payload.groundId)).name, reason: groundReason(e.payload.reasonCode, locale) }),
    link: (e) => `/vendor/grounds/${e.payload.groundId}`,
  },
  {
    code: 'GROUND_PRICING_PUBLISHED',
    events: ['ground.pricing_published'],
    category: 'moderation',
    channels: ['in_app'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e) => ({ name: (await groundFacts(e.payload.groundId)).name }),
    link: (e) => `/vendor/grounds/${e.payload.groundId}/pricing`,
  },
  {
    code: 'GROUND_REVIEW_NEEDED',
    events: ['ground.submitted'],
    category: 'staff_ops',
    channels: ['in_app'],
    recipients: () => reviewersOf('ground'),
    values: async (e) => ({ name: (await groundFacts(e.payload.groundId)).name }),
    link: () => '/admin/moderation?kind=ground',
  },
  // ---------------- M05: reviewers and masters (member messages stay with the subject module)
  {
    code: 'MOD_SLA_BREACH',
    events: ['submission.sla_breached'],
    category: 'staff_ops',
    channels: ['in_app', 'email'],
    recipients: (e) => reviewersOf(e.payload.kind),
    values: (e, { locale }) => ({ kind: kindLabel(e.payload.kind, locale), hours: Math.max(1, Math.round(e.payload.overdueMinutes / 60)), url: adminUrl(`/admin/moderation?id=${e.payload.submissionId}`) }),
    link: (e) => `/admin/moderation?id=${e.payload.submissionId}`,
  },
  {
    code: 'MOD_APPLY_FAILED',
    events: ['submission.apply_failed'],
    category: 'staff_ops',
    channels: ['in_app', 'email'],
    urgent: true,
    recipients: () => directory.masters(),
    values: (e, { locale }) => ({ kind: kindLabel(e.payload.kind, locale), attempts: e.payload.attempts, url: adminUrl(`/admin/moderation?id=${e.payload.submissionId}`) }),
    link: (e) => `/admin/moderation?id=${e.payload.submissionId}`,
  },
  {
    // The reviewer holding the lock when the submitter resubmitted or withdrew.
    code: 'MOD_CLAIM_LOST',
    events: ['submission.withdrawn'],
    category: 'staff_ops',
    channels: ['in_app'],
    recipients: (e) => [e.payload.claimedBy].filter(Boolean),
    values: (e, { locale }) => ({ kind: kindLabel(e.payload.kind, locale) }),
    link: () => '/admin/moderation',
  },
  // ---------------- M21: players (category tournaments; push arrives with the mobile app) and staff
  {
    code: 'ESPORTS_UID_VERIFIED',
    events: ['esports_game_profile.verified'],
    category: 'tournaments',
    channels: ['in_app'],
    recipients: (e) => [e.payload.userId],
    values: () => ({}),
    link: () => esportsUrl('/me/esports'),
  },
  {
    code: 'ESPORTS_UID_REJECTED',
    events: ['esports_game_profile.rejected'],
    category: 'tournaments',
    channels: ['in_app'],
    recipients: (e) => [e.payload.userId],
    values: (e) => ({ reason: (e.payload.reasonCode ?? 'other').replace(/_/g, ' ') }),
    link: () => esportsUrl('/me/esports'),
  },
  {
    code: 'ESPORTS_SQUAD_INVITE',
    events: ['esports_squad.invited'],
    category: 'tournaments',
    channels: ['in_app'],
    recipients: (e) => [e.payload.userId],
    values: async (e) => ({ squad: await es().squadName(e.payload.squadId) }),
    link: () => esportsUrl('/me/esports'),
  },
  {
    code: 'ESPORTS_REG_CONFIRMED',
    events: ['esports_registration.confirmed'],
    category: 'tournaments',
    channels: ['in_app'],
    recipients: (e) => es().entryPeople(e.payload.registrationId),
    values: async (e, { locale }) => ({ title: await tTitle(e.payload.tournamentId, locale) }),
    link: () => esportsUrl('/me/matches'),
  },
  {
    code: 'ESPORTS_WAITLIST_OFFER',
    events: ['esports_registration.offered'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    urgent: true,
    recipients: (e) => [e.payload.registrantUserId],
    values: async (e, { locale }) => ({ title: await tTitle(e.payload.tournamentId, locale), until: e.payload.offerExpiresAt }),
    link: () => esportsUrl('/me/matches'),
  },
  {
    code: 'ESPORTS_CHECKIN_OPEN',
    events: ['esports_tournament.checkin_opened'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    urgent: true,
    recipients: (e) => es().confirmedPlayers(e.payload.tournamentId),
    values: async (e, { locale }) => ({ title: await tTitle(e.payload.tournamentId, locale), until: e.payload.closesAt }),
    link: () => esportsUrl('/me/matches'),
  },
  {
    // Never the room ID or password: the player opens the room page (FR-15).
    code: 'ESPORTS_ROOM_READY',
    events: ['esports_match.room_revealed'],
    category: 'tournaments',
    channels: ['in_app'],
    urgent: true,
    recipients: async (e) => (await es().matchPlayers(e.payload.matchId)).users,
    values: async (e, { locale }) => ({ title: await tTitle(e.payload.tournamentId, locale), match: (await es().matchPlayers(e.payload.matchId)).seq ?? 1 }),
    link: (e) => esportsUrl(`/me/matches/${e.payload.matchId}/room`),
  },
  {
    code: 'ESPORTS_RESULTS_POSTED',
    events: ['esports_match.results_posted'],
    category: 'tournaments',
    channels: ['in_app'],
    recipients: async (e) => (await es().matchPlayers(e.payload.matchId)).users,
    values: async (e, { locale }) => ({ title: await tTitle(e.payload.tournamentId, locale), match: e.payload.seq, until: e.payload.disputeClosesAt }),
    link: (e) => esportsUrl(`/me/matches/${e.payload.matchId}/result`),
  },
  {
    code: 'ESPORTS_DISPUTE_DECIDED',
    events: ['esports_result.dispute_resolved'],
    category: 'tournaments',
    channels: ['in_app'],
    recipients: (e) => [e.payload.raisedBy],
    values: async (e, { locale }) => ({ title: await tTitle(e.payload.tournamentId, locale), outcome: e.payload.outcome === 'corrected' ? (locale === 'bn' ? 'ফলাফল সংশোধন করা হয়েছে' : 'the results were corrected') : locale === 'bn' ? 'ফলাফল অপরিবর্তিত' : 'the results stand' }),
    link: (e) => esportsUrl(`/me/matches/${e.payload.matchId}/result`),
  },
  {
    code: 'ESPORTS_CANCELLED',
    events: ['esports_tournament.cancelled'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    recipients: (e) => es().allEntrants(e.payload.tournamentId),
    values: async (e, { locale }) => ({ title: await tTitle(e.payload.tournamentId, locale) }),
    link: () => esportsUrl('/me/matches'),
  },
  {
    code: 'ESPORTS_PRIZE_CREDITED',
    events: ['esports_prize.credited'],
    category: 'money',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.userId],
    values: async (e, { locale }) => ({ amount: e.payload.amount, title: await tTitle(e.payload.tournamentId, locale) }),
    link: () => esportsUrl('/me/winnings'),
  },
  {
    code: 'ESPORTS_DISPUTE_OPENED',
    events: ['esports_result.disputed'],
    category: 'staff_ops',
    channels: ['in_app'],
    recipients: () => directory.withPermission('manage_esports'),
    values: async (e) => ({ title: await tTitle(e.payload.tournamentId, 'en') }),
    link: () => '/admin/esports?tab=disputes',
  },
  // ---------------- M07: payees (category money: in-app and SMS mandatory) and finance staff
  {
    code: 'PAYOUT_SCHEDULED',
    events: ['payout.scheduled'],
    category: 'money',
    channels: ['in_app'],
    recipients: (e) => (e.payload.kind === 'earning' ? [e.payload.payeeId] : []),
    values: (e) => ({ amount: e.payload.amount, code: e.payload.code }),
    link: () => '/me/payouts',
  },
  {
    code: 'PAYOUT_PAID',
    events: ['payout.paid'],
    category: 'money',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.payeeId],
    values: async (e) => {
      const p = await payoutFacts(e.payload.payoutId);
      return { amount: e.payload.amount, account: p.masked ?? '—', ref: p.providerRef ?? e.payload.code };
    },
    link: () => '/me/payouts',
  },
  {
    code: 'PAYOUT_FAILED',
    events: ['payout.failed'],
    category: 'money',
    channels: ['in_app', 'sms', 'email'],
    recipients: (e) => [e.payload.payeeId],
    values: async (e) => ({ amount: e.payload.amount, account: (await payoutFacts(e.payload.payoutId)).masked ?? '—', url: webUrl('/me/payout-account') }),
    link: () => '/me/payout-account',
  },
  {
    code: 'PAYOUT_HELD',
    events: ['payout.held'],
    category: 'money',
    channels: ['in_app'],
    // Payee-facing for the holds a payee can understand; risk and dispute holds speak through M18/M17.
    recipients: (e) => (['manual', 'account_change', 'account_suspended', 'kyc'].includes(e.payload.type) ? [e.payload.payeeId] : []),
    values: (e, { locale }) => ({ reason: HOLD_REASONS[locale]?.[e.payload.type] ?? HOLD_REASONS.en[e.payload.type] ?? e.payload.type }),
    link: () => '/me/payouts',
  },
  {
    code: 'PAYOUT_ACCOUNT_CHANGED',
    events: ['payout_account.added'],
    category: 'security',
    channels: ['in_app', 'sms', 'email'],
    // A possible account takeover: the registered phone hears at once, even in quiet hours.
    urgent: true,
    recipients: (e) => [e.payload.userId],
    values: async (e) => ({ account: (await accountFacts(e.payload.accountId)).masked, hours: settingsHours() }),
    link: () => '/me/payout-account',
  },
  {
    code: 'PAYOUT_ACCOUNT_VERIFIED',
    events: ['payout_account.verified'],
    category: 'money',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.userId],
    values: async (e, { locale }) => ({
      account: (await accountFacts(e.payload.accountId)).masked,
      note: e.payload.holdUntil ? holdNote(e.payload.holdUntil, locale) : locale === 'bn' ? 'এখন থেকে পেআউট এখানে যাবে।' : 'Payouts go to it from now on.',
    }),
    link: () => '/me/payout-account',
  },
  {
    code: 'PAYOUT_ACCOUNT_REJECTED',
    events: ['payout_account.rejected'],
    category: 'money',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.userId],
    values: async (e) => {
      const a = await accountFacts(e.payload.accountId);
      return { account: a.masked, reason: a.reviewNote ?? '—' };
    },
    link: () => '/me/payout-account',
  },
  {
    code: 'PAYOUT_NEEDS_APPROVAL',
    events: ['payout.approval_requested'],
    category: 'staff_ops',
    channels: ['in_app', 'email'],
    recipients: () => directory.masters(),
    values: (e) => ({ code: e.payload.code, amount: e.payload.amount, url: adminUrl(`/admin/finance?tab=payouts&id=${e.payload.payoutId}`) }),
    link: (e) => `/admin/finance?tab=payouts&id=${e.payload.payoutId}`,
  },
  {
    code: 'PAYOUT_ACCOUNT_REVIEW',
    events: ['payout_account.added'],
    category: 'staff_ops',
    channels: ['in_app'],
    recipients: () => directory.withPermission('view_payouts'),
    values: async (e) => ({ account: (await accountFacts(e.payload.accountId)).masked }),
    link: () => '/admin/finance?tab=accounts',
  },
  // ---------------- M19 analytics
  {
    code: 'ANALYTICS_DRIFT',
    events: ['analytics.drift_detected'],
    category: 'staff_ops',
    channels: ['in_app', 'email'],
    recipients: async () => directory.masters(),
    values: async (e) => ({ vertical: e.payload.vertical, records: e.payload.records, amount: e.payload.amount }),
    link: () => '/admin',
  },
  // ---------------- M10 bookings (v3: instant confirmation; the advance is not refunded)
  {
    code: 'BOOKING_CONFIRMED',
    events: ['booking.confirmed'],
    category: 'bookings',
    channels: ['in_app', 'sms'],
    recipients: toBooker,
    values: bookingValues,
    link: myBooking,
  },
  {
    code: 'BOOKING_NEW_FOR_OWNER',
    events: ['booking.confirmed'],
    category: 'bookings',
    channels: ['in_app'],
    recipients: (e) => [e.payload.ownerId],
    values: bookingValues,
    link: () => vendorUrl('/vendor/bookings'),
  },
  {
    code: 'BOOKING_CANCELLED',
    events: ['booking.cancelled'],
    category: 'bookings',
    channels: ['in_app', 'sms'],
    recipients: toBooker,
    values: bookingValues,
    link: myBooking,
  },
  {
    code: 'BOOKING_CANCELLED_FOR_OWNER',
    events: ['booking.cancelled'],
    category: 'bookings',
    channels: ['in_app'],
    recipients: (e) => [e.payload.ownerId],
    values: bookingValues,
    link: () => vendorUrl('/vendor/bookings'),
  },
  {
    code: 'BOOKING_OWNER_CANCELLED',
    events: ['booking.owner_cancelled', 'booking.platform_cancelled'],
    category: 'bookings',
    channels: ['in_app', 'sms'],
    urgent: true,
    recipients: toBooker,
    values: bookingValues,
    link: myBooking,
  },
  {
    code: 'BOOKING_REMINDER',
    events: ['booking.reminded'],
    category: 'bookings',
    channels: ['in_app', 'sms'],
    recipients: toBooker,
    values: bookingValues,
    link: myBooking,
  },
  {
    code: 'BOOKING_MOVED',
    events: ['booking.moved'],
    category: 'bookings',
    channels: ['in_app', 'sms'],
    urgent: true,
    recipients: toBooker,
    values: bookingValues,
    link: myBooking,
  },
  {
    code: 'BOOKING_NO_SHOW',
    events: ['booking.no_show_marked'],
    category: 'bookings',
    channels: ['in_app', 'sms'],
    recipients: toBooker,
    values: bookingValues,
    link: myBooking,
  },
  // ---------------- M17 disputes, reports and reviews
  {
    code: 'DISPUTE_OPENED',
    events: ['dispute.opened'],
    category: 'disputes_reports',
    channels: ['in_app', 'sms'],
    urgent: true,
    recipients: (e) => (e.payload.respondentId ? [e.payload.respondentId] : []),
    values: disputeValues,
    link: vendorDispute,
  },
  {
    code: 'DISPUTE_RECEIVED',
    events: ['dispute.opened'],
    category: 'disputes_reports',
    channels: ['in_app'],
    recipients: (e) => [e.payload.claimantId],
    values: disputeValues,
    link: myDispute,
  },
  {
    code: 'DISPUTE_RESPONSE_DUE',
    events: ['dispute.respondent_reminded'],
    category: 'disputes_reports',
    channels: ['in_app'],
    recipients: (e) => (e.payload.respondentId ? [e.payload.respondentId] : []),
    values: disputeValues,
    link: vendorDispute,
  },
  {
    code: 'DISPUTE_RESPONDED',
    events: ['dispute.response_submitted'],
    category: 'disputes_reports',
    channels: ['in_app'],
    recipients: (e) => [e.payload.claimantId],
    values: disputeValues,
    link: myDispute,
  },
  {
    code: 'DISPUTE_DECIDED',
    events: ['dispute.resolved'],
    category: 'disputes_reports',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.claimantId, e.payload.respondentId].filter(Boolean),
    values: disputeValues,
    link: (e, { userId } = {}) => (userId && userId === e.payload.respondentId ? vendorDispute(e) : myDispute(e)),
  },
  {
    code: 'DISPUTE_ESCALATED',
    events: ['dispute.escalated'],
    category: 'staff_ops',
    channels: ['in_app'],
    recipients: () => directory.masters(),
    values: disputeValues,
    link: adminDispute,
  },
  {
    code: 'DISPUTE_SLA_BREACHED',
    events: ['dispute.sla_breached'],
    category: 'staff_ops',
    channels: ['in_app'],
    recipients: (e) => (e.payload.level === 'master' ? directory.masters() : directory.withPermission(e.payload.sourceType === 'esports_result' ? 'manage_esports' : 'resolve_reports')),
    values: disputeValues,
    link: adminDispute,
  },
  {
    code: 'REPORT_OUTCOME',
    events: ['report.resolved'],
    category: 'disputes_reports',
    channels: ['in_app'],
    recipients: (e) => e.payload.reporterIds,
    values: (e, { locale }) => ({ subject: subjectLabel(e.payload.subjectType, locale), outcome: REPORT_OUTCOMES[locale]?.[e.payload.action] ?? REPORT_OUTCOMES.en[e.payload.action] }),
    link: () => '/me/reports',
  },
  {
    code: 'REPORT_FLAGGED',
    events: ['report.threshold_reached'],
    category: 'staff_ops',
    channels: ['in_app'],
    recipients: () => directory.withPermission('resolve_reports'),
    values: (e, { locale }) => ({ subject: subjectLabel(e.payload.subjectType, locale), reporters: e.payload.reporters }),
    link: (e) => `/admin/reports?subjectType=${e.payload.subjectType}&subjectId=${e.payload.subjectId}`,
  },
  {
    code: 'REVIEW_NEW',
    events: ['review.posted'],
    category: 'reviews',
    channels: ['in_app'],
    recipients: (e) => (e.payload.status === 'published' ? [e.payload.ownerId] : []),
    values: async (e) => {
      const f = await reviewFacts(e.payload.reviewId);
      return { stars: f.stars, ground: f.groundName };
    },
    link: () => vendorUrl('/vendor/reviews'),
  },
  {
    code: 'REVIEW_HIDDEN',
    events: ['review.hidden'],
    category: 'reviews',
    channels: ['in_app'],
    recipients: (e) => [e.payload.authorId],
    values: async (e) => ({ ground: (await reviewFacts(e.payload.reviewId)).groundName }),
    link: () => '/me/reviews',
  },
  // ---------------- M12 market: shop and product reviews, stock (the shop owner), saved items (members)
  {
    code: 'SHOP_LIVE',
    events: ['shop.published'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e) => ({ name: (await shopFacts(e.payload.shopId)).name, url: vendorUrl('/vendor/shop') }),
    link: () => '/vendor/shop',
  },
  {
    code: 'SHOP_CHANGES_REQUESTED',
    events: ['shop.changes_requested'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e, { locale }) => ({ name: (await shopFacts(e.payload.shopId)).name, reason: marketReason(e.payload.reasonCode, locale) }),
    link: () => '/vendor/shop',
  },
  {
    code: 'SHOP_REJECTED',
    events: ['shop.rejected'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e, { locale }) => ({ name: (await shopFacts(e.payload.shopId)).name, reason: marketReason(e.payload.reasonCode, locale) }),
    link: () => '/vendor/shop',
  },
  {
    code: 'PRODUCT_LIVE',
    events: ['product.published'],
    category: 'moderation',
    channels: ['in_app'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e) => ({ name: (await productFacts(e.payload.productId)).title, url: await webProduct(e.payload.productId) }),
    link: (e) => `/vendor/products/${e.payload.productId}`,
  },
  {
    code: 'PRODUCT_CHANGES_REQUESTED',
    events: ['product.changes_requested'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e, { locale }) => ({ name: (await productFacts(e.payload.productId)).title, reason: marketReason(e.payload.reasonCode, locale) }),
    link: (e) => `/vendor/products/${e.payload.productId}`,
  },
  {
    code: 'PRODUCT_REJECTED',
    events: ['product.rejected'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e, { locale }) => ({ name: (await productFacts(e.payload.productId)).title, reason: marketReason(e.payload.reasonCode, locale) }),
    link: (e) => `/vendor/products/${e.payload.productId}`,
  },
  {
    code: 'STOCK_LOW',
    events: ['variant.low_stock_reached'],
    category: 'orders',
    channels: ['in_app'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e, { locale }) => ({ ...(await variantValues(e, locale)), left: e.payload.available }),
    link: () => '/vendor/inventory?status=low',
  },
  {
    code: 'STOCK_OUT',
    events: ['variant.stock_depleted'],
    category: 'orders',
    channels: ['in_app'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e, { locale }) => variantValues(e, locale),
    link: () => '/vendor/inventory?status=out',
  },
  {
    code: 'SUPPLEMENT_EXPIRING',
    events: ['variant.sale_blocked'],
    category: 'orders',
    channels: ['in_app'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e, { locale }) => ({ ...(await variantValues(e, locale)), expiry: e.payload.expiryDate ?? '' }),
    link: () => '/vendor/inventory?status=blocked',
  },
  {
    code: 'SAVED_BACK_IN_STOCK',
    events: ['saved_item.alerted'],
    category: 'offers',
    channels: ['in_app'],
    recipients: (e) => (e.payload.reason === 'back_in_stock' ? [e.payload.userId] : []),
    values: async (e) => ({ name: (await productFacts(e.payload.itemId)).title }),
    link: () => '/shop/saved',
  },
  {
    code: 'SAVED_PRICE_DROP',
    events: ['saved_item.alerted'],
    category: 'offers',
    channels: ['in_app'],
    recipients: (e) => (e.payload.reason === 'price_dropped' ? [e.payload.userId] : []),
    values: async (e) => ({ name: (await productFacts(e.payload.itemId)).title, price: e.payload.pricePoisha }),
    link: () => '/shop/saved',
  },
  // ---------------- M18 risk and trust (the payee never sees the rule)
  {
    code: 'RISK_FLAGGED',
    events: ['risk.flag_raised'],
    category: 'staff_ops',
    channels: ['in_app'],
    recipients: async (e) => (['high', 'critical'].includes(e.payload.severity) ? riskDeskStaff() : []),
    values: async (e, { locale }) => ({ rule: pick(RULE_LABELS, locale, e.payload.ruleKey), severity: pick(SEVERITY_LABELS, locale, e.payload.severity), user: await nameOf(e.payload.userId) }),
    link: riskDesk,
  },
  {
    code: 'PAYOUTS_FROZEN',
    events: ['risk.action_taken'],
    category: 'money',
    channels: ['in_app', 'sms'],
    recipients: (e) => (actionIs('freeze_payouts')(e) ? [e.payload.userId] : []),
    values: () => ({}),
    link: () => '/me/payouts',
  },
  {
    code: 'PAYOUTS_UNFROZEN',
    events: ['risk.action_taken'],
    category: 'money',
    channels: ['in_app', 'sms'],
    recipients: (e) => (actionIs('unfreeze_payouts')(e) ? [e.payload.userId] : []),
    values: () => ({}),
    link: () => '/me/payouts',
  },
  {
    code: 'DOCUMENTS_REQUESTED',
    events: ['document_request.created'],
    category: 'security',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.userId],
    values: (e, { locale }) => ({ doc: pick(DOC_REQUEST_LABELS, locale, e.payload.docType), dueAt: e.payload.dueAt }),
    link: () => '/account/verification',
  },
  {
    code: 'DOCUMENTS_OVERDUE',
    events: ['document_request.overdue_marked'],
    category: 'staff_ops',
    channels: ['in_app'],
    recipients: () => riskDeskStaff(),
    values: async (e, { locale }) => ({ user: await nameOf(e.payload.userId), doc: pick(DOC_REQUEST_LABELS, locale, e.payload.docType) }),
    link: riskDesk,
  },
  {
    code: 'TRUST_LOW',
    events: ['trust.low_crossed'],
    category: 'bookings',
    channels: ['in_app'],
    recipients: (e) => (e.payload.kind === 'owner' ? [e.payload.userId] : []),
    values: (e, { locale }) => ({ kind: pick(TRUST_KINDS, locale, e.payload.kind), score: e.payload.score }),
    link: () => vendorUrl('/vendor'),
  },
];

const byCode = new Map(CATALOGUE.map((c) => [c.code, c]));

module.exports = { CATALOGUE, byCode, roleLabel };
