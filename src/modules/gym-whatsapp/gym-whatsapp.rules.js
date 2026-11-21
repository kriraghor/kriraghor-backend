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

module.exports = { E164, CONSENTS, chatNumber, numberSource, waDigits, last4, currentConsent, consentChanged };
