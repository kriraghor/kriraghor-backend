'use strict';

/**
 * M24 invariants (§7.2), registered with the M06 invariants runner (nightly, and the gym-manage
 * reconcile job): a due's paid amount is the sum of its payment rows; a due's status matches §6.2; a
 * released online fee has a matching M06 release. Read-only; any failure is reported by M06
 * (ledger.invariant_failed) and logged by the reconcile job.
 */
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');

/** Dues whose paid_poisha differs from Σ gym_fee_payments (reversals negative). */
async function duesPaidMismatch() {
  return sequelize.query(
    `SELECT d.id FROM gym_dues d LEFT JOIN (SELECT due_id, SUM(amount_poisha) AS s FROM gym_fee_payments GROUP BY due_id) p ON p.due_id = d.id
      WHERE d.paid_poisha <> COALESCE(p.s, 0) LIMIT 20`,
    { type: QueryTypes.SELECT }
  );
}

/** Dues (not void) whose status is not what §6.2 says for their amounts. */
async function duesStatusMismatch() {
  return sequelize.query(
    `SELECT id FROM gym_dues WHERE status <> 'void' AND status <> CASE
       WHEN amount_poisha - paid_poisha - waived_poisha <= 0 AND paid_poisha > 0 THEN 'paid'
       WHEN amount_poisha - paid_poisha - waived_poisha <= 0 THEN 'waived'
       WHEN paid_poisha > 0 THEN 'partial' ELSE 'unpaid' END LIMIT 20`,
    { type: QueryTypes.SELECT }
  );
}

const CHECKS = {
  gym_dues_paid_match: async () => {
    const rows = await duesPaidMismatch();
    return { ok: rows.length === 0, detail: rows.length ? `Dues out of line: ${rows.map((r) => r.id).join(', ')}` : null };
  },
  gym_dues_status_match: async () => {
    const rows = await duesStatusMismatch();
    return { ok: rows.length === 0, detail: rows.length ? `Due status out of line: ${rows.map((r) => r.id).join(', ')}` : null };
  },
  gym_fee_released_has_release: async () => {
    const bad = await require('./links-pay.service').releasedWithoutRelease();
    return { ok: bad.length === 0, detail: bad.length ? `Released without an M06 release: ${bad.join(', ')}` : null };
  },
};

function registerInvariants() {
  const inv = require('../payments').invariants;
  for (const [name, fn] of Object.entries(CHECKS)) inv.register(name, fn);
}

/** Job gym-manage.reconcile (04:00): run the M24 checks and log any drift (FR-108: ids only). */
async function reconcile() {
  const logger = require('../../common/logger');
  const out = {};
  for (const [name, fn] of Object.entries(CHECKS)) {
    const r = await fn();
    out[name] = r.ok;
    if (!r.ok) logger.error({ check: name, detail: r.detail }, 'gym-manage invariant failed');
  }
  return out;
}

module.exports = { CHECKS, registerInvariants, reconcile };
