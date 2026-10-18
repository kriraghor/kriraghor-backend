'use strict';

/**
 * M23 → M21: the entry-policy hooks (invite-only finals) and the consumers of M21's outbox events.
 * Loaded once per process (subscriptions.registerAll) and by the M23 routes.
 */
const { onEvent } = require('../events/events.consumers');
const { registerEntryPolicy } = require('../esports/esports.common');
const qualifications = require('./qualifications.service');

registerEntryPolicy({ entryBlock: qualifications.entryBlock, onEntered: qualifications.onEntered });

function registerEsportsEventConsumers() {
  onEvent('esports_tournament.finalised', 'esports_events.qualify', (e, { transaction }) => qualifications.onFinalised(e.payload.tournamentId, { transaction }));
  onEvent('esports_tournament.cancelled', 'esports_events.tournament-cancelled', (e, { transaction }) => qualifications.onCancelled(e.payload.tournamentId, { transaction }));
  onEvent('esports_registration.disqualified', 'esports_events.revoke-disqualified', (e, { transaction }) => qualifications.onDisqualified(e.payload.registrationId, { transaction }));
  for (const name of ['esports_registration.withdrawn', 'esports_registration.cancelled', 'esports_registration.refunded']) {
    onEvent(name, `esports_events.reopen-${name.split('.')[1]}`, (e, { transaction }) => qualifications.onEntryClosed(e.payload.registrationId, { transaction }));
  }
  onEvent('esports_stream.live_started', 'esports_events.stream-live', (e, { transaction }) => require('./events.service').onTournamentStreamLive(e.payload, { transaction }));
}

module.exports = { registerEsportsEventConsumers };
