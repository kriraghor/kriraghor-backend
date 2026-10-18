'use strict';

/**
 * M14 registrations (FR-10 to FR-14) and tournament money (§6.8, §6.9):
 *  - a captain or vice-captain registers an M16 team with a roster (gate register_team: an NID
 *    member); a free place → pending_payment (entry fee into escrow, M06 purpose tournament_entry)
 *    or pending_approval when free; a full tournament → the reserve list;
 *  - the organiser approves (roster ready, under the tournament lock and the max), rejects (100%
 *    refund), removes, waives the fee; a freed place is offered to the next reserve team for
 *    reserve_offer_hours;
 *  - withdraw and cancel refund per the table; tranche 1 at the first result, the rest at completion,
 *    fees.tournament_pct (snapshotted) on each release.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const audit = require('../audit/audit.service');
const gates = require('../auth/gate.service');
const payments = require('../payments/payments.service');
const purposes = require('../payments/payments.purposes');
const refunds = require('../payments/refunds.service');
const escrow = require('../payments/escrow.service');
const organisations = require('../organisations/organisations.service');
const teamsSvc = require('../teams/teams.service');
const rosters = require('../teams/rosters.service');
const { payUrl } = require('../bookings/holds.service');
const { sequelize, Tournament, Registration, Match } = require('../../models');
const rules = require('./tournaments.rules');
const c = require('./tournaments.common');

const MANAGERS = ['captain', 'vice_captain'];

function gate(principal) {
  const g = gates.evaluateAction(principal, 'register_team');
  if (!g.allowed) throw E.forbidden(g.code, 'You cannot enter tournaments yet', undefined, { next: g.next });
}

const payload = (r, extra = {}) => ({ registrationId: r.id, tournamentId: r.tournamentId, teamId: r.teamId, captainId: r.captainId, ...extra });
const publishReg = (transaction, name, r, extra, actor = null) => c.publish(transaction, name, 'registration', r.id, payload(r, extra), actor);

/** A captain's view of a registration (with the payment link while unpaid). */
async function view(r, { transaction } = {}) {
  const t = await Tournament.findByPk(r.tournamentId, { transaction });
  const team = await teamsSvc.getTeam(r.teamId, { transaction });
  return {
    id: r.id,
    status: r.status,
    tournament: { id: t.id, slug: t.slug, name: t.name, status: t.status, startDate: t.startDate },
    team: team ? { id: team.id, name: team.name, shortCode: team.shortCode } : null,
    reservePosition: r.reservePosition,
    holdExpiresAt: r.holdExpiresAt?.toISOString() ?? null,
    offerExpiresAt: r.offerExpiresAt?.toISOString() ?? null,
    feePoisha: r.feePoisha,
    feeWaived: r.feeWaived,
    refundedPoisha: r.refundedPoisha,
    reason: r.reason,
    payment: r.status === 'pending_payment' && r.paymentId ? { id: r.paymentId, payUrl: payUrl(r.paymentId) } : null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Places taken right now (pending payment, offered, waiting, approved). */
const holding = (tournamentId, transaction) => Registration.count({ where: { tournamentId, status: { [Op.in]: rules.HOLDING } }, transaction });

/** Opens the M06 intent for the entry fee (payee: the organisation owner). */
async function attachPayment(r, t, transaction) {
  const ownerId = await organisations.ownerOf(t.organisationId, { transaction });
  const holdExpiresAt = new Date(Date.now() + c.config().holdMinutes * 60000);
  const payment = await payments.createIntent(
    { purpose: 'tournament_entry', purposeId: r.id, payerId: r.captainId, payeeId: ownerId, amount: r.feePoisha, title: `Entry: ${t.name}`, groupRef: t.id, expiresAt: holdExpiresAt, idempotencyKey: `tournament:reg:${r.id}:${holdExpiresAt.getTime()}` },
    { transaction }
  );
  await r.update({ status: 'pending_payment', paymentId: payment.id, holdExpiresAt }, { transaction });
}

/** pending_payment or pending_approval for a team taking a place (offer accepted or a new entry). */
async function takePlace(r, t, transaction) {
  if (t.entryFeePoisha > 0) await attachPayment(r, t, transaction);
  else await r.update({ status: 'pending_approval', holdExpiresAt: null, offerExpiresAt: null }, { transaction });
}

/** POST /tournaments/:id/registrations {teamId, rosterUserIds, acceptRules} (Idempotency-Key). */
async function register(principal, tournamentId, body, idempotencyKey, req) {
  gate(principal);
  const prior = await Registration.findOne({ where: { captainId: principal.id, idempotencyKey } });
  if (prior) return view(prior);
  const id = await sequelize.transaction(async (transaction) => {
    const t = await Tournament.findByPk(tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!t || !rules.PUBLIC.includes(t.status)) throw E.notFound('Tournament');
    const window = rules.registrationWindow(t, new Date());
    if (window === 'not_yet') throw c.fail('REGISTRATION_NOT_YET_OPEN');
    if (window === 'closed') throw c.fail('REGISTRATION_CLOSED');
    const team = await teamsSvc.getTeam(body.teamId, { transaction });
    if (!team) throw E.notFound('Team');
    if (team.status !== 'active') throw c.fail('TEAM_ARCHIVED');
    if (team.sportId !== t.sportId) throw c.fail('TEAM_SPORT_MISMATCH');
    if (!MANAGERS.includes(await teamsSvc.roleOf(principal.id, team.id, { transaction }))) throw c.fail('NOT_TEAM_CAPTAIN');
    if (await Registration.findOne({ where: { tournamentId: t.id, teamId: team.id, status: { [Op.in]: rules.LIVE } }, transaction })) throw c.fail('TEAM_ALREADY_REGISTERED');
    const free = rules.placeFree(await holding(t.id, transaction), t.maxTeams);
    const lastReserve = free ? 0 : ((await Registration.max('reservePosition', { where: { tournamentId: t.id }, transaction })) ?? 0);
    const r = await Registration.create(
      { tournamentId: t.id, teamId: team.id, captainId: principal.id, status: free ? 'pending_approval' : 'reserve', reservePosition: free ? null : lastReserve + 1, feePoisha: t.entryFeePoisha, idempotencyKey },
      { transaction }
    );
    await rosters.create(r, body.rosterUserIds, t, { transaction, actorId: principal.id });
    if (free) await takePlace(r, t, transaction);
    await audit.record({ action: 'registration.submitted', actor: principal, entityType: 'registration', entityId: r.id, after: { status: r.status, teamId: team.id }, meta: { tournamentId: t.id }, req }, { transaction });
    await publishReg(transaction, 'registration.submitted', r, { status: r.status, organisationId: t.organisationId }, principal);
    return r.id;
  });
  return view(await Registration.findByPk(id));
}

// ---------------------------------------------------------------- M06 hooks

/** M06 capture: a paid entry waits for the organiser; late (lapsed, cancelled) → M06 refunds it. */
async function onCaptured({ payment, transaction }) {
  const r = await Registration.findByPk(payment.purposeId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!r || r.status !== 'pending_payment' || r.paymentId !== payment.id) return 'reject';
  await r.update({ status: 'pending_approval', holdExpiresAt: null }, { transaction });
  await publishReg(transaction, 'registration.paid', r, { amount: r.feePoisha });
  return 'accept';
}
purposes.register('tournament_entry', { onCaptured });

/** M06 payment.failed / payment.expired: the unpaid place lapses and goes to the next reserve team. */
async function onPaymentClosed(paymentId, { transaction }) {
  const r = await Registration.findOne({ where: { paymentId, status: 'pending_payment' }, transaction, lock: transaction.LOCK.UPDATE });
  if (!r) return null;
  const t = await Tournament.findByPk(r.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
  await endInTx(r, 'lapsed', { transaction, reason: 'unpaid' });
  if (t.status === 'registration_open') await offerNext(t, { transaction });
  return r.id;
}

// ---------------------------------------------------------------- ending, refunds, offers

/** Moves a registration out of the tournament: releases the roster, ends an unpaid intent. */
async function endInTx(r, status, { transaction, reason = null, actor = null }) {
  if (!rules.can(rules.REGISTRATION, r.status, status)) throw c.fail('REGISTRATION_STATE');
  if (r.status === 'pending_payment' && r.paymentId) {
    try {
      await payments.cancelIntent(r.paymentId, { transaction });
    } catch {
      // Already closed or captured: a late capture is refunded by M06 (onCaptured → reject).
    }
  }
  await r.update({ status, reason: reason ?? r.reason, endedAt: new Date(), holdExpiresAt: null, offerExpiresAt: null, reservePosition: status === 'reserve' ? r.reservePosition : null, decidedBy: actor?.id ?? r.decidedBy }, { transaction });
  await rosters.release(r.id, { transaction });
  await publishReg(transaction, `registration.${status}`, r, { reason: reason ?? null }, actor);
}

/** Refunds per §6.9 from what the hold still has. Returns the amount refunded. */
async function refundInTx(r, t, reason, { transaction, actor = null }) {
  if (!r.paymentId || r.feeWaived) return 0;
  const hold = await escrow.lockHoldForPayment(r.paymentId, transaction);
  if (!hold) return 0; // never captured
  const available = hold.heldPoisha - hold.releasedPoisha - hold.refundedPoisha;
  const amount = Math.min(
    available,
    rules.refundAmount({ reason, paid: hold.heldPoisha, available, closed: t.status !== 'registration_open', firstResult: Boolean(t.firstResultAt), afterClosePct: c.config().afterClosePct })
  );
  if (amount <= 0) return 0;
  const done = await refunds.refundPayment({ paymentId: r.paymentId, amount, reasonCode: `tournament_${reason}`, idempotencyKey: `tournament:refund:${r.id}:${reason}`, actor }, { transaction });
  if (!done) return 0;
  await r.update({ refundedPoisha: r.refundedPoisha + amount }, { transaction });
  return amount;
}

/** Offers free places to reserve teams in order, each for reserve_offer_hours. */
async function offerNext(t, { transaction }) {
  let offered = 0;
  while (rules.placeFree(await holding(t.id, transaction), t.maxTeams)) {
    const next = await Registration.findOne({ where: { tournamentId: t.id, status: 'reserve' }, order: [['reservePosition', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
    if (!next) break;
    const until = new Date(Date.now() + c.config().offerHours * 3600000);
    await next.update({ status: 'offered', offerExpiresAt: until }, { transaction });
    await publishReg(transaction, 'registration.promoted', next, { offerExpiresAt: until.toISOString() });
    offered += 1;
  }
  return offered;
}

/** POST /me/registrations/:id/accept-offer (Idempotency-Key): the reserve team takes the place. */
async function acceptOffer(principal, id, req) {
  await sequelize.transaction(async (transaction) => {
    const r = await ownRegistration(principal, id, transaction);
    const t = await Tournament.findByPk(r.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
    await r.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (r.status !== 'offered' || t.status !== 'registration_open') throw c.fail('REGISTRATION_STATE');
    await takePlace(r, t, transaction);
    await audit.record({ action: 'registration.offer_accepted', actor: principal, entityType: 'registration', entityId: r.id, req }, { transaction });
  });
  return view(await Registration.findByPk(id));
}

/** A captain or vice-captain of the registered team (404 otherwise). */
async function ownRegistration(principal, id, transaction) {
  const r = await Registration.findByPk(id, { transaction });
  if (!r || !MANAGERS.includes(await teamsSvc.roleOf(principal.id, r.teamId, { transaction }))) throw E.notFound('Registration');
  return r;
}

/**
 * POST /me/registrations/:id/withdraw. Refund per §6.9; a withdrawn team's remaining matches become
 * walkovers for their opponents once fixtures exist.
 */
async function withdraw(principal, id, req) {
  await sequelize.transaction(async (transaction) => {
    const probe = await ownRegistration(principal, id, transaction);
    const t = await Tournament.findByPk(probe.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
    const r = await Registration.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!rules.can(rules.REGISTRATION, r.status, 'withdrawn')) throw c.fail('REGISTRATION_STATE');
    const placed = r.status === 'approved';
    const refunded = await refundInTx(r, t, 'withdrawn', { transaction, actor: principal });
    await endInTx(r, 'withdrawn', { transaction, reason: 'withdrawn_by_team', actor: principal });
    if (placed) await require('./fixtures.service').forfeitTeam(t, r.teamId, { transaction });
    if (t.status === 'registration_open') await offerNext(t, { transaction });
    await audit.record({ action: 'registration.withdrawn', actor: principal, entityType: 'registration', entityId: r.id, meta: { refunded }, req }, { transaction });
  });
  return view(await Registration.findByPk(id));
}

/** PUT /me/registrations/:id/roster {rosterUserIds}: change the squad before it freezes. */
async function setRoster(principal, id, { rosterUserIds }, req) {
  await sequelize.transaction(async (transaction) => {
    const r = await ownRegistration(principal, id, transaction);
    if (!['pending_payment', 'reserve', 'offered', 'pending_approval', 'approved'].includes(r.status)) throw c.fail('REGISTRATION_STATE');
    const t = await Tournament.findByPk(r.tournamentId, { transaction });
    await rosters.setPlayers(r, rosterUserIds, t, { transaction, actorId: principal.id });
    await audit.record({ action: 'registration.roster_changed', actor: principal, entityType: 'registration', entityId: r.id, meta: { players: rosterUserIds.length }, req }, { transaction });
  });
  return view(await Registration.findByPk(id));
}

/** GET /me/registrations: registrations of every team I captain or vice-captain. */
async function mine(principal) {
  const teamIds = (await teamsSvc.teamsOf(principal.id)).filter((x) => MANAGERS.includes(x.role)).map((x) => x.id);
  if (!teamIds.length) return { items: [] };
  const rows = await Registration.findAll({ where: { teamId: { [Op.in]: teamIds } }, order: [['createdAt', 'DESC']], limit: 100 });
  return { items: await Promise.all(rows.map((r) => view(r))) };
}

// ---------------------------------------------------------------- the organiser (console)

async function orgRegistration(org, id, transaction) {
  const r = await Registration.findByPk(id, { transaction });
  const t = r && (await Tournament.findOne({ where: { id: r.tournamentId, organisationId: org.id }, transaction, lock: transaction.LOCK.UPDATE }));
  if (!t) throw E.notFound('Registration');
  return { r: await Registration.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }), t };
}

/** GET …/registrations?status: rows with roster readiness (names and NID booleans only). */
async function orgList(org, tournamentId, { status } = {}) {
  const t = await c.ownTournament(org, tournamentId);
  const rows = await Registration.findAll({ where: { tournamentId: t.id, ...(status ? { status } : {}) }, order: [['reservePosition', 'ASC NULLS FIRST'], ['createdAt', 'ASC']] });
  const teams = await Promise.all(rows.map((r) => teamsSvc.getTeam(r.teamId)));
  const ready = await Promise.all(rows.map((r) => (rules.LIVE.includes(r.status) ? rosters.readiness(r.id, t) : null)));
  return {
    items: rows.map((r, i) => ({
      id: r.id,
      status: r.status,
      team: teams[i] ? { id: teams[i].id, name: teams[i].name, shortCode: teams[i].shortCode } : null,
      reservePosition: r.reservePosition,
      feePoisha: r.feePoisha,
      feeWaived: r.feeWaived,
      refundedPoisha: r.refundedPoisha,
      reason: r.reason,
      roster: ready[i],
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/** POST …/registrations/:id/approve: needs a ready roster and a free approved place (FR-10/12). */
async function approve(principal, org, id, req) {
  return sequelize.transaction(async (transaction) => {
    const { r, t } = await orgRegistration(org, id, transaction);
    if (r.status !== 'pending_approval') throw c.fail('REGISTRATION_STATE');
    if ((await Registration.count({ where: { tournamentId: t.id, status: 'approved' }, transaction })) >= t.maxTeams) throw c.fail('CAPACITY_FULL');
    const ready = await rosters.readiness(r.id, t, { transaction });
    if (!ready.ready) throw c.fail('ROSTER_NOT_READY', { eligible: ready.eligible, needed: t.squadMin });
    await r.update({ status: 'approved', approvedAt: new Date(), decidedBy: principal.id, decidedAt: new Date() }, { transaction });
    await audit.record({ action: 'registration.approved', actor: principal, entityType: 'registration', entityId: r.id, req }, { transaction });
    await publishReg(transaction, 'registration.approved', r, {}, principal);
    return { id: r.id, status: r.status };
  });
}

/** POST …/registrations/:id/reject {reason}: a 100% refund (FR-12); the place goes to the next team. */
async function reject(principal, org, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const { r, t } = await orgRegistration(org, id, transaction);
    if (!['pending_approval', 'pending_payment', 'reserve', 'offered'].includes(r.status)) throw c.fail('REGISTRATION_STATE');
    const refunded = await refundInTx(r, t, 'rejected', { transaction, actor: principal });
    await endInTx(r, 'rejected', { transaction, reason, actor: principal });
    if (t.status === 'registration_open') await offerNext(t, { transaction });
    await audit.record({ action: 'registration.rejected', actor: principal, entityType: 'registration', entityId: r.id, meta: { reason, refunded }, req }, { transaction });
    return { id: r.id, status: 'rejected', refunded };
  });
}

/** POST …/registrations/:id/remove {reason}: an approved team out (refund per §6.9; walkovers). */
async function remove(principal, org, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const { r, t } = await orgRegistration(org, id, transaction);
    if (r.status !== 'approved') throw c.fail('REGISTRATION_STATE');
    const refunded = await refundInTx(r, t, 'removed', { transaction, actor: principal });
    await endInTx(r, 'removed', { transaction, reason, actor: principal });
    await require('./fixtures.service').forfeitTeam(t, r.teamId, { transaction });
    if (t.status === 'registration_open') await offerNext(t, { transaction });
    await audit.record({ action: 'registration.removed', actor: principal, entityType: 'registration', entityId: r.id, meta: { reason, refunded }, req }, { transaction });
    return { id: r.id, status: 'removed', refunded };
  });
}

/** POST …/registrations/:id/waive {reason} (organisation admins): no fee, no escrow (audited). */
async function waive(principal, org, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const { r } = await orgRegistration(org, id, transaction);
    if (!['pending_payment', 'offered'].includes(r.status)) throw c.fail('REGISTRATION_STATE');
    if (r.status === 'pending_payment' && r.paymentId) {
      try {
        await payments.cancelIntent(r.paymentId, { transaction });
      } catch {
        throw c.fail('REGISTRATION_STATE'); // already paid: nothing to waive
      }
    }
    await r.update({ status: 'pending_approval', feeWaived: true, waiveReason: reason, feePoisha: 0, paymentId: null, holdExpiresAt: null, offerExpiresAt: null }, { transaction });
    await audit.record({ action: 'registration.fee_waived', actor: principal, entityType: 'registration', entityId: r.id, meta: { reason }, req }, { transaction });
    await publishReg(transaction, 'registration.fee_waived', r, {}, principal);
    return { id: r.id, status: r.status };
  });
}

// ---------------------------------------------------------------- tournament-wide

/** At registration close: unpaid places, open offers and the reserve list lapse. */
async function closeAllOpenInTx(t, { transaction }) {
  const open = await Registration.findAll({ where: { tournamentId: t.id, status: { [Op.in]: ['pending_payment', 'offered', 'reserve'] } }, transaction, lock: transaction.LOCK.UPDATE });
  for (const r of open) await endInTx(r, 'lapsed', { transaction, reason: 'registration_closed' });
  return open.length;
}

/** The tournament is cancelled: every live registration ends with its refund. */
async function cancelAllInTx(t, { transaction, actor }) {
  const live = await Registration.findAll({ where: { tournamentId: t.id, status: { [Op.in]: rules.LIVE } }, transaction, lock: transaction.LOCK.UPDATE });
  for (const r of live) {
    await refundInTx(r, t, 'cancelled', { transaction, actor });
    await endInTx(r, 'cancelled', { transaction, reason: 'tournament_cancelled', actor });
  }
  return live.length;
}

/**
 * Releases a tranche of every held entry fee to the organiser (§6.8): `first` = release_pct of each
 * hold, `final` = the rest. Frozen holds (an open dispute) wait. Idempotent: a released share is
 * never released twice. Returns {gross, fee}.
 */
async function releaseTranche(t, which, { transaction }) {
  const regs = await Registration.findAll({ where: { tournamentId: t.id, paymentId: { [Op.ne]: null }, feeWaived: false }, transaction });
  const sum = { gross: 0, fee: 0 };
  for (const r of regs) {
    const hold = await escrow.lockHoldForPayment(r.paymentId, transaction);
    if (!hold || hold.status === 'frozen') continue;
    const amount = rules.trancheAmount({ held: hold.heldPoisha, released: hold.releasedPoisha, refunded: hold.refundedPoisha }, which === 'first' ? t.releasePct : 100);
    if (amount <= 0) continue;
    const moved = await escrow.releaseInTx(hold, { amount, feeBase: amount, transaction, kind: 'escrow.release_tournament' });
    sum.gross += moved.gross;
    sum.fee += moved.fee;
  }
  return sum;
}

/** Money of a tournament from its holds (Overview KPI, staff detail): read-only through M06. */
async function moneyOf(t) {
  const { items } = await escrow.list({ purpose: 'tournament_entry', groupRef: t.id, limit: 1000 });
  const sum = { collected: 0, held: 0, released: 0, refunded: 0, fees: 0 };
  for (const h of items) {
    sum.collected += h.held;
    sum.released += h.released;
    sum.refunded += h.refunded;
    sum.fees += h.feeTaken;
    sum.held += h.available;
  }
  return sum;
}

/** Approved teams whose squad is not ready (the checklist). */
async function readinessSummary(t) {
  const approved = await Registration.findAll({ where: { tournamentId: t.id, status: 'approved' }, attributes: ['id'] });
  let notReady = 0;
  for (const r of approved) if (!(await rosters.readiness(r.id, t)).ready) notReady += 1;
  return { approved: approved.length, notReady };
}

/** The hub's teams: approved teams with player names and NID booleans only. */
async function publicTeams(t) {
  const rows = await Registration.findAll({ where: { tournamentId: t.id, status: 'approved' }, order: [['approvedAt', 'ASC']] });
  const map = await rosters.rostersFor(rows.map((r) => r.id));
  const teams = await Promise.all(rows.map((r) => teamsSvc.getTeam(r.teamId)));
  return rows.map((r, i) => {
    const list = map.get(r.id) ?? [];
    return { teamId: r.teamId, name: teams[i]?.name ?? '—', shortCode: teams[i]?.shortCode ?? null, players: list.length, verified: list.filter((p) => p.nidVerified).length, roster: list.map((p) => ({ displayName: p.displayName, username: p.username, nidVerified: p.nidVerified })) };
  });
}

/** Staff detail: every registration with its money. */
async function staffList(t) {
  const rows = await Registration.findAll({ where: { tournamentId: t.id }, order: [['createdAt', 'ASC']] });
  const teams = await Promise.all(rows.map((r) => teamsSvc.getTeam(r.teamId)));
  return rows.map((r, i) => ({ id: r.id, status: r.status, team: teams[i]?.name ?? '—', feePoisha: r.feePoisha, feeWaived: r.feeWaived, refundedPoisha: r.refundedPoisha, paymentId: r.paymentId, reason: r.reason }));
}

/** Approved team ids in seed order (registration order, or the organiser's manual seeds). */
async function approvedTeams(t, { transaction } = {}) {
  const rows = await Registration.findAll({ where: { tournamentId: t.id, status: 'approved' }, order: [['approvedAt', 'ASC'], ['createdAt', 'ASC']], transaction });
  return rows.map((r) => r.teamId);
}

/** The clock: unpaid holds and lapsed offers end; free places go to the next reserve team. */
async function expireHolds(now = new Date()) {
  const due = await Registration.findAll({
    where: { [Op.or]: [{ status: 'pending_payment', holdExpiresAt: { [Op.lt]: new Date(now.getTime() - 5 * 60000) } }, { status: 'offered', offerExpiresAt: { [Op.lt]: now } }] },
    attributes: ['id', 'tournamentId'],
  });
  for (const { id, tournamentId } of due) {
    await sequelize.transaction(async (transaction) => {
      const t = await Tournament.findByPk(tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
      const r = await Registration.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      const late = (r.status === 'pending_payment' && r.holdExpiresAt < now) || (r.status === 'offered' && r.offerExpiresAt < now);
      if (!late) return;
      await endInTx(r, 'lapsed', { transaction, reason: r.status === 'offered' ? 'offer_expired' : 'unpaid' });
      if (t.status === 'registration_open') await offerNext(t, { transaction });
    });
  }
  return due.length;
}

/** For M16 re-checks: the running tournaments among these ids (with the fields rosters need). */
async function tournamentsOf(ids, { transaction } = {}) {
  return Tournament.findAll({ where: { id: { [Op.in]: ids }, status: { [Op.in]: ['registration_open', 'registration_closed', 'live'] } }, attributes: ['id', 'squadMin', 'squadMax', 'eligibility', 'startDate'], transaction });
}

/** Matches still to play for a team (used when it leaves). */
const openMatchesOf = (t, teamId, transaction) => Match.findAll({ where: { tournamentId: t.id, status: { [Op.in]: ['draft', 'scheduled', 'postponed'] }, [Op.or]: [{ teamAId: teamId }, { teamBId: teamId }] }, transaction });

module.exports = {
  view,
  register,
  onCaptured,
  onPaymentClosed,
  endInTx,
  refundInTx,
  offerNext,
  acceptOffer,
  withdraw,
  setRoster,
  mine,
  orgList,
  approve,
  reject,
  remove,
  waive,
  closeAllOpenInTx,
  cancelAllInTx,
  releaseTranche,
  moneyOf,
  readinessSummary,
  publicTeams,
  staffList,
  approvedTeams,
  expireHolds,
  tournamentsOf,
  openMatchesOf,
};
