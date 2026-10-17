'use strict';

// M04 contract gates (FR-06, FR-12, §13 "Contract"): the registries and the code agree.
const fs = require('fs');
const path = require('path');
const { EVENTS } = require('../../src/modules/events/catalog');
const { ACTIONS } = require('../../src/modules/audit/audit.actions');

const SRC = path.join(__dirname, '..', '..', 'src');
function sources(dir = SRC) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'migrations' ? [] : sources(p);
    return p.endsWith('.js') ? [fs.readFileSync(p, 'utf8')] : [];
  });
}
const code = sources().join('\n');

describe('event registry ↔ producers', () => {
  it('every registered event is published somewhere in src', () => {
    const silent = Object.keys(EVENTS).filter((name) => !code.includes(`'${name}'`));
    expect(silent).toEqual([]);
  });

  it('every published event literal is registered', () => {
    const published = [...code.matchAll(/name: '([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]).filter((n) => !/^(outbox|audit)\.[a-z]+-/.test(n));
    // Job names (not events) that look like event names.
    const known = new Set([...Object.keys(EVENTS), 'outbox.relay', 'identity.sanction-expire', 'settings.apply-scheduled', 'ledger.invariants', 'reconciliation.daily', 'idempotency.purge', 'payouts.schedule', 'esports.tick', 'bookings.tick']);
    expect([...new Set(published)].filter((n) => !known.has(n) && !n.includes('-'))).toEqual([]);
  });
});

describe('audit action registry ↔ emitters (M04-FR-06)', () => {
  it('every action literal passed to audit.record is registered', () => {
    const literals = new Set();
    for (const m of code.matchAll(/action: (?:[a-z]+ \? )?'([a-z_]+\.[a-z_.]+)'(?: : '([a-z_]+\.[a-z_.]+)')?/g)) {
      literals.add(m[1]);
      if (m[2]) literals.add(m[2]);
    }
    // user_role.${status} covers these statuses (admin-users.service setRoleStatus).
    for (const s of ['in_review', 'active', 'changes_requested', 'rejected', 'suspended']) literals.add(`user_role.${s}`);
    expect([...literals].filter((a) => !ACTIONS[a])).toEqual([]);
  });

  // §6.2 must-audit list for the modules built so far, mapped to the action names the code uses.
  // [] marks a feature that is not built yet (it gets an emitter when it is).
  const MUST = {
    M01: {
      'user.registered': ['user.registered'],
      'user.signed_in': ['auth.signed_in'],
      'user.sign_in_failed': ['auth.sign_in_failed', 'auth.totp_failed'],
      'user.step_up_failed': ['auth.step_up_failed'],
      'user.profile_updated': ['user.profile_updated'],
      'user.phone_changed': [],
      'user_role.*': ['user_role.applied', 'user_role.withdrawn'],
      'user.searched': ['user.searched'],
      'user.suspended': ['user.suspended'],
      'user.banned': ['user.banned'],
      'user.restored': ['user.restored'],
      'user.sessions_revoked': ['user.signed_out_by_admin', 'session.revoked'],
      'staff.invited': ['staff.invited'],
      'staff.permissions_changed': ['staff.permission_granted', 'staff.permission_revoked'],
      'staff.offboarded': ['staff.offboarded'],
      'twofa.reset': ['staff.totp_reset'],
      'webauthn.credential_added/removed': [],
    },
    M03: {
      'setting.change_proposed': ['setting.change_proposed'],
      'setting.change_approved/rejected': ['setting.change_approved', 'setting.change_rejected'],
      'setting.changed': ['setting.changed'],
      'catalog_item.created/updated/deactivated': ['catalog_item.created', 'catalog_item.updated', 'catalog_item.deactivated'],
    },
    M04: { 'audit_log.exported': ['audit_log.exported'], 'outbox.event_replayed': ['outbox.event_replayed'] },
    // M07 §5 FR-11: every release, hold, approval, retry and manual mark-paid is audited.
    M07: {
      'payout.released/approved': ['payout.released', 'payout.approved'],
      'payout.held/hold_lifted': ['payout.held', 'payout.hold_lifted'],
      'payout.marked_paid/failed': ['payout.marked_paid', 'payout.marked_failed'],
      'payout.account_revealed': ['payout.account_revealed'],
      'payout_account.*': ['payout_account.added', 'payout_account.verified', 'payout_account.rejected'],
    },
  };

  it('every §6.2 action of a built module has an emitter, and the ★ ones are critical', () => {
    const missing = [];
    for (const [mod, list] of Object.entries(MUST)) {
      for (const [spec, actions] of Object.entries(list)) {
        for (const a of actions) {
          if (!ACTIONS[a] || ACTIONS[a].module !== mod) missing.push(`${spec} → ${a} (registry)`);
          if (!code.includes(`'${a}'`) && !a.startsWith('user_role.')) missing.push(`${spec} → ${a} (emitter)`);
        }
      }
    }
    expect(missing).toEqual([]);
    for (const a of ['user.banned', 'staff.invited', 'staff.permission_granted', 'staff.offboarded', 'staff.totp_reset', 'setting.changed', 'audit_log.exported', 'payout.released', 'payout.approved', 'payout.account_revealed', 'payout.marked_paid']) {
      expect([a, ACTIONS[a].severity]).toEqual([a, 'critical']);
    }
  });
});
