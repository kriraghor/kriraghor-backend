'use strict';

/**
 * M02 routes (§9), lite.
 *   meVerification  /me/verification     the member checklist, badge, unlocks and limits
 *   meDocuments     /me/documents        upload a file (raw body), submit the NID, view my own upload
 *   adminKyc        /admin/kyc           the document panel on the Moderation desk (approve_documents):
 *                                        review fields, audited file viewer, NID reveal. The queue and
 *                                        the decision are M05 (/admin/submissions).
 * Files and the NID number are never cached (no-store) and never idempotency-stored.
 */
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireAnyPermission } = require('../../middlewares/auth');
const limits = require('../../middlewares/rateLimit');
const kyc = require('./kyc.service');
const s = require('./kyc.schemas');

// The hard ceiling is the upper bound of kyc.max_file_bytes (20 MB); the setting is checked per file.
const raw = express.raw({ type: () => true, limit: '20mb' });

/** Send a stored file: inline, never cached, never sniffed, sandboxed (a PDF cannot run scripts). */
function sendFile(res, { body, mime }) {
  res.set('Content-Type', mime).set('Content-Disposition', 'inline').set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  if (Buffer.isBuffer(body)) return res.send(body);
  return body.pipe(res);
}

const meVerification = Router();
meVerification.get('/', authenticate, validate(s.verificationQuery, 'query'), async (req, res) => res.json(await kyc.verification(req.user, req.validQuery.locale, req.validQuery.role)));

const meDocuments = Router();
meDocuments.use(authenticate);
meDocuments.post('/files', validate(s.uploadQuery, 'query'), limits.kycUpload, raw, async (req, res) =>
  res.status(201).json(await kyc.uploadFile(req.user, { slot: req.validQuery.slot, docType: req.validQuery.docType, contentType: req.get('content-type'), body: req.body }))
);
meDocuments.post('/', validate(s.submitBody), async (req, res) => res.status(201).json(await kyc.submit(req.user, req.body, req)));
meDocuments.get('/:id/files/:fileId', validate(s.fileParams, 'params'), async (req, res) => sendFile(res, await kyc.ownFile(req.user, req.params.id, req.params.fileId)));

const adminKyc = Router();
adminKyc.use(authenticateAdmin, requireStaff, requireAnyPermission(PERMISSIONS.APPROVE_DOCUMENTS));
adminKyc.get('/documents/:id', validate(s.idParam, 'params'), async (req, res) => res.json(await kyc.adminGet(req.params.id)));
adminKyc.get('/documents/:id/files/:fileId', validate(s.fileParams, 'params'), async (req, res) => sendFile(res, await kyc.viewFile(req.user, req.params.id, req.params.fileId, req)));
adminKyc.post('/documents/:id/reveal-nid', validate(s.idParam, 'params'), validate(s.revealBody), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await kyc.revealNid(req.user, req.params.id, req.body, req));
});

module.exports = { meVerification, meDocuments, adminKyc };
