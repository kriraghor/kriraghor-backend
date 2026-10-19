'use strict';

/**
 * M09 ground photos (§4.4, FR-02): uploaded through the API, checked by their first bytes (JPEG, PNG
 * or WebP, at most ground.photo_max_bytes), stored in the public bucket under a key that is never
 * reused (so CDNs may cache it for a year). Removing a photo sets its status; nothing is deleted.
 * Photos are a review field (FR-04): a change to a published ground marks an edit.
 */
const crypto = require('crypto');
const { E } = require('../../common/errors');
const storage = require('../../common/storage');
const { sniffMime, PHOTO_TYPES: ALLOWED, fileBlock } = require('../../common/filetype');
const { uuid7 } = require('../../common/uuid7');
const { sequelize, GroundPhoto } = require('../../models');
const audit = require('../audit/audit.service');
const settings = require('../settings/settings.service');
const rules = require('./grounds.rules');
const c = require('./grounds.common');

const { fail } = c;

function editable(g) {
  if (g.status === 'pending_review' || g.editStatus === 'pending_review') throw fail('GROUND_IN_REVIEW');
  if (!rules.isEditable(g.status, g.editStatus)) throw fail('GROUND_STATE');
}

const markEdited = (g) => {
  if (rules.isPublished(g.status) && (!g.editStatus || g.editStatus === 'rejected')) g.editStatus = 'draft';
};

/** POST /me/grounds/:id/photos (raw body): one photo, appended last. */
async function upload(principal, groundId, { contentType, body }, req) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const block = fileBlock({ declared, sniffed: sniffMime(buf), size: buf.length, max: settings.get('ground.photo_max_bytes') });
  if (block) throw fail(block);
  return sequelize.transaction(async (transaction) => {
    const g = await c.owned(principal, groundId, { transaction, lock: true });
    editable(g);
    const count = await GroundPhoto.count({ where: { groundId: g.id, status: 'active' }, transaction });
    if (count >= settings.get('ground.max_photos')) throw fail('PHOTO_LIMIT');
    const id = uuid7();
    const storageKey = `grounds/${g.id}/${id}.${ALLOWED[declared]}`;
    await storage.putPublic(storageKey, buf, declared);
    const top = await GroundPhoto.max('sort', { where: { groundId: g.id, status: 'active' }, transaction });
    const photo = await GroundPhoto.create(
      {
        id,
        groundId: g.id,
        storageKey,
        mime: declared,
        sizeBytes: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        sort: Number.isFinite(top) ? top + 1 : 0,
        versionAdded: g.liveVersion + 1,
        createdBy: principal.id,
        updatedBy: principal.id,
      },
      { transaction }
    );
    markEdited(g);
    await g.save({ transaction });
    await audit.record({ action: 'ground_photo.added', actor: principal, entityType: 'ground', entityId: g.id, meta: { photoId: photo.id, sizeBytes: photo.sizeBytes }, req }, { transaction });
    return c.photoView(photo);
  });
}

/** PUT /me/grounds/:id/photos/order: every active photo id, first = cover. Not a review change. */
async function reorder(principal, groundId, ids, req) {
  return sequelize.transaction(async (transaction) => {
    const g = await c.owned(principal, groundId, { transaction, lock: true });
    editable(g);
    const photos = await GroundPhoto.findAll({ where: { groundId: g.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (photos.length !== ids.length || new Set(ids).size !== ids.length || photos.some((p) => !ids.includes(p.id))) throw fail('PHOTOS_MISMATCH');
    for (const p of photos) await p.update({ sort: ids.indexOf(p.id) }, { transaction });
    // The public version follows the new order for the photos it already shows.
    if (rules.isPublished(g.status)) {
      const pos = (id) => {
        const i = ids.indexOf(id);
        return i < 0 ? ids.length : i;
      };
      g.liveSnapshot = { ...g.liveSnapshot, photos: [...g.liveSnapshot.photos].sort((a, b) => pos(a.id) - pos(b.id)) };
      await g.save({ transaction });
    }
    await audit.record({ action: 'ground_photo.reordered', actor: principal, entityType: 'ground', entityId: g.id, meta: { order: ids }, req }, { transaction });
    return { items: photos.sort((a, b) => a.sort - b.sort).map(c.photoView) };
  });
}

/** POST /me/grounds/:id/photos/:photoId/remove: status `removed` (the object stays for the version history). */
async function remove(principal, groundId, photoId, req) {
  return sequelize.transaction(async (transaction) => {
    const g = await c.owned(principal, groundId, { transaction, lock: true });
    editable(g);
    const photo = await GroundPhoto.findOne({ where: { id: photoId, groundId: g.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!photo) throw E.notFound('Photo');
    await photo.update({ status: 'removed', removedAt: new Date(), updatedBy: principal.id }, { transaction });
    markEdited(g);
    await g.save({ transaction });
    await audit.record({ action: 'ground_photo.removed', actor: principal, entityType: 'ground', entityId: g.id, meta: { photoId }, req }, { transaction });
    return { removed: photo.id };
  });
}

module.exports = { upload, reorder, remove };
