'use strict';

/**
 * M02 consent (M02-FR-05, product owner 25 Oct 2026; Bangladesh Personal Data Protection Ordinance
 * 2025: explicit, specific, freely given consent for sensitive data). Nobody submits an NID or a
 * business document without ticking a box that showed the current text.
 *
 * The texts live in the shipped reference JSON (kyc-requirements.v1.json `consent`), read once here and
 * never copied into the database: the requirements seeder is insert-only, so a database copy would never
 * change. One version covers two texts (the NID text and the business text); a wording change is a code
 * change with a new version, tracked in git. {retentionDays} (FR-17) and {minAge} (§6.3 age_ok) are
 * filled from the settings at read time.
 */
const seed = require('../../db/seed/reference/kyc-requirements.v1.json');
const settings = require('../settings').settings;
const rules = require('./kyc.rules');

const CONSENT = seed.consent;
if (!CONSENT || !Number.isInteger(CONSENT.version) || !CONSENT.nid?.en || !CONSENT.nid?.bn || !CONSENT.business?.en || !CONSENT.business?.bn) {
  throw new Error('kyc-requirements.v1.json has no valid consent object');
}

/** { version, draft } of the consent the forms show today. */
const current = () => ({ version: CONSENT.version, draft: Boolean(CONSENT.draft) });

/** The text for the NID form ('nid') or a business document form ('business'), placeholders filled. */
function textFor(kind, locale = 'en') {
  const texts = kind === 'nid' ? CONSENT.nid : CONSENT.business;
  const bn = locale === 'bn';
  const vars = { retentionDays: settings.get('kyc.raw_image_retention_days'), minAge: settings.get('kyc.min_age_years') };
  return rules.fillText(bn ? texts.bn : texts.en, vars, { bn });
}

/** null, CONSENT_REQUIRED or CONSENT_VERSION_STALE for the `consent` a client sent (kyc.rules.consentBlock). */
const check = (consent) => rules.consentBlock(consent, CONSENT.version);

module.exports = { current, textFor, check };
