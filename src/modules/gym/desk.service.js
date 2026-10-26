'use strict';

/**
 * M20 front desk (FR-05) in the gym app on gym.kriraghor.com (/manage/:id/desk): the gym owner admits a pass by its QR token or its
 * 6-character backup code. Every check runs on the server (no offline admission): the pass is this
 * gym's, active, valid today (Dhaka), not yet used today, and the gym is open now (its live hours).
 * The admission row (UNIQUE pass and day) and the pass row lock settle two scans at once: one admits,
 * the other answers "Already used at 07:42". The first admission releases the pass's money to the
 * owner minus fees.gym_pct; a day pass is then used up.
 *
 * Round B3: the gym's staff work the desk too (business-members actFor): desk.admit admits,
 * desk.admissions lists the day, passes.view lists passes sold without any money. Staff never see the
 * amount released; the money still goes to the gym's owner. Other gyms answer 404 to staff.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, Gym, GymPass, PassRedemption } = require('../../models');
const audit = require('../audit').audit;
const directory = require('../users').directory;
const access = require('../business-members').access;
const rules = require('./gym.rules');
const c = require('./gym.common');

const { fail } = c;
const DESK = ['live', 'paused'];

const actAt = (principal, gymId, ownerId, permission) => access.actFor(principal, 'gym', gymId, permission, { ownerId, notFound: 'Gym', foreign: () => fail('NOT_OWNER') });
const shown = (ctx, body) => (ctx.staff ? access.forStaff(body) : body);

async function ownGym(principal, gymId, permission) {
  const g = await Gym.findByPk(gymId);
  if (!g || g.status === 'removed') throw E.notFound('Gym');
  const ctx = actAt(principal, g.id, g.ownerId, permission);
  if (!DESK.includes(g.status)) throw fail('GYM_STATE');
  return { g, ctx };
}

/** The pass a token or a typed code names (codes are looked up within this gym only). */
async function findPass(g, { token, code }) {
  if (token) {
    const parsed = c.parseToken(token);
    if (!parsed) throw fail('INVALID_PASS_TOKEN');
    const p = await GymPass.findByPk(parsed.passId, { attributes: ['id', 'qrNonce'] });
    if (!p || p.qrNonce !== parsed.nonce) throw fail('INVALID_PASS_TOKEN');
    return { id: p.id, method: 'qr' };
  }
  const normalized = rules.normalizeCode(code);
  if (!normalized) throw fail('INVALID_PASS_TOKEN');
  const p = await GymPass.findOne({ where: { gymId: g.id, backupCode: normalized, status: { [Op.in]: ['active'] } }, attributes: ['id'] });
  if (p) return { id: p.id, method: 'code' };
  // A day pass used up today no longer answers to its code: tell the desk when it was used rather
  // than "not a pass" (codes are unique among active passes only, so look at today's admissions here).
  const used = await GymPass.findOne({ where: { gymId: g.id, backupCode: normalized, status: 'redeemed', lastRedeemedAt: { [Op.gte]: rules.instantOf(c.today()) } }, order: [['lastRedeemedAt', 'DESC']], attributes: ['id', 'lastRedeemedAt'] });
  if (used) throw fail('PASS_ALREADY_REDEEMED', { at: used.lastRedeemedAt.toISOString() });
  throw fail('INVALID_PASS_TOKEN');
}

async function card(p, { redeemedAt, released }) {
  const names = await directory.publicNames([p.holderId]);
  return {
    passCode: p.code,
    kind: p.kind,
    title: p.title,
    validFrom: p.validFrom,
    validTo: p.validTo,
    status: p.status,
    holder: { displayName: names.get(p.holderId)?.displayName ?? null },
    redeemedAt: c.iso(redeemedAt),
    released,
  };
}

