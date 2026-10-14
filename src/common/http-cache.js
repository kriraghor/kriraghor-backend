'use strict';

const crypto = require('crypto');

/**
 * Public, cacheable JSON (M03-FR-02): Cache-Control max-age plus a weak ETag from a version
 * stamp, answering 304 when the client already has it.
 */
function sendCached(req, res, body, stamp, { maxAge = 300 } = {}) {
  const etag = `W/"${crypto.createHash('sha1').update(String(stamp)).digest('base64url').slice(0, 27)}"`;
  res.set('Cache-Control', `public, max-age=${maxAge}`);
  res.set('ETag', etag);
  if (req.get('if-none-match') === etag) return res.status(304).end();
  return res.json(body);
}

module.exports = { sendCached };
