'use strict';

/**
 * M24 §21 desk mode with a PIN (product owner, 11 Nov 2026; ADR-010; M24-FR-134 to FR-143).
 *
 *  - Each person (the owner, each staff member) sets their own 4-digit desk PIN for a gym from their own
 *    sign-in (FR-134). Only an argon2id hash over a server-keyed value is kept. The owner can clear a
 *    staff member's PIN, never read it (FR-135).
 *  - Someone who works at the gym switches desk mode on for the device they are signed in on (FR-136): a
 *    gym_desk_sessions row bound to that sign-in's session family, so a token refresh changes nothing.
 *    From then on the device does nothing until a person picks their name and types their PIN.
 *  - While unlocked, the server acts as that person with that person's permissions (the request guard
 *    swaps the principal, FR-138); audit rows say it was a desk and who opened it (meta.desk).
 *  - Idle for gym_manage.desk_idle_minutes → locked; only the page's touch (real input) keeps it awake.
 *  - Wrong PINs are counted in the database before the PIN is checked, under row locks, so parallel guesses
 *    cannot race (FR-137): per person and gym, and per device.
 *  - Owner-only pages never open in desk mode, even after the owner's PIN (business-members actFor, FR-140).
 *  - Ending desk mode signs the device out (FR-141): a 4-digit PIN must never hand back a full sign-in. Any
 *    valid PIN of the gym ends it; the owner can end it from their own sign-in elsewhere.
 *  - A removed staff member's unlock, or a desk whose opener no longer works at the gym, ends on the next
 *    request (FR-142).
 */
const crypto = require('crypto');
const argon2 = require('@node-rs/argon2');
const config = require('../../config');
const { E } = require('../../common/errors');
const { sequelize, GymDeskPin, GymDeskSession, GymDeskUnlock } = require('../../models');
const gymFacade = require('../gym').gyms;
const staffFacade = require('../business-members').members;
const access = require('../business-members').access;
const directory = require('../users').directory;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');

const MINUTE = 60000;
// argon2id at the OWASP minimum (19 MiB, t=2): a 4-digit PIN is guarded by the server key and the try
// counters, not by the hash cost, and the desk unlocks often.
const HASH_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, algorithm: 2 };
let pepperKey = null;
const pepper = () => (pepperKey ??= Buffer.from(crypto.hkdfSync('sha256', config.crypto.dataKey, Buffer.alloc(0), 'kriraghor/gym-desk-pin/v1', 32)));
/** The value that is hashed: the PIN keyed by the server and bound to the person and the gym. */
const keyed = (gymId, userId, pin) => crypto.createHmac('sha256', pepper()).update(`${gymId}:${userId}:${pin}`).digest('hex');
const hashPin = (gymId, userId, pin) => argon2.hash(keyed(gymId, userId, pin), HASH_OPTIONS);
const pinMatches = async (row, pin) => {
  try {
    return await argon2.verify(row.pinHash, keyed(row.gymId, row.userId, pin));
  } catch {
    return false;
  }
};

const cfg = () => {
  const x = c.cfg();
  return { idle: x.deskIdleMinutes, failLimit: x.deskPinFailLimit, lockMinutes: x.deskPinLockMinutes, maxLockouts: x.deskPinMaxLockouts, deviceLimit: x.deskDeviceFailLimit };
};
const later = (now, minutes) => new Date(now.getTime() + minutes * MINUTE);
const future = (d, now) => (d && new Date(d).getTime() > now.getTime() ? c.iso(d) : null);

