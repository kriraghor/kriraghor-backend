'use strict';

/**
 * M21 test fixtures (jest and the Postman runners): a player with a verified UID, a tournament body,
 * paid entries and check-in, and helpers that move the stored times so the lifecycle tick advances a
 * tournament (registration, check-in, matches, the dispute window).
 */
const h = require('../helpers');
const f = require('./market');
const lifecycle = require('../../src/modules/esports/esports.lifecycle');

const { api, P, models } = h;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake screenshot')]);
let seq = 0;
let uidSeq = 500000;

const game = (k) => models.EsportsGame.findOne({ where: { key: k } });
const modeOf = async (gameKey, modeKey) => models.EsportsMode.findOne({ where: { gameId: (await game(gameKey)).id, key: modeKey } });
const mapsOf = async (gameKey) => models.EsportsMap.findAll({ where: { gameId: (await game(gameKey)).id }, order: [['sort', 'ASC']] });

/** A member with a verified UID for a game (uploaded and approved on the Moderation desk). */
async function player(reviewer, name, gameKey = 'free_fire') {
  const m = await h.signupUser({ name });
  const up = await api().post(`${P}/me/esports/uploads`).set(h.bearer(m)).set('Content-Type', 'image/jpeg').send(Buffer.concat([JPEG, Buffer.from(f.uniq(name))])).expect(201);
  uidSeq += 1;
  const p = await api().post(`${P}/me/esports/profiles`).set(h.bearer(m)).send({ gameId: (await game(gameKey)).id, uid: `8${uidSeq}`, ign: name.split(' ')[0], screenshotKey: up.body.key }).expect(201);
  await f.review(reviewer, 'game_profile', p.body.id);
  m.profileId = p.body.id;
  return m;
}

/** A tournament body (solo Free Fire by default), starting six hours from now. */
async function tournamentBody({ gameKey = 'free_fire', modeKey = 'solo', fee = 40000, maxSlots = 4, min = 2, prizes = [100000, 50000], killReward = 0, maxPaidKills, matches = 1 } = {}) {
  const mode = await modeOf(gameKey, modeKey);
  const maps = await mapsOf(gameKey);
  const preset = await models.EsportsPointsPreset.findOne({ where: { gameId: mode.gameId } });
  const start = Date.now() + 6 * 3600000;
  return {
    gameId: mode.gameId,
    modeId: mode.id,
    titleEn: `Clutch Cup ${(seq += 1)}`,
    titleBn: 'ক্লাচ কাপ',
    tier: 'daily',
    format: matches > 1 ? 'series' : 'single_match',
    entryFee: fee,
    maxSlots,
    minParticipants: min,
    prizes: prizes.map((amount, i) => ({ place: i + 1, amount })),
    killReward,
    ...(maxPaidKills !== undefined ? { maxPaidKills } : {}),
    pointsPresetId: preset.id,
    registrationOpensAt: new Date(Date.now() + 60000).toISOString(),
    matches: Array.from({ length: matches }, (_, i) => ({ mapId: maps[i % maps.length].id, startsAt: new Date(start + i * 3600000).toISOString() })),
    rulesMd: 'Play fair.',
    featured: false,
  };
}

// ---- moving the clock (the lifecycle job decides from the stored times)
const ago = (ms) => new Date(Date.now() - ms);
const soon = (ms) => new Date(Date.now() + ms);
async function openRegistration(id) {
  await models.EsportsTournament.update({ registrationOpensAt: ago(2 * 3600000) }, { where: { id } });
  await lifecycle.tick();
}
async function closeRegistration(id) {
  await models.EsportsTournament.update({ registrationClosesAt: ago(3600000) }, { where: { id } });
  await lifecycle.tick();
  await h.drainEvents();
}
async function openCheckin(id) {
  await models.EsportsStage.update({ checkinOpensAt: ago(600000), checkinClosesAt: soon(600000) }, { where: { tournamentId: id } });
  await lifecycle.tick();
}
async function startMatches(id) {
  const ms = await models.EsportsMatch.findAll({ where: { tournamentId: id }, order: [['seq', 'ASC']] });
  for (const [i, m] of ms.entries()) await m.update({ startsAt: ago(60000 * (ms.length - i)) });
  await models.EsportsTournament.update({ startsAt: ago(60000 * ms.length) }, { where: { id } });
  await lifecycle.tick();
}
/** The dispute window of every posted match closes: matches turn final. */
async function closeDisputes(id) {
  await models.EsportsMatch.update({ disputeClosesAt: ago(1000) }, { where: { tournamentId: id } });
  await lifecycle.tick();
  await h.drainEvents();
}

/** A paid solo entry (pays through the simulator); returns the registration. */
async function enterPaid(who, tournamentId) {
  const r = await api().post(`${P}/esports/tournaments/${tournamentId}/registrations`).set(h.bearer(who)).set('Idempotency-Key', f.uniq('reg')).send({ players: [who.profileId] }).expect(201);
  if (r.body.payment) await h.payWithSimulator(who, r.body.payment.id);
  return r.body.registration;
}

/** Register and pay every player, close registration, open check-in and check them in. */
async function fill(tournamentId, people) {
  await openRegistration(tournamentId);
  for (const p of people) p.reg = await enterPaid(p, tournamentId);
  await closeRegistration(tournamentId);
  await openCheckin(tournamentId);
  for (const p of people) await api().post(`${P}/me/esports/registrations/${p.reg.id}/check-in`).set(h.bearer(p)).expect(200);
}

const matchesOf = (id) => models.EsportsMatch.findAll({ where: { tournamentId: id }, order: [['seq', 'ASC']] });

module.exports = { JPEG, game, modeOf, mapsOf, player, tournamentBody, ago, soon, openRegistration, closeRegistration, openCheckin, startMatches, closeDisputes, enterPaid, fill, matchesOf };
