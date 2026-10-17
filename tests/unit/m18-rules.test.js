'use strict';

// M18 rules (100% branch gate): severities and the risk level, metrics and rates, the flag machine with
// the clear snooze and re-breach test (FR-05, FR-08), lapsing, action authority and undo (FR-09, Q100,
// Q101), and reliability with the spec's 96% example and the sample gate (§6.3, Q102).
const r = require('../../src/modules/risk/risk.rules');

const T0 = new Date('2026-10-20T10:00:00Z');
const D = 24 * 3600 * 1000;
const at = (days) => new Date(T0.getTime() + days * D);

describe('M18 severities and the risk level', () => {
  it('takes the highest open or actioned flag', () => {
    expect(r.riskLevel([])).toBe('none');
    expect(r.riskLevel([{ status: 'open', severity: 'medium' }, { status: 'actioned', severity: 'high' }, { status: 'cleared', severity: 'critical' }])).toBe('high');
    expect(r.riskLevel([{ status: 'lapsed', severity: 'critical' }])).toBe('none');
    expect(r.riskLevel([{ status: 'open', severity: 'info' }])).toBe('info');
  });
  it('raises one level, capped at critical; alerts from high', () => {
    expect(r.raised('info')).toBe('medium');
    expect(r.raised('high')).toBe('critical');
    expect(r.raised('critical')).toBe('critical');
    expect(r.alerts('high')).toBe(true);
    expect(r.alerts('critical')).toBe(true);
    expect(r.alerts('medium')).toBe(false);
  });
});

describe('M18 metrics', () => {
  it('compares with gte or gt', () => {
    expect(r.breached({ comparator: 'gte', value: 3, threshold: 3 })).toBe(true);
    expect(r.breached({ comparator: 'gte', value: 2, threshold: 3 })).toBe(false);
    expect(r.breached({ comparator: 'gt', value: 1, threshold: 1 })).toBe(false); // one account per NID is fine
    expect(r.breached({ comparator: 'gt', value: 2, threshold: 1 })).toBe(true);
  });
  it('gives a percentage only from the minimum sample', () => {
    expect(r.rate({ part: 2, whole: 10, minSample: 10 })).toBe(20);
    expect(r.rate({ part: 1, whole: 3, minSample: 3 })).toBe(33.33);
    expect(r.rate({ part: 2, whole: 9, minSample: 10 })).toBeNull();
    expect(r.rate({ part: 0, whole: 0, minSample: 0 })).toBeNull();
  });
});

describe('M18 flag machine (§8.1)', () => {
  const step = (flag, value, now = T0) => r.flagStep({ flag, comparator: 'gte', value, threshold: 3, now });
  it('raises a new flag on a breach, nothing otherwise', () => {
    expect(step(null, 3)).toBe('raise');
    expect(step(null, 2)).toBe('none');
  });
  it('refreshes open and actioned flags whatever the value', () => {
    expect(step({ status: 'open' }, 2)).toBe('refresh');
    expect(step({ status: 'actioned' }, 9)).toBe('refresh');
  });
  it('reopens a cleared flag after its snooze; inside it only when clearly worse (FR-08)', () => {
    const cleared = { status: 'cleared', snoozeUntil: at(30), clearedValue: 5 };
    expect(step(cleared, 5)).toBe('none');
    expect(step(cleared, 5.5)).toBe('none'); // 0.5 < half of (5 − 3)
    expect(step(cleared, 6)).toBe('reopen');
    expect(step(cleared, 5, at(31))).toBe('reopen');
    expect(step(cleared, 2, at(31))).toBe('none');
    expect(step({ status: 'cleared', snoozeUntil: at(30), clearedValue: null }, 4)).toBe('reopen'); // cleared at the threshold: any rise
    expect(step({ status: 'cleared', snoozeUntil: null, clearedValue: 5 }, 3)).toBe('reopen');
    expect(step({ status: 'lapsed' }, 3)).toBe('reopen');
  });
  it('measures worsening from the cleared value', () => {
    expect(r.worsened({ cleared: 3, value: 3, threshold: 3 })).toBe(false);
    expect(r.worsened({ cleared: 3, value: 3.01, threshold: 3 })).toBe(true);
    expect(r.worsened({ cleared: 2, value: 3, threshold: 3 })).toBe(true); // cleared below the threshold
  });
  it('lapses open flags with no activity', () => {
    expect(r.lapseDue({ status: 'open', lastActivityAt: T0, now: at(14), days: 14 })).toBe(true);
    expect(r.lapseDue({ status: 'open', lastActivityAt: T0, now: at(13), days: 14 })).toBe(false);
    expect(r.lapseDue({ status: 'actioned', lastActivityAt: T0, now: at(30), days: 14 })).toBe(false);
  });
  it('moves the flag with each action', () => {
    expect(r.flagAfter('freeze_payouts', 'open')).toBe('actioned');
    expect(r.flagAfter('suspend', 'actioned')).toBe('actioned');
    expect(r.flagAfter('clear', 'open')).toBe('cleared');
    expect(r.flagAfter('clear', 'cleared')).toBeNull();
    expect(r.flagAfter('reopen', 'cleared')).toBe('open');
    expect(r.flagAfter('reopen', 'open')).toBeNull();
    expect(r.flagAfter('unfreeze_payouts', 'actioned')).toBeNull();
  });
});