/** The people who can unlock a gym's desk: the owner and its active staff, with their PIN state. */
async function people(gymId, { now = new Date(), transaction } = {}) {
  const gym = await gymFacade.get(gymId);
  if (!gym) return [];
  const staff = (await staffFacade.staffOf('gym', gymId)).filter((s) => s.status === 'active').map((s) => s.memberId);
  const ids = [...new Set([gym.ownerId, ...staff])];
  const [names, pins] = await Promise.all([directory.displayNames(ids), GymDeskPin.findAll({ where: { gymId, userId: ids }, transaction })]);
  const pinOf = new Map(pins.map((p) => [p.userId, p]));
  return ids.map((userId) => {
    const p = pinOf.get(userId);
    return {
      userId,
      displayName: names.get(userId) ?? null,
      role: userId === gym.ownerId ? 'owner' : 'staff',
      pin: p?.status === 'active' ? 'set' : p ? 'cleared' : 'none',
      lockedUntil: p?.status === 'active' ? future(p.lockedUntil, now) : null,
    };
  });
}

/** End a desk's live unlock (if any), with the reason. */
async function endUnlock(deskSessionId, reason, now, transaction) {
  await GymDeskUnlock.update({ endedAt: now, endReason: reason }, { where: { deskSessionId, endedAt: null }, transaction });
}

/** End every live unlock of one person at a gym (their PIN was reset, they were removed). */
async function endUnlocksOf(gymId, userId, reason, now, transaction) {
  await GymDeskUnlock.update({ endedAt: now, endReason: reason }, { where: { gymId, userId, endedAt: null }, transaction });
}

/** Close a desk: the session, its unlock, and the sign-in it was opened on (signed out, FR-141). */
async function closeDesk(s, { reason, by = null, now = new Date(), transaction }) {
  await GymDeskSession.update({ status: 'closed', closedAt: now, closedBy: by, closeReason: reason }, { where: { id: s.id, status: 'open' }, transaction });
  await endUnlock(s.id, 'closed', now, transaction);
  await require('../auth').session.revokeFamilyOf(s.openedSessionId, 'logout', { transaction });
}

// ---------------------------------------------------------------- my own PIN (FR-134)

/** My desk PINs at every gym I have one for (never the PIN itself). */
async function myPins(principal) {
  const now = new Date();
  const rows = await GymDeskPin.findAll({ where: { userId: principal.id }, order: [['setAt', 'DESC']] });
  return { items: rows.map((r) => ({ gymId: r.gymId, set: r.status === 'active', setAt: r.status === 'active' ? c.iso(r.setAt) : null, lockedUntil: r.status === 'active' ? future(r.lockedUntil, now) : null })) };
}

/** Set or change my own desk PIN for a gym I work at (the owner too). Weak PINs are refused. */
async function setPin(principal, { gymId, pin }, req) {
  const a = await c.gymAccess(principal, gymId, null);
  const phone = await directory.verifiedPhoneOf(principal.id);
  const why = rules.deskPinBlock({ pin, phoneLast4: phone ? String(phone).slice(-4) : null });
  if (why) throw c.fail('GYM_DESK_PIN_WEAK', { reason: why });
  const pinHash = await hashPin(gymId, principal.id, pin);
  const now = new Date();
  return sequelize.transaction(async (transaction) => {
    const row = await GymDeskPin.findOne({ where: { gymId, userId: principal.id }, lock: transaction.LOCK.UPDATE, transaction });
    const values = { pinHash, status: 'active', failedCount: 0, lockouts: 0, lockedUntil: null, setAt: now, clearedAt: null, clearedBy: null };
    if (row) await row.update(values, { transaction });
    else await GymDeskPin.create({ gymId, userId: principal.id, ...values }, { transaction });
    // A changed PIN ends any desk unlocked with the old one.
    if (row) await endUnlocksOf(gymId, principal.id, 'pin_reset', now, transaction);
    await c.record({ action: 'gym_desk.pin_set', actor: a.actor, entityType: 'gym', entityId: gymId, after: { changed: Boolean(row) }, meta: { gymId }, req }, transaction);
    return { gymId, set: true, setAt: c.iso(now), lockedUntil: null };
  });
}

// ---------------------------------------------------------------- the owner's view (FR-135, FR-141)

