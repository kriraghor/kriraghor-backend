'use strict';

/**
 * M18 event consumers (§2.3). Events only say whose account to look at again: each schedules the
 * debounced evaluation (rules and reliability) for the users it names. The evaluation reads the facts
 * through the owning services, so a late, duplicated or replayed event changes nothing by itself.
 *   document.duplicate_nid_detected (M02)    accounts_per_nid
 *   payout_account.added / .verified (M07)   payout_account_change, shared_payout_account
 *   dispute.resolved (M17)                   dispute_loss_rate, owner reliability (the respondent)
 *   report.resolved (M17)                    reports_upheld (the subject's owner)
 *   booking.* (M10)                          refund_rate, owner and booker reliability
 *   esports_registration.disqualified, esports_game_profile.banned (M21)
 *   document_request.overdue_marked (M02)    the flag it was made for goes up one level (FR-07)
 *   setting.changed for risk.* / trust.*     re-evaluate everyone with flags or metrics (FR-03)
 */
const { onEvent } = require('../events/events.consumers');

const later = (...ids) => {
  const jobs = require('./risk.jobs');
  for (const id of new Set(ids.filter(Boolean))) jobs.scheduleEvaluation(id);
  return null;
};

function registerRiskConsumers() {
  onEvent('document.duplicate_nid_detected', 'risk.nid', (e) => later(e.payload.userId));
  for (const name of ['payout_account.added', 'payout_account.verified']) onEvent(name, `risk.${name.split('.')[1]}-account`, (e) => later(e.payload.userId));
  onEvent('dispute.resolved', 'risk.dispute', (e) => later(e.payload.respondentId, e.payload.claimantId));
  onEvent('report.resolved', 'risk.report', (e) => later(e.payload.subjectOwnerId));
  for (const name of ['booking.owner_cancelled', 'booking.cancelled', 'booking.no_show_marked', 'booking.completed', 'booking.check_in_recorded', 'booking.dispute_settled']) {
    onEvent(name, `risk.${name.replace('.', '-')}`, (e) => later(e.payload.ownerId, e.payload.bookerUserId));
  }
  onEvent('esports_registration.disqualified', 'risk.esports-dq', (e) => later(e.payload.registrantUserId));
  onEvent('esports_game_profile.banned', 'risk.esports-ban', (e) => later(e.payload.userId));
  onEvent('document_request.overdue_marked', 'risk.doc-overdue', (e, { transaction }) => (e.payload.sourceRef ? require('./flags.service').escalateForOverdue(e.payload.sourceRef, { transaction }) : null));
  onEvent('setting.changed', 'risk.threshold', (e) => (/^(risk|trust)\./.test(e.payload.key) ? require('./risk.jobs').scheduleReevaluation(e.payload.key) : null));
}

module.exports = { registerRiskConsumers };
