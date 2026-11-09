'use strict';

/**
 * Notification catalogue (M08 §6.6), as code. Each entry maps a domain event to recipients, channels
 * and template variables. Template texts are versioned rows in message_templates (EN and BN for
 * every default channel; a contract test checks it). Built so far: the M01, M02, M03, M04, M05, M06, M07, M09, M10, M12, M13, M17, M18, M19 and M21 events.
 *
 * Entry: { code, events[], category, channels[], urgent, roleContext?(e), recipients(e) → userIds,
 *          values(e, { locale, userId }) → template values, link(e, { userId }) → in-app link }
 */
const config = require('../../config');
const directory = require('../users').directory;
const { formatValue } = require('./notify.rules');

const ROLE_LABELS = {
  en: { member: 'Member', player: 'Player', pro: 'Pro', ground_owner: 'Venue owner', shop_owner: 'Shop', organiser: 'Organiser', gym_owner: 'Gym owner' },
  bn: { member: 'সদস্য', player: 'খেলোয়াড়', pro: 'প্রো', ground_owner: 'ভেন্যু মালিক', shop_owner: 'দোকান', organiser: 'আয়োজক', gym_owner: 'জিম মালিক' },
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
const settingsRequest = (id) => require('../settings').changeRequest.getOne(id);
const auditEntry = (id) => require('../audit').admin.getOne(id);
const paymentFacts = (id) => require('../payments').intents.facts(id);
const refundFacts = (id) => require('../payments').refunds.facts(id);
const documentFacts = (id) => require('../kyc').kyc.facts(id);
// M05 reason codes for the document kind (moderation.v1.json), worded for the member.
const KYC_REASONS = {
  en: { docs_mismatch_nid: 'the details do not match the NID', unreadable: 'the photos are unclear or cut off', expired: 'the NID looks expired', duplicate: 'this NID is already on another account', info_incomplete: 'some required information is missing', breaks_rules: 'it breaks our rules', other: 'see the note from our team' },
  bn: { docs_mismatch_nid: 'তথ্য NID-এর সাথে মেলে না', unreadable: 'ছবি অস্পষ্ট বা কাটা', expired: 'NID-এর মেয়াদ শেষ মনে হচ্ছে', duplicate: 'এই NID অন্য অ্যাকাউন্টে আছে', info_incomplete: 'প্রয়োজনীয় তথ্য নেই', breaks_rules: 'এটি আমাদের নিয়ম ভঙ্গ করে', other: 'আমাদের টিমের নোট দেখুন' },
};
const reviewersOf = (kind) => directory.withPermission(require('../moderation').adapters.get(kind).permission);
const KIND_LABELS = {
  en: { document: 'identity document', game_profile: 'game UID', esports_tournament: 'esports event', ground: 'venue listing', shop: 'shop', product: 'shop product', tournament: 'tournament' },
  bn: { document: 'পরিচয় ডকুমেন্ট', game_profile: 'গেম UID', esports_tournament: 'এস্পোর্টস ইভেন্ট', ground: 'ভেন্যুর তালিকা', shop: 'দোকান', product: 'দোকানের পণ্য', tournament: 'টুর্নামেন্ট' },
};
const kindLabel = (kind, locale) => KIND_LABELS[locale]?.[kind] ?? KIND_LABELS.en[kind] ?? kind;
const es = () => require('../esports').facts;
// M09: grounds and the ground owner's business documents.
const groundFacts = (id) => require('../grounds').grounds.facts(id);
// VENDOR_APP_URL already ends in /vendor (values/backend/*.yaml): pass the path inside the vendor area.
const vendorUrl = (p) => `${config.apps.vendor}${p}`;
// M24-FR-103: since 25 Oct 2026 gym owners and members use the gym app on gym.kriraghor.com
// (GYM_APP_URL), so gym and member-side trainer links are absolute gym URLs.
const gymUrl = (p) => `${config.apps.gym}${p}`;
// M20: gyms (the owner), passes (the holder), trainer subscriptions (the member and the trainer).
const gymFacts = (id) => require('../gym').gyms.facts(id);
// M24: a gym member's code (the gym's own record; never the name or phone).
const gmMemberFacts = (id) => require('../gym-manage').facts.member(id);
// M24 prompt 2 (§11.1): a member notice goes to the linked account (user id) or, for an unlinked member
// with an email in the gym's record, by email through the recipient adapter `gym_member`. gym-manage
// decides (the owner's plan has reminders, not restricted, the kind switched on).
const gmTargets = (kind) => (e) => require('../gym-manage').notices.memberTargets(e.payload, kind);
const gmUsers = (kind) => async (e) => (await gmTargets(kind)(e)).userIds;
const gmExternal = (kind) => async (e) => (await gmTargets(kind)(e)).external;
const gmFacts = () => require('../gym-manage').facts;
const gymName = async (id) => (await gymFacts(id))?.name ?? '';
/** A Dhaka calendar date as the recipient reads it: "3 Nov 2026" / "৩ নভে, ২০২৬". */
const dayText = (date, locale) => (date ? new Intl.DateTimeFormat(locale === 'bn' ? 'bn-BD' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${String(date).slice(0, 10)}T00:00:00Z`)) : '');
const TIER_NAMES = { en: { free: 'Free', basic: 'Basic', standard: 'Standard', pro: 'Pro' }, bn: { free: 'ফ্রি', basic: 'বেসিক', standard: 'স্ট্যান্ডার্ড', pro: 'প্রো' } };
const FEE_NAMES = { en: { 'fees.gym_referral_poisha': 'referral fee', 'fees.gym_pct': 'pass commission' }, bn: { 'fees.gym_referral_poisha': 'রেফারেল ফি', 'fees.gym_pct': 'পাস কমিশন' } };
const pickLocale = (map, locale, key) => map[locale]?.[key] ?? map.en[key] ?? key;
const PLAN_KINDS = { en: { workout: 'workout plan', diet: 'diet chart' }, bn: { workout: 'ওয়ার্কআউট প্ল্যান', diet: 'ডায়েট চার্ট' } };
const gymOwnerAndCollectors = async (e) => [e.payload.ownerId, ...(await staffOf('gym', e.payload.gymId, 'fees.collect'))];
// M27: the gym's owner (from M20) and the staff holding a permission.
const gymOwnerId = async (gymId) => (await require('../gym').gyms.get(gymId))?.ownerId ?? null;
// M27 round 2: many members of a gym at once (classes, notices): linked accounts, else email to the gym's record.
const gmMembersReach = (e) => require('../gym-manage').ops.reachOf(e.payload.gymId, e.payload.memberIds ?? []);
const gmMemberReach = (e) => require('../gym-manage').ops.reachOf(e.payload.gymId, [e.payload.memberId]);
const classOf = (e) => require('../gym-ops').classes.sessionFacts(e.payload.sessionId);
const timeText = (iso, locale) => (iso ? new Intl.DateTimeFormat(locale === 'bn' ? 'bn-BD' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dhaka' }).format(new Date(iso)) : '');
const gymOwnerAnd = (permission) => async (e) => [await gymOwnerId(e.payload.gymId), ...(permission ? await staffOf('gym', e.payload.gymId, permission) : [])].filter(Boolean);
// M14 lite and M22: the organisation (its name) and its admins (owner and admins get organiser news).
const orgAdmins = (id) => require('../organisations').organisations.adminIds(id);
// M14: tournament names, registrations and captains.
const tf = () => require('../tournaments').facts;
const eventOf = async (id) => require('../../models').EsportsEvent.findByPk(id, { attributes: ['id', 'slug', 'titleEn'] });
const eventTitle = async (id) => (await eventOf(id))?.titleEn ?? '';
// Links take the id: the esports app's /showcases/[slug] page accepts an id too (M23 showcases).
const eventLink = (id) => `/showcases/${id}`;
const followerPage = (kind) => (e) => (e.payload.kind === kind ? require('../esports-events').alerts.pageRecipients(e.payload) : []);
const teamName = async (id) => (await require('../teams').teams.getTeam(id))?.name ?? '';
const orgName = async (id) => (await require('../organisations').organisations.publicRefs([id])).get(id)?.name ?? '';
const passFacts = (id) => require('../gym').reads.passFacts(id);
const isNid = (e) => !e.payload.role || e.payload.role === 'member';
const DOC_LABELS = {
  en: { trade_license: 'trade licence', deed_or_lease: 'land deed or lease', tin: 'TIN certificate', bin: 'VAT registration (BIN)' },
  bn: { trade_license: 'ট্রেড লাইসেন্স', deed_or_lease: 'জমির দলিল বা লিজ', tin: 'টিআইএন সনদ', bin: 'ভ্যাট নিবন্ধন (বিআইএন)' },
};
const docLabel = (type, locale) => DOC_LABELS[locale]?.[type] ?? DOC_LABELS.en[type] ?? type;
const GROUND_REASONS = {
  en: { photos_unclear: 'the photos are unclear or not of this venue', price_wrong: 'the price looks wrong', duplicate: 'this venue is already listed', info_incomplete: 'some information is missing', breaks_rules: 'it breaks our rules', location_wrong: 'the address or map pin is wrong', not_a_venue: 'it is not a bookable sports venue', other: 'see the note from our team' },
  bn: { photos_unclear: 'ছবি অস্পষ্ট বা এই ভেন্যুর নয়', price_wrong: 'দাম ঠিক মনে হচ্ছে না', duplicate: 'এই ভেন্যু আগেই তালিকায় আছে', info_incomplete: 'কিছু তথ্য নেই', breaks_rules: 'এটি আমাদের নিয়ম ভঙ্গ করে', location_wrong: 'ঠিকানা বা ম্যাপ পিন ভুল', not_a_venue: 'এটি বুকিংযোগ্য খেলার ভেন্যু নয়', other: 'আমাদের টিমের নোট দেখুন' },
};
const groundReason = (code, locale) => GROUND_REASONS[locale]?.[code] ?? GROUND_REASONS.en[code] ?? reasonText(code, locale);
const esportsUrl = (p) => `${config.apps.esports}${p}`;
// M12: shops, products and stock (the shop owner), saved items (members).
const shopFacts = (id) => require('../market').shops.facts(id);
const productFacts = (id) => require('../market').products.facts(id);
const variantFacts = (id) => require('../market').products.variantFacts(id);
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
const bookingFacts = (id) => require('../bookings').reads.facts(id);
// M11: hire requests and jobs (the manager and the pro). Codes, role names and amounts only.
const hireFacts = (e) => require('../hire').reads.facts({ requestId: e.payload.requestId, jobId: e.payload.jobId ?? null });
const hireProfileFacts = (id) => require('../hire').profiles.facts(id);
const hireRole = async (e, locale) => {
  const f = await hireFacts(e);
  return locale === 'bn' ? f.roleBn : f.roleEn;
};
const hireReason = (code, locale) => marketReason(code, locale);
// M13: shop orders (the buyer and the shop owner). Codes, shop names and amounts only.
const orderFacts = (id) => require('../orders').reads.facts(id);
const ORDER_REASONS = {
  en: { out_of_stock: 'the item is out of stock', cannot_deliver_area: 'the shop cannot deliver to your area', price_error: 'the price was wrong', shop_closed: 'the shop is closed', not_accepted: 'the shop did not accept in time', not_shipped: 'the shop did not ship in time', ship_overdue: 'you cancelled a late shipment', buyer_cancelled: 'you cancelled it', platform: 'our team cancelled it', payment_not_completed: 'the payment was not completed', payment_timeout: 'the payment was not completed in time', other: 'see the order for details' },
  bn: { out_of_stock: 'পণ্যটি স্টকে নেই', cannot_deliver_area: 'দোকান আপনার এলাকায় পাঠাতে পারে না', price_error: 'দাম ভুল ছিল', shop_closed: 'দোকান বন্ধ', not_accepted: 'দোকান সময়মতো গ্রহণ করেনি', not_shipped: 'দোকান সময়মতো পাঠায়নি', ship_overdue: 'দেরিতে পাঠানোর কারণে আপনি বাতিল করেছেন', buyer_cancelled: 'আপনি বাতিল করেছেন', platform: 'আমাদের টিম বাতিল করেছে', payment_not_completed: 'পেমেন্ট সম্পন্ন হয়নি', payment_timeout: 'সময়মতো পেমেন্ট হয়নি', other: 'বিস্তারিত অর্ডারে দেখুন' },
};
const orderReason = (code, locale) => ORDER_REASONS[locale]?.[code] ?? ORDER_REASONS.en[code] ?? reasonText(code, locale);
const orderLink = (e) => `/me/orders/${e.payload.code.replace(/-[A-Z]$/, '')}`;
const vendorOrder = (e) => `/vendor/orders?id=${e.payload.subOrderId}`;
const bookingValues = async (e) => {
  const f = await bookingFacts(e.payload.bookingId);
  return { code: f.code, ground: f.groundName, start: f.start, paid: f.paidOnline, due: f.dueAtVenue, refund: f.refund, retained: f.retained };
};
const toBooker = (e) => (e.payload.bookerUserId ? [e.payload.bookerUserId] : []);
const myBooking = (e) => `/me/bookings/${e.payload.bookingId}`;
const tTitle = async (id, locale) => es().title(await es().tournament(id), locale);
const payoutFacts = (id) => require('../payouts').payouts.facts(id);
// Round B3: a business's staff who hold a permission also hear about its bookings, orders and stock
// (never completed-order money, payouts or moderation); their own team changes come to them.
const staffOf = (type, businessId, permission) => require('../business-members').members.staffRecipients(type, businessId, permission);
const businessName = (type, businessId) => require('../business-members').members.businessName(type, businessId);
const BUSINESS_LABELS = { en: { venue: 'venue', gym: 'gym', shop: 'shop' }, bn: { venue: 'ভেন্যু', gym: 'জিম', shop: 'দোকান' } };
const businessLabel = (type, locale) => BUSINESS_LABELS[locale]?.[type] ?? BUSINESS_LABELS.en[type] ?? type;
const staffBookingValues = async (e) => {
  const f = await bookingFacts(e.payload.bookingId);
  return { code: f.code, ground: f.groundName, start: f.start, due: f.dueAtVenue };
};
const staffBookings = (e) => vendorUrl(`/bookings?groundId=${e.payload.groundId}`);
// Stock alerts: the owner's link is unchanged; staff name the shop (staff of several shops would get
// 422 BUSINESS_REQUIRED from GET /shop/inventory without it).
const stockLink = (status, e, { userId } = {}) => `/vendor/inventory?status=${status}${userId && userId !== e.payload.ownerId ? `&shopId=${e.payload.shopId}` : ''}`;
const accountFacts = (id) => require('../payouts').payoutAccounts.facts(id);
const settingsHours = () => require('../settings').settings.get('risk.payout_change_hold_hours');
const HOLD_REASONS = {
  en: { manual: 'our finance team is checking it', account_change: 'your payout account changed recently', account_suspended: 'your account is suspended', kyc: 'your verification needs renewing' },
  bn: { manual: 'আমাদের ফিনান্স টিম যাচাই করছে', account_change: 'সম্প্রতি আপনার পেআউট অ্যাকাউন্ট বদলেছে', account_suspended: 'আপনার অ্যাকাউন্ট স্থগিত', kyc: 'আপনার যাচাই নবায়ন দরকার' },
};
function holdNote(until, locale) {
  const when = formatValue('datetime', until, locale);
  return locale === 'bn' ? `নিরাপত্তার জন্য ${when} পর্যন্ত পেআউট বন্ধ থাকবে।` : `For your safety, payouts to it start after ${when}.`;
}
async function holdFacts(holdId) {
  const hold = await require('../payments').escrow.getOne(holdId);
  return { ...hold, title: (await paymentFacts(hold.paymentId)).title };
}

// M17 disputes, reports and reviews.
const disputeFacts = (id) => require('../trust').disputes.facts(id);
const reviewFacts = (id) => require('../trust').reviews.facts(id);
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
const vendorDispute = (e) => vendorUrl(`/disputes/${e.payload.code}`);
const adminDispute = (e) => `/admin/disputes?code=${e.payload.code}`;

// M18 risk and trust.
const RULE_LABELS = {
  en: { accounts_per_nid: 'the same NID on several accounts', shared_payout_account: 'a payout wallet shared with another account', esports_uid_banned: 'a banned game UID', refund_rate: 'many refunds', dispute_loss_rate: 'many lost disputes', reports_upheld: 'upheld reports', esports_disqualified: 'esports disqualifications', velocity_breaches: 'many rate-limit hits', payout_account_change: 'a new payout account' },
  bn: { accounts_per_nid: 'একাধিক অ্যাকাউন্টে একই NID', shared_payout_account: 'অন্য অ্যাকাউন্টের সাথে একই পেআউট ওয়ালেট', esports_uid_banned: 'নিষিদ্ধ গেম UID', refund_rate: 'অনেক রিফান্ড', dispute_loss_rate: 'অনেক বিরোধে হার', reports_upheld: 'সঠিক প্রমাণিত রিপোর্ট', esports_disqualified: 'এস্পোর্টস থেকে বাদ', velocity_breaches: 'বারবার সীমা ছোঁয়া', payout_account_change: 'নতুন পেআউট অ্যাকাউন্ট' },
};
const SEVERITY_LABELS = { en: { info: 'info', medium: 'medium', high: 'high', critical: 'critical' }, bn: { info: 'তথ্য', medium: 'মাঝারি', high: 'উচ্চ', critical: 'গুরুতর' } };
const DOC_REQUEST_LABELS = { en: { nid: 'NID', trade_license: 'trade licence', deed_or_lease: 'land deed or lease', tin: 'TIN certificate' }, bn: { nid: 'NID', trade_license: 'ট্রেড লাইসেন্স', deed_or_lease: 'জমির দলিল বা লিজ', tin: 'টিআইএন সনদ' } };
const TRUST_KINDS = { en: { owner: 'venue owner', booker: 'booking' }, bn: { owner: 'ভেন্যু মালিক', booker: 'বুকিং' } };
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
    code: 'PASSWORD_CHANGED',
    events: ['user.password_changed'],
    category: 'security',
    channels: ['in_app', 'sms', 'email'],
    urgent: true,
    recipients: (e) => [e.payload.userId],
    values: async (e) => ({ when: e.payload.at }),
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
  // ---------------- Round B3: staff accounts for businesses (the staff member hears of their own access)
  {
    code: 'TEAM_ADDED',
    events: ['business_member.added'],
    category: 'security',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.memberId],
    values: async (e, { locale }) => ({ owner: await nameOf(e.payload.ownerId), business: await businessName(e.payload.businessType, e.payload.businessId), kind: businessLabel(e.payload.businessType, locale) }),
    // M24-FR-103: gym staff work in the gym app (gym.kriraghor.com, 25 Oct 2026); venues and shops stay on vendor.
    link: (e) => (e.payload.businessType === 'gym' ? gymUrl('/manage') : vendorUrl('/')),
  },
  {
    code: 'TEAM_REMOVED',
    events: ['business_member.removed'],
    category: 'security',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.memberId],
    values: async (e, { locale }) => ({ owner: await nameOf(e.payload.ownerId), business: await businessName(e.payload.businessType, e.payload.businessId), kind: businessLabel(e.payload.businessType, locale) }),
    link: () => '/me',
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
    values: async (e) => ({ name: (await groundFacts(e.payload.groundId)).name, url: vendorUrl(`/venues/${e.payload.groundId}`) }),
    link: (e) => `/vendor/venues/${e.payload.groundId}`,
  },
  {
    code: 'GROUND_CHANGES_REQUESTED',
    events: ['ground.changes_requested'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e, { locale }) => ({ name: (await groundFacts(e.payload.groundId)).name, reason: groundReason(e.payload.reasonCode, locale) }),
    link: (e) => `/vendor/venues/${e.payload.groundId}`,
  },
  {
    code: 'GROUND_REJECTED',
    events: ['ground.rejected'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e, { locale }) => ({ name: (await groundFacts(e.payload.groundId)).name, reason: groundReason(e.payload.reasonCode, locale) }),
    link: (e) => `/vendor/venues/${e.payload.groundId}`,
  },
  {
    code: 'GROUND_PRICING_PUBLISHED',
    events: ['ground.pricing_published'],
    category: 'moderation',
    channels: ['in_app'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e) => ({ name: (await groundFacts(e.payload.groundId)).name }),
    link: (e) => `/vendor/venues/${e.payload.groundId}/pricing`,
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
    link: () => vendorUrl('/bookings'),
  },
  {
    code: 'TEAM_BOOKING_NEW',
    events: ['booking.confirmed'],
    category: 'bookings',
    channels: ['in_app'],
    recipients: (e) => staffOf('venue', e.payload.groundId, 'bookings.view'),
    values: staffBookingValues,
    link: staffBookings,
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
    link: () => vendorUrl('/bookings'),
  },
  {
    code: 'TEAM_BOOKING_CANCELLED',
    events: ['booking.cancelled'],
    category: 'bookings',
    channels: ['in_app'],
    recipients: (e) => staffOf('venue', e.payload.groundId, 'bookings.view'),
    values: staffBookingValues,
    link: staffBookings,
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
    code: 'TEAM_CHECKIN_SOON',
    events: ['booking.reminded'],
    category: 'bookings',
    channels: ['in_app'],
    recipients: (e) => staffOf('venue', e.payload.groundId, 'bookings.check_in'),
    values: staffBookingValues,
    link: staffBookings,
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
      return { stars: f.stars, ground: f.subjectName };
    },
    // Venue owners, shops and gyms reply on vendor.kriraghor.com; pros on their kriraghor.com desk.
    link: (e) => (e.payload.subjectType === 'hire_profile' ? '/pro/reviews' : vendorUrl('/reviews')),
  },
  {
    code: 'REVIEW_HIDDEN',
    events: ['review.hidden'],
    category: 'reviews',
    channels: ['in_app'],
    recipients: (e) => [e.payload.authorId],
    values: async (e) => ({ ground: (await reviewFacts(e.payload.reviewId)).subjectName }),
    link: () => '/me/reviews',
  },
  {
    code: 'REVIEW_REPLIED',
    events: ['review.replied'],
    category: 'reviews',
    channels: ['in_app'],
    // The author hears about the first reply only (an edited reply is not news).
    recipients: (e) => (e.payload.firstReply === false ? [] : [e.payload.authorId]),
    values: async (e) => ({ subject: (await reviewFacts(e.payload.reviewId)).subjectName }),
    link: () => '/me/reviews',
  },
  // ---------------- M12 market: shop and product reviews, stock (the shop owner), saved items (members)
  {
    code: 'SHOP_LIVE',
    events: ['shop.published'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e) => ({ name: (await shopFacts(e.payload.shopId)).name, url: vendorUrl('/shop') }),
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
    recipients: async (e) => [e.payload.ownerId, ...(await staffOf('shop', e.payload.shopId, 'stock.view'))],
    values: async (e, { locale }) => ({ ...(await variantValues(e, locale)), left: e.payload.available }),
    link: (e, ctx) => stockLink('low', e, ctx),
  },
  {
    code: 'STOCK_OUT',
    events: ['variant.stock_depleted'],
    category: 'orders',
    channels: ['in_app'],
    recipients: async (e) => [e.payload.ownerId, ...(await staffOf('shop', e.payload.shopId, 'stock.view'))],
    values: async (e, { locale }) => variantValues(e, locale),
    link: (e, ctx) => stockLink('out', e, ctx),
  },
  {
    code: 'SUPPLEMENT_EXPIRING',
    events: ['variant.sale_blocked'],
    category: 'orders',
    channels: ['in_app'],
    recipients: async (e) => [e.payload.ownerId, ...(await staffOf('shop', e.payload.shopId, 'stock.view'))],
    values: async (e, { locale }) => ({ ...(await variantValues(e, locale)), expiry: e.payload.expiryDate ?? '' }),
    link: (e, ctx) => stockLink('blocked', e, ctx),
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
  // ---------------- M11 hire: the manager (hirer) and the player or pro
  {
    code: 'HIRE_REQUEST_NEW',
    events: ['hire_request.sent'],
    category: 'hire',
    channels: ['in_app', 'sms'],
    urgent: true,
    recipients: (e) => [e.payload.proUserId],
    values: async (e, { locale }) => ({ code: e.payload.code, role: await hireRole(e, locale), total: e.payload.total, replyBy: e.payload.replyBy }),
    link: () => '/pro/requests',
  },
  {
    code: 'HIRE_ACCEPTED_PAY',
    events: ['hire_request.accepted'],
    category: 'hire',
    channels: ['in_app', 'sms'],
    urgent: true,
    recipients: (e) => [e.payload.hirerId],
    values: (e) => ({ code: e.payload.code, total: e.payload.total, payBy: e.payload.payBy }),
    link: (e) => `/me/hire/${e.payload.code}`,
  },
  {
    code: 'HIRE_DECLINED',
    events: ['hire_request.declined', 'hire_request.expired'],
    category: 'hire',
    channels: ['in_app'],
    recipients: (e) => [e.payload.hirerId],
    values: async (e, { locale }) => ({ code: e.payload.code, role: await hireRole(e, locale) }),
    link: () => '/hiring',
  },
  {
    code: 'HIRE_LAPSED',
    events: ['hire_request.lapsed'],
    category: 'hire',
    channels: ['in_app'],
    recipients: (e) => [e.payload.hirerId, e.payload.proUserId],
    values: (e) => ({ code: e.payload.code }),
    link: (e) => `/me/hire/${e.payload.code}`,
  },
  {
    code: 'HIRE_CONFIRMED',
    events: ['hire_request.paid'],
    category: 'hire',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.hirerId, e.payload.proUserId],
    values: async (e) => ({ code: e.payload.code, start: (await hireFacts(e)).start }),
    link: (e, { userId } = {}) => (userId === e.payload.proUserId ? '/pro/jobs' : `/me/hire/${e.payload.code}`),
  },
  {
    code: 'TOURNAMENT_POST_COMMENT',
    events: ['tournament_post.commented'],
    category: 'tournaments',
    channels: ['in_app'],
    recipients: (e) => (e.payload.commenterId === e.payload.authorId ? [] : [e.payload.authorId]),
    values: (e) => ({ title: e.payload.title }),
    link: (e) => `/tournaments/${e.payload.slug}`,
  },
  {
    code: 'TOURNAMENT_POST_MESSAGE',
    events: ['tournament_message.posted'],
    category: 'tournaments',
    channels: ['in_app'],
    recipients: (e) => [e.payload.recipientId],
    values: (e) => ({ title: e.payload.title }),
    link: (e) => `/me/tournaments?thread=${e.payload.threadId}`,
  },
  {
    code: 'TOURNAMENT_POST_REMOVED',
    events: ['tournament_post.removed'],
    category: 'tournaments',
    channels: ['in_app'],
    recipients: (e) => [e.payload.authorId],
    values: (e) => ({ title: e.payload.title, reason: e.payload.reason }),
    link: () => '/me/tournaments',
  },
  {
    code: 'TOURNAMENT_POST_RESTORED',
    events: ['tournament_post.restored'],
    category: 'tournaments',
    channels: ['in_app'],
    recipients: (e) => [e.payload.authorId],
    values: (e) => ({ title: e.payload.title }),
    link: (e) => `/tournaments/${e.payload.slug}`,
  },
  {
    code: 'HIRE_MESSAGE',
    events: ['hire_message.posted'],
    category: 'hire',
    channels: ['in_app'],
    recipients: (e) => [e.payload.recipientId],
    values: (e) => ({ code: e.payload.code }),
    link: (e) => `/me/hire/${e.payload.code}`,
  },
  {
    code: 'JOB_CHECKIN_OPENS',
    events: ['hire_job.checkin_opened'],
    category: 'hire',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.proUserId],
    values: (e) => ({ code: e.payload.code, start: e.payload.start }),
    link: () => '/pro/jobs',
  },
  {
    code: 'JOB_COMPLETED_CONFIRM',
    events: ['hire_job.completed_marked'],
    category: 'hire',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.hirerId],
    values: (e) => ({ code: e.payload.code, releaseAt: e.payload.releaseAt }),
    link: (e) => `/me/hire/${e.payload.code.replace(/-\d+$/, '')}`,
  },
  {
    code: 'JOB_PAID',
    events: ['hire_job.released'],
    category: 'hire',
    channels: ['in_app'],
    recipients: (e) => [e.payload.proUserId],
    values: (e) => ({ code: e.payload.code, net: e.payload.net }),
    link: () => '/me/payouts',
  },
  {
    code: 'JOB_CANCELLED',
    events: ['hire_job.cancelled'],
    category: 'hire',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.proUserId],
    values: (e) => ({ code: e.payload.code, proGets: e.payload.proGets }),
    link: () => '/pro/jobs',
  },
  {
    code: 'JOB_WITHDRAWN',
    events: ['hire_job.withdrawn'],
    category: 'hire',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.hirerId],
    values: (e) => ({ code: e.payload.code, refund: e.payload.refund }),
    link: () => '/hiring',
  },
  {
    code: 'HIRE_PROFILE_LIVE',
    events: ['hire_profile.published'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => (e.payload.first ? [e.payload.userId] : []),
    values: async (e, { locale }) => {
      const f = await hireProfileFacts(e.payload.profileId);
      return { role: locale === 'bn' ? f.roleBn : f.roleEn };
    },
    link: () => '/pro',
  },
  {
    code: 'HIRE_PROFILE_CHANGES',
    events: ['hire_profile.changes_requested', 'hire_profile.rejected'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.userId],
    values: async (e, { locale }) => {
      const f = await hireProfileFacts(e.payload.profileId);
      return { role: locale === 'bn' ? f.roleBn : f.roleEn, reason: hireReason(e.payload.reasonCode, locale) };
    },
    link: () => '/pro',
  },
  // ---------------- M13 orders: the buyer and the shop owner
  {
    code: 'ORDER_PLACED',
    events: ['order.placed'],
    category: 'orders',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.buyerId],
    values: (e) => ({ code: e.payload.code, total: e.payload.total }),
    link: (e) => `/me/orders/${e.payload.code}`,
  },
  {
    code: 'SHOP_NEW_ORDER',
    events: ['sub_order.placed'],
    category: 'orders',
    channels: ['in_app', 'sms'],
    urgent: true,
    recipients: async (e) => [e.payload.sellerId, ...(await staffOf('shop', e.payload.shopId, 'orders.view'))],
    values: (e) => ({ code: e.payload.code, total: e.payload.total, acceptBy: e.payload.acceptBy }),
    link: vendorOrder,
  },
  {
    code: 'SHOP_ORDER_REMINDER',
    events: ['sub_order.accept_reminded'],
    category: 'orders',
    channels: ['in_app', 'sms'],
    urgent: true,
    recipients: async (e) => [e.payload.sellerId, ...(await staffOf('shop', e.payload.shopId, 'orders.accept'))],
    values: (e) => ({ code: e.payload.code, acceptBy: e.payload.acceptBy }),
    link: vendorOrder,
  },
  {
    code: 'ORDER_ACCEPTED',
    events: ['sub_order.accepted'],
    category: 'orders',
    channels: ['in_app'],
    recipients: (e) => [e.payload.buyerId],
    values: async (e) => ({ code: e.payload.code, shop: (await orderFacts(e.payload.subOrderId)).shopName }),
    link: orderLink,
  },
  {
    code: 'ORDER_REJECTED',
    events: ['sub_order.rejected'],
    category: 'orders',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.buyerId],
    values: async (e, { locale }) => ({ code: e.payload.code, shop: (await orderFacts(e.payload.subOrderId)).shopName, reason: orderReason(e.payload.reason, locale), refund: e.payload.refund }),
    link: orderLink,
  },
  {
    code: 'ORDER_SHIPPED',
    events: ['sub_order.shipped'],
    category: 'orders',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.buyerId],
    values: (e) => ({ code: e.payload.code, courier: e.payload.courier, tracking: e.payload.tracking }),
    link: orderLink,
  },
  {
    code: 'ORDER_DELIVERED',
    events: ['sub_order.delivered'],
    category: 'orders',
    channels: ['in_app'],
    recipients: (e) => [e.payload.buyerId],
    values: (e) => ({ code: e.payload.code }),
    link: orderLink,
  },
  {
    code: 'ORDER_COMPLETED',
    events: ['sub_order.completed'],
    category: 'orders',
    channels: ['in_app'],
    recipients: (e) => [e.payload.sellerId],
    values: (e) => ({ code: e.payload.code, net: e.payload.net }),
    link: vendorOrder,
  },
  {
    code: 'ORDER_CANCELLED',
    events: ['sub_order.cancelled', 'sub_order.expired'],
    category: 'orders',
    channels: ['in_app', 'sms'],
    // An unpaid order that lapsed tells no one (nothing was paid or sent to the shop).
    recipients: (e) => (['payment_not_completed', 'payment_timeout'].includes(e.payload.reason) ? [] : [e.payload.buyerId]),
    values: (e, { locale }) => ({ code: e.payload.code, reason: orderReason(e.payload.reason, locale), refund: e.payload.refund }),
    link: orderLink,
  },
  {
    code: 'SHOP_ORDER_CANCELLED',
    events: ['sub_order.cancelled', 'sub_order.expired'],
    category: 'orders',
    channels: ['in_app'],
    recipients: async (e) => (['payment_not_completed', 'payment_timeout'].includes(e.payload.reason) ? [] : [e.payload.sellerId, ...(await staffOf('shop', e.payload.shopId, 'orders.view'))]),
    values: (e, { locale }) => ({ code: e.payload.code, reason: orderReason(e.payload.reason, locale) }),
    link: vendorOrder,
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
    link: () => vendorUrl(''),
  },
  // ---------------- M20 gym: owners, pass holders, trainers and their members
  // M24-FR-103 (25 Oct 2026): owner and member links point at the gym app (gym.kriraghor.com); the
  // trainer's own links (/pro/subscriptions, /me/payouts) stay on kriraghor.com with Hire.
  {
    code: 'GYM_LIVE',
    events: ['gym.published'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e) => ({ name: (await gymFacts(e.payload.gymId)).name }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/edit`),
  },
  {
    code: 'GYM_CHANGES_REQUESTED',
    events: ['gym.changes_requested'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e, { locale }) => ({ name: (await gymFacts(e.payload.gymId)).name, reason: groundReason(e.payload.reasonCode, locale) }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/edit`),
  },
  {
    code: 'GYM_REJECTED',
    events: ['gym.rejected'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e, { locale }) => ({ name: (await gymFacts(e.payload.gymId)).name, reason: groundReason(e.payload.reasonCode, locale) }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/edit`),
  },
  {
    code: 'GYM_PASS_READY',
    events: ['gym_pass.paid'],
    category: 'bookings',
    channels: ['in_app', 'sms'],
    urgent: true,
    recipients: (e) => [e.payload.holderId],
    values: async (e) => {
      const f = await passFacts(e.payload.passId);
      return { code: e.payload.code, gym: f?.gym ?? '', from: e.payload.validFrom, price: e.payload.price };
    },
    link: (e) => gymUrl(`/me/passes/${e.payload.code}`),
  },
  {
    code: 'GYM_PASS_CANCELLED',
    events: ['gym_pass.cancelled'],
    category: 'bookings',
    channels: ['in_app'],
    recipients: (e) => [e.payload.holderId],
    values: (e) => ({ code: e.payload.code, refund: e.payload.refund }),
    link: () => gymUrl('/me/passes'),
  },
  {
    code: 'TRAINER_SUB_STARTED',
    events: ['trainer_subscription.started'],
    category: 'hire',
    channels: ['in_app'],
    recipients: (e) => [e.payload.memberId],
    values: (e) => ({ code: e.payload.code, from: e.payload.periodStart, to: e.payload.periodEnd }),
    link: () => gymUrl('/me/subscriptions'),
  },
  {
    code: 'TRAINER_NEW_SUBSCRIBER',
    events: ['trainer_subscription.started'],
    category: 'hire',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.trainerId],
    values: (e) => ({ code: e.payload.code, from: e.payload.periodStart, price: e.payload.price }),
    link: () => '/pro/subscriptions',
  },
  {
    code: 'TRAINER_SUB_RENEWAL_DUE',
    events: ['trainer_subscription.renewal_opened'],
    category: 'hire',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.memberId],
    values: (e) => ({ code: e.payload.code, price: e.payload.price, payBy: e.payload.payBy }),
    link: () => gymUrl('/me/subscriptions'),
  },
  {
    code: 'TRAINER_SUB_LAPSED',
    events: ['trainer_subscription.lapsed'],
    category: 'hire',
    channels: ['in_app'],
    recipients: (e) => [e.payload.memberId, e.payload.trainerId],
    values: (e) => ({ code: e.payload.code }),
    // Per recipient: the trainer manages subscribers on their kriraghor.com desk, the member in the gym app.
    link: (e, { userId } = {}) => (userId && userId === e.payload.trainerId ? webUrl('/pro/subscriptions') : gymUrl('/me/subscriptions')),
  },
  {
    code: 'TRAINER_SUB_CANCELLED',
    events: ['trainer_subscription.cancelled'],
    category: 'hire',
    channels: ['in_app'],
    recipients: (e) => [e.payload.trainerId],
    values: (e) => ({ code: e.payload.code, refund: e.payload.refund }),
    link: () => '/pro/subscriptions',
  },
  {
    code: 'TRAINER_SUB_PAID',
    events: ['trainer_subscription.released'],
    category: 'hire',
    channels: ['in_app'],
    recipients: (e) => (e.payload.net > 0 ? [e.payload.trainerId] : []),
    values: (e) => ({ code: e.payload.code, net: e.payload.net }),
    link: () => '/me/payouts',
  },
  // ---------------- M24 gym management, prompt 1 (§11.2): the consent messages, on every tier (no SMS)
  {
    code: 'GYM_LINK_INVITE',
    events: ['gym_link.requested'],
    category: 'gym',
    channels: ['in_app', 'email'],
    // A gym invite to a known account; an invite stored by phone hash is re-published when that phone is verified.
    recipients: (e) => (e.payload.direction === 'gym_invite' && e.payload.userId ? [e.payload.userId] : []),
    values: async (e) => ({ gym: (await gymFacts(e.payload.gymId))?.name ?? '', memberCode: (await gmMemberFacts(e.payload.memberId))?.memberCode ?? '', url: gymUrl('/me/requests') }),
    link: () => gymUrl('/me/requests'),
  },
  {
    code: 'GYM_LINK_ACCEPTED',
    events: ['gym_member.linked'],
    category: 'gym_business',
    channels: ['in_app'],
    // Prompt 3: not when the owner linked the record themselves (accepting a join request for a member already on the books).
    recipients: (e) => (e.payload.by === e.payload.ownerId ? [] : [e.payload.ownerId]),
    values: async (e) => ({ memberCode: (await gmMemberFacts(e.payload.memberId))?.memberCode ?? '' }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/members/${e.payload.memberId}`),
  },
  // ---------------- M24 gym management, prompt 3 (§11.2): join requests and their answers are consent
  // messages (every tier, no SMS); plan notices follow the member-notice rules of kind `plan` (the owner's
  // plan has reminders, not restricted, the kind on) and reach linked members in-app and by push.
  {
    code: 'GYM_JOIN_REQUEST_NEW',
    events: ['gym_link.requested'],
    category: 'gym_business',
    channels: ['in_app'],
    recipients: async (e) => (e.payload.direction === 'join_request' ? [e.payload.ownerId, ...(await staffOf('gym', e.payload.gymId, 'members.view'))] : []),
    values: async (e) => ({ gym: await gymName(e.payload.gymId) }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/requests`),
  },
  {
    code: 'GYM_JOIN_ACCEPTED',
    events: ['gym_link.accepted'],
    category: 'gym',
    channels: ['in_app', 'email'],
    recipients: (e) => (e.payload.direction === 'join_request' && e.payload.userId ? [e.payload.userId] : []),
    values: async (e) => ({ gym: await gymName(e.payload.gymId), link: gymUrl(`/me/memberships/${e.payload.memberId}`) }),
    link: (e) => gymUrl(`/me/memberships/${e.payload.memberId}`),
  },
  {
    code: 'GYM_JOIN_DECLINED',
    events: ['gym_link.declined'],
    category: 'gym',
    channels: ['in_app'],
    recipients: (e) => (e.payload.direction === 'join_request' && e.payload.userId ? [e.payload.userId] : []),
    values: async (e) => ({ gym: await gymName(e.payload.gymId) }),
    link: () => gymUrl('/gyms'),
  },
  {
    code: 'GYM_PLAN_ASSIGNED',
    events: ['gym_plan.assigned'],
    category: 'gym',
    channels: ['in_app'],
    recipients: gmUsers('plan'),
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), planKind: pickLocale(PLAN_KINDS, locale, e.payload.kind), planTitle: (await gmFacts().plan(e.payload.planId))?.title ?? '' }),
    link: (e) => gymUrl(`/me/plans/${e.payload.assignmentId}`),
  },
  {
    code: 'GYM_PLAN_UPDATED',
    events: ['gym_plan.updated'],
    category: 'gym',
    channels: ['in_app'],
    recipients: gmUsers('plan'),
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), planKind: pickLocale(PLAN_KINDS, locale, e.payload.kind) }),
    link: (e) => gymUrl(`/me/plans/${e.payload.assignmentId}`),
  },
  // ---------------- M24 gym management, prompt 2 (§11.2): member notices (paid tiers: in-app, push,
  // email; an unlinked member by email), owner notices, and Kriraghor's own billing. No gym SMS until the
  // add-on (prompt 3b); GYM_INVOICE_OVERDUE and GYM_ACCOUNT_RESTRICTED use the money category (G19).
  {
    code: 'GYM_MEMBERSHIP_STARTED',
    events: ['gym_membership.started', 'gym_membership.renewed'],
    category: 'gym',
    channels: ['in_app', 'email'],
    recipients: gmUsers(null),
    external: gmExternal(null),
    values: async (e, { locale }) => ({
      gym: await gymName(e.payload.gymId),
      package: (await gmFacts().membership(e.payload.membershipId))?.title ?? '',
      startsOn: dayText(e.payload.startsOn, locale),
      endsOn: dayText(e.payload.endsOn, locale),
      link: gymUrl(`/me/memberships/${e.payload.memberId}`),
    }),
    link: (e) => gymUrl(`/me/memberships/${e.payload.memberId}`),
  },
  {
    code: 'GYM_MEMBERSHIP_FROZEN',
    events: ['gym_membership.frozen'],
    category: 'gym',
    channels: ['in_app'],
    recipients: gmUsers(null),
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), fromOn: dayText(e.payload.fromOn, locale), toOn: dayText(e.payload.toOn, locale), endsOn: dayText(e.payload.endsOn, locale) }),
    link: (e) => gymUrl(`/me/memberships/${e.payload.memberId}`),
  },
  {
    code: 'GYM_RENEWAL_DUE',
    events: ['gym_membership.renewal_reminded'],
    category: 'gym',
    channels: ['in_app', 'email'],
    recipients: gmUsers('renewal_due'),
    external: gmExternal('renewal_due'),
    values: async (e, { locale }) => ({
      gym: await gymName(e.payload.gymId),
      endsOn: dayText(e.payload.endsOn, locale),
      link: (await gmFacts().payLinkUrl(e.payload.linkId)) ?? gymUrl(`/me/memberships/${e.payload.memberId}`),
    }),
    link: (e) => gymUrl(`/me/memberships/${e.payload.memberId}`),
  },
  {
    code: 'GYM_MEMBERSHIP_ENDS_TODAY',
    events: ['gym_membership.end_reminded'],
    category: 'gym',
    channels: ['in_app', 'email'],
    recipients: gmUsers('ends_today'),
    external: gmExternal('ends_today'),
    values: async (e) => ({ gym: await gymName(e.payload.gymId), link: gymUrl(`/me/memberships/${e.payload.memberId}`) }),
    link: (e) => gymUrl(`/me/memberships/${e.payload.memberId}`),
  },
  {
    code: 'GYM_FEE_OVERDUE',
    events: ['gym_due.overdue_reminded'],
    category: 'gym',
    channels: ['in_app', 'email'],
    recipients: gmUsers('overdue'),
    external: gmExternal('overdue'),
    values: async (e, { locale }) => ({
      gym: await gymName(e.payload.gymId),
      outstanding: e.payload.outstanding,
      dueOn: dayText(e.payload.dueOn, locale),
      link: (await gmFacts().payLinkUrl(e.payload.linkId)) ?? gymUrl('/me/dues'),
    }),
    link: () => gymUrl('/me/dues'),
  },
  {
    code: 'GYM_MEMBERSHIP_EXPIRED',
    events: ['gym_membership.expiry_reminded'],
    category: 'gym',
    channels: ['in_app'],
    recipients: gmUsers('expired'),
    values: async (e) => ({ gym: await gymName(e.payload.gymId) }),
    link: (e) => gymUrl(`/me/memberships/${e.payload.memberId}`),
  },
  {
    code: 'GYM_FEE_RECEIPT',
    events: ['gym_fee.recorded'],
    category: 'gym',
    channels: ['in_app', 'email'],
    // Opening balances of an import are never announced (M24-FR-78).
    recipients: async (e) => (e.payload.method === 'opening' ? [] : gmUsers('receipt')(e)),
    external: async (e) => (e.payload.method === 'opening' ? [] : gmExternal('receipt')(e)),
    values: async (e) => ({ gym: await gymName(e.payload.gymId), amount: e.payload.amount, receiptNo: e.payload.receiptNo, outstandingAfter: e.payload.outstandingAfter, link: gmFacts().receiptUrl(e.payload.feePaymentId) }),
    link: (e) => gmFacts().receiptUrl(e.payload.feePaymentId),
  },
  {
    code: 'GYM_FEE_REVERSED',
    events: ['gym_fee.reversed'],
    category: 'gym',
    channels: ['in_app', 'email'],
    recipients: gmUsers('receipt'),
    external: gmExternal('receipt'),
    values: async (e) => {
      const r = await gmFacts().reversedReceipt(e.payload.feePaymentId);
      return { gym: await gymName(e.payload.gymId), receiptNo: r?.receiptNo ?? '', link: r?.url ?? gymUrl('/me/receipts') };
    },
    link: (e) => gmFacts().receiptUrl(e.payload.reversesId),
  },
  {
    code: 'GYM_PAY_LINK',
    events: ['gym_payment_link.created'],
    category: 'gym',
    channels: ['in_app', 'email'],
    // Only when the gym chose to send it (an empty list: shown as a QR at the counter, or the member's own link).
    recipients: async (e) => (e.payload.channels.length ? gmUsers('pay_link')(e) : []),
    external: async (e) => (e.payload.channels.length ? gmExternal('pay_link')(e) : []),
    values: async (e) => ({ gym: await gymName(e.payload.gymId), amount: e.payload.amount, link: (await gmFacts().payLinkUrl(e.payload.linkId)) ?? gymUrl('/me/dues') }),
    link: () => gymUrl('/me/dues'),
  },
  {
    code: 'GYM_ONLINE_FEE_PAID',
    events: ['gym_fee.recorded'],
    category: 'gym_business',
    channels: ['in_app'],
    recipients: async (e) => (e.payload.method === 'online' ? gymOwnerAndCollectors(e) : []),
    values: async (e) => ({ memberCode: (await gmMemberFacts(e.payload.memberId))?.memberCode ?? '', amount: e.payload.amount, receiptNo: e.payload.receiptNo }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/members/${e.payload.memberId}`),
  },
  // M27 gym operations, round 1.
  {
    code: 'GYM_STOCK_LOW',
    events: ['gym_stock.low_reached'],
    category: 'gym_business',
    channels: ['in_app'],
    recipients: gymOwnerAnd('stock.manage'),
    values: async (e) => ({ gym: await gymName(e.payload.gymId), product: e.payload.item, left: e.payload.stockQty }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/stock`),
  },
  {
    code: 'GYM_PRODUCT_EXPIRING',
    events: ['gym_product.expiry_warned'],
    category: 'gym_business',
    channels: ['in_app'],
    recipients: gymOwnerAnd('stock.manage'),
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), product: e.payload.item, expiresOn: dayText(e.payload.expiresOn, locale) }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/stock`),
  },
  {
    code: 'GYM_CASH_DIFFERENCE',
    events: ['gym_cash.closed'],
    category: 'gym_business',
    channels: ['in_app'],
    recipients: async (e) => (e.payload.difference === 0 ? [] : [await gymOwnerId(e.payload.gymId)].filter(Boolean)),
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), date: dayText(e.payload.date, locale), difference: e.payload.difference }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/fees/closing?date=${e.payload.date}`),
  },
  // M27 round 2.
  {
    code: 'GYM_CLASS_CANCELLED',
    events: ['gym_class.session_cancelled'],
    category: 'gym',
    channels: ['in_app', 'push', 'email'],
    recipients: async (e) => (await gmMembersReach(e)).userIds,
    external: async (e) => (await gmMembersReach(e)).external,
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), className: (await classOf(e))?.name ?? '', startsAt: timeText(e.payload.startsAt, locale) }),
    link: () => gymUrl('/me/classes'),
  },
  {
    code: 'GYM_CLASS_REMINDER',
    events: ['gym_class.reminded'],
    category: 'gym',
    channels: ['in_app', 'push'],
    recipients: async (e) => (await gmMembersReach(e)).userIds,
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), className: (await classOf(e))?.name ?? '', startsAt: timeText(e.payload.startsAt, locale) }),
    link: () => gymUrl('/me/classes'),
  },
  {
    code: 'GYM_CLASS_PROMOTED',
    events: ['gym_booking.promoted'],
    category: 'gym',
    channels: ['in_app', 'push', 'email'],
    recipients: async (e) => (await gmMemberReach(e)).userIds,
    external: async (e) => (await gmMemberReach(e)).external,
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), className: (await classOf(e))?.name ?? '', startsAt: timeText(e.payload.startsAt, locale) }),
    link: () => gymUrl('/me/classes'),
  },
  {
    code: 'GYM_NOTICE',
    events: ['gym_notice.sent'],
    category: 'gym',
    channels: ['in_app', 'push', 'email'],
    recipients: async (e) => (await require('../gym-ops').notices.targets(e.payload.noticeId)).userIds,
    external: async (e) => (await require('../gym-ops').notices.targets(e.payload.noticeId)).external,
    values: async (e) => {
      const n = await require('../gym-ops').notices.facts(e.payload.noticeId);
      return { gym: await gymName(e.payload.gymId), title: n?.title ?? '', message: n?.body ?? '' };
    },
    link: () => gymUrl('/me'),
  },
  {
    code: 'GYM_LEAD_NEW',
    events: ['gym_lead.received'],
    category: 'gym_business',
    channels: ['in_app', 'push'],
    recipients: async (e) => [e.payload.ownerId, ...(await staffOf('gym', e.payload.gymId, 'leads.manage'))],
    values: async (e) => ({ gym: await gymName(e.payload.gymId) }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/leads`),
  },
  // ---------------- M24 trial visits (9 Nov 2026): free visits before joining. The gym (owner and staff
  // with attendance.mark) hears of each booking and gets the morning list; the guest gets the confirmation
  // and a morning reminder. A cancellation goes to the other side. Free, so never SMS.
  {
    code: 'GYM_VISIT_BOOKED',
    events: ['gym_visit.booked'],
    category: 'gym_business',
    channels: ['in_app', 'push'],
    recipients: gymOwnerAnd('attendance.mark'),
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), guest: await nameOf(e.payload.userId), day: dayText(e.payload.date, locale), time: e.payload.arriveAt }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/desk`),
  },
  {
    code: 'GYM_VISIT_CONFIRMED',
    events: ['gym_visit.booked'],
    category: 'gym',
    channels: ['in_app', 'push', 'email'],
    recipients: (e) => [e.payload.userId],
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), day: dayText(e.payload.date, locale), time: e.payload.arriveAt, link: gymUrl('/me/visits') }),
    link: () => gymUrl('/me/visits'),
  },
  {
    code: 'GYM_VISIT_REMINDER',
    events: ['gym_visit.reminded'],
    category: 'gym',
    channels: ['in_app', 'push'],
    recipients: (e) => [e.payload.userId],
    values: async (e) => ({ gym: await gymName(e.payload.gymId), time: e.payload.arriveAt }),
    link: () => gymUrl('/me/visits'),
  },
  {
    code: 'GYM_GUESTS_TODAY',
    events: ['gym_visits.listed'],
    category: 'gym_business',
    channels: ['in_app', 'push'],
    recipients: gymOwnerAnd('attendance.mark'),
    values: async (e) => ({ gym: await gymName(e.payload.gymId), count: e.payload.count, firstAt: e.payload.firstAt }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/desk`),
  },
  {
    // The guest cancelled: the gym hears.
    code: 'GYM_VISIT_CANCELLED_BY_GUEST',
    events: ['gym_visit.cancelled'],
    category: 'gym_business',
    channels: ['in_app'],
    recipients: async (e) => (e.payload.by === 'guest' ? gymOwnerAnd('attendance.mark')(e) : []),
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), guest: await nameOf(e.payload.userId), day: dayText(e.payload.date, locale), time: e.payload.arriveAt }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/desk`),
  },
  {
    // The gym cancelled: the guest hears.
    code: 'GYM_VISIT_CANCELLED',
    events: ['gym_visit.cancelled'],
    category: 'gym',
    channels: ['in_app', 'push', 'email'],
    recipients: (e) => (e.payload.by === 'gym' ? [e.payload.userId] : []),
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), day: dayText(e.payload.date, locale), time: e.payload.arriveAt }),
    link: () => gymUrl('/me/visits'),
  },
  {
    // M27-FR-85: a machine is due for service (the owner and staff with assets.manage).
    code: 'GYM_ASSET_SERVICE_DUE',
    events: ['gym_asset.service_reminded'],
    category: 'gym_business',
    channels: ['in_app', 'push'],
    recipients: gymOwnerAnd('assets.manage'),
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), item: e.payload.item, dueOn: dayText(e.payload.dueOn, locale) }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/equipment`),
  },
  {
    // M27-FR-81: the staff member's pay for the month was paid; the payslip is ready.
    code: 'GYM_PAYSLIP_READY',
    events: ['gym_payroll_line.paid'],
    category: 'gym_business',
    channels: ['in_app', 'push'],
    recipients: async (e) => [e.payload.userId],
    values: async (e) => ({ gym: await gymName(e.payload.gymId), period: e.payload.period }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/my-work`),
  },
  {
    code: 'GYM_LOCKER_ENDING',
    events: ['gym_locker.end_reminded'],
    category: 'gym',
    channels: ['in_app', 'email'],
    recipients: gmUsers(null),
    external: gmExternal(null),
    values: async (e, { locale }) => ({ gym: await gymName(e.payload.gymId), endsOn: dayText(e.payload.endsOn, locale) }),
    link: (e) => gymUrl(`/me/memberships/${e.payload.memberId}`),
  },
  {
    code: 'GYM_OWNER_MORNING',
    events: ['gym_owner.summary_prepared'],
    category: 'gym_business',
    channels: ['in_app'],
    recipients: gymOwnerAndCollectors,
    values: async (e) => ({ gym: await gymName(e.payload.gymId), expiringToday: e.payload.expiringToday, overdue: e.payload.overdue, notSeen: e.payload.notSeen, requests: e.payload.requestsWaiting }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}`),
  },
  {
    code: 'GYM_OWNER_MONTHLY_REPORT',
    events: ['gym_owner.report_prepared'],
    category: 'gym_business',
    channels: ['in_app', 'email'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e) => ({
      gym: await gymName(e.payload.gymId),
      month: e.payload.month,
      collected: e.payload.collected,
      outstanding: e.payload.outstanding,
      newMembers: e.payload.newMembers,
      left: e.payload.left,
      link: gymUrl(`/manage/${e.payload.gymId}/reports?month=${e.payload.month}`),
    }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/reports?month=${e.payload.month}`),
  },
  {
    code: 'GYM_TIER_LIMIT_NEAR',
    events: ['gym_active_members.counted'],
    category: 'gym_business',
    channels: ['in_app', 'email'],
    recipients: (e) => (e.payload.notice ? [e.payload.ownerId] : []),
    values: (e, { locale }) => ({ count: e.payload.count, tier: pickLocale(TIER_NAMES, locale, e.payload.chosenTier), limit: e.payload.tierLimit ?? 0, link: gymUrl('/manage/billing') }),
    link: () => gymUrl('/manage/billing'),
  },
  {
    code: 'GYM_INVOICE_ISSUED',
    events: ['gym_invoice.issued'],
    category: 'gym_business',
    channels: ['in_app', 'email'],
    recipients: (e) => [e.payload.ownerId],
    values: (e, { locale }) => ({ number: e.payload.number, total: e.payload.total, dueAt: dayText(new Date(new Date(e.payload.dueAt).getTime() - 1 + 6 * 3600000).toISOString(), locale), link: gymUrl(`/manage/billing/invoices/${e.payload.invoiceId}`) }),
    link: (e) => gymUrl(`/manage/billing/invoices/${e.payload.invoiceId}`),
  },
  {
    code: 'GYM_INVOICE_DUE_SOON',
    events: ['gym_invoice.reminded'],
    category: 'gym_business',
    channels: ['in_app', 'email'],
    recipients: (e) => [e.payload.ownerId],
    values: (e, { locale }) => ({ number: e.payload.number, total: e.payload.total, dueAt: dayText(new Date(new Date(e.payload.dueAt).getTime() - 1 + 6 * 3600000).toISOString(), locale), link: gymUrl(`/manage/billing/invoices/${e.payload.invoiceId}`) }),
    link: (e) => gymUrl(`/manage/billing/invoices/${e.payload.invoiceId}`),
  },
  {
    code: 'GYM_INVOICE_OVERDUE',
    events: ['gym_invoice.overdue_marked'],
    category: 'money',
    channels: ['in_app', 'email', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: (e, { locale }) => ({ number: e.payload.number, restrictOn: dayText(e.payload.restrictOn, locale), link: gymUrl(`/manage/billing/invoices/${e.payload.invoiceId}`) }),
    link: (e) => gymUrl(`/manage/billing/invoices/${e.payload.invoiceId}`),
  },
  {
    code: 'GYM_INVOICE_PAID',
    events: ['gym_invoice.paid'],
    category: 'gym_business',
    channels: ['in_app', 'email'],
    recipients: (e) => [e.payload.ownerId],
    values: (e) => ({ number: e.payload.number, link: gymUrl('/manage/billing') }),
    link: () => gymUrl('/manage/billing'),
  },
  {
    code: 'GYM_ACCOUNT_RESTRICTED',
    events: ['gym_subscription.restricted'],
    category: 'money',
    channels: ['in_app', 'email', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: (e) => ({ number: e.payload.number ?? '', link: gymUrl('/manage/billing') }),
    link: () => gymUrl('/manage/billing'),
  },
  {
    code: 'GYM_ACCOUNT_RESTORED',
    events: ['gym_subscription.restored'],
    category: 'gym_business',
    channels: ['in_app'],
    recipients: (e) => [e.payload.ownerId],
    values: () => ({}),
    link: () => gymUrl('/manage'),
  },
  {
    code: 'GYM_FEE_OVERRIDE_SET',
    events: ['gym_fee_override.set'],
    category: 'gym_business',
    channels: ['in_app', 'email'],
    recipients: (e) => [e.payload.ownerId],
    values: (e, { locale }) => ({
      feeName: pickLocale(FEE_NAMES, locale, e.payload.key),
      value: e.payload.key === 'fees.gym_pct' ? `${e.payload.value}%` : formatValue('money', Math.round(e.payload.value), locale),
      validTo: e.payload.validTo ? dayText(new Date(new Date(e.payload.validTo).getTime() + 6 * 3600000).toISOString(), locale) : locale === 'bn' ? 'পরবর্তী নোটিশ' : 'further notice',
      link: gymUrl('/manage/billing'),
    }),
    link: () => gymUrl('/manage/billing'),
  },
  {
    code: 'GYM_IMPORT_READY',
    events: ['gym_import.previewed'],
    category: 'gym_business',
    channels: ['in_app', 'email'],
    // Only a member list Kriraghor staff uploaded with the owner's consent (M24-FR-79).
    recipients: async (e) => {
      const f = await gmFacts().importUpload(e.payload.importId);
      return f?.uploadedAs === 'staff' ? [f.ownerId] : [];
    },
    values: async (e) => ({ gym: await gymName(e.payload.gymId), rowsOk: e.payload.rowsOk, rowsFailed: e.payload.rowsFailed, link: gymUrl(`/manage/${e.payload.gymId}/import`) }),
    link: (e) => gymUrl(`/manage/${e.payload.gymId}/import`),
  },
  // ---------------- M14 lite organisations and M22 organiser SaaS: the organisation's owner and admins
  {
    code: 'ORG_VERIFIED',
    events: ['organisation.verified'],
    category: 'moderation',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e) => ({ name: await orgName(e.payload.organisationId) }),
    // The business home, which opens the organisation in its console (sports or esports).
    link: () => '/vendor',
  },
  {
    code: 'ORG_CHANGES_REQUESTED',
    events: ['organisation.changes_requested'],
    category: 'moderation',
    channels: ['in_app'],
    recipients: (e) => [e.payload.ownerId],
    values: async (e) => ({ name: await orgName(e.payload.organisationId) }),
    link: () => '/account/business?as=organiser',
  },
  {
    code: 'ORG_CONTRACT_ACTIVE',
    events: ['organiser_contract.activated'],
    category: 'tournaments',
    channels: ['in_app', 'email'],
    recipients: (e) => orgAdmins(e.payload.organisationId),
    values: async (e) => ({ name: await orgName(e.payload.organisationId) }),
    link: (e) => `/vendor/esports/${e.payload.organisationId}/billing`,
  },
  {
    code: 'ORG_CONTRACT_SUSPENDED',
    events: ['organiser_contract.suspended'],
    category: 'tournaments',
    channels: ['in_app', 'email'],
    urgent: true,
    recipients: (e) => orgAdmins(e.payload.organisationId),
    values: async (e) => ({ name: await orgName(e.payload.organisationId) }),
    link: (e) => `/vendor/esports/${e.payload.organisationId}/billing`,
  },
  {
    code: 'ORG_CONTRACT_ENDING',
    events: ['organiser_contract.expiry_notified'],
    category: 'tournaments',
    channels: ['in_app', 'email'],
    recipients: (e) => orgAdmins(e.payload.organisationId),
    values: (e) => ({ endsOn: e.payload.endsOn }),
    link: (e) => `/vendor/esports/${e.payload.organisationId}/billing`,
  },
  {
    code: 'ORG_INVOICE_ISSUED',
    events: ['organiser_invoice.issued'],
    category: 'money',
    channels: ['in_app', 'email'],
    recipients: (e) => orgAdmins(e.payload.organisationId),
    values: (e) => ({ number: e.payload.number, total: e.payload.total }),
    link: (e) => `/vendor/esports/${e.payload.organisationId}/billing`,
  },
  {
    code: 'ORG_INVOICE_OVERDUE',
    events: ['organiser_invoice.overdue_flagged'],
    category: 'money',
    channels: ['in_app', 'email', 'sms'],
    urgent: true,
    recipients: (e) => orgAdmins(e.payload.organisationId),
    values: (e) => ({ number: e.payload.number, total: e.payload.total }),
    link: (e) => `/vendor/esports/${e.payload.organisationId}/billing`,
  },
  {
    code: 'ORG_INVOICE_PAID',
    events: ['organiser_invoice.paid'],
    category: 'money',
    channels: ['in_app'],
    recipients: (e) => orgAdmins(e.payload.organisationId),
    values: (e) => ({ number: e.payload.number, total: e.payload.total }),
    link: (e) => `/vendor/esports/${e.payload.organisationId}/billing`,
  },
  {
    code: 'ORG_FUND_RECEIVED',
    events: ['organiser_prize_fund.deposited'],
    category: 'money',
    channels: ['in_app'],
    recipients: (e) => orgAdmins(e.payload.organisationId),
    values: (e) => ({ amount: e.payload.amount, deposited: e.payload.deposited }),
    link: (e) => `/vendor/esports/${e.payload.organisationId}/events/${e.payload.tournamentId}`,
  },
  {
    code: 'ORG_FUND_RETURNED',
    events: ['organiser_prize_fund.returned'],
    category: 'money',
    channels: ['in_app'],
    recipients: (e) => orgAdmins(e.payload.organisationId),
    values: (e) => ({ amount: e.payload.amount }),
    link: (e) => `/vendor/esports/${e.payload.organisationId}/events/${e.payload.tournamentId}`,
  },
  // ---------------- M16 teams: invites (members with an account only; unknown numbers get the captain's link)
  {
    code: 'TEAM_INVITE',
    events: ['team_invite.sent', 'team_invite.linked'],
    category: 'teams',
    channels: ['in_app', 'sms'],
    recipients: (e) => (e.name === 'team_invite.linked' || e.payload.linked ? require('../teams').invites.recipientOf(e.payload.inviteId) : []),
    values: (e) => require('../teams').invites.noticeValues(e.payload.inviteId),
    link: () => '/me/teams',
  },
  {
    code: 'TEAM_INVITE_ACCEPTED',
    events: ['team_invite.accepted'],
    category: 'teams',
    channels: ['in_app'],
    recipients: async (e) => {
      const members = await require('../teams').teams.activeMembers(e.payload.teamId);
      return members.filter((m) => ['captain', 'vice_captain'].includes(m.role) && m.userId !== e.payload.userId).map((m) => m.userId);
    },
    values: async (e) => ({ team: await teamName(e.payload.teamId), name: (await require('../users').directory.publicNames([e.payload.userId])).get(e.payload.userId)?.displayName ?? '' }),
    link: (e) => `/me/teams/${e.payload.teamId}`,
  },
  {
    code: 'TEAM_MEMBER_REMOVED',
    events: ['team_member.removed'],
    category: 'teams',
    channels: ['in_app'],
    recipients: (e) => (e.payload.reasonCode === 'removed' ? [e.payload.userId] : []),
    values: async (e) => ({ team: await teamName(e.payload.teamId) }),
    link: () => '/me/teams',
  },
  {
    code: 'TEAM_CAPTAIN_GIVEN',
    events: ['team.captain_changed'],
    category: 'teams',
    channels: ['in_app'],
    recipients: (e) => [e.payload.toUserId],
    values: async (e) => ({ team: await teamName(e.payload.teamId) }),
    link: (e) => `/me/teams/${e.payload.teamId}`,
  },
  // ---------------- M14 tournaments (physical sports): organisers (admins) and captains (who registered)
  {
    code: 'TOURNAMENT_APPROVED',
    events: ['tournament.approved'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    recipients: (e) => orgAdmins(e.payload.organisationId),
    values: async (e) => ({ tournament: (await tf().tournament(e.payload.tournamentId)).name }),
    link: (e) => `/vendor/events/${e.payload.organisationId}/e/${e.payload.tournamentId}`,
  },
  {
    code: 'TOURNAMENT_CHANGES_REQUESTED',
    events: ['tournament.changes_requested'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    recipients: (e) => orgAdmins(e.payload.organisationId),
    values: async (e) => ({ tournament: (await tf().tournament(e.payload.tournamentId)).name }),
    link: (e) => `/vendor/events/${e.payload.organisationId}/e/${e.payload.tournamentId}`,
  },
  {
    code: 'TOURNAMENT_REJECTED',
    events: ['tournament.rejected'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    recipients: (e) => orgAdmins(e.payload.organisationId),
    values: async (e) => ({ tournament: (await tf().tournament(e.payload.tournamentId)).name }),
    link: (e) => `/vendor/events/${e.payload.organisationId}/e/${e.payload.tournamentId}`,
  },
  {
    code: 'REGISTRATION_SUBMITTED',
    events: ['registration.submitted', 'registration.paid'],
    category: 'tournaments',
    channels: ['in_app'],
    recipients: async (e) => (e.name === 'registration.submitted' && e.payload.status === 'pending_payment' ? [] : orgAdmins((await tf().tournament(e.payload.tournamentId)).organisationId)),
    values: async (e) => {
      const r = await tf().registration(e.payload.registrationId);
      return { team: r.team, tournament: r.tournament };
    },
    link: () => '/vendor/events',
  },
  {
    code: 'REGISTRATION_APPROVED',
    events: ['registration.approved'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.captainId],
    values: async (e) => {
      const r = await tf().registration(e.payload.registrationId);
      return { team: r.team, tournament: r.tournament };
    },
    link: () => '/me/events',
  },
  {
    code: 'REGISTRATION_REJECTED',
    events: ['registration.rejected'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.captainId],
    values: async (e) => {
      const r = await tf().registration(e.payload.registrationId);
      return { team: r.team, tournament: r.tournament, refund: r.refund };
    },
    link: () => '/me/events',
  },
  {
    code: 'RESERVE_OFFERED',
    events: ['registration.promoted'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.captainId],
    values: async (e) => {
      const r = await tf().registration(e.payload.registrationId);
      return { team: r.team, tournament: r.tournament, until: e.payload.offerExpiresAt };
    },
    link: () => '/me/events',
  },
  {
    code: 'TOURNAMENT_CANCELLED',
    events: ['registration.cancelled'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    recipients: (e) => [e.payload.captainId],
    values: async (e) => {
      const r = await tf().registration(e.payload.registrationId);
      return { tournament: r.tournament, refund: r.refund };
    },
    link: () => '/me/events',
  },
  {
    code: 'FIXTURES_PUBLISHED',
    events: ['tournament.fixtures_published'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    recipients: (e) => tf().captains(e.payload.tournamentId),
    values: async (e) => ({ tournament: (await tf().tournament(e.payload.tournamentId)).name }),
    link: () => '/me/events',
  },
  {
    code: 'MATCH_RESCHEDULED',
    events: ['match.rescheduled', 'match.postponed'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    recipients: (e) => tf().matchCaptains(e.payload.matchId),
    values: async (e) => ({ tournament: (await tf().tournament(e.payload.tournamentId)).name, match: e.payload.matchNo }),
    link: () => '/me/events',
  },
  {
    code: 'REGISTRATION_BELOW_MIN',
    events: ['tournament.registration_closed'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    recipients: (e) => (e.payload.belowMin ? orgAdmins(e.payload.organisationId) : []),
    values: async (e) => ({ tournament: (await tf().tournament(e.payload.tournamentId)).name, approved: e.payload.approved }),
    link: (e) => `/vendor/events/${e.payload.organisationId}/e/${e.payload.tournamentId}`,
  },
  {
    code: 'LOTS_NEEDED',
    events: ['tournament.lots_needed'],
    category: 'tournaments',
    channels: ['in_app'],
    recipients: async (e) => orgAdmins((await tf().tournament(e.payload.tournamentId)).organisationId),
    values: async (e) => ({ tournament: (await tf().tournament(e.payload.tournamentId)).name }),
    link: () => '/vendor/events',
  },
  // ---------------- M23 big events: follow alerts (paged; in-app only) and final places
  {
    code: 'ESPORTS_EVENT_STARTED',
    events: ['esports_event.followers_alerted'],
    category: 'event_alerts',
    channels: ['in_app'],
    recipients: followerPage('event_started'),
    values: async (e) => ({ title: await eventTitle(e.payload.eventId) }),
    link: (e) => eventLink(e.payload.eventId),
  },
  {
    code: 'ESPORTS_EVENT_STREAM_LIVE',
    events: ['esports_event.followers_alerted'],
    category: 'event_alerts',
    channels: ['in_app'],
    recipients: followerPage('stream_live'),
    values: async (e) => ({ title: await eventTitle(e.payload.eventId) }),
    link: (e) => eventLink(e.payload.eventId),
  },
  {
    code: 'ESPORTS_EVENT_FINAL_SOON',
    events: ['esports_event.followers_alerted'],
    category: 'event_alerts',
    channels: ['in_app'],
    recipients: followerPage('final_soon'),
    values: async (e) => ({ title: await eventTitle(e.payload.eventId) }),
    link: (e) => eventLink(e.payload.eventId),
  },
  {
    code: 'ESPORTS_EVENT_QUALIFIED',
    events: ['esports_event_qualification.granted'],
    category: 'tournaments',
    channels: ['in_app', 'sms'],
    recipients: (e) => require('../esports-events').qualifications.recipientsOf(e.payload.qualificationId),
    values: async (e) => ({ title: await eventTitle(e.payload.eventId) }),
    link: (e) => eventLink(e.payload.eventId),
  },
  {
    code: 'ESPORTS_EVENT_QUALIFICATION_REVOKED',
    events: ['esports_event_qualification.revoked'],
    category: 'tournaments',
    channels: ['in_app'],
    recipients: (e) => require('../esports-events').qualifications.recipientsOf(e.payload.qualificationId),
    values: async (e) => ({ title: await eventTitle(e.payload.eventId) }),
    link: (e) => eventLink(e.payload.eventId),
  },
  {
    code: 'ESPORTS_EVENT_QUALIFICATION_MISSED',
    events: ['esports_event_qualification.missed'],
    category: 'staff_ops',
    channels: ['in_app'],
    recipients: () => require('../users').directory.withPermission('manage_esports'),
    values: async (e) => ({ title: await eventTitle(e.payload.eventId) }),
    link: (e) => `/admin/esports/showcases?id=${e.payload.eventId}`,
  },
];

const byCode = new Map(CATALOGUE.map((c) => [c.code, c]));

module.exports = { CATALOGUE, byCode, roleLabel, gymUrl };