/** Who has a desk PIN at this gym, and the devices in desk mode now (owner only). */
async function overview(principal, gymId) {
  await c.gymAccess(principal, gymId, 'owner.only');
  const now = new Date();
  const [list, desks] = await Promise.all([people(gymId, { now }), GymDeskSession.findAll({ where: { gymId, status: 'open' }, order: [['openedAt', 'ASC']] })]);
  const live = desks.length ? await GymDeskUnlock.findAll({ where: { deskSessionId: desks.map((d) => d.id), endedAt: null } }) : [];
  const liveOf = new Map(live.filter((u) => rules.deskUnlockLive(u, now)).map((u) => [u.deskSessionId, u]));
  const names = await directory.displayNames([...new Set([...desks.map((d) => d.openedBy), ...[...liveOf.values()].map((u) => u.userId)])]);
  return {
    people: list,
    desks: desks.map((d) => {
      const u = liveOf.get(d.id);
      return { deskId: d.id, openedBy: { userId: d.openedBy, displayName: names.get(d.openedBy) ?? null }, openedAt: c.iso(d.openedAt), unlockedBy: u ? { userId: u.userId, displayName: names.get(u.userId) ?? null } : null };
    }),
  };
}

/** Clear a staff member's desk PIN (owner only; never read). Their desk unlocks end. */
async function resetPin(principal, gymId, userId, req) {
  const a = await c.gymAccess(principal, gymId, 'owner.only');
  const now = new Date();
  return sequelize.transaction(async (transaction) => {
    const row = await GymDeskPin.findOne({ where: { gymId, userId }, lock: transaction.LOCK.UPDATE, transaction });
    if (!row) throw E.notFound('Desk PIN');
    if (row.status === 'active') {
      await row.update({ status: 'cleared', pinHash: null, failedCount: 0, lockedUntil: null, clearedAt: now, clearedBy: principal.id }, { transaction });
      await endUnlocksOf(gymId, userId, 'pin_reset', now, transaction);
      await c.record({ action: 'gym_desk.pin_reset', actor: a.actor, entityType: 'user', entityId: userId, meta: { gymId }, req }, transaction);
    }
    return { gymId, userId, pin: 'cleared' };
  });
}

/** End desk mode on every device at this gym from the owner's own sign-in (FR-141); each device is signed out. */
async function endByOwner(principal, gymId, req) {
  const a = await c.gymAccess(principal, gymId, 'owner.only');
  const now = new Date();
  return sequelize.transaction(async (transaction) => {
    const open = await GymDeskSession.findAll({ where: { gymId, status: 'open' }, lock: transaction.LOCK.UPDATE, transaction });
    for (const s of open) {
      await closeDesk(s, { reason: 'ended_by_owner', by: principal.id, now, transaction });
      await c.record({ action: 'gym_desk.ended_by_owner', actor: a.actor, entityType: 'gym', entityId: gymId, meta: { gymId, deskSessionId: s.id }, req }, transaction);
    }
    return { gymId, ended: open.length };
  });
}

// ---------------------------------------------------------------- the device (FR-136 to FR-139)

/** The open desk of a sign-in family, or null. */
const deskOf = (familyId, { transaction } = {}) => (familyId ? GymDeskSession.findOne({ where: { familyId, status: 'open' }, transaction }) : Promise.resolve(null));

/** What the device shows: off, or the desk with who is unlocked and the names for the lock screen. */
async function state(principal, auth) {
  const s = await deskOf(auth?.familyId);
  if (!s) return { open: false };
  return stateOf(s);
}

