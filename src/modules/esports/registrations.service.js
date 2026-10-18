'use strict';

/**
 * M21 registrations (FR-08 to FR-13, FR-24, §6.6, §8.2).
 *
 *   register ─slot free─▶ pending_payment ─captured─▶ confirmed ─check-in─▶ checked_in
 *            ─free (fee 0)▶ confirmed                                 ─check-in closes short─▶ no_show
 *            ─full───────▶ waitlisted ─slot freed─▶ offered ─accept─▶ pending_payment | confirmed
 *   pending_payment ─hold expired / payment failed─▶ cancelled (slot freed, next on the waitlist offered)
 *   withdraw: before close → refund esports.withdraw_refund_pct; after close → forfeit (Q122)
 *
 * No overselling (FR-09): every slot change locks the tournament row; UNIQUE(tournament_id, slot_no)
 * is the backstop. A UID (and a player) is in one entry per tournament (partial unique indexes).
 * Money goes through M06: the entry fee is an esports_entry intent pooled by tournament; refunds are
 * M06 policy refunds keyed esports:refund:{registrationId}.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const config = require('../../config');
const realtime = require('../../common/realtime');
const models = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const settings = require('../settings/settings.service');
const gates = require('../auth/gate.service');
const payments = require('../payments/payments.service');
const refunds = require('../payments/refunds.service');
const squads = require('./squads.service');
const { fail, setting, rooms, money } = require('./esports.common');
const rules = require('./esports.rules');

const { sequelize, EsportsTournament, EsportsRegistration, EsportsRegistrationPlayer, EsportsGameProfile, EsportsSquad, EsportsMode, EsportsStage, EsportsCheckin, EsportsMatch } = models;

const OPEN_STATUSES = ['pending_payment', 'confirmed', 'checked_in', 'waitlisted', 'offered'];
const DONE_TOURNAMENT = ['finalised', 'paid_out', 'cancelled'];

// ---------------------------------------------------------------- views

async function playersOf(regIds, { transaction } = {}) {
  const rows = await EsportsRegistrationPlayer.findAll({ where: { registrationId: regIds, status: 'active' }, transaction });
  const profiles = new Map((await EsportsGameProfile.findAll({ where: { id: rows.map((r) => r.gameProfileId) }, transaction })).map((p) => [p.id, p]));
  const names = await require('../users/directory.service').publicNames(rows.map((r) => r.userId), { transaction });
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.registrationId)) by.set(r.registrationId, []);
    const p = profiles.get(r.gameProfileId);
    by.get(r.registrationId).push({ userId: r.userId, profileId: r.gameProfileId, ign: p?.ign ?? null, uidMasked: p ? rules.maskUid(p.uid) : null, isSubstitute: r.isSubstitute, username: names.get(r.userId)?.username ?? null });
  }
  return by;
}

function serialize(r, players = []) {
  return {
    id: r.id,
    tournamentId: r.tournamentId,
    registrantUserId: r.registrantUserId,
    squadId: r.squadId ?? null,
    slotNo: r.slotNo ?? null,
    status: r.status,
    amount: money(r.amountPoisha),
    paymentId: r.paymentId ?? null,
    holdExpiresAt: r.holdExpiresAt ?? null,
    offerExpiresAt: r.offerExpiresAt ?? null,
    waitlistPosition: r.waitlistPosition ?? null,
    prizeSplit: r.prizeSplit ?? null,
    confirmedAt: r.confirmedAt ?? null,
    createdAt: r.createdAt,
    players,
  };
}

const payUrl = (paymentId) => `${config.apps.web}/pay/${paymentId}`;
const announceSlots = (t, transaction) =>
  transaction.afterCommit(async () => {
    const c = (await require('./tournaments.service').slotCounts([t.id])).get(t.id);
    realtime.toRoom(rooms.tournament(t.id), 'esports.slots_updated', { tournamentId: t.id, taken: c.taken, max: t.maxSlots, waitlist: c.waitlist });
  });
const regEvent = (transaction, name, r, extra = {}) =>
  events.publish(transaction, { name, aggregateType: 'esports_registration', aggregateId: r.id, payload: { registrationId: r.id, tournamentId: r.tournamentId, registrantUserId: r.registrantUserId, ...extra } });

async function holdingSlots(t, transaction) {
  const rows = await EsportsRegistration.findAll({ where: { tournamentId: t.id, status: rules.HOLDING }, attributes: ['slotNo'], transaction });
  return new Set(rows.map((r) => r.slotNo).filter((s) => s !== null));
}

async function removePlayers(regId, transaction) {
  await EsportsRegistrationPlayer.update({ status: 'removed' }, { where: { registrationId: regId, status: 'active' }, transaction });
}

// ---------------------------------------------------------------- register (FR-08, FR-09, FR-10)

function gate(principal) {
  const g = gates.evaluateAction(principal, 'join_esports');
  if (!g.allowed) throw E.forbidden(g.code, 'You cannot join tournaments yet', undefined, { next: g.next });
}

/**
 * POST /esports/tournaments/:id/registrations (Idempotency-Key). Body { squadId?, players:[profileId],
 * substitutes:[profileId] }. Returns { registration, payment: { id, payUrl } | null, waitlisted }.
 */
