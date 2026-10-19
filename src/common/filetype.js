'use strict';

/** The real type of an upload from its first bytes (never trust the declared Content-Type). */
function sniffMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Public photo types and the file extension each is stored with. */
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Why a photo upload is refused, or null: empty, too large, not a photo type, or a body whose real
 * type differs from the declared one (shared by venues, shop products and order evidence).
 */
function fileBlock({ declared, sniffed, size, max }) {
  if (!size) return 'FILE_EMPTY';
  if (size > max) return 'FILE_TOO_LARGE';
  if (!PHOTO_TYPES[declared]) return 'FILE_TYPE_NOT_ALLOWED';
  if (sniffed !== declared) return 'FILE_TYPE_MISMATCH';
  return null;
}

module.exports = { sniffMime, PHOTO_TYPES, fileBlock };
