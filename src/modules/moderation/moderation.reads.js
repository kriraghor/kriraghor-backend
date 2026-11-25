'use strict';

/**
 * Reads other modules use for figures about reviewing (M19-FR-32, FR-33; M19 §6.4). Moderation keeps
 * its tables; M19 builds its own review facts from the decision events and asks here only for what the
 * events do not carry: which kinds a staff member may review, the reason labels, and the decided rows
 * once for the backfill.
 */
const { Op } = require('sequelize');
const { Submission, RejectionReason } = require('../../models');
const adapters = require('./moderation.adapters');

const DECIDED = ['approved', 'changes_requested', 'rejected'];

/** The kinds this staff member may review (masters: every kind). */
const reviewKinds = (principal) => adapters.permittedKinds(principal);

/** `{ code, labelEn, labelBn }` for each code given (unknown codes are left out). */
async function reasonLabels(codes) {
  const list = [...new Set((codes ?? []).filter(Boolean))];
  if (!list.length) return [];
  const rows = await RejectionReason.findAll({ where: { code: list }, attributes: ['code', 'labelEn', 'labelBn'] });
  return rows.map((r) => ({ code: r.code, labelEn: r.labelEn, labelBn: r.labelBn }));
}

/**
 * The decided submissions as they stand, oldest decision first, a page at a time (`after` is the last
 * row's `{ decidedAt, id }`). Used once by M19's backfill; a decision a master later reopened is no
 * longer on the row and cannot be returned.
 */
async function decisions({ after = null, limit = 500 } = {}) {
  const where = { status: DECIDED, decidedAt: { [Op.ne]: null }, decidedBy: { [Op.ne]: null } };
  if (after) {
    where[Op.or] = [{ decidedAt: { [Op.gt]: after.decidedAt } }, { decidedAt: after.decidedAt, id: { [Op.gt]: after.id } }];
  }
  const rows = await Submission.findAll({
    where,
    attributes: ['id', 'kind', 'status', 'reasonCode', 'decidedBy', 'submittedAt', 'decidedAt'],
    order: [
      ['decidedAt', 'ASC'],
      ['id', 'ASC'],
    ],
    limit,
  });
  return rows.map((s) => ({
    submissionId: s.id,
    kind: s.kind,
    decision: s.status,
    reasonCode: s.status === 'approved' ? null : s.reasonCode,
    decidedBy: s.decidedBy,
    submittedAt: s.submittedAt,
    decidedAt: s.decidedAt,
    cursor: { decidedAt: s.decidedAt, id: s.id },
  }));
}

module.exports = { reviewKinds, reasonLabels, decisions, DECIDED };
