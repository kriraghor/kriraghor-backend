'use strict';

/**
 * The esports module's public interface (ADR-007 §3): other modules use only this file; everything
 * else in esports is internal (tests/unit/boundaries.test.js). Each facade lists exactly what other
 * modules call. Functions delegate lazily, so requiring the index never changes load order and cannot
 * create a require cycle at load time.
 */
const lazy = (file, names, values = []) => {
  const out = Object.fromEntries(names.map((n) => [n, (...args) => require(file)[n](...args)]));
  for (const v of values) Object.defineProperty(out, v, { enumerable: true, get: () => require(file)[v] });
  return Object.freeze(out);
};

module.exports = {
  tournaments: lazy('./tournaments.service', ['adminDetail', 'cancel', 'createDraft', 'list', 'submit', 'update']),
  common: lazy('./esports.common', ['registerEntryPolicy', 'registerOrganiser']),
  disputes: lazy('./esports.disputes', ['register']),
  facts: lazy('./esports.facts', ['allEntrants', 'confirmedPlayers', 'entryFact', 'entryPeople', 'matchPlayers', 'riskFacts', 'squadName', 'title', 'tournament', 'tournamentFact']),
  reads: lazy('./esports.reads', ['entryLabels', 'pendingActions', 'hasAnyVerifiedProfile', 'hasVerifiedProfile', 'squadFacts', 'standingsWithEntries', 'streamsOf', 'tournamentSummary']),
  schemas: lazy('./esports.schemas', [], ['cancelBody', 'resultRow', 'resultsBody', 'roomBody', 'rotateBody', 'tournamentBody', 'tournamentPatch']),
  prizes: lazy('./prizes.service', ['finalise', 'preview']),
  registrations: lazy('./registrations.service', ['board']),
  results: lazy('./results.service', ['adminMatch', 'enter', 'post']),
  rooms: lazy('./rooms.service', ['panel', 'rotate', 'setRoom']),
  streamsRules: lazy('./streams.rules', ['embedFor', 'parseStream']),
};