async function stateOf(s) {
  const now = new Date();
  const [gym, unlock, list] = await Promise.all([gymFacade.get(s.gymId), GymDeskUnlock.findOne({ where: { deskSessionId: s.id, endedAt: null } }), people(s.gymId, { now })]);
  const live = rules.deskUnlockLive(unlock, now) ? unlock : null;
  const who = live ? list.find((p) => p.userId === live.userId) : null;
  return {
    open: true,
    deskId: s.id,
    gym: { id: s.gymId, name: gym?.name ?? null },
    idleMinutes: cfg().idle,
    // M24 §22: wrong PINs the device allows a person while it has no connection (then that person waits for it).
    pinFailLimit: cfg().failLimit,
    deviceLockedUntil: future(s.deviceLockedUntil, now),
    unlocked: live ? { userId: live.userId, unlockId: live.id, displayName: who?.displayName ?? null, role: who?.role ?? 'staff', expiresAt: c.iso(live.expiresAt) } : null,
    // Only people who can unlock: those with a PIN set (the rest set one from their own sign-in first).
    people: list.filter((p) => p.pin === 'set').map(({ userId, displayName, role, lockedUntil }) => ({ userId, displayName, role, lockedUntil })),
  };
}

/** Switch desk mode on for this device (the sign-in it is on). The opener needs their own PIN set. */
async function open(principal, auth, gymId, req) {
  const a = await c.gymAccess(principal, gymId, null, { feature: 'desk_mode', restricted: true });
  const mine = await GymDeskPin.findOne({ where: { gymId, userId: principal.id } });
  if (mine?.status !== 'active') throw c.fail('GYM_DESK_PIN_REQUIRED');
  if (await deskOf(auth.familyId)) throw c.fail('GYM_DESK_STATE', { reason: 'already_open' });
  const now = new Date();
  const s = await sequelize.transaction(async (transaction) => {
    const row = await GymDeskSession.create(
      { gymId, ownerId: a.gym.ownerId, openedBy: principal.id, familyId: auth.familyId, openedSessionId: auth.sessionId, status: 'open', openedAt: now },
      { transaction }
    );
    await c.record({ action: 'gym_desk.opened', actor: a.actor, entityType: 'gym', entityId: gymId, meta: { gymId, deskSessionId: row.id }, req }, transaction);
    return row;
  });
  return stateOf(s);
}

/**
 * One PIN try at a desk, counted before it is checked (FR-137). Returns { ok, row, outcome } after the
 * counters are saved; the caller acts on `ok` inside the same transaction. A locked person or device is
 * refused without a try. canUnlock (the person is the owner or active staff) is read before the transaction:
 * while tries queue on the row locks, the try in hand must not need a second pool connection.
 */
async function attempt(s, userId, pin, now, transaction, canUnlock) {
  const c2 = cfg();
  if (s.deviceLockedUntil && new Date(s.deviceLockedUntil) > now) return { ok: false, error: c.fail('GYM_DESK_PIN_LOCKED', { until: c.iso(s.deviceLockedUntil), scope: 'device' }) };
  const row = canUnlock ? await GymDeskPin.findOne({ where: { gymId: s.gymId, userId }, lock: transaction.LOCK.UPDATE, transaction }) : null;
  if (!row || row.status !== 'active') return { ok: false, error: c.fail('GYM_DESK_PIN_REQUIRED') };
  if (row.lockedUntil && new Date(row.lockedUntil) > now) return { ok: false, error: c.fail('GYM_DESK_PIN_LOCKED', { until: c.iso(row.lockedUntil), scope: 'person' }) };
  // Count first, then check.
  row.failedCount += 1;
  s.deviceFailCount += 1;
  if (await pinMatches(row, pin)) {
    await row.update({ failedCount: 0, lockouts: 0, lockedUntil: null }, { transaction });
    await s.update({ deviceFailCount: 0, deviceLockedUntil: null }, { transaction });
    return { ok: true, row };
  }
  const wrong = rules.deskPinWrong({ failed: row.failedCount, lockouts: row.lockouts, failLimit: c2.failLimit, maxLockouts: c2.maxLockouts });
  const pinPatch = { failedCount: row.failedCount };
  let error = c.fail('GYM_DESK_PIN_WRONG', { left: wrong.left });
  if (wrong.lock) {
    Object.assign(pinPatch, { failedCount: 0, lockouts: row.lockouts + 1, lockedUntil: later(now, c2.lockMinutes) });
    error = c.fail('GYM_DESK_PIN_LOCKED', { until: c.iso(pinPatch.lockedUntil), scope: 'person' });
  }
  if (wrong.clear) {
    Object.assign(pinPatch, { status: 'cleared', pinHash: null, lockedUntil: null, lockouts: 0, clearedAt: now, clearedBy: null });
    error = c.fail('GYM_DESK_PIN_REQUIRED', { reason: 'cleared' });
  }
  await row.update(pinPatch, { transaction });
  const devicePatch = { deviceFailCount: s.deviceFailCount };
  if (s.deviceFailCount >= c2.deviceLimit) {
    Object.assign(devicePatch, { deviceFailCount: 0, deviceLockedUntil: later(now, c2.lockMinutes) });
    // The device now waits, whoever is tried next: say so rather than the person's tries left.
    if (!wrong.clear) error = c.fail('GYM_DESK_PIN_LOCKED', { until: c.iso(devicePatch.deviceLockedUntil), scope: 'device' });
  }
  await s.update(devicePatch, { transaction });
  const action = wrong.clear ? 'gym_desk.pin_cleared' : wrong.lock ? 'gym_desk.pin_locked' : null;
  return { ok: false, error, action, deviceLocked: Boolean(devicePatch.deviceLockedUntil) };
}