async function register(principal, tournamentId, { squadId = null, players, substitutes = [] }, idempotencyKey, req) {
  gate(principal);
  const userId = principal.user.id;
  const existing = await EsportsRegistration.findOne({ where: { registrantUserId: userId, idempotencyKey } });
  if (existing) return response(existing);
  const t = await EsportsTournament.findByPk(tournamentId);
  if (!t || !rules.PUBLIC.includes(t.status)) throw E.notFound('Tournament');
  const mode = await EsportsMode.findByPk(t.modeId);
  const ids = [...players, ...substitutes];
  const profiles = await EsportsGameProfile.findAll({ where: { id: ids } });
  const byId = new Map(profiles.map((p) => [p.id, p]));
  if (profiles.length !== new Set(ids).size) throw fail('ESPORTS_GAME_PROFILE_REQUIRED');
  const block = rules.rosterBlock({
    players: players.map((id) => byId.get(id)),
    substitutes: substitutes.map((id) => byId.get(id)),
    mode,
    gameId: t.gameId,
    registrantUserId: userId,
    entryUnit: t.entryUnit,
  });
  if (block) throw fail(block);
  if (t.entryUnit === 'squad') {
    const squad = squadId ? await EsportsSquad.findByPk(squadId) : null;
    if (!squad || squad.status !== 'active' || squad.gameId !== t.gameId) throw fail('ESPORTS_NOT_IN_SQUAD');
    if (squad.captainUserId !== userId) throw fail('ESPORTS_SQUAD_CAPTAIN_ONLY');
    const members = new Set((await squads.activeMembers(squad.id)).map((m) => m.userId));
    if (ids.some((id) => !members.has(byId.get(id).userId))) throw fail('ESPORTS_NOT_IN_SQUAD');
  }
  for (const p of profiles) if (await require('./profiles.service').isBanned(p.gameId, p.uid)) throw fail('ESPORTS_UID_BANNED');
  // M22 edge case: the organising team does not play in its own tournament.
  if (t.organiserType === 'organisation' && (await require('./esports.common').organiser.isMember([userId, ...profiles.map((p) => p.userId)], t.organisationId))) throw fail('ESPORTS_CONFLICT_OF_INTEREST');

  try {
    const out = await sequelize.transaction(async (transaction) => {
      const locked = await EsportsTournament.findByPk(t.id, { transaction, lock: transaction.LOCK.UPDATE });
      const now = new Date();
      if (locked.status !== 'registration_open' || now >= locked.registrationClosesAt) throw fail('ESPORTS_REGISTRATION_CLOSED');
      const already = await EsportsRegistrationPlayer.count({ where: { tournamentId: t.id, status: 'active', [Op.or]: [{ userId: ids.map((id) => byId.get(id).userId) }, { gameProfileId: ids }] }, transaction });
      if (already) throw fail('ESPORTS_ALREADY_REGISTERED');
      const taken = await holdingSlots(locked, transaction);
      const offered = await EsportsRegistration.count({ where: { tournamentId: t.id, status: 'offered' }, transaction });
      const free = locked.maxSlots - taken.size - offered > 0 ? rules.freeSlot(taken, locked.maxSlots) : null;
      const fee = locked.entryFeePoisha;
      const holdMin = setting(locked, 'esports.payment_hold_minutes');
      let r;
      if (free !== null) {
        r = await EsportsRegistration.create(
          {
            tournamentId: t.id,
            registrantUserId: userId,
            squadId: t.entryUnit === 'squad' ? squadId : null,
            slotNo: free,
            status: fee > 0 ? 'pending_payment' : 'confirmed',
            amountPoisha: fee,
            holdExpiresAt: fee > 0 ? new Date(now.getTime() + holdMin * 60000) : null,
            confirmedAt: fee > 0 ? null : now,
            idempotencyKey,
          },
          { transaction }
        );
      } else {
        const last = await EsportsRegistration.max('waitlistPosition', { where: { tournamentId: t.id }, transaction });
        r = await EsportsRegistration.create(
          { tournamentId: t.id, registrantUserId: userId, squadId: t.entryUnit === 'squad' ? squadId : null, status: 'waitlisted', amountPoisha: fee, waitlistPosition: (last ?? 0) + 1, idempotencyKey },
          { transaction }
        );
      }
      await EsportsRegistrationPlayer.bulkCreate(
        ids.map((id) => ({ registrationId: r.id, tournamentId: t.id, userId: byId.get(id).userId, gameProfileId: id, isSubstitute: substitutes.includes(id) })),
        { transaction }
      );
      if (r.status === 'pending_payment') await attachPayment(r, locked, transaction);
      await audit.record({ action: 'esports_registration.created', actor: principal, entityType: 'esports_registration', entityId: r.id, after: { status: r.status, slotNo: r.slotNo }, req }, { transaction });
      await regEvent(transaction, r.status === 'waitlisted' ? 'esports_registration.waitlisted' : 'esports_registration.created', r, { status: r.status });
      if (r.status === 'confirmed') await regEvent(transaction, 'esports_registration.confirmed', r, { paid: false });
      announceSlots(locked, transaction);
      return r;
    });
    return response(out);
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const again = await EsportsRegistration.findOne({ where: { registrantUserId: userId, idempotencyKey } });
      if (again) return response(again);
      throw fail('ESPORTS_ALREADY_REGISTERED');
    }
    throw err;
  }
}

