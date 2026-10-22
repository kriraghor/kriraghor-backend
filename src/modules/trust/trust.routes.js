'use strict';

/**
 * M17 routes (§9), step 1.
 *   disputesRouter   /disputes                 open a booking dispute (gate file_dispute: a verified phone; Idempotency-Key)
 *   meDisputes       /me/disputes              the parties: list, options, case, statements, files, respond, withdraw
 *   adminDisputes    /admin/disputes           the desk: queue, claim, notes, decide (staff), escalate; masters
 *                                              master-decide (step-up refund.large) and send back. Sources by
 *                                              permission: bookings resolve_reports, esports results manage_esports
 *   reportsRouter    /reports                  report a ground, booking, member, review or tournament
 *   meReports        /me/reports               what I reported and how it ended
 *   adminReports     /admin/reports            grouped queue, subject detail, resolve, escalate, dismiss (resolve_reports)
 *   groundsReviews   /grounds/:id/reviews      public reviews of a venue with the summary (v1 alias of GET /reviews)
 *   reviewsRouter    /reviews                  public reviews of any subject (venue, pro, shop, gym); post and edit a review
 *   meReviews        /me/reviewable, /me/reviews  waiting to review; my reviews, or (role=owner) the reviews of what I
 *                                              own, and the owner's reply (any subject; FR-34)
 *   meGroundReviews  /me/ground-reviews        the venue owner's reviews and replies (gate list_ground; v1 alias)
 *   adminReviews     /admin/reviews            held and hidden reviews; hide, restore, publish (resolve_reports)
 */
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireAnyPermission, requireMaster, requireStepUp, requireGate } = require('../../middlewares/auth');
const limits = require('../../middlewares/rateLimit');
const disputes = require('./disputes.service');
const reports = require('./reports.service');
const reviews = require('./reviews.service');
const s = require('./trust.schemas');

const code = validate(s.codeParam, 'params');
const ev = validate(s.evidenceParam, 'params');
const id = validate(s.idParam, 'params');
// The hard ceiling is the upper bound of disputes.evidence_max_bytes (20 MB); the setting is checked per file.
const raw = express.raw({ type: () => true, limit: '20mb' });

/** Send a stored file: inline, never cached, never sniffed, sandboxed (a PDF cannot run scripts). */
function sendFile(res, { body, mime }) {
  res.set('Content-Type', mime).set('Content-Disposition', 'inline').set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  if (Buffer.isBuffer(body)) return res.send(body);
  return body.pipe(res);
}

// ---------------- disputes: the parties
const disputesRouter = Router();
disputesRouter.use(authenticate);
disputesRouter.post('/', requireGate('file_dispute'), validate(s.openBody), requireIdempotencyKey('disputes.open'), async (req, res) =>
  res.status(201).json(await disputes.open(req.user, req.body, req.get('idempotency-key'), req))
);

const meDisputes = Router();
meDisputes.use(authenticate);
meDisputes.get('/', validate(s.mineQuery, 'query'), async (req, res) => res.json(await disputes.listMine(req.user, req.validQuery)));
meDisputes.get('/options', validate(s.optionsQuery, 'query'), async (req, res) => res.json(await disputes.options(req.user, req.validQuery)));
meDisputes.get('/:code', code, async (req, res) => res.json(await disputes.getMine(req.user, req.params.code)));
meDisputes.post('/:code/statement', code, validate(s.statementBody), async (req, res) => res.json(await disputes.addStatement(req.user, req.params.code, req.body, req)));
meDisputes.post('/:code/evidence', code, limits.disputeUpload, raw, async (req, res) => res.status(201).json(await disputes.addFile(req.user, req.params.code, { body: req.body }, req)));
meDisputes.get('/:code/evidence/:eid/file', ev, async (req, res) => sendFile(res, await disputes.file(req.user, req.params.code, req.params.eid, { staff: false }, req)));
meDisputes.post('/:code/respond', code, validate(s.statementBody), async (req, res) => res.json(await disputes.respond(req.user, req.params.code, req.body, req)));
meDisputes.post('/:code/withdraw', code, validate(s.withdrawBody), async (req, res) => res.json(await disputes.withdraw(req.user, req.params.code, req.body, req)));

// ---------------- disputes: the desk
const adminDisputes = Router();
adminDisputes.use(authenticateAdmin, requireStaff, requireAnyPermission(PERMISSIONS.RESOLVE_REPORTS, PERMISSIONS.MANAGE_ESPORTS));
adminDisputes.get('/', validate(s.adminListQuery, 'query'), async (req, res) => res.json(await disputes.adminList(req.user, req.validQuery)));
adminDisputes.get('/:code', code, async (req, res) => res.json(await disputes.adminGet(req.user, req.params.code)));
adminDisputes.post('/:code/claim', code, async (req, res) => res.json(await disputes.claim(req.user, req.params.code, req)));
adminDisputes.post('/:code/heartbeat', code, async (req, res) => res.json(await disputes.heartbeat(req.user, req.params.code)));
adminDisputes.post('/:code/release', code, async (req, res) => res.json(await disputes.releaseClaim(req.user, req.params.code)));
adminDisputes.post('/:code/notes', code, validate(s.noteBody), async (req, res) => res.json(await disputes.addNote(req.user, req.params.code, req.body, req)));
adminDisputes.get('/:code/evidence/:eid/file', ev, async (req, res) => sendFile(res, await disputes.file(req.user, req.params.code, req.params.eid, { staff: true }, req)));
adminDisputes.post('/:code/evidence/:eid/hide', ev, validate(s.hideBody), async (req, res) => res.json(await disputes.hideEvidence(req.user, req.params.code, req.params.eid, req.body, req)));
adminDisputes.post('/:code/decide', code, validate(s.decideBody), requireIdempotencyKey('disputes.decide'), async (req, res) => res.json(await disputes.decide(req.user, req.params.code, req.body, req)));
adminDisputes.post('/:code/escalate', code, validate(s.escalateBody), async (req, res) => res.json(await disputes.escalate(req.user, req.params.code, req.body, req)));
adminDisputes.post('/:code/master-decide', requireMaster, code, validate(s.decideBody), requireStepUp('refund.large'), requireIdempotencyKey('disputes.master_decide'), async (req, res) =>
  res.json(await disputes.masterDecide(req.user, req.params.code, req.body, req))
);
adminDisputes.post('/:code/send-back', requireMaster, code, validate(s.sendBackBody), async (req, res) => res.json(await disputes.sendBack(req.user, req.params.code, req.body, req)));