/** Unlock the desk as a person (their PIN). The previous person's unlock ends. */
async function unlock(req, { userId, pin }) {
  const now = new Date();
  const canUnlock = (await people(req.desk.session.gymId, { now })).some((p) => p.userId === userId);
  const result = await sequelize.transaction(async (transaction) => {
    const s = await GymDeskSession.findByPk(req.desk.session.id, { lock: transaction.LOCK.UPDATE, transaction });
    if (!s || s.status !== 'open') throw c.fail('GYM_DESK_STATE', { reason: 'closed' });
    const tried = await attempt(s, userId, pin, now, transaction, canUnlock);
    const meta = { gymId: s.gymId, deskSessionId: s.id, userId };
    if (!tried.ok) {
      if (tried.action) await c.record({ action: tried.action, actor: req.user, entityType: 'user', entityId: userId, meta, req }, transaction);
      if (tried.deviceLocked) await c.record({ action: 'gym_desk.device_locked', actor: req.user, entityType: 'gym', entityId: s.gymId, meta, req }, transaction);
      return { error: tried.error };
    }
    await endUnlock(s.id, 'switched', now, transaction);
    await GymDeskUnlock.create({ deskSessionId: s.id, gymId: s.gymId, userId, unlockedAt: now, lastTouchAt: now, expiresAt: rules.deskIdleUntil(now, cfg().idle) }, { transaction });
    await c.record({ action: 'gym_desk.unlocked', actor: req.user, entityType: 'user', entityId: userId, meta, req }, transaction);
    return { s };
  });
  // The tries are saved even when the PIN was wrong: throw only after the commit.
  if (result.error) throw result.error;
  return stateOf(result.s);
}

/** Lock the desk now (the person is done). */
async function lock(req) {
  await endUnlock(req.desk.session.id, 'locked', new Date(), null);
  return stateOf(req.desk.session);
}

/** Real input at the desk keeps it unlocked for another idle period. */
async function touch(req) {
  const now = new Date();
  const u = await GymDeskUnlock.findOne({ where: { deskSessionId: req.desk.session.id, endedAt: null } });
  if (!rules.deskUnlockLive(u, now)) throw c.fail('GYM_DESK_LOCKED');
  await u.update({ lastTouchAt: now, expiresAt: rules.deskIdleUntil(now, cfg().idle) });
  return { expiresAt: c.iso(u.expiresAt) };
}

