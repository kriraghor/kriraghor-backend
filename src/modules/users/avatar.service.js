'use strict';

/**
 * M01 avatar (users.avatar_key, Round B1): POST /me/avatar takes the raw image (JPEG, PNG or WebP,
 * checked by its first bytes, at most users.avatar_max_bytes) and stores it in the public bucket under a new key;
 * DELETE /me/avatar clears it. Old objects are left in the bucket (keys are never reused). Audited;
 * the Me view and the public profile views show avatarUrl (storage.publicUrl).
 */
const crypto = require('crypto');
const { AppError } = require('../../common/errors');
const { sniffMime, PHOTO_TYPES, fileBlock } = require('../../common/filetype');
const storage = require('../../common/storage');
const { sequelize } = require('../../models');
const settings = require('../settings').settings;
const audit = require('../audit').audit;

const ERRORS = {
  FILE_EMPTY: [422, 'The file is empty'],
  FILE_TOO_LARGE: [413, 'The file is too large'],
  FILE_TYPE_NOT_ALLOWED: [415, 'Upload a JPEG, PNG or WebP image'],
  FILE_TYPE_MISMATCH: [415, 'The file is not the type it says it is'],
};

/** The public URL of an avatar key, or null. */
const avatarUrl = (key) => (key ? storage.publicUrl(key) : null);

/** POST /me/avatar (raw body). */
async function upload(principal, { contentType, body }, req) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const block = fileBlock({ declared, sniffed: sniffMime(buf), size: buf.length, max: settings.get('users.avatar_max_bytes') });
  if (block) throw new AppError(ERRORS[block][0], block, ERRORS[block][1]);
  const key = `avatars/${principal.id}/${crypto.randomBytes(8).toString('hex')}.${PHOTO_TYPES[declared]}`;
  await storage.putPublic(key, buf, declared);
  const { user } = principal;
  await sequelize.transaction(async (transaction) => {
    await user.update({ avatarKey: key }, { transaction });
    await audit.record({ action: 'user.avatar_updated', actor: principal, entityType: 'user', entityId: user.id, meta: { sizeBytes: buf.length, type: declared }, req }, { transaction });
  });
  return { avatarUrl: avatarUrl(key) };
}

/** DELETE /me/avatar. Idempotent. */
async function remove(principal, req) {
  const { user } = principal;
  if (!user.avatarKey) return { avatarUrl: null };
  await sequelize.transaction(async (transaction) => {
    await user.update({ avatarKey: null }, { transaction });
    await audit.record({ action: 'user.avatar_removed', actor: principal, entityType: 'user', entityId: user.id, req }, { transaction });
  });
  return { avatarUrl: null };
}

module.exports = { upload, remove, avatarUrl };
