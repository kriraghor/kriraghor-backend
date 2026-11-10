'use strict';

/**
 * Demo sign-in accounts (21 Oct 2026): one account of each kind that a person can sign in to with a
 * phone number and a password, so the product can be explored while SMS codes are not delivered.
 *
 * - Only runs when DEMO_PASSWORD is set (12–128 characters). The password lives in the host's
 *   environment, never in the code or the logs; every account below gets that same password through
 *   the real POST /me/password route (so the password rules apply).
 * - Never a master: an account holding master_admin is skipped, whatever list it is on. Demo staff
 *   get a few permissions each and set up their own authenticator on the first sign-in (the staff
 *   two-factor setup step), so no shared second factor exists.
 * - Round B3 business staff (a venue and a gym front desk, a shop packer) are ordinary members:
 *   steps/team.js makes them and their owner adds them to the team; this step only gives the
 *   password. They sign in at vendor.kriraghor.com and are never Kriraghor staff.
 * - Re-running keeps passwords that are already set. demo:hide suspends these accounts and offboards
 *   the demo staff like the rest of the demo data.
 */
const rt = require('../runtime');
const people = require('./people');
const D = require('../data');

/** Member accounts by their place in the demo phone block (see data.js). */
const MEMBERS = [
  { n: 1, kind: 'Venue owner', where: 'vendor.kriraghor.com' },
  { n: 8, kind: 'Shop owner', where: 'vendor.kriraghor.com' },
  { n: 10, kind: 'Gym owner', where: 'vendor.kriraghor.com' },
  { n: 11, kind: 'Sports events organiser', where: 'vendor.kriraghor.com' },
  { n: 21, kind: 'Football referee (hire)', where: 'kriraghor.com/pro' },
  { n: 30, kind: 'Gym trainer (monthly plans)', where: 'kriraghor.com/pro' },
  { n: 41, kind: 'Esports player, Free Fire', where: 'esports.kriraghor.com' },
  { n: 52, kind: 'Esports player, PUBG Mobile', where: 'esports.kriraghor.com' },
  // A plain member: made here if the listings profile did not (it has no listing of its own).
  { n: 90, kind: 'Member (books, buys, hires)', where: 'kriraghor.com', create: true },
  // Round B3 business staff: made and added to their owner's team by steps/team.js (POST /me/team).
  ...D.BUSINESS_STAFF.map((s) => ({ n: s.n, kind: s.kind, where: 'vendor.kriraghor.com' })),
  // The demo gym's trainer (steps/gym-panel.js): there once the gym panel is seeded.
  { n: D.GYM_PANEL.trainer.n, kind: D.GYM_PANEL.trainer.kind, where: 'gym.kriraghor.com' },
];

/** Demo staff: their own accounts in the demo phone block, a few permissions each, never master. */
const STAFF = [
  { n: 191, label: 'ops', name: 'Demo Operations', team: 'Operations', employeeId: 'KG-DEMO-OPS', permissions: ['manage_users', 'approve_listings', 'approve_documents', 'resolve_reports'] },
  { n: 192, label: 'finance', name: 'Demo Finance', team: 'Finance', employeeId: 'KG-DEMO-FIN', permissions: ['view_payouts', 'refund_small'] },
  { n: 193, label: 'esports', name: 'Demo Esports Desk', team: 'Esports', employeeId: 'KG-DEMO-ESP', permissions: ['manage_esports', 'enter_results'] },
];

const nameOf = (n) => [...D.OWNERS, ...D.PROS, ...D.TRAINERS, ...D.PLAYERS, D.MEMBER, ...D.BUSINESS_STAFF, D.GYM_PANEL.trainer].find((p) => p.n === n)?.name;

/** True when the step should run; explains why not otherwise. */
function enabled() {
  const pw = process.env.DEMO_PASSWORD ?? '';
  if (!pw) return { ok: false, why: 'DEMO_PASSWORD is not set, so no demo account can sign in (set it on the host to enable demo sign-in)' };
  if (pw.length < 12 || pw.length > 128) return { ok: false, why: 'DEMO_PASSWORD must be 12–128 characters' };
  return { ok: true, password: pw };
}

/** Sets the password on one account through the route, unless it has one or is a master. */
async function givePassword(a, password) {
  const user = await rt.models.User.findByPk(a.userId);
  const roles = await rt.models.UserRole.findAll({ where: { userId: a.userId, status: 'active' }, attributes: ['role'] });
  if (roles.some((r) => r.role === 'master_admin')) return 'skipped (master)';
  if (user.passwordHash) return 'kept';
  await rt.post(a, '/me/password', { newPassword: password });
  return 'set';
}

/**
 * Members with a password, and the demo staff (invited by the demo master with step-up). Returns
 * the rows to print: phone, name, kind, where to sign in, what happened.
 */
async function run({ master }) {
  const on = enabled();
  if (!on.ok) return { skipped: on.why, rows: [] };
  const rows = [];
  for (const m of MEMBERS) {
    const name = nameOf(m.n);
    const existing = await rt.models.User.findOne({ where: { phone: people.phoneOf(m.n) } });
    if ((!existing && !m.create) || !name) {
      rows.push({ phone: people.phoneOf(m.n), name: name ?? '?', kind: m.kind, where: m.where, result: 'missing (run the listings seed first)' });
      continue;
    }
    const a = await people.member(m.n, name);
    rows.push({ phone: people.phoneOf(m.n), name, kind: m.kind, where: m.where, result: await givePassword(a, on.password) });
  }
  for (const s of STAFF) {
    const a = await people.member(s.n, s.name);
    const result = await givePassword(a, on.password);
    if (!(await rt.models.StaffMember.findOne({ where: { userId: a.userId } }))) {
      await rt.post(master, '/admin/staff', { userId: a.userId, employeeId: s.employeeId, team: s.team, permissions: s.permissions }, { headers: { 'X-Step-Up': await rt.stepUp(master, 'staff.write') } });
    }
    await rt.mark('staff', a.userId, s.label);
    rows.push({ phone: people.phoneOf(s.n), name: s.name, kind: `Staff: ${s.permissions.join(', ')}`, where: 'admin.kriraghor.com (password, then set up the authenticator)', result });
  }
  return { rows };
}

module.exports = { run, enabled, MEMBERS, STAFF };
