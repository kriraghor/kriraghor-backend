'use strict';

/**
 * M22 → M21: the organiser hooks M21 calls for organiser tournaments (esports.common.registerOrganiser).
 * Loaded once per process (registry.registerAll) and by the M22 routes.
 */
const { registerOrganiser } = require('../esports').common;
const organisations = require('../organisations').organisations;
const contracts = require('./contracts.service');
const invoices = require('./invoices.service');
const funds = require('./prize-funds.service');
const rules = require('./saas.rules');
const c = require('./saas.common');

/** FR-01, FR-05, FR-09, FR-13: a verified (not suspended) organisation, an active contract, no invoice overdue past grace, a funded pool. */
async function submitBlock(t, { transaction }) {
  const status = await organisations.statusOf(t.organisationId, { transaction });
  if (status !== 'verified') throw c.fail(status === 'suspended' ? 'ORG_SUSPENDED' : 'ORG_NOT_VERIFIED');
  const block = rules.contractBlock(await contracts.currentFor(t.organisationId, { transaction }), c.today());
  if (block) throw c.fail(block);
  if (await invoices.publishBlocked(t.organisationId, { transaction })) throw c.fail('INVOICE_OVERDUE');
  const fundBlock = await funds.blockFor(t, { transaction });
  if (fundBlock) throw c.fail(fundBlock);
}

/** FR-06: the fee model and rate are snapshotted on the tournament when it is published. */
async function onPublished(t, { transaction }) {
  const k = await contracts.currentFor(t.organisationId, { transaction });
  const model = k?.model ?? 'percentage';
  const bps = rules.feeBpsFor(k ?? { model: 'percentage', pct: null }, c.config().feePct);
  await t.update({ saasFeeModel: model, saasFeeBps: bps, contractId: k?.id ?? null }, { transaction });
}

function registerSaasHooks() {
  registerOrganiser({
    submitBlock,
    onPublished,
    onDraftChanged: funds.onDraftChanged,
    onCancelled: funds.onCancelled,
    settle: funds.settle,
    reverse: funds.reverse,
    isMember: (userIds, organisationId) => organisations.isMember(userIds, organisationId),
  });
}
registerSaasHooks();

module.exports = { registerSaasHooks, submitBlock, onPublished };
