'use strict';

/**
 * M24 §25 chat numbers (M24-FR-157, FR-158): an owner's WhatsApp number used by every branch, a branch's own
 * number that wins over it, and whether the gym page shows the WhatsApp button. These are the business's
 * public contact, so they are stored as E.164 text and shown on the gym page.
 *   GET /manage/whatsapp                  the owner's number and every branch (owner)
 *   PUT /manage/whatsapp/number           the owner's number (owner)
 *   GET/PATCH /manage/gyms/:gymId/whatsapp  one branch (owner)
 *   facade contact.forGym                 the number M20's gym page shows
 */
const { sequelize, GymWhatsappOwner, GymWhatsappGym } = require('../../models');
const gymFacade = require('../gym').gyms;
const rules = require('./gym-whatsapp.rules');
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
  };
}

/** GET /manage/whatsapp (owner, gate run_gym): the owner's number and each branch's. */
async function ownerView(principal) {
  const gyms = await gymFacade.ofOwner(principal.id);
  const { owner, byGym } = await rowsOf(principal.id, gyms.map((g) => g.id));
  const ownerNumber = owner?.number ?? null;
  return { apiEnabled: c.cfg().apiEnabled, number: ownerNumber, gyms: gyms.map((g) => gymView(g, byGym.get(g.id), ownerNumber)) };
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

/** GET /manage/gyms/:gymId/whatsapp (owner): one branch, with the owner's number it falls back to. */
async function gymWhatsapp(principal, gymId) {
  const a = await c.gymManage().access(principal, gymId, 'owner.only');
  return viewOf(a.gym);
}

async function viewOf(gym, { transaction } = {}) {
  const { owner, byGym } = await rowsOf(gym.ownerId, [gym.id], { transaction });
  const ownerNumber = owner?.number ?? null;
  return { ...gymView(gym, byGym.get(gym.id), ownerNumber), ownerNumber, apiEnabled: c.cfg().apiEnabled };
}

/** PATCH /manage/gyms/:gymId/whatsapp { number?, showOnPage? } (owner): the branch's own number and the button. */
async function patchGym(principal, gymId, body, req) {
  const a = await c.gymManage().access(principal, gymId, 'owner.only');
  c.gymManage().needs(a, 'owner.only');
  const patch = {};
  if (body.number !== undefined) patch.number = body.number === null ? null : c.phoneOf(body.number);
  if (body.showOnPage !== undefined) patch.showOnPage = body.showOnPage;
  await sequelize.transaction(async (transaction) => {
    const row = await GymWhatsappGym.findByPk(gymId, { transaction, lock: transaction.LOCK.UPDATE });
    const before = { number: row?.number ?? null, showOnPage: row?.showOnPage ?? true };
    const after = { ...before, ...patch };
    if (before.number === after.number && before.showOnPage === after.showOnPage) return;
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
