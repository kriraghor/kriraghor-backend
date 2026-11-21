'use strict';

/**
 * M24 §25 WhatsApp: the pure rules (no I/O), 100% branch-tested in tests/unit/gym-whatsapp-rules.test.js.
 */

/** A Bangladesh mobile in E.164 (+8801[3-9]XXXXXXXX), the only form stored. */
const E164 = /^\+8801[3-9]\d{8}$/;

/** The consent kinds (M24-FR-159): what a member agreed to receive on WhatsApp. */
const CONSENTS = Object.freeze(['service', 'news']);

/**
 * M24-FR-157, FR-158: the number a branch's gym page shows, or null. The branch's own number wins over the
 * owner's number for every branch; a branch that switched the button off shows nothing.
 */
function chatNumber({ gymNumber = null, ownerNumber = null, showOnPage = true } = {}) {
  if (!showOnPage) return null;
  return gymNumber || ownerNumber || null;
}

/** Which number a branch uses: its own, the owner's, or none (the panel's label). */
function numberSource({ gymNumber = null, ownerNumber = null } = {}) {
  if (gymNumber) return 'own';
  return ownerNumber ? 'owner' : 'none';
}

/** The digits wa.me needs: +8801712345678 → 8801712345678 (null for anything that is not a stored number). */
function waDigits(e164) {
  return typeof e164 === 'string' && E164.test(e164) ? e164.slice(1) : null;
}

/** The last 4 digits shown instead of a member's number. */
const last4 = (e164) => e164.slice(-4);

/**
 * M24-FR-160: the current consent of a member from their consent rows (newest first), or the "nothing
 * agreed" default. A member who never answered has agreed to nothing.
 */
function currentConsent(rows) {
  const r = rows?.[0];
  if (!r) return { service: false, news: false, source: null, at: null, numberLast4: null, consentVersion: null };
  return { service: Boolean(r.service), news: Boolean(r.news), source: r.source, at: r.createdAt ?? null, numberLast4: r.numberLast4, consentVersion: r.consentVersion };
}

/**
 * Is a new consent row needed? Only when something changed: the number, either consent, or the consent
 * text's version (a member re-agreeing to a newer text is recorded).
 */
function consentChanged(current, next) {
  if (!current) return true;
  return current.numberHash !== next.numberHash || current.service !== next.service || current.news !== next.news || current.consentVersion !== next.consentVersion;
}

// ---------------------------------------------------------------- step 2: sending (M24-FR-161 to FR-170)

/** The consent a category needs: utility → receipts and reminders (`service`), marketing → news and offers. */
const consentFor = (category) => (category === 'marketing' ? 'news' : 'service');

/**
 * Why one member cannot get a message now, or null (M24-FR-164): no consent for its category (or none
 * given), the branch has no connected number, or the template is not approved in the member's language.
 */
function memberBlock({ consent, category, senderConnected, templateApproved }) {
  if (!senderConnected) return 'no_sender';
  if (!templateApproved) return 'template';
  if (!consent || !consent[consentFor(category)]) return 'no_consent';
  return null;
}

const DHAKA_OFFSET_MIN = 6 * 60; // Asia/Dhaka has no daylight saving
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/**
 * M24-FR-168: when a message may go out. Utility messages (receipts, reminders) go now; marketing waits
 * out the platform's quiet hours (notify.quiet_hours_start to _end, Dhaka, may wrap midnight).
 */
function sendAfter({ now = new Date(), category, quietStart, quietEnd }) {
  if (category !== 'marketing') return now;
  const local = new Date(now.getTime() + DHAKA_OFFSET_MIN * 60000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const start = toMinutes(quietStart);
  const end = toMinutes(quietEnd);
  const inQuiet = start > end ? minute >= start || minute < end : minute >= start && minute < end;
  if (!inQuiet) return now;
  const endLocal = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Math.floor(end / 60), end % 60));
  if (endLocal.getTime() <= local.getTime()) endLocal.setUTCDate(endLocal.getUTCDate() + 1);
  return new Date(endLocal.getTime() - DHAKA_OFFSET_MIN * 60000);
}

/** M24-FR-169: a reply that opts the member out of everything (English or Bangla, any case, spaces). */
const STOP_WORDS = Object.freeze(['stop', 'unsubscribe', 'বন্ধ', 'বন্ধ করুন']);
const isStop = (text) => typeof text === 'string' && STOP_WORDS.includes(text.trim().toLowerCase());

/** Meta's status order: a later webhook never moves a message back (read after delivered, delivered after sent). */
const STATUS_RANK = Object.freeze({ queued: 0, sending: 1, sent: 2, delivered: 3, read: 4, failed: 5, expired: 5 });
/** Does a status from Meta move this message forward? failed only before delivery. */
function advances(current, next) {
  if (!(next in STATUS_RANK) || !(current in STATUS_RANK)) return false;
  if (next === 'failed') return STATUS_RANK[current] < STATUS_RANK.delivered;
  if (current === 'failed' || current === 'expired') return false;
  return STATUS_RANK[next] > STATUS_RANK[current];
}

/** The daily cap on bulk sends per branch (M24-FR-167): how many are left today. */
const bulkLeft = ({ cap, sentToday }) => Math.max(0, cap - sentToday);

module.exports = { E164, CONSENTS, chatNumber, numberSource, waDigits, last4, currentConsent, consentChanged, consentFor, memberBlock, sendAfter, isStop, STATUS_RANK, advances, bulkLeft };
