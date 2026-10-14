'use strict';

const person = (id, names) => (id ? { id, displayName: names.get(id) ?? null } : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Admin view of one setting (definition + current value). */
function serializeSetting(e) {
  return {
    key: e.key,
    category: e.category,
    value: e.value,
    valueType: e.valueType,
    unit: e.unit,
    min: e.minValue,
    max: e.maxValue,
    options: e.enumOptions ?? null,
    approval: e.approval,
    isPublic: e.isPublic,
    label: { en: e.labelEn, bn: e.labelBn },
    why: e.whyEn || e.whyBn ? { en: e.whyEn, bn: e.whyBn } : null,
    version: e.version,
    updatedBy: e.updatedBy,
    updatedAt: iso(e.updatedAt),
  };
}

function serializeHistory(row, names) {
  return {
    version: row.version,
    oldValue: row.oldValue,
    newValue: row.newValue,
    effectiveAt: iso(row.effectiveAt),
    requestId: row.requestId,
    changedBy: person(row.changedBy, names),
    approvedBy: person(row.approvedBy, names),
    reason: row.reason,
  };
}

function serializeRequest(row, names = new Map()) {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    changes: row.changes,
    projection: row.projection ?? null,
    reason: row.reason,
    effectiveAt: iso(row.effectiveAt),
    needsFourEyes: row.needsFourEyes,
    needsSecondApprover: row.needsFourEyes && row.status === 'proposed',
    proposedBy: person(row.proposedBy, names),
    approvedBy: person(row.approvedBy, names),
    decidedBy: person(row.decidedBy, names),
    decidedAt: iso(row.decidedAt),
    decisionNote: row.decisionNote ?? null,
    appliedAt: iso(row.appliedAt),
    createdAt: iso(row.createdAt),
  };
}

module.exports = { serializeSetting, serializeHistory, serializeRequest };