// ---------------- reports
const reportsRouter = Router();
reportsRouter.post('/', authenticate, limits.report, validate(s.reportBody), async (req, res) => res.status(201).json(await reports.file(req.user, req.body, req)));

const meReports = Router();
meReports.get('/', authenticate, async (req, res) => res.json(await reports.listMine(req.user)));

const adminReports = Router();
adminReports.use(authenticateAdmin, requireStaff, requireAnyPermission(PERMISSIONS.RESOLVE_REPORTS));
adminReports.get('/', validate(s.reportListQuery, 'query'), async (req, res) => res.json(await reports.adminList(req.user, req.validQuery)));
adminReports.get('/subjects/:type/:id', validate(s.subjectParam, 'params'), async (req, res) => res.json(await reports.adminSubject(req.user, req.params.type, req.params.id)));
adminReports.post('/resolve', validate(s.resolveBody), async (req, res) => res.json(await reports.resolve(req.user, req.body, req)));
adminReports.post('/escalate', validate(s.escalateReportBody), async (req, res) => res.json(await reports.escalate(req.user, req.body, req)));
adminReports.post('/:code/dismiss', code, validate(s.dismissBody), async (req, res) => res.json(await reports.dismiss(req.user, req.params.code, req.body, req)));

// ---------------- reviews
const groundsReviews = Router();
groundsReviews.get('/:id/reviews', id, validate(s.publicReviewsQuery, 'query'), async (req, res) => res.json(await reviews.publicList(req.params.id, req.validQuery)));

const reviewsRouter = Router();
reviewsRouter.get('/', validate(s.subjectReviewsQuery, 'query'), async (req, res) => {
  const { subjectType, subjectId, ...q } = req.validQuery;
  res.json(await reviews.publicListFor(subjectType, subjectId, q));
});
reviewsRouter.use(authenticate);
reviewsRouter.post('/', validate(s.reviewBody), async (req, res) => {
  const out = await reviews.post(req.user, req.body, req);
  res.status(out.updated ? 200 : 201).json(out);
});
reviewsRouter.patch('/:id', id, validate(s.reviewPatch), async (req, res) => res.json(await reviews.edit(req.user, req.params.id, req.body, req)));

const meReviewable = Router();
meReviewable.get('/', authenticate, async (req, res) => res.json(await reviews.reviewable(req.user)));
const meReviews = Router();
meReviews.use(authenticate);
meReviews.get('/', validate(s.myReviewsQuery, 'query'), async (req, res) => {
  const q = req.validQuery;
  const owner = q.role === 'owner' || (q.role === undefined && (q.subjectType !== undefined || q.subjectId !== undefined));
  res.json(owner ? await reviews.ownerList(req.user, q) : await reviews.listMine(req.user));
});
meReviews.post('/:id/reply', id, validate(s.replyBody), async (req, res) => res.json(await reviews.reply(req.user, req.params.id, req.body, req)));

const meGroundReviews = Router();
meGroundReviews.use(authenticate, requireGate('list_ground'));
meGroundReviews.get('/', validate(s.ownerReviewsQuery, 'query'), async (req, res) => res.json(await reviews.ownerList(req.user, { ...req.validQuery, subjectType: 'ground' })));
meGroundReviews.post('/:id/reply', id, validate(s.replyBody), async (req, res) => res.json(await reviews.reply(req.user, req.params.id, req.body, req)));

const adminReviews = Router();
adminReviews.use(authenticateAdmin, requireStaff, requireAnyPermission(PERMISSIONS.RESOLVE_REPORTS));
adminReviews.get('/', validate(s.adminReviewsQuery, 'query'), async (req, res) => res.json(await reviews.adminList(req.validQuery)));
adminReviews.post('/:id/hide', id, validate(s.hideReviewBody), async (req, res) => res.json(await reviews.staffAction(req.user, req.params.id, 'hide', req.body, req)));
adminReviews.post('/:id/restore', id, async (req, res) => res.json(await reviews.staffAction(req.user, req.params.id, 'restore', {}, req)));
adminReviews.post('/:id/publish', id, async (req, res) => res.json(await reviews.staffAction(req.user, req.params.id, 'publish', {}, req)));

module.exports = { disputesRouter, meDisputes, adminDisputes, reportsRouter, meReports, adminReports, groundsReviews, reviewsRouter, meReviewable, meReviews, meGroundReviews, adminReviews };
