'use strict';

/**
 * M24 §25 chat numbers (M24-FR-157, FR-158): an owner's WhatsApp number used by every branch, a branch's own
 * number that wins over it, and whether the gym page shows the WhatsApp button. These are the business's
 * public contact, so they are stored as E.164 text and shown on the gym page.
 *   GET /manage/whatsapp                  the owner's number and every branch (owner)
 *   PUT /manage/whatsapp/number           the owner's number (owner)
 *   GET/PATCH /manage/gyms/:gymId/whatsapp  one branch (read: owner or whatsapp.send; change: owner)
 *   facade contact.forGym                 the number M20's gym page shows
 * Step 2 (M24-FR-161, FR-165): the owner's view also lists the connected numbers, the units and the sign-up
 * values; a branch chooses which connected number it sends from and which automatic messages go on WhatsApp.
 */
const { sequelize, GymWhatsappOwner, GymWhatsappGym } = require('../../models');
const gymFacade = require('../gym').gyms;
const rules = require('./gym-whatsapp.rules');
const TPL = require('./templates');
const c = require('./gym-whatsapp.common');

/** The owner row and the branch rows of these gyms → { owner, byGym: Map }. */
async function rowsOf(ownerId, gymIds, { transaction } = {}) {
  const owner = await GymWhatsappOwner.findByPk(ownerId, { transaction });
  const gyms = gymIds.length ? await GymWhatsappGym.findAll({ where: { gymId: gymIds }, transaction }) : [];
  return { owner, byGym: new Map(gyms.map((g) => [g.gymId, g])) };
}

function gymView(gym, row, ownerNumber) {
  const gymNumber = row?.number ?? null;
  const showOnPage = row?.showOnPage ?? true;
  return {
    gymId: gym.id,
    name: gym.name,
    number: gymNumber,
    showOnPage,
    source: rules.numberSource({ gymNumber, ownerNumber }),
    shown: rules.chatNumber({ gymNumber, ownerNumber, showOnPage }),
    senderId: row?.senderId ?? null,
    autoKinds: row?.autoKinds ?? [],
  };
}

/** GET /manage/whatsapp (owner, gate run_gym): the owner's number and each branch's. */
async function ownerView(principal) {
  const gyms = await gymFacade.ofOwner(principal.id);
  const { owner, byGym } = await rowsOf(principal.id, gyms.map((g) => g.id));
  const ownerNumber = owner?.number ?? null;
  const senders = require('./senders.service');
  return {
    apiEnabled: c.cfg().apiEnabled,
    number: ownerNumber,
    gyms: gyms.map((g) => gymView(g, byGym.get(g.id), ownerNumber)),
    senders: await senders.listFor(principal.id),
    units: await c.units().view(principal.id),
    signUp: senders.signUpConfig(),
  };
}

/** PUT /manage/whatsapp/number { number } (owner): one number for every branch without its own (null removes it). */
async function setOwnerNumber(principal, { number }, req) {
  const next = number === null ? null : c.phoneOf(number);
  await sequelize.transaction(async (transaction) => {
    const row = await GymWhatsappOwner.findByPk(principal.id, { transaction, lock: transaction.LOCK.UPDATE });
    const before = row?.number ?? null;
    if (before === next) return;
    if (row) await row.update({ number: next, updatedBy: principal.id }, { transaction });
    else await GymWhatsappOwner.create({ ownerId: principal.id, number: next, updatedBy: principal.id }, { transaction });
    await c.record({ action: 'gym_whatsapp.owner_number_set', actor: principal, entityType: 'user', entityId: principal.id, before: { number: before }, after: { number: next }, req }, transaction);
  });
  return ownerView(principal);
}

/** GET /manage/gyms/:gymId/whatsapp (owner or whatsapp.send): one branch, with the owner's number it falls back to. */
async function gymWhatsapp(principal, gymId) {
  const a = await c.gymManage().access(principal, gymId, 'whatsapp.send');
  return viewOf(a.gym);
}

async function viewOf(gym, { transaction } = {}) {
  const { owner, byGym } = await rowsOf(gym.ownerId, [gym.id], { transaction });
  const ownerNumber = owner?.number ?? null;
  const ctx = await require('./messages.service').contextOf(gym, { transaction });
  const sender = ctx.sender ? require('./senders.service').senderView(ctx.sender, [...ctx.templates.values()]) : null;
  return { ...gymView(gym, byGym.get(gym.id), ownerNumber), ownerNumber, apiEnabled: c.cfg().apiEnabled, sender, autoKindsAvailable: TPL.AUTO_KINDS };
}

/** PATCH /manage/gyms/:gymId/whatsapp { number?, showOnPage?, senderId?, autoKinds? } (owner): the branch's own number, the button, the number it sends from and the automatic kinds. */
async function patchGym(principal, gymId, body, req) {
  const a = await c.gymManage().access(principal, gymId, 'owner.only');
  c.gymManage().needs(a, 'owner.only');
  const patch = {};
  if (body.number !== undefined) patch.number = body.number === null ? null : c.phoneOf(body.number);
  if (body.showOnPage !== undefined) patch.showOnPage = body.showOnPage;
  if (body.autoKinds !== undefined) patch.autoKinds = TPL.AUTO_KINDS.filter((k) => body.autoKinds.includes(k));
  if (body.senderId !== undefined) {
    if (body.senderId !== null && !(await require('./senders.service').liveOf(a.gym.ownerId, body.senderId))) throw c.fail('GYM_WHATSAPP_SENDER_STATE', { senderId: body.senderId });
    patch.senderId = body.senderId;
  }
  await sequelize.transaction(async (transaction) => {
    const row = await GymWhatsappGym.findByPk(gymId, { transaction, lock: transaction.LOCK.UPDATE });
    const before = { number: row?.number ?? null, showOnPage: row?.showOnPage ?? true, senderId: row?.senderId ?? null, autoKinds: row?.autoKinds ?? [] };
    const after = { ...before, ...patch };
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (row) await row.update({ ...patch, updatedBy: principal.id }, { transaction });
    else await GymWhatsappGym.create({ gymId, ownerId: a.gym.ownerId, ...after, updatedBy: principal.id }, { transaction });
    await c.record({ action: 'gym_whatsapp.gym_number_set', actor: principal, entityType: 'gym', entityId: gymId, before, after, req }, transaction);
  });
  return viewOf(a.gym);
}

/**
 * Facade contact.forGym (M20's gym page, M24-FR-158): the E.164 number the gym page shows for this branch,
 * or null (no number, or the button switched off).
 */
async function forGym(gymId, ownerId) {
  const { owner, byGym } = await rowsOf(ownerId, [gymId]);
  const row = byGym.get(gymId);
  return rules.chatNumber({ gymNumber: row?.number ?? null, ownerNumber: owner?.number ?? null, showOnPage: row?.showOnPage ?? true });
}

module.exports = { ownerView, setOwnerNumber, gymWhatsapp, patchGym, forGym };
