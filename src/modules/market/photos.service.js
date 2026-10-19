'use strict';

/**
 * M12 product photos (FR-02, FR-03; the M09 photo pattern): uploaded through the API, checked by their
 * first bytes (JPEG, PNG or WebP, at most market.photo_max_bytes), stored in the public bucket under a
 * key that is never reused (CDN-cacheable). Removing a photo sets its status; nothing is deleted.
 * Photos are a review field: a change to a published product marks an edit.
 */
const crypto = require('crypto');
const { E } = require('../../common/errors');
const storage = require('../../common/storage');
const { sniffMime } = require('../../common/filetype');
const { uuid7 } = require('../../common/uuid7');
const { sequelize, ProductPhoto } = require('../../models');
const audit = require('../audit/audit.service');
const settings = require('../settings/settings.service');
const { fileBlock } = require('../../common/filetype');
const rules = require('./market.rules');
const c = require('./market.common');

const { fail } = c;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function editable(p) {
  if (p.status === 'pending_review' || p.editStatus === 'pending_review') throw fail('PRODUCT_IN_REVIEW');
  if (!rules.isEditable(p.status, p.editStatus)) throw fail('PRODUCT_STATE');
}

const markEdited = (p) => {
  p.editStatus = rules.editStatusAfterChange(p.status, p.editStatus);
};

/** POST /shop/products/:id/photos (raw body): one photo, appended last. */
async function upload(principal, productId, { contentType, body }, req) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const block = fileBlock({ declared, sniffed: sniffMime(buf), size: buf.length, max: settings.get('market.photo_max_bytes') });
  if (block) throw fail(block);
  return sequelize.transaction(async (transaction) => {
    const { product: p } = await c.ownedProduct(principal, productId, { transaction, lock: true });
    editable(p);
    const where = { ownerType: 'product', ownerId: p.id, status: 'active' };
    if ((await ProductPhoto.count({ where, transaction })) >= settings.get('market.product_max_photos')) throw fail('PHOTO_LIMIT');
    const id = uuid7();
    const storageKey = `market/products/${p.id}/${id}.${EXT[declared]}`;
    await storage.putPublic(storageKey, buf, declared);
    const top = await ProductPhoto.max('sort', { where, transaction });
    const photo = await ProductPhoto.create(
      {
        id,
        ownerType: 'product',
        ownerId: p.id,
        storageKey,
        mime: declared,
        sizeBytes: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        sort: Number.isFinite(top) ? top + 1 : 0,
        versionAdded: p.liveVersion + 1,
        createdBy: principal.id,
        updatedBy: principal.id,
      },
      { transaction }
    );
    markEdited(p);
    await p.save({ transaction });
    await audit.record({ action: 'product_photo.added', actor: principal, entityType: 'product', entityId: p.id, meta: { photoId: photo.id, sizeBytes: photo.sizeBytes }, req }, { transaction });
    return c.photoView(photo);
  });
}

/** PUT /shop/products/:id/photos/order: every active photo id, first = cover. Not a review change. */
async function reorder(principal, productId, ids, req) {
  return sequelize.transaction(async (transaction) => {
    const { product: p } = await c.ownedProduct(principal, productId, { transaction, lock: true });
    editable(p);
    const photos = await ProductPhoto.findAll({ where: { ownerType: 'product', ownerId: p.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (photos.length !== ids.length || new Set(ids).size !== ids.length || photos.some((x) => !ids.includes(x.id))) throw fail('PHOTOS_MISMATCH');
    for (const x of photos) await x.update({ sort: ids.indexOf(x.id) }, { transaction });
    // The public version follows the new order for the photos it already shows.
    if (rules.isPublished(p.status)) {
      const pos = (id) => {
        const i = ids.indexOf(id);
        return i < 0 ? ids.length : i;
      };
      p.liveSnapshot = { ...p.liveSnapshot, photos: [...p.liveSnapshot.photos].sort((a, b) => pos(a.id) - pos(b.id)) };
      await p.save({ transaction });
    }
    await audit.record({ action: 'product_photo.reordered', actor: principal, entityType: 'product', entityId: p.id, meta: { order: ids }, req }, { transaction });
    return { items: photos.sort((a, b) => a.sort - b.sort).map(c.photoView) };
  });
}

/** POST /shop/products/:id/photos/:photoId/remove: status `removed` (the object stays for the version history). */
async function remove(principal, productId, photoId, req) {
  return sequelize.transaction(async (transaction) => {
    const { product: p } = await c.ownedProduct(principal, productId, { transaction, lock: true });
    editable(p);
    const photo = await ProductPhoto.findOne({ where: { id: photoId, ownerType: 'product', ownerId: p.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!photo) throw E.notFound('Photo');
    await photo.update({ status: 'removed', removedAt: new Date(), updatedBy: principal.id }, { transaction });
    markEdited(p);
    await p.save({ transaction });
    await audit.record({ action: 'product_photo.removed', actor: principal, entityType: 'product', entityId: p.id, meta: { photoId }, req }, { transaction });
    return { removed: photo.id };
  });
}

module.exports = { upload, reorder, remove };
