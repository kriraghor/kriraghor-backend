'use strict';

// M05 moderation rules, 100% branch coverage: the state machine (§8), SLA states (FR-18, §6.5), the
// claim lock (FR-07, FR-08), rubric and checks (FR-06, FR-09, FR-10), reasons (FR-11), self-review
// and the master override of a failing hard check (Q46).
const R = require('../../src/modules/moderation/moderation.rules');

const at = (iso) => new Date(iso);

describe('M05 state machine (§8)', () => {
  it('allows the drawn transitions only', () => {
    expect(R.canTransition('pending_review', 'approved')).toBe(true);
    expect(R.canTransition('changes_requested', 'superseded')).toBe(true);
    expect(R.canTransition('approved', 'pending_review')).toBe(true);
    expect(R.canTransition('rejected', 'pending_review')).toBe(true);
    expect(R.canTransition('withdrawn', 'pending_review')).toBe(false);
    expect(R.canTransition('approved', 'rejected')).toBe(false);
    expect(R.canTransition('nope', 'approved')).toBe(false);
    expect(R.OPEN).toEqual(['pending_review', 'changes_requested']);
    expect(R.DECISION_STATUS.request_changes).toBe('changes_requested');
  });
});

describe('M05 SLA (§6.5 worked example)', () => {
  const due = R.slaDue(at('2026-10-11T15:30:00Z'), 24); // 11 Oct 21:30 Dhaka → 12 Oct 21:30
  it('is due 24 hours after submission', () => {
    expect(due.toISOString()).toBe('2026-10-12T15:30:00.000Z');
  });
  it('warns under 4 hours left and is overdue after', () => {
    expect(R.slaState(due, at('2026-10-12T06:00:00Z'), 4)).toBe('ok');
    expect(R.slaState(due, at('2026-10-12T12:00:00Z'), 4)).toBe('warn'); // 18:00 Dhaka, 3h30 left
    expect(R.slaState(due, at('2026-10-12T16:15:00Z'), 4)).toBe('overdue');
    expect(R.slaState(due, due, 4)).toBe('warn');
  });
});

describe('M05 claim lock (FR-07, FR-08)', () => {
  const now = at('2026-10-12T04:00:00Z');
  it('locks for the TTL, never past the hard cap', () => {
    const w = R.claimWindow(now, 30, 120);
    expect(w.expiresAt.toISOString()).toBe('2026-10-12T04:30:00.000Z');
    expect(w.hardExpiresAt.toISOString()).toBe('2026-10-12T06:00:00.000Z');
    expect(R.claimWindow(now, 200, 120).expiresAt.toISOString()).toBe('2026-10-12T06:00:00.000Z');
  });
  it('heartbeats extend up to the hard cap', () => {
    const claim = { hardExpiresAt: at('2026-10-12T06:00:00Z') };
    expect(R.heartbeatExpiry(claim, at('2026-10-12T05:00:00Z'), 30).toISOString()).toBe('2026-10-12T05:30:00.000Z');
    expect(R.heartbeatExpiry(claim, at('2026-10-12T05:50:00Z'), 30).toISOString()).toBe('2026-10-12T06:00:00.000Z');
  });
  it('knows when a claim still holds', () => {
    const live = { releasedAt: null, expiresAt: at('2026-10-12T04:30:00Z'), hardExpiresAt: at('2026-10-12T06:00:00Z') };
    expect(R.claimActive(live, now)).toBe(true);
    expect(R.claimActive({ ...live, releasedAt: now }, now)).toBe(false);
    expect(R.claimActive(live, at('2026-10-12T04:31:00Z'))).toBe(false);
    expect(R.claimActive({ ...live, expiresAt: at('2026-10-12T07:00:00Z') }, at('2026-10-12T06:01:00Z'))).toBe(false);
    expect(R.claimActive(null, now)).toBe(false);
  });
});