describe('M18 actions and undo (FR-09, Q100, Q101)', () => {
  const staff = { isMaster: false, canManageUsers: true };
  const master = { isMaster: true, canManageUsers: true };
  const block = (action, actor, extra = {}) => r.actionBlock({ action, actor, staffSuspendMaxDays: 30, ...extra });
  it('lets staff ask for documents, clear and suspend up to the limit', () => {
    expect(block('request_documents', staff)).toBeNull();
    expect(block('clear', staff)).toBeNull();
    expect(block('suspend', staff, { days: 30 })).toBeNull();
    expect(block('suspend', staff, { days: 31 })).toBe('SUSPENSION_TOO_LONG');
    expect(block('suspend', staff)).toBe('SUSPENSION_TOO_LONG'); // staff always set an end
    expect(block('restore', staff)).toBeNull();
  });
  it('keeps freezes, bans and lifting bans for masters', () => {
    expect(block('freeze_payouts', staff)).toBe('MASTER_REQUIRED');
    expect(block('unfreeze_payouts', staff)).toBe('MASTER_REQUIRED');
    expect(block('ban', staff)).toBe('MASTER_REQUIRED');
    expect(block('restore', staff, { restoringBan: true })).toBe('MASTER_REQUIRED');
    expect(block('ban', master)).toBeNull();
    expect(block('suspend', master)).toBeNull();
    expect(block('clear', { isMaster: false, canManageUsers: false })).toBe('PERMISSION_REQUIRED');
  });
  it('names the step-up and the undo of each action', () => {
    expect(r.stepUpFor('freeze_payouts')).toBe('risk.manage');
    expect(r.stepUpFor('unfreeze_payouts')).toBe('risk.manage');
    expect(r.stepUpFor('ban')).toBe('user.ban');
    expect(r.stepUpFor('suspend')).toBeNull();
    expect(r.undoOf('freeze_payouts')).toBe('unfreeze_payouts');
    expect(r.undoOf('request_documents')).toBe('cancel_document_request');
    expect(r.undoOf('clear')).toBe('reopen');
    expect(r.undoOf('suspend')).toBe('restore');
    expect(r.undoOf('ban')).toBe('restore');
    expect(r.undoOf('restore')).toBeNull();
    expect(r.FORWARD).toEqual(Object.keys(r.UNDO));
  });
  it('undoes forward actions once; undo rows are final', () => {
    expect(r.undoBlock({ action: 'ban', reversed: false })).toBeNull();
    expect(r.undoBlock({ action: 'ban', reversed: true })).toBe('ACTION_ALREADY_REVERSED');
    expect(r.undoBlock({ action: 'unfreeze_payouts', reversed: false })).toBe('ACTION_NOT_REVERSIBLE');
  });
});

describe('M18 reliability (§6.3, Q102)', () => {
  it('weights incidents (unknown kinds count nothing)', () => {
    expect(r.weighted({ owner_cancel: 2, owner_dispute_lost: 1 }, { owner_cancel: 1, owner_dispute_lost: 0.5 })).toBe(2.5);
    expect(r.weighted({ other: 4 }, {})).toBe(0);
  });
  it('gives the spec example: 25 bookings, one penalised cancel → 96%', () => {
    expect(r.reliability({ sample: 25, incidents: 1, minSample: 5, minDenominator: 10 })).toEqual({ score: 96, shown: true });
  });
  it('divides by at least the minimum denominator, never below 0, and shows from the minimum sample', () => {
    expect(r.reliability({ sample: 4, incidents: 1, minSample: 5, minDenominator: 10 })).toEqual({ score: 90, shown: false });
    expect(r.reliability({ sample: 10, incidents: 15, minSample: 5, minDenominator: 10 })).toEqual({ score: 0, shown: true });
    expect(r.reliability({ sample: 0, incidents: 0, minSample: 5, minDenominator: 10 })).toEqual({ score: 100, shown: false });
  });
  it('alerts once when a shown score falls below the line', () => {
    expect(r.lowCrossed({ before: null, after: { score: 70, shown: true }, line: 80 })).toBe(true);
    expect(r.lowCrossed({ before: { score: 90, shown: true }, after: { score: 79, shown: true }, line: 80 })).toBe(true);
    expect(r.lowCrossed({ before: { score: 75, shown: true }, after: { score: 70, shown: true }, line: 80 })).toBe(false);
    expect(r.lowCrossed({ before: { score: 75, shown: false }, after: { score: 70, shown: true }, line: 80 })).toBe(true);
    expect(r.lowCrossed({ before: null, after: { score: 70, shown: false }, line: 80 })).toBe(false);
    expect(r.lowCrossed({ before: null, after: { score: 85, shown: true }, line: 80 })).toBe(false);
  });
});
