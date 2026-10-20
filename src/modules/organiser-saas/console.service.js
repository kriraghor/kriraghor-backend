'use strict';

/**
 * M22 organiser console (FR-03, FR-04; vendor.kriraghor.com/vendor/esports). Every call is scoped by
 * the caller's membership (req.org from requireOrgRole): a tournament or match of another
 * organisation is a 404. Organiser tournaments are M21 tournaments, so the console calls the M21
 * services after the ownership check:
 *   - drafts, edits and submits (org admins submit; M05 review by Kriraghor staff, FR-04);
 *   - rooms and results (org staff too, Q135; every room action is audited by M21; Kriraghor staff
 *     keep their override on the admin desk);
 *   - finalise (org admins; the prize payout is confirmed with a code to the admin's phone, since
 *     customers have no authenticator for step-up).
 * Organisers cancel only drafts and tournaments in review; a published one is cancelled by Kriraghor.
 */
const { AppError } = require('../../common/errors');
const { E } = require('../../common/errors');
const { EsportsTournament, EsportsMatch } = require('../../models');
const otp = require('../auth').otp;
const tournaments = require('../esports').tournaments;
const registrations = require('../esports').registrations;
const rooms = require('../esports').rooms;
const results = require('../esports').results;
const prizes = require('../esports').prizes;
const contracts = require('./contracts.service');
const invoices = require('./invoices.service');
const funds = require('./prize-funds.service');
const rules = require('./saas.rules');
const c = require('./saas.common');

const OTP_PURPOSE = 'org_finalise';

async function ownTournament(org, id) {
  const t = await EsportsTournament.findOne({ where: { id, organisationId: org.id } });
  if (!t) throw E.notFound('Tournament');
  return t;
}

async function ownMatch(org, matchId) {
  const m = await EsportsMatch.findByPk(matchId, { attributes: ['id', 'tournamentId'] });
  if (!m) throw E.notFound('Match');
  await ownTournament(org, m.tournamentId).catch(() => {
    throw E.notFound('Match');
  });
  return m;
}

/** GET /org/:orgId/esports/dashboard: contract, open invoices, funds and tournaments at a glance. */
async function dashboard(org) {
  const [contract, open, list] = await Promise.all([
    contracts.currentFor(org.id),
    invoices.list({ organisationId: org.id }),
    tournaments.list({ organisationId: org.id, staff: true, limit: 50 }),
  ]);
  const unpaid = open.items.filter((i) => ['issued', 'overdue'].includes(i.status));
  const byStatus = {};
  for (const t of list.items) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  return {
    organisation: { id: org.id, name: org.name, status: org.status, role: org.role },
    contract: contract ? contracts.view(contract) : null,
    canSubmit: !rules.contractBlock(contract, c.today()) && !(await invoices.publishBlocked(org.id)),
    unpaidInvoices: unpaid.length,
    unpaidTotal: unpaid.reduce((s, i) => s + i.total, 0),
    tournaments: byStatus,
    upcoming: list.items.filter((t) => !['draft', 'review', 'finalised', 'paid_out', 'cancelled'].includes(t.status)).slice(0, 5),
  };
}

const list = (org, { status } = {}) => tournaments.list({ organisationId: org.id, staff: true, status: status?.split(',').filter(Boolean), limit: 50 });

/** GET /org/:orgId/esports/tournaments/:id: the staff view, the prize fund and the fee snapshot. */
async function detail(org, id) {
  const t = await ownTournament(org, id);
  const d = await tournaments.adminDetail(t.id);
  return { ...d, fund: await funds.stateFor(t), saas: { model: t.saasFeeModel, feeBps: t.saasFeeBps ?? null, contractId: t.contractId ?? null } };
}

const create = (principal, org, body, req) => tournaments.createDraft(principal, body, req, { org: { id: org.id } });

async function update(principal, org, id, body, req) {
  await ownTournament(org, id);
  return tournaments.update(principal, id, body, req);
}

async function submit(principal, org, id, req) {
  await ownTournament(org, id);
  return tournaments.submit(principal, id, req);
}

/** POST /org/:orgId/esports/tournaments/:id/cancel (org admin): drafts and tournaments in review only. */
async function cancel(principal, org, id, body, req) {
  const t = await ownTournament(org, id);
  if (!['draft', 'review'].includes(t.status)) throw c.fail('ORG_TOURNAMENT_STATE');
  return tournaments.cancel(principal, id, body, req);
}

async function checkins(org, id) {
  await ownTournament(org, id);
  return registrations.board(id);
}

// ---------------------------------------------------------------- matches (rooms and results, Q135)

async function match(org, matchId) {
  await ownMatch(org, matchId);
  return results.adminMatch(matchId);
}
async function roomPanel(org, matchId) {
  await ownMatch(org, matchId);
  return rooms.panel(matchId);
}
async function setRoom(principal, org, matchId, body, req) {
  await ownMatch(org, matchId);
  return rooms.setRoom(principal, matchId, body, req);
}
async function rotateRoom(principal, org, matchId, body, req) {
  await ownMatch(org, matchId);
  return rooms.rotate(principal, matchId, body, req);
}
async function enterResults(principal, org, matchId, body, req) {
  await ownMatch(org, matchId);
  return results.enter(principal, matchId, body, req);
}
async function postResults(principal, org, matchId, req) {
  await ownMatch(org, matchId);
  return results.post(principal, matchId, req);
}

// ---------------------------------------------------------------- finalise (org admins, code to the phone)

function phoneOf(principal) {
  const { user } = principal;
  if (!user.phone || !user.phoneVerifiedAt) throw new AppError(409, 'PHONE_REQUIRED', 'Add and verify a phone number first');
  return user.phone;
}

async function finalisePreview(org, id) {
  await ownTournament(org, id);
  return prizes.preview(id);
}

/** POST /org/:orgId/esports/tournaments/:id/finalise/code: a code to the admin's phone. */
async function sendFinaliseCode(principal, org, id, req) {
  await ownTournament(org, id);
  const result = await otp.issue({ target: { type: 'phone', value: phoneOf(principal) }, purpose: OTP_PURPOSE, ip: req.ip, locale: principal.user.locale });
  return { sent: true, ...result };
}

/** POST /org/:orgId/esports/tournaments/:id/finalise { code } (org admin): prizes paid from the fund. */
async function finalise(principal, org, id, { code }, req) {
  await ownTournament(org, id);
  await otp.consume({ target: { type: 'phone', value: phoneOf(principal) }, purpose: OTP_PURPOSE, code });
  return prizes.finalise(principal, id, req);
}

module.exports = { dashboard, list, detail, create, update, submit, cancel, checkins, match, roomPanel, setRoom, rotateRoom, enterResults, postResults, finalisePreview, sendFinaliseCode, finalise };
