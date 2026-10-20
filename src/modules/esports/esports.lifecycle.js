'use strict';

/**
 * M21 time-based moves (job esports.tick, every minute; spec §10). Each step is guarded by status, so
 * running it twice (or two workers at once) changes nothing the second time:
 *   scheduled ─registration_opens_at─▶ registration_open
 *   registration_open ─registration_closes_at─▶ registration_closed (or cancelled below the minimum, FR-12)
 *   registration_closed ─check-in opens─▶ check_in;  check-in closes ─▶ no-shows (FR-13)
 *   unpaid holds and slot offers past their time; room reveal at reveal_at (FR-15)
 *   check_in ─first match starts─▶ live;  dispute windows that closed ─▶ match final (FR-21)
 * Per-entity delayed jobs with deterministic ids are a step-2 refinement; the room API already serves
 * credentials from reveal_at even if a tick is late.
 */
const { Op } = require('sequelize');
const realtime = require('../../common/realtime');
const models = require('../../models');
const events = require('../events').events;
const registrations = require('./registrations.service');
const rooms = require('./rooms.service');
const results = require('./results.service');
const tournaments = require('./tournaments.service');
const { rooms: roomNames } = require('./esports.common');

const { sequelize, EsportsTournament, EsportsStage, EsportsMatch } = models;

async function each(where, fn) {
  const rows = await EsportsTournament.findAll({ where, attributes: ['id'] });
  let n = 0;
  for (const r of rows) {
    await sequelize.transaction(async (transaction) => {
      const t = await EsportsTournament.findByPk(r.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (await fn(t, transaction)) n += 1;
    });
  }
  return n;
}

async function tick(now = new Date()) {
  const out = {};
  out.opened = await each({ status: 'scheduled', registrationOpensAt: { [Op.lte]: now } }, async (t, transaction) => {
    if (t.status !== 'scheduled') return false;
    await tournaments.moveInTx(t, 'registration_open', { transaction });
    await events.publish(transaction, { name: 'esports_tournament.registration_opened', aggregateType: 'esports_tournament', aggregateId: t.id, payload: { tournamentId: t.id, gameId: t.gameId } });
    return true;
  });
  out.closed = await each({ status: 'registration_open', registrationClosesAt: { [Op.lte]: now } }, async (t, transaction) => {
    if (t.status !== 'registration_open') return false;
    await registrations.closeRegistrationInTx(t, { transaction });
    return true;
  });
  out.checkinOpened = await each({ status: 'registration_closed' }, async (t, transaction) => {
    const stage = await registrations.stageOf(t, transaction);
    if (t.status !== 'registration_closed' || stage.checkinOpensAt > now) return false;
    await stage.update({ checkinOpenedAt: now }, { transaction });
    await tournaments.moveInTx(t, 'check_in', { transaction });
    await events.publish(transaction, { name: 'esports_tournament.checkin_opened', aggregateType: 'esports_tournament', aggregateId: t.id, payload: { tournamentId: t.id, stageId: stage.id, closesAt: stage.checkinClosesAt.toISOString() } });
    return true;
  });
  out.checkinClosed = await each({ status: ['check_in', 'live'] }, async (t, transaction) => {
    const stage = await EsportsStage.findOne({ where: { tournamentId: t.id, checkinClosedAt: null, checkinClosesAt: { [Op.lte]: now } }, transaction, lock: transaction.LOCK.UPDATE });
    if (!stage) return false;
    await registrations.closeCheckinInTx(t, stage, { transaction });
    return true;
  });
  Object.assign(out, await registrations.expireHolds(now));
  Object.assign(out, await rooms.revealDue(now));
  out.live = await each({ status: 'check_in', startsAt: { [Op.lte]: now } }, async (t, transaction) => {
    if (t.status !== 'check_in') return false;
    await EsportsMatch.update({ status: 'live' }, { where: { tournamentId: t.id, status: 'room_revealed', startsAt: { [Op.lte]: now } }, transaction });
    await tournaments.moveInTx(t, 'live', { transaction });
    return true;
  });
  // Later matches of a live series go live at their start.
  const [, started] = await EsportsMatch.update({ status: 'live' }, { where: { status: 'room_revealed', startsAt: { [Op.lte]: now } }, returning: true });
  for (const m of started ?? []) realtime.toRoom(roomNames.match(m.id), 'esports.match_status', { matchId: m.id, status: 'live' });
  Object.assign(out, await results.closeWindows(now));
  return out;
}

module.exports = { tick };