/** The entry fee as an M06 esports_entry intent, pooled by tournament, expiring with the slot hold. */
async function attachPayment(r, t, transaction) {
  const payment = await payments.createIntent(
    {
      purpose: 'esports_entry',
      purposeId: r.id,
      payerId: r.registrantUserId,
      amount: t.entryFeePoisha,
      title: `Entry: ${t.titleEn}`,
      groupRef: t.id,
      expiresAt: r.holdExpiresAt,
      idempotencyKey: `esports:reg:${r.id}:${r.holdExpiresAt.getTime()}`,
    },
    { transaction }
  );
  await r.update({ paymentId: payment.id }, { transaction });
  return payment;
}

async function response(r) {
  const players = (await playersOf([r.id])).get(r.id) ?? [];
  return {
    registration: serialize(r, players),
    payment: r.status === 'pending_payment' && r.paymentId ? { id: r.paymentId, payUrl: payUrl(r.paymentId) } : null,
    waitlisted: r.status === 'waitlisted',
  };
}

// ---------------------------------------------------------------- payment events (M06 hook and consumers)

/**
 * M06 onCaptured for esports_entry, inside the capture transaction: confirm the entry, or reject so M06
 * refunds it in full (edge case 2: the hold expired and no slot is free any more).
 */
async function onCaptured({ payment, transaction }) {
  const r = await EsportsRegistration.findOne({ where: { paymentId: payment.id }, transaction, lock: transaction.LOCK.UPDATE });
  if (!r) return 'reject';
  if (['confirmed', 'checked_in'].includes(r.status)) return 'accept';
  const t = await EsportsTournament.findByPk(r.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
  if (r.status === 'cancelled') {
    // The hold lapsed before the money arrived: take a slot if one is still free.
    if (t.status !== 'registration_open' || new Date() >= t.registrationClosesAt) return 'reject';
    const taken = await holdingSlots(t, transaction);
    const free = rules.freeSlot(taken, t.maxSlots);
    if (free === null) return 'reject';
    // Its players may have entered again in the meantime (one entry per player and UID).
    const mine = await EsportsRegistrationPlayer.findAll({ where: { registrationId: r.id }, transaction });
    const clash = await EsportsRegistrationPlayer.count({ where: { tournamentId: t.id, status: 'active', [Op.or]: [{ userId: mine.map((p) => p.userId) }, { gameProfileId: mine.map((p) => p.gameProfileId) }] }, transaction });
    if (clash) return 'reject';
    await EsportsRegistrationPlayer.update({ status: 'active' }, { where: { registrationId: r.id }, transaction });
    await r.update({ slotNo: free }, { transaction });
  } else if (r.status !== 'pending_payment') {
    return 'reject';
  }
  await r.update({ status: 'confirmed', confirmedAt: new Date(), holdExpiresAt: null }, { transaction });
  await regEvent(transaction, 'esports_registration.confirmed', r, { paid: true });
  announceSlots(t, transaction);
  return 'accept';
}

/** payment.failed / payment.expired: an unpaid hold is released and the next on the waitlist offered. */
async function onPaymentClosed(paymentId, { transaction }) {
  const r = await EsportsRegistration.findOne({ where: { paymentId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!r || r.status !== 'pending_payment') return null;
  const t = await EsportsTournament.findByPk(r.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
  await r.update({ status: 'cancelled', slotNo: null, holdExpiresAt: null }, { transaction });
  await removePlayers(r.id, transaction);
  await regEvent(transaction, 'esports_registration.cancelled', r, { reasonCode: 'payment_not_completed' });
  await offerNext(t, { transaction });
  announceSlots(t, transaction);
  return 'cancelled';
}

// ---------------------------------------------------------------- waitlist offers (FR-10, Q124)

/** Offer free slots to the waitlist in order (before registration closes). */
async function offerNext(t, { transaction, now = new Date() }) {
  if (t.status !== 'registration_open' || now >= t.registrationClosesAt) return 0;
  const taken = await holdingSlots(t, transaction);
  const offered = await EsportsRegistration.count({ where: { tournamentId: t.id, status: 'offered' }, transaction });
  let free = t.maxSlots - taken.size - offered;
  let made = 0;
  while (free > 0) {
    const next = await EsportsRegistration.findOne({ where: { tournamentId: t.id, status: 'waitlisted' }, order: [['waitlistPosition', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
    if (!next) break;
    await next.update({ status: 'offered', offerExpiresAt: new Date(now.getTime() + setting(t, 'esports.payment_hold_minutes') * 60000) }, { transaction });
    await regEvent(transaction, 'esports_registration.offered', next, { offerExpiresAt: next.offerExpiresAt.toISOString() });
    free -= 1;
    made += 1;
  }
  return made;
}

/** POST /me/esports/registrations/:id/accept-offer (Idempotency-Key). */
async function acceptOffer(principal, id) {
  const out = await sequelize.transaction(async (transaction) => {
    const r = await EsportsRegistration.findOne({ where: { id, registrantUserId: principal.user.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw E.notFound('Registration');
    if (r.status === 'pending_payment' || r.status === 'confirmed') return r;
    if (r.status !== 'offered') throw fail('ESPORTS_REGISTRATION_STATE');
    const now = new Date();
    if (r.offerExpiresAt <= now) throw fail('ESPORTS_OFFER_EXPIRED');
    const t = await EsportsTournament.findByPk(r.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (t.status !== 'registration_open' || now >= t.registrationClosesAt) throw fail('ESPORTS_REGISTRATION_CLOSED');
    const free = rules.freeSlot(await holdingSlots(t, transaction), t.maxSlots);
    if (free === null) throw fail('SLOTS_FULL');
    const fee = t.entryFeePoisha;
    await r.update(
      fee > 0
        ? { status: 'pending_payment', slotNo: free, offerExpiresAt: null, waitlistPosition: null, holdExpiresAt: new Date(now.getTime() + setting(t, 'esports.payment_hold_minutes') * 60000) }
        : { status: 'confirmed', slotNo: free, offerExpiresAt: null, waitlistPosition: null, confirmedAt: now },
      { transaction }
    );
    if (fee > 0) await attachPayment(r, t, transaction);
    else await regEvent(transaction, 'esports_registration.confirmed', r, { paid: false });
    announceSlots(t, transaction);
    return r;
  });
  return response(out);
}

// ---------------------------------------------------------------- withdraw and refunds (FR-11, §6.6)

/** Refund an entry's fee through M06 (idempotent per registration and reason). Returns the amount. */
async function refundInTx(r, { situation, beforeClose, t, actor = null, transaction }) {
  if (!r.paymentId || r.amountPoisha <= 0) return 0;
  const amount = rules.refundAmount(situation, { paid: r.amountPoisha, beforeClose, withdrawRefundPct: setting(t, 'esports.withdraw_refund_pct') });
  if (amount <= 0) return 0;
  const refund = await refunds.refundPayment({ paymentId: r.paymentId, amount, reasonCode: `esports_${situation}`, idempotencyKey: `esports:refund:${r.id}`, actor }, { transaction });
  return refund ? amount : 0;
}

/** Release an unpaid intent (best effort: one already at the gateway is settled by M06 later). */
async function releaseIntent(r, transaction) {
  if (!r.paymentId) return;
  try {
    await payments.cancelIntent(r.paymentId, { transaction });
  } catch {
    // A capture that lands later is rejected by onCaptured and refunded in full by M06.
  }
}

/** POST /me/esports/registrations/:id/withdraw (the registrant). */
async function withdraw(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const r = await EsportsRegistration.findOne({ where: { id, registrantUserId: principal.user.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw E.notFound('Registration');
    if (!rules.canRegistration(r.status, 'withdrawn')) throw fail('ESPORTS_REGISTRATION_STATE');
    const t = await EsportsTournament.findByPk(r.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (DONE_TOURNAMENT.includes(t.status) || ['live', 'results_pending'].includes(t.status)) throw fail('ESPORTS_REGISTRATION_STATE');
    const now = new Date();
    const beforeClose = now < t.registrationClosesAt;
    const before = { status: r.status };
    let refunded = 0;
    if (r.status === 'pending_payment') await releaseIntent(r, transaction);
    if (['confirmed'].includes(r.status)) refunded = await refundInTx(r, { situation: 'withdraw', beforeClose, t, actor: principal, transaction });
    await r.update({ status: 'withdrawn', slotNo: null, withdrawnAt: now, holdExpiresAt: null, offerExpiresAt: null }, { transaction });
    await removePlayers(r.id, transaction);
    await audit.record({ action: 'esports_registration.withdrawn', actor: principal, entityType: 'esports_registration', entityId: r.id, before, after: { status: 'withdrawn', refunded }, req }, { transaction });
    await regEvent(transaction, 'esports_registration.withdrawn', r, { refunded });
    await offerNext(t, { transaction });
    announceSlots(t, transaction);
    return { ...serialize(r), refunded: money(refunded) };
  });
}

/**
 * Close every open entry of a tournament being cancelled (staff cancel or min_participants not met):
 * paid entries are refunded 100%, unpaid holds released, the waitlist cancelled. Returns the count refunded.
 */
async function closeAllInTx(t, { situation, actor = null, transaction }) {
  const open = await EsportsRegistration.findAll({ where: { tournamentId: t.id, status: OPEN_STATUSES }, transaction, lock: transaction.LOCK.UPDATE });
  let refunded = 0;
  for (const r of open) {
    if (['confirmed', 'checked_in'].includes(r.status)) {
      const amount = await refundInTx(r, { situation, beforeClose: true, t, actor, transaction });
      if (amount > 0) refunded += 1;
      await r.update({ status: amount > 0 ? 'refunded' : 'cancelled', slotNo: null }, { transaction });
      await regEvent(transaction, 'esports_registration.refunded', r, { amount, reasonCode: situation });
    } else {
      if (r.status === 'pending_payment') await releaseIntent(r, transaction);
      await r.update({ status: 'cancelled', slotNo: null, holdExpiresAt: null, offerExpiresAt: null }, { transaction });
    }
    await removePlayers(r.id, transaction);
  }
  return refunded;
}

// ---------------------------------------------------------------- prize split (FR-24)

/** PUT /me/esports/registrations/:id/prize-split (the captain, before the first match). */
async function setSplit(principal, id, { split }, req) {
  return sequelize.transaction(async (transaction) => {
    const r = await EsportsRegistration.findOne({ where: { id, registrantUserId: principal.user.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw E.notFound('Registration');
    const t = await EsportsTournament.findByPk(r.tournamentId, { transaction });
    if (t.entryUnit !== 'squad' || !['confirmed', 'checked_in', 'pending_payment'].includes(r.status)) throw fail('ESPORTS_REGISTRATION_STATE');
    if (new Date() >= t.startsAt) throw fail('ESPORTS_SPLIT_LOCKED');
    const players = await EsportsRegistrationPlayer.findAll({ where: { registrationId: r.id, status: 'active', isSubstitute: false }, transaction });
    const block = rules.splitBlock(split, players.map((p) => p.userId));
    if (block) throw fail(block);
    await r.update({ prizeSplit: split }, { transaction });
    await audit.record({ action: 'esports_registration.split_set', actor: principal, entityType: 'esports_registration', entityId: r.id, after: { split }, req }, { transaction });
    return serialize(r);
  });
}

// ---------------------------------------------------------------- check-in (FR-13)

async function stageOf(t, transaction) {
  return EsportsStage.findOne({ where: { tournamentId: t.id }, order: [['seq', 'ASC']], transaction });
}

/** Check one player in (the player, or staff with source 'staff' — edge case 7). */
async function checkInInTx(r, t, stage, userId, { source, createdBy = null, transaction }) {
  const player = await EsportsRegistrationPlayer.findOne({ where: { registrationId: r.id, userId, status: 'active' }, transaction });
  if (!player) throw fail('ESPORTS_NOT_IN_MATCH');
  const exists = await EsportsCheckin.findOne({ where: { stageId: stage.id, userId }, transaction });
  if (!exists) await EsportsCheckin.create({ stageId: stage.id, registrationId: r.id, userId, source, createdBy }, { transaction });
  const mode = await EsportsMode.findByPk(t.modeId, { transaction });
  const count = await EsportsCheckin.count({ where: { stageId: stage.id, registrationId: r.id }, transaction });
  if (r.status === 'confirmed' && count >= mode.teamSize) {
    await r.update({ status: 'checked_in' }, { transaction });
    await regEvent(transaction, 'esports_registration.checkin_completed', r);
  }
  return count;
}

/** POST /me/esports/registrations/:id/check-in (any listed player of the entry, within the window). */
async function checkIn(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const player = await EsportsRegistrationPlayer.findOne({ where: { registrationId: id, userId: principal.user.id, status: 'active' }, transaction });
    if (!player) throw E.notFound('Registration');
    const r = await EsportsRegistration.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!['confirmed', 'checked_in'].includes(r.status)) throw fail('ESPORTS_REGISTRATION_STATE');
    const t = await EsportsTournament.findByPk(r.tournamentId, { transaction });
    const stage = await stageOf(t, transaction);
    const now = new Date();
    if (now < stage.checkinOpensAt || now >= stage.checkinClosesAt || stage.checkinClosedAt) throw fail('ESPORTS_CHECKIN_CLOSED');
    const checkedIn = await checkInInTx(r, t, stage, principal.user.id, { source: req.get?.('x-client-type') === 'mobile' ? 'mobile' : 'web', transaction });
    await audit.record({ action: 'esports_registration.check_in', actor: principal, entityType: 'esports_registration', entityId: r.id, after: { checkedIn }, req }, { transaction });
    return { ...serialize(r), checkedInPlayers: checkedIn };
  });
}

/** POST /admin/esports/registrations/:id/check-in { userId } (staff, audited; edge case 7). */
async function staffCheckIn(actor, id, { userId }, req) {
  return sequelize.transaction(async (transaction) => {
    const r = await EsportsRegistration.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw E.notFound('Registration');
    if (!['confirmed', 'checked_in', 'no_show'].includes(r.status)) throw fail('ESPORTS_REGISTRATION_STATE');
    const t = await EsportsTournament.findByPk(r.tournamentId, { transaction });
    if (r.status === 'no_show') await r.update({ status: 'confirmed' }, { transaction });
    const checkedIn = await checkInInTx(r, t, await stageOf(t, transaction), userId, { source: 'staff', createdBy: actor.id, transaction });
    await audit.record({ action: 'esports_registration.staff_check_in', actor, entityType: 'esports_registration', entityId: r.id, after: { userId, checkedIn }, req }, { transaction });
    if (r.status === 'checked_in') await require('./rooms.service').deliverToUserInTx(r.tournamentId, userId, { transaction });
    return { ...serialize(r), checkedInPlayers: checkedIn };
  });
}

/** GET /admin/esports/tournaments/:id/checkins: the check-in board. */
async function board(tournamentId) {
  const t = await EsportsTournament.findByPk(tournamentId);
  if (!t) throw E.notFound('Tournament');
  const regs = await EsportsRegistration.findAll({ where: { tournamentId }, order: [['slotNo', 'ASC'], ['waitlistPosition', 'ASC'], ['createdAt', 'ASC']] });
  const players = await playersOf(regs.map((r) => r.id));
  const stage = await stageOf(t);
  const checkins = stage ? await EsportsCheckin.findAll({ where: { stageId: stage.id } }) : [];
  const done = new Set(checkins.map((c) => c.userId));
  return {
    tournamentId,
    stage: stage ? { id: stage.id, checkinOpensAt: stage.checkinOpensAt, checkinClosesAt: stage.checkinClosesAt, closed: Boolean(stage.checkinClosedAt) } : null,
    items: regs.map((r) => ({ ...serialize(r, (players.get(r.id) ?? []).map((p) => ({ ...p, checkedIn: done.has(p.userId) }))) })),
  };
}

// ---------------------------------------------------------------- lifecycle steps (job esports.tick)

/** Unpaid holds past their time (backstop for payment.expired); offers past their time go to the end of the queue. */
async function expireHolds(now = new Date()) {
  const grace = settings.get('payments.unknown_grace_minutes') * 60000;
  const holds = await EsportsRegistration.findAll({ where: { status: 'pending_payment', holdExpiresAt: { [Op.lt]: new Date(now.getTime() - grace) } }, attributes: ['id', 'paymentId'] });
  let expired = 0;
  for (const h of holds) {
    await sequelize.transaction(async (transaction) => {
      const r = await EsportsRegistration.findByPk(h.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (r.status !== 'pending_payment') return;
      await releaseIntent(r, transaction);
      if ((await onPaymentClosed(r.paymentId, { transaction })) === 'cancelled') expired += 1;
    });
  }
  const offers = await EsportsRegistration.findAll({ where: { status: 'offered', offerExpiresAt: { [Op.lt]: now } }, attributes: ['id'] });
  for (const o of offers) {
    await sequelize.transaction(async (transaction) => {
      const r = await EsportsRegistration.findByPk(o.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (r.status !== 'offered') return;
      const t = await EsportsTournament.findByPk(r.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
      const last = await EsportsRegistration.max('waitlistPosition', { where: { tournamentId: t.id }, transaction });
      await r.update({ status: 'waitlisted', offerExpiresAt: null, waitlistPosition: (last ?? 0) + 1 }, { transaction });
      await offerNext(t, { transaction, now });
    });
  }
  return { expired, offersExpired: offers.length };
}

/** At registration close: the waitlist is cancelled; below min_participants the tournament is cancelled (FR-12). */
async function closeRegistrationInTx(t, { transaction }) {
  const waiting = await EsportsRegistration.findAll({ where: { tournamentId: t.id, status: ['waitlisted', 'offered'] }, transaction, lock: transaction.LOCK.UPDATE });
  for (const r of waiting) {
    await r.update({ status: 'cancelled', offerExpiresAt: null }, { transaction });
    await removePlayers(r.id, transaction);
  }
  const confirmed = await EsportsRegistration.count({ where: { tournamentId: t.id, status: rules.PLAYING }, transaction });
  if (confirmed < t.minParticipants) {
    await require('./tournaments.service').cancelInTx(t, { situation: 'min_not_met', reason: `Only ${confirmed} of ${t.minParticipants} entries confirmed`, transaction });
    return 'cancelled';
  }
  await require('./tournaments.service').moveInTx(t, 'registration_closed', { transaction });
  await events.publish(transaction, { name: 'esports_tournament.registration_closed', aggregateType: 'esports_tournament', aggregateId: t.id, payload: { tournamentId: t.id, confirmed } });
  return 'closed';
}

/** At check-in close: entries short of players become no-shows; their fee is forfeited (FR-13, Q122). */
async function closeCheckinInTx(t, stage, { transaction }) {
  const mode = await EsportsMode.findByPk(t.modeId, { transaction });
  const regs = await EsportsRegistration.findAll({ where: { tournamentId: t.id, status: 'confirmed' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const r of regs) {
    const n = await EsportsCheckin.count({ where: { stageId: stage.id, registrationId: r.id }, transaction });
    if (rules.isNoShow(n, mode.teamSize)) {
      await r.update({ status: 'no_show' }, { transaction });
      await regEvent(transaction, 'esports_registration.no_show_marked', r);
    }
  }
  await stage.update({ checkinClosedAt: new Date() }, { transaction });
}

// ---------------------------------------------------------------- fair play, sanctions (FR-04, FR-22, §6.6)

/** Is this profile in an entry of a tournament that is not over? */
async function profileInActiveEntry(profileId, { transaction } = {}) {
  const rows = await EsportsRegistrationPlayer.findAll({ where: { gameProfileId: profileId, status: 'active' }, transaction });
  if (!rows.length) return false;
  const regs = await EsportsRegistration.findAll({ where: { id: rows.map((r) => r.registrationId), status: OPEN_STATUSES }, transaction });
  if (!regs.length) return false;
  const ts = await EsportsTournament.count({ where: { id: regs.map((r) => r.tournamentId), status: { [Op.notIn]: DONE_TOURNAMENT } }, transaction });
  return ts > 0;
}

/** A UID ban (FR-04): the profile's open entries are disqualified with no refund. */
async function forfeitForBan(actor, profileId, { reasonCode, transaction }) {
  const rows = await EsportsRegistrationPlayer.findAll({ where: { gameProfileId: profileId, status: 'active' }, transaction });
  for (const row of rows) {
    const r = await EsportsRegistration.findByPk(row.registrationId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!OPEN_STATUSES.includes(r.status)) continue;
    const t = await EsportsTournament.findByPk(r.tournamentId, { transaction });
    if (DONE_TOURNAMENT.includes(t.status)) continue;
    await require('./results.service').disqualifyInTx(actor, r, t, { reasonCode: reasonCode === 'cheating' ? 'cheating' : 'other', note: 'UID banned', userId: row.userId, effects: { forfeitPrize: true, removeFromStandings: true, banUid: true }, transaction });
  }
}

/**
 * user.suspended / user.banned (§6.6): the user's open entries in tournaments not yet live are withdrawn
 * (refunded before close, forfeited after) and the waitlist entries cancelled.
 */
async function withdrawForSanction(userId, { transaction }) {
  const rows = await EsportsRegistrationPlayer.findAll({ where: { userId, status: 'active' }, transaction });
  for (const row of rows) {
    const r = await EsportsRegistration.findByPk(row.registrationId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!OPEN_STATUSES.includes(r.status)) continue;
    const t = await EsportsTournament.findByPk(r.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!['scheduled', 'registration_open', 'registration_closed', 'check_in'].includes(t.status)) continue;
    const beforeClose = new Date() < t.registrationClosesAt;
    let refunded = 0;
    if (r.status === 'pending_payment') await releaseIntent(r, transaction);
    if (['confirmed', 'checked_in'].includes(r.status)) refunded = await refundInTx(r, { situation: 'suspended', beforeClose, t, transaction });
    await r.update({ status: r.status === 'waitlisted' || r.status === 'offered' ? 'cancelled' : 'withdrawn', slotNo: null, withdrawnAt: new Date() }, { transaction });
    await removePlayers(r.id, transaction);
    await regEvent(transaction, 'esports_registration.withdrawn', r, { refunded, reasonCode: 'account_sanctioned' });
    await offerNext(t, { transaction });
  }
}

// ---------------------------------------------------------------- the player's lists

/** GET /me/esports/registrations: entries I registered or play in, newest tournament first. */
async function mine(userId) {
  const asPlayer = await EsportsRegistrationPlayer.findAll({ where: { userId, status: 'active' }, attributes: ['registrationId'] });
  const regs = await EsportsRegistration.findAll({
    where: { [Op.or]: [{ registrantUserId: userId }, { id: asPlayer.map((p) => p.registrationId) }], status: { [Op.ne]: 'cancelled' } },
    order: [['createdAt', 'DESC']],
    limit: 100,
  });
  const players = await playersOf(regs.map((r) => r.id));
  const ts = await EsportsTournament.findAll({ where: { id: [...new Set(regs.map((r) => r.tournamentId))] } });
  const byT = new Map(ts.map((t) => [t.id, t]));
  const matches = await EsportsMatch.findAll({ where: { tournamentId: ts.map((t) => t.id) }, order: [['seq', 'ASC']] });
  return {
    items: regs.map((r) => {
      const t = byT.get(r.tournamentId);
      return {
        ...serialize(r, players.get(r.id) ?? []),
        payment: r.status === 'pending_payment' && r.paymentId ? { id: r.paymentId, payUrl: payUrl(r.paymentId) } : null,
        tournament: { id: t.id, slug: t.slug, titleEn: t.titleEn, titleBn: t.titleBn, status: t.status, startsAt: t.startsAt, entryUnit: t.entryUnit },
        matches: matches.filter((m) => m.tournamentId === t.id).map((m) => ({ id: m.id, seq: m.seq, startsAt: m.startsAt, status: m.status })),
      };
    }),
  };
}

module.exports = {
  register,
  onCaptured,
  onPaymentClosed,
  offerNext,
  acceptOffer,
  withdraw,
  closeAllInTx,
  refundInTx,
  setSplit,
  checkIn,
  staffCheckIn,
  board,
  expireHolds,
  closeRegistrationInTx,
  closeCheckinInTx,
  profileInActiveEntry,
  forfeitForBan,
  withdrawForSanction,
  mine,
  playersOf,
  serialize,
  stageOf,
  OPEN_STATUSES,
};
