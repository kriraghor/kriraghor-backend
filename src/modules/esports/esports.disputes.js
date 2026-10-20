'use strict';

/**
 * M21's side of the M17 targets port (source 'esports_result', the esports_result_disputes row id).
 * Players open these from the match page (POST /me/esports/matches/:id/disputes), which checks the
 * window and the per-entry limit and opens the M17 case in the same transaction. There is no money to
 * freeze: an open dispute already keeps the match from becoming final and the tournament from paying
 * out (ESPORTS_NOT_FINALISABLE). The decision is rejected or corrected (with the corrected rows).
 */
const { fail } = require('../trust').errors;

const snapshot = async () => {
  throw fail('DISPUTE_NOT_ELIGIBLE'); // opened from the match page only
};
const options = async () => [];
const freeze = async () => {};
const unfreeze = async () => {};

async function applyOutcome({ sourceId, dispute, outcome, rows, actor, transaction }) {
  await require('./results.service').resolveInTx(actor, sourceId, { outcome, rows, note: dispute.decisionReason ?? dispute.code }, { transaction });
  return { refunded: 0, released: 0, fee: 0 };
}

/** The player withdrew the case: the M21 row closes as rejected so the match can become final. */
async function withdrawn({ sourceId, actor, transaction }) {
  await require('./results.service').resolveInTx(actor, sourceId, { outcome: 'rejected', note: 'Withdrawn by the player' }, { transaction });
}

const describe = (sourceId) => require('./results.service').disputeSummary(sourceId);

function register() {
  require('../trust').targetsPort.register('esports_result', { permission: 'manage_esports', snapshot, options, freeze, unfreeze, applyOutcome, withdrawn, describe });
}

module.exports = { register };