describe('M05 decisions (FR-06, FR-09 to FR-11, Q46)', () => {
  const now = at('2026-10-12T04:10:00Z');
  const submission = { status: 'pending_review', submittedBy: 'owner', kind: 'document' };
  const items = [{ key: 'name_matches' }, { key: 'readable' }];
  const claim = { staffId: 'rafiq', ticks: ['name_matches', 'readable'], releasedAt: null, expiresAt: at('2026-10-12T04:30:00Z'), hardExpiresAt: at('2026-10-12T06:00:00Z') };
  const pass = [{ key: 'nid_format', severity: 'hard', result: 'pass' }, { key: 'file_reused', severity: 'soft', result: 'warn' }];
  const failing = [{ key: 'nid_unique', severity: 'hard', result: 'fail' }];
  const reason = { kinds: ['document'], requiresText: false };
  const base = { submission, claim, now, actorId: 'rafiq', isMaster: false, rubricItems: items, checks: pass };

  it('approves with an active claim, every tick and no hard failure', () => {
    expect(R.decisionBlock({ ...base, decision: 'approve' })).toBeNull();
  });

  it('refuses the wrong state, self-review, no claim or an expired one', () => {
    expect(R.decisionBlock({ ...base, submission: { ...submission, status: 'approved' }, decision: 'approve' })).toEqual({ code: 'INVALID_STATE' });
    expect(R.decisionBlock({ ...base, actorId: 'owner', decision: 'approve' })).toEqual({ code: 'SELF_REVIEW_FORBIDDEN' });
    expect(R.decisionBlock({ ...base, claim: null, decision: 'approve' })).toEqual({ code: 'CLAIM_REQUIRED' });
    expect(R.decisionBlock({ ...base, actorId: 'sumaiya', decision: 'approve' })).toEqual({ code: 'CLAIM_REQUIRED' });
    expect(R.decisionBlock({ ...base, now: at('2026-10-12T04:31:00Z'), decision: 'approve' })).toEqual({ code: 'CLAIM_EXPIRED' });
  });

  it('needs every rubric tick, and stops on a failing hard check unless a master overrides', () => {
    expect(R.decisionBlock({ ...base, claim: { ...claim, ticks: ['readable'] }, decision: 'approve' })).toEqual({ code: 'RUBRIC_INCOMPLETE', missing: ['name_matches'] });
    expect(R.decisionBlock({ ...base, checks: failing, decision: 'approve' })).toEqual({ code: 'CHECK_FAILED', failing: ['nid_unique'] });
    expect(R.decisionBlock({ ...base, checks: failing, decision: 'approve', override: 'Known twin' })).toEqual({ code: 'MASTER_REQUIRED' });
    expect(R.decisionBlock({ ...base, checks: failing, isMaster: true, decision: 'approve', override: 'Known twin' })).toBeNull();
    // An adapter's locked checks cannot be overridden, not even by a master.
    const locked = failing.filter((c) => c.result === 'fail').map((c) => c.key);
    expect(R.decisionBlock({ ...base, checks: failing, locked, isMaster: true, decision: 'approve', override: 'Known twin' })).toEqual({ code: 'CHECK_LOCKED', failing: locked });
    expect(R.decisionBlock({ ...base, checks: failing, locked: ['other_check'], isMaster: true, decision: 'approve', override: 'Known twin' })).toBeNull();
  });

  it('needs a reason valid for the kind, with text when the reason asks for it', () => {
    expect(R.decisionBlock({ ...base, decision: 'reject', reason })).toBeNull();
    expect(R.decisionBlock({ ...base, decision: 'request_changes', reason: null })).toEqual({ code: 'REASON_REQUIRED' });
    expect(R.decisionBlock({ ...base, decision: 'reject', reason: { kinds: ['ground'], requiresText: false } })).toEqual({ code: 'REASON_NOT_ALLOWED_FOR_KIND' });
    expect(R.decisionBlock({ ...base, decision: 'reject', reason: { kinds: ['document'], requiresText: true } })).toEqual({ code: 'REASON_REQUIRED' });
    expect(R.decisionBlock({ ...base, decision: 'reject', reason: { kinds: ['document'], requiresText: true }, reasonText: '  ' })).toEqual({ code: 'REASON_REQUIRED' });
    expect(R.decisionBlock({ ...base, decision: 'reject', reason: { kinds: ['document'], requiresText: true }, reasonText: 'Blurred back' })).toBeNull();
  });

  it('stores only rubric keys, once each', () => {
    expect(R.cleanTicks(items, ['readable', 'readable', 'made_up', 'name_matches'])).toEqual(['readable', 'name_matches']);
    expect(R.missingTicks(items, [])).toEqual(['name_matches', 'readable']);
    expect(R.hardFailures([...pass, ...failing, { key: 'x', severity: 'soft', result: 'fail' }])).toEqual(['nid_unique']);
  });
});