/** POST /me/gyms/:id/redemptions { token } | { code }. */
async function redeem(principal, gymId, body, req) {
  const { g, ctx } = await ownGym(principal, gymId, 'desk.admit');
  const found = await findPass(g, body);
  const now = new Date();
  const today = c.today(now);
  return sequelize.transaction(async (transaction) => {
    const p = await c.lockPass(found.id, transaction);
    const used = await PassRedemption.findOne({ where: { passId: p.id, redeemedOn: today }, transaction });
    const block = rules.redeemBlock({ pass: p, gymId: g.id, today, at: now, hours: g.liveSnapshot.hours, usedTodayAt: used?.redeemedAt ?? null });
    if (block) {
      const { code, ...meta } = block;
      throw fail(code, Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])));
    }
    let redemption;
    try {
      redemption = await sequelize.transaction({ transaction }, (savepoint) => PassRedemption.create({ passId: p.id, gymId: g.id, redeemedOn: today, redeemedAt: now, redeemedBy: principal.id, method: found.method }, { transaction: savepoint }));
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw fail('PASS_ALREADY_REDEEMED');
      throw err;
    }
    const a = rules.admission(p);
    const moved = a.release ? await c.release(p, { actor: ctx.actor, transaction }) : { gross: 0, fee: 0, net: 0 };
    await p.update({ status: a.status, firstRedeemedAt: p.firstRedeemedAt ?? now, lastRedeemedAt: now }, { transaction });
    await audit.record({ action: 'gym_pass.redeemed', actor: ctx.actor, entityType: 'gym_pass', entityId: p.id, entityCode: p.code, after: { status: p.status, method: found.method }, meta: { gymId: g.id }, req }, { transaction });
    // M24-FR-52: the redemption row and its Dhaka day, so gym-manage counts a linked member's check-in.
    await c.publishPass(transaction, 'gym_pass.redeemed', p, { method: found.method, released: moved.gross, net: moved.net, redemptionId: redemption.id, redeemedOn: today }, ctx.actor);
    return shown(ctx, await card(p, { redeemedAt: now, released: moved.net }));
  });
}

/** GET /me/gyms/:id/redemptions?date: the day's admissions (default today, Dhaka). */
async function admissions(principal, gymId, { date } = {}) {
  const { g } = await ownGym(principal, gymId, 'desk.admissions');
  const day = date ?? c.today();
  const rows = await PassRedemption.findAll({ where: { gymId: g.id, redeemedOn: day }, order: [['redeemedAt', 'DESC']] });
  const passes = await GymPass.findAll({ where: { id: rows.map((r) => r.passId) } });
  const names = await directory.publicNames(passes.map((p) => p.holderId));
  return {
    date: day,
    items: rows.map((r) => {
      const p = passes.find((x) => x.id === r.passId);
      return { passCode: p.code, kind: p.kind, title: p.title, holder: names.get(p.holderId)?.displayName ?? null, method: r.method, redeemedAt: c.iso(r.redeemedAt) };
    }),
  };
}

/** GET /me/gyms/:id/passes?status: passes sold (codes and dates; the buyer's name only). */
async function sold(principal, gymId, { status } = {}) {
  const g = await Gym.findByPk(gymId);
  // A missing gym stays NOT_OWNER for owners (as before); staff get the 404 of actFor.
  const ctx = actAt(principal, gymId, g?.ownerId, 'passes.view');
  if (!g) throw fail('NOT_OWNER');
  const rows = await GymPass.findAll({ where: { gymId: g.id, status: status ? [status] : { [Op.notIn]: ['void', 'pending_payment'] } }, order: [['createdAt', 'DESC']], limit: 200 });
  const names = await directory.publicNames(rows.map((p) => p.holderId));
  return {
    items: rows.map((p) => ({
      id: p.id,
      code: p.code,
      kind: p.kind,
      title: p.title,
      status: p.status,
      validFrom: p.validFrom,
      validTo: p.validTo,
      holder: names.get(p.holderId)?.displayName ?? null,
      // Round B3: staff with passes.view see the passes, never their money.
      ...(ctx.staff ? {} : { money: { price: p.pricePoisha, fee: p.feePoisha, net: p.netPoisha, released: p.releasedPoisha, refunded: p.refundedPoisha } }),
      paidAt: c.iso(p.paidAt),
      firstRedeemedAt: c.iso(p.firstRedeemedAt),
    })),
  };
}

/**
 * M24 desk search (§4.1, one search box): the pass a QR token or a typed backup code names at this gym,
 * as a card without money or the holder's contact; null when the text is not one of this gym's passes.
 * Admitting it stays POST /me/gyms/:id/redemptions (desk.admit).
 */
async function lookup(gymId, text) {
  const q = String(text ?? '').trim();
  let pass = null;
  const parsed = c.parseToken(q);
  if (parsed) {
    const p = await GymPass.findByPk(parsed.passId);
    if (p && p.qrNonce === parsed.nonce && p.gymId === gymId) pass = p;
  } else {
    const code = rules.normalizeCode(q);
    if (code) pass = await GymPass.findOne({ where: { gymId, backupCode: code, status: 'active' } });
  }
  if (!pass) return null;
  const names = await directory.publicNames([pass.holderId]);
  return { passCode: pass.code, kind: pass.kind, title: pass.title, validFrom: pass.validFrom, validTo: pass.validTo, status: pass.status, holder: { displayName: names.get(pass.holderId)?.displayName ?? null }, method: parsed ? 'qr' : 'code' };
}

module.exports = { redeem, admissions, sold, lookup };
