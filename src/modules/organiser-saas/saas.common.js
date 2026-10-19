'use strict';

/** Shared bits of M22: the error catalogue (spec §9 codes), settings read per call, events and dates. */
const { AppError } = require('../../common/errors');
const events = require('../events').events;
const settings = require('../settings').settings;

const ERRORS = {
  ORG_NOT_VERIFIED: [409, 'The organisation must be verified first'],
  ORG_SUSPENDED: [409, 'The organisation is suspended. Contact Kriraghor support'],
  ORG_CONTRACT_REQUIRED: [409, 'The organisation needs an active esports contract with Kriraghor'],
  ORG_CONTRACT_SUSPENDED: [409, 'The organisation\'s contract is suspended'],
  CONTRACT_STATE: [409, 'The contract cannot do that in its current state'],
  CONTRACT_ACTIVE_EXISTS: [409, 'The organisation already has an active contract'],
  CONTRACT_DOCUMENT_REQUIRED: [409, 'Upload the signed contract first'],
  CONTRACT_FIELDS_INVALID: [422, 'A percentage contract takes a percent; a flat contract takes a fee and a monthly or quarterly cycle'],
  PRIZE_FUND_REQUIRED: [409, 'Fund the prize pool before sending the event for review'],
  PRIZE_FUND_AMOUNT_MISMATCH: [409, 'The deposit is more than the prize pool. Raise the prizes, or cancel the draft to get the fund back'],
  PRIZE_FUND_LOCKED: [409, 'The prize fund is already paid for this event'],
  PRIZE_FUND_SHRINK: [409, 'The prize pool cannot be smaller than what is already deposited. Cancel the draft to get the fund back'],
  INVOICE_OVERDUE: [409, 'An invoice is overdue. Pay it before sending new events'],
  INVOICE_STATE: [409, 'The invoice cannot do that in its current state'],
  SUBDOMAIN_INVALID: [422, 'Use 3 to 30 letters, digits or dashes (not at the start or end)'],
  SUBDOMAIN_RESERVED: [422, 'This subdomain is reserved'],
  SUBDOMAIN_TAKEN: [409, 'Another organisation already uses this subdomain'],
  BRAND_PRIMARY_CONTRAST: [422, 'The primary colour is too light for white text (WCAG AA 4.5:1)'],
  BRAND_ACCENT_CONTRAST: [422, 'The accent colour is too dark to read on the dark page (WCAG AA 4.5:1)'],
  FILE_EMPTY: [422, 'The file is empty'],
  FILE_TOO_LARGE: [413, 'The file is too large'],
  FILE_TYPE_NOT_ALLOWED: [415, 'Upload a JPEG, PNG or WebP image (or a PDF for the contract)'],
  FILE_TYPE_MISMATCH: [415, 'The file is not the type it says it is'],
  ORG_TOURNAMENT_STATE: [409, 'Organisers can cancel only drafts and events in review; ask Kriraghor to cancel a published one'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

const config = () => ({
  feePct: settings.get('fees.esports_saas_pct'),
  dueDays: settings.get('saas.invoice_due_days'),
  graceDays: settings.get('saas.overdue_grace_days'),
  reserved: settings.get('saas.subdomain_reserved'),
  vatEnabled: settings.get('saas.vat_enabled'),
  vatPct: settings.get('saas.vat_pct'),
  noticeDays: settings.get('saas.contract_expiry_notice_days'),
});

const publish = (transaction, name, aggregateType, aggregateId, payload, actor = null) => events.publish(transaction, { name, aggregateType, aggregateId, payload, actor });

const DHAKA_MS = 6 * 3600000;
const today = (now = new Date()) => new Date(now.getTime() + DHAKA_MS).toISOString().slice(0, 10);
const iso = (d) => (d ? new Date(d).toISOString() : null);

module.exports = { ERRORS, fail, config, publish, today, iso };