/** End desk mode with any valid PIN of the gym (FR-141). The device is signed out. */
async function close(req, { userId, pin }) {
  const now = new Date();
  const canUnlock = (await people(req.desk.session.gymId, { now })).some((p) => p.userId === userId);
  const result = await sequelize.transaction(async (transaction) => {
    const s = await GymDeskSession.findByPk(req.desk.session.id, { lock: transaction.LOCK.UPDATE, transaction });
    if (!s || s.status !== 'open') throw c.fail('GYM_DESK_STATE', { reason: 'closed' });
    const tried = await attempt(s, userId, pin, now, transaction, canUnlock);
    const meta = { gymId: s.gymId, deskSessionId: s.id, userId };
    if (!tried.ok) {
      if (tried.action) await c.record({ action: tried.action, actor: req.user, entityType: 'user', entityId: userId, meta, req }, transaction);
      return { error: tried.error };
    }
    await closeDesk(s, { reason: 'ended', by: userId, now, transaction });
    await c.record({ action: 'gym_desk.closed', actor: req.user, entityType: 'gym', entityId: s.gymId, meta, req }, transaction);
    return { gymId: s.gymId };
  });
  if (result.error) throw result.error;
  return { open: false, signedOut: true };
}

// ---------------------------------------------------------------- the request guard (FR-138, FR-139, FR-142)

const API_PREFIX = /^\/api\/v\d+/;

/**
 * Runs after a customer token is accepted. On a device in desk mode: desk-mode endpoints and sign-out pass
 * as the sign-in (req.desk); the desk gym's work needs a live unlock and runs as the unlocked person
 * (req.user swapped, with `desk`); everything else is refused. Without an open desk it does nothing.
 */
async function guard(req) {
  const s = await deskOf(req.auth?.familyId);
  if (!s) return;
  const path = (req.originalUrl || req.url).replace(API_PREFIX, '');
  const kind = rules.deskRoute({ method: req.method, path, gymId: s.gymId });
  const gym = await gymFacade.get(s.gymId);
  const now = new Date();
  // The opener must still work at the gym (FR-142); otherwise the desk ends and the device is signed out.
  try {
    if (!gym) throw new Error('gone');
    access.actFor(req.user, 'gym', s.gymId, null, { ownerId: gym.ownerId, notFound: 'Gym' });
  } catch {
    await sequelize.transaction((transaction) => closeDesk(s, { reason: 'opener_left', now, transaction }));
    throw E.unauthorized('AUTH_REQUIRED', 'Sign in to continue');
  }
  if (kind === 'control') {
    if (req.method === 'POST' && path.split('?')[0].replace(/\/+$/, '') === '/auth/logout') {
      await sequelize.transaction((transaction) => closeDesk(s, { reason: 'signed_out', now, transaction }));
      return;
    }
    req.desk = { session: s };
    return;
  }
  if (kind === 'outside') throw c.fail('GYM_DESK_SCOPE');
  const u = await GymDeskUnlock.findOne({ where: { deskSessionId: s.id, endedAt: null } });
  if (!rules.deskUnlockLive(u, now)) {
    if (u) await endUnlock(s.id, 'idle', now, null);
    throw c.fail('GYM_DESK_LOCKED');
  }
  const person = await require('../auth').authz.loadPrincipal(u.userId);
  try {
    if (!person) throw new Error('gone');
    access.actFor(person, 'gym', s.gymId, null, { ownerId: gym.ownerId, notFound: 'Gym' });
  } catch {
    await endUnlock(s.id, 'removed', now, null);
    throw c.fail('GYM_DESK_LOCKED');
  }
  req.desk = { session: s, unlock: u, opener: req.user };
  req.user = { ...person, desk: { sessionId: s.id, unlockId: u.id, gymId: s.gymId, openedBy: s.openedBy } };
}

/** For Socket.IO: the gym of a sign-in family's open desk, or null (FR-143). */
async function deskGymOf(familyId) {
  const s = await deskOf(familyId);
  return s ? s.gymId : null;
}

module.exports = { myPins, setPin, overview, resetPin, endByOwner, state, open, unlock, lock, touch, close, guard, deskGymOf, people };
