'use strict';

/**
 * Domain event registry (M04 §6.3, FR-12, FR-18, FR-19). Every event a module publishes is listed
 * here with its version and a zod schema for the payload. publish() rejects unknown events and
 * invalid payloads before commit. Payloads carry IDs, codes, amounts, statuses and timestamps only:
 * no phone, NID, DOB, email or names (consumers read details through the producer's service).
 *
 * Built so far: M01, M02, M03, M04, M05, M06, M07, M09, M10, M12, M17, M18, M19, M21. Each later module adds its events here when it is built.
 */
const { z } = require('zod');

const id = z.string().min(1).max(64);
const uuid = z.uuid();
const role = z.string().max(32);
const iso = z.string().max(40);
const json = z.unknown();
const poisha = z.number().int().nonnegative();
const paymentClosed = z.object({ paymentId: uuid, purpose: z.string(), purposeId: uuid, amount: poisha, payerId: uuid, reason: z.string().max(60) });
const refundEvent = z.object({ refundId: uuid, paymentId: uuid, amount: poisha, purpose: z.string(), purposeId: uuid, payerId: uuid });
const groundEvent = z.object({ groundId: uuid, ownerId: uuid });
const shopEvent = z.object({ shopId: uuid, ownerId: uuid });
const productEvent = z.object({ productId: uuid, shopId: uuid, ownerId: uuid });
const variantEvent = z.object({ variantId: uuid, productId: uuid, shopId: uuid, ownerId: uuid });
const reasonText = z.string().max(300).nullable().optional();
const docEvent = z.object({ documentId: uuid, userId: uuid, docType: z.string().max(30), role: z.string().max(32).optional() });
const payoutEvent = z.object({ payoutId: uuid, code: z.string(), payeeId: uuid, amount: poisha });
const subEvent = z.object({ submissionId: uuid, kind: z.string().max(30), subjectId: uuid, version: z.number().int(), submittedBy: uuid });
const esReg = z.object({ registrationId: uuid, tournamentId: uuid, registrantUserId: uuid });
const esMatch = z.object({ matchId: uuid, tournamentId: uuid });
const esProfile = z.object({ profileId: uuid, userId: uuid, gameId: uuid });
const esShare = z.object({ shareId: uuid, tournamentId: uuid, userId: uuid, amount: poisha });
const bookingEvent = z.object({ bookingId: uuid, code: z.string().max(16), groundId: uuid, ownerId: uuid, bookerUserId: uuid.nullable() });
const disputeEvent = z.object({ disputeId: uuid, code: z.string().max(20), sourceType: z.enum(['booking', 'esports_result']), sourceId: uuid, category: z.string().max(30), claimantId: uuid, respondentId: uuid.nullable() });
const subjectType = z.enum(['ground', 'booking', 'user', 'review', 'esports_tournament', 'shop', 'product']);
const reviewEvent = z.object({ reviewId: uuid, subjectType: z.literal('ground'), subjectId: uuid, authorId: uuid });
const docRequestEvent = z.object({ requestId: uuid, userId: uuid, docType: z.string().max(30), sourceRef: uuid.nullable(), dueAt: iso.nullable() });
const riskFlagEvent = z.object({ flagId: uuid, userId: uuid, ruleKey: z.string().max(40), severity: z.enum(['info', 'medium', 'high', 'critical']) });
const catalogItem = z.object({ table: z.string(), id: uuid, key: z.string(), version: z.number().int().optional(), isActive: z.boolean().optional() });

const EVENTS = {
  // ---------------- M01 Identity ----------------
  'user.registered': { module: 'M01', version: 1, schema: z.object({ userId: uuid, roles: z.array(role) }) },
  'user.suspended': { module: 'M01', version: 1, schema: z.object({ userId: uuid, sanctionId: uuid, until: iso.nullable() }) },
  'user.banned': { module: 'M01', version: 1, schema: z.object({ userId: uuid, sanctionId: uuid }) },
  'user.restored': { module: 'M01', version: 1, schema: z.object({ userId: uuid }) },
  'user.email_changed': { module: 'M01', version: 1, schema: z.object({ userId: uuid }) },
  'user_role.applied': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role }) },
  'user_role.activated': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role }) },
  'user_role.reinstated': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role }) },
  'user_role.rejected': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role, reasonCode: z.string().max(40).nullable() }) },
  'user_role.suspended': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role, reasonCode: z.string().max(40).nullable() }) },
  'user_role.withdrawn': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role }) },
  'staff.invited': { module: 'M01', version: 1, schema: z.object({ userId: uuid }) },
  'staff.activated': { module: 'M01', version: 1, schema: z.object({ userId: uuid }) },
  'staff.offboarded': { module: 'M01', version: 1, schema: z.object({ userId: uuid }) },
  'staff.permissions_changed': { module: 'M01', version: 1, schema: z.object({ userId: uuid, added: z.array(z.string()), removed: z.array(z.string()) }) },
  'session.revoked': { module: 'M01', version: 1, schema: z.object({ userId: uuid, cause: z.string().max(40), count: z.number().int().min(1) }) },

  // ---------------- M03 Settings and catalogue ----------------
  'setting.change_proposed': {
    module: 'M03',
    version: 1,
    schema: z.object({ requestId: uuid, keys: z.array(z.string()), proposedBy: uuid, source: z.string(), needsFourEyes: z.boolean() }),
  },
  'setting.changed': {
    module: 'M03',
    version: 1,
    schema: z.object({ key: z.string(), version: z.number().int(), oldValue: json, newValue: json, effectiveAt: iso, requestId: uuid }),
  },
  'setting.change_rejected': { module: 'M03', version: 1, schema: z.object({ requestId: uuid, code: z.string().optional() }) },
  'setting.change_withdrawn': { module: 'M03', version: 1, schema: z.object({ requestId: uuid }) },
  'catalog_item.created': { module: 'M03', version: 1, schema: catalogItem },
  'catalog_item.updated': { module: 'M03', version: 1, schema: catalogItem },
  'catalog_item.deactivated': { module: 'M03', version: 1, schema: catalogItem },

  // ---------------- M04 Audit and events ----------------
  'audit.critical_recorded': {
    module: 'M04',
    version: 1,
    schema: z.object({ auditLogId: id, action: z.string(), actorId: uuid.nullable(), entityType: z.string().nullable(), entityId: id.nullable() }),
  },
  'audit_log.exported': { module: 'M04', version: 1, schema: z.object({ exportId: uuid, requestedBy: uuid, rowCount: z.number().int() }) },
  'audit.chain_mismatch_detected': { module: 'M04', version: 1, schema: z.object({ seq: z.number().int(), auditLogId: id }) },
  'outbox.event_dead_lettered': { module: 'M04', version: 1, schema: z.object({ eventId: uuid, eventType: z.string(), consumer: z.string(), attempts: z.number().int() }) },

  // ---------------- M06 Payments, ledger and escrow (amounts in poisha) ----------------
  'payment.succeeded': {
    module: 'M06',
    version: 1,
    schema: z.object({ paymentId: uuid, code: z.string(), purpose: z.string(), purposeId: uuid, amount: poisha, method: z.string().nullable(), payerId: uuid, late: z.boolean(), accepted: z.boolean() }),
  },
  'payment.failed': { module: 'M06', version: 1, schema: paymentClosed },
  'payment.expired': { module: 'M06', version: 1, schema: paymentClosed },
  'refund.escalated': { module: 'M06', version: 1, schema: refundEvent },
  'refund.approved': { module: 'M06', version: 1, schema: refundEvent },
  'refund.succeeded': { module: 'M06', version: 1, schema: refundEvent },
  'refund.failed': { module: 'M06', version: 1, schema: refundEvent },
  'refund.manual_required': { module: 'M06', version: 1, schema: refundEvent },
  'escrow.held': {
    module: 'M06',
    version: 1,
    schema: z.object({ holdId: uuid, paymentId: uuid, purpose: z.string(), purposeId: uuid, amount: poisha, payeeId: uuid.nullable(), groupRef: uuid.nullable() }),
  },
  'escrow.released': {
    module: 'M06',
    version: 1,
    schema: z.object({ holdId: uuid, purpose: z.string(), purposeId: uuid, gross: poisha, fee: poisha, net: poisha, payeeId: uuid, transactionId: uuid }),
  },
  'escrow.pool_settled': {
    module: 'M06',
    version: 1,
    schema: z.object({ groupRef: uuid, purpose: z.string(), collected: poisha, paid: poisha, subsidy: poisha, fee: poisha, transactionId: uuid }),
  },
  'escrow.frozen': { module: 'M06', version: 1, schema: z.object({ holdId: uuid, reason: z.string().max(200), payeeId: uuid.nullable() }) },
  'escrow.unfrozen': { module: 'M06', version: 1, schema: z.object({ holdId: uuid, reason: z.string().max(200), payeeId: uuid.nullable() }) },
  'ledger.transaction_posted': {
    module: 'M06',
    version: 1,
    schema: z.object({ transactionId: uuid, kind: z.string(), refType: z.string(), refId: id, total: poisha }),
  },
  'ledger.invariant_failed': { module: 'M06', version: 1, schema: z.object({ failed: z.array(z.string()), checkedAt: iso }) },
  'reconciliation.exception_raised': { module: 'M06', version: 1, schema: z.object({ runId: uuid, itemId: uuid, type: z.string(), amount: poisha }) },
  'reconciliation.run_completed': {
    module: 'M06',
    version: 1,
    schema: z.object({ runId: uuid, provider: z.string(), businessDate: z.string(), matched: z.number().int(), exceptions: z.number().int(), autoHealed: z.number().int() }),
  },

  // ---------------- M07 Payouts (amounts in poisha; no account numbers, only ids) ----------------
  'payout.scheduled': { module: 'M07', version: 1, schema: payoutEvent.extend({ status: z.string(), kind: z.enum(['earning', 'refund', 'withdrawal']) }) },
  'payout.approval_requested': { module: 'M07', version: 1, schema: payoutEvent },
  'payout.released': { module: 'M07', version: 1, schema: payoutEvent.extend({ attempt: z.number().int() }) },
  'payout.paid': { module: 'M07', version: 1, schema: payoutEvent.extend({ kind: z.enum(['earning', 'refund', 'withdrawal']) }) },
  'payout.failed': { module: 'M07', version: 1, schema: payoutEvent.extend({ reason: z.string().max(40), retryable: z.boolean() }) },
  'payout.held': { module: 'M07', version: 1, schema: z.object({ holdId: uuid, payeeId: uuid, payoutId: uuid.nullable(), type: z.string(), scope: z.string() }) },
  'payout.hold_lifted': { module: 'M07', version: 1, schema: z.object({ holdId: uuid, payeeId: uuid, payoutId: uuid.nullable(), type: z.string() }) },
  'payout_account.added': { module: 'M07', version: 1, schema: z.object({ accountId: uuid, userId: uuid, type: z.enum(['bkash', 'nagad']) }) },
  'payout_account.verified': { module: 'M07', version: 1, schema: z.object({ accountId: uuid, userId: uuid, type: z.enum(['bkash', 'nagad']), holdUntil: iso.nullable() }) },
  'payout_account.rejected': { module: 'M07', version: 1, schema: z.object({ accountId: uuid, userId: uuid }) },

  // ---------------- M02 KYC (ids, type and reason codes only: never the number, DOB or name) ----------------
  'document.submitted': { module: 'M02', version: 1, schema: docEvent.extend({ version: z.number().int() }) },
  'document.approved': { module: 'M02', version: 1, schema: docEvent },
  'document.changes_requested': { module: 'M02', version: 1, schema: docEvent.extend({ reasonCode: z.string().max(40) }) },
  'document.rejected': { module: 'M02', version: 1, schema: docEvent.extend({ reasonCode: z.string().max(40) }) },
  'document.duplicate_nid_detected': { module: 'M02', version: 1, schema: z.object({ documentId: uuid, userId: uuid, otherAccounts: z.number().int() }) },
  'verification.passed': { module: 'M02', version: 1, schema: z.object({ userId: uuid, role: z.string().max(32) }) },

  // ---------------- M05 Moderation (ids, kinds and codes only: the payload stays in the submission) ----------------
  'submission.created': { module: 'M05', version: 1, schema: subEvent.extend({ isEdit: z.boolean(), mode: z.enum(['pre', 'post']), slaDueAt: iso }) },
  'submission.approved': { module: 'M05', version: 1, schema: subEvent.extend({ decidedBy: uuid, overridden: z.boolean() }) },
  'submission.changes_requested': { module: 'M05', version: 1, schema: subEvent.extend({ decidedBy: uuid, reasonCode: z.string().max(40) }) },
  'submission.rejected': { module: 'M05', version: 1, schema: subEvent.extend({ decidedBy: uuid, reasonCode: z.string().max(40) }) },
  'submission.withdrawn': { module: 'M05', version: 1, schema: subEvent.extend({ byOwner: z.boolean(), superseded: z.boolean(), claimedBy: uuid.nullable() }) },
  'submission.sla_breached': { module: 'M05', version: 1, schema: subEvent.extend({ overdueMinutes: z.number().int(), claimedBy: uuid.nullable() }) },
  'submission.apply_failed': { module: 'M05', version: 1, schema: subEvent.extend({ attempts: z.number().int() }) },
  'submission.applied': { module: 'M05', version: 1, schema: subEvent },

  // ---------------- M21 Esports (ids, codes and amounts; never room credentials, UIDs or names) ----------------
  'esports_game_profile.submitted': { module: 'M21', version: 1, schema: esProfile },
  'esports_game_profile.verified': { module: 'M21', version: 1, schema: esProfile },
  'esports_game_profile.rejected': { module: 'M21', version: 1, schema: esProfile.extend({ reasonCode: z.string().max(40).nullable() }) },
  'esports_game_profile.banned': { module: 'M21', version: 1, schema: esProfile.extend({ reasonCode: z.string().max(40) }) },
  'esports_squad.invited': { module: 'M21', version: 1, schema: z.object({ squadId: uuid, memberId: uuid, userId: uuid, invitedBy: uuid }) },
  'esports_squad.joined': { module: 'M21', version: 1, schema: z.object({ squadId: uuid, userId: uuid }) },
  'esports_tournament.published': { module: 'M21', version: 1, schema: z.object({ tournamentId: uuid, gameId: uuid, entryFee: poisha, prizePool: poisha, startsAt: iso }) },
  'esports_tournament.registration_opened': { module: 'M21', version: 1, schema: z.object({ tournamentId: uuid, gameId: uuid }) },
  'esports_tournament.registration_closed': { module: 'M21', version: 1, schema: z.object({ tournamentId: uuid, confirmed: z.number().int() }) },
  'esports_tournament.checkin_opened': { module: 'M21', version: 1, schema: z.object({ tournamentId: uuid, stageId: uuid, closesAt: iso }) },
  'esports_tournament.cancelled': { module: 'M21', version: 1, schema: z.object({ tournamentId: uuid, reasonCode: z.string().max(40), refunded: z.number().int() }) },
  'esports_tournament.finalised': { module: 'M21', version: 1, schema: z.object({ tournamentId: uuid, gameId: uuid, awards: z.number().int(), paid: poisha, subsidy: poisha, revenue: poisha }) },
  'esports_registration.created': { module: 'M21', version: 1, schema: esReg.extend({ status: z.string().max(20) }) },
  'esports_registration.waitlisted': { module: 'M21', version: 1, schema: esReg.extend({ status: z.string().max(20) }) },
  'esports_registration.confirmed': { module: 'M21', version: 1, schema: esReg.extend({ paid: z.boolean() }) },
  'esports_registration.cancelled': { module: 'M21', version: 1, schema: esReg.extend({ reasonCode: z.string().max(40) }) },
  'esports_registration.offered': { module: 'M21', version: 1, schema: esReg.extend({ offerExpiresAt: iso }) },
  'esports_registration.withdrawn': { module: 'M21', version: 1, schema: esReg.extend({ refunded: poisha, reasonCode: z.string().max(40).optional() }) },
  'esports_registration.refunded': { module: 'M21', version: 1, schema: esReg.extend({ amount: poisha, reasonCode: z.string().max(40) }) },
  'esports_registration.checkin_completed': { module: 'M21', version: 1, schema: esReg },
  'esports_registration.no_show_marked': { module: 'M21', version: 1, schema: esReg },
  'esports_registration.disqualified': { module: 'M21', version: 1, schema: esReg.extend({ reasonCode: z.string().max(40) }) },
  'esports_match.room_revealed': { module: 'M21', version: 1, schema: esMatch.extend({ version: z.number().int(), players: z.number().int() }) },
  'esports_match.room_rotated': { module: 'M21', version: 1, schema: esMatch.extend({ version: z.number().int() }) },
  'esports_match.results_posted': { module: 'M21', version: 1, schema: esMatch.extend({ seq: z.number().int(), disputeClosesAt: iso }) },
  'esports_match.finalised': { module: 'M21', version: 1, schema: esMatch },
  'esports_match.cancelled': { module: 'M21', version: 1, schema: esMatch },
  'esports_result.disputed': { module: 'M21', version: 1, schema: esMatch.extend({ disputeId: uuid, registrationId: uuid }) },
  'esports_result.corrected': { module: 'M21', version: 1, schema: esMatch.extend({ disputeId: uuid, rows: z.number().int() }) },
  'esports_result.dispute_resolved': { module: 'M21', version: 1, schema: esMatch.extend({ disputeId: uuid, raisedBy: uuid, outcome: z.enum(['rejected', 'corrected']) }) },
  'esports_prize.credited': { module: 'M21', version: 1, schema: esShare },
  'esports_prize.reversed': { module: 'M21', version: 1, schema: esShare },
  'esports_prize.forfeited': { module: 'M21', version: 1, schema: z.object({ awardId: uuid, tournamentId: uuid, registrationId: uuid, amount: poisha }) },
// ---------------- M09 Grounds (ids and keys only) ----------------
  'ground.submitted': { module: 'M09', version: 1, schema: groundEvent.extend({ version: z.number().int(), isEdit: z.boolean() }) },
  'ground.published': { module: 'M09', version: 1, schema: groundEvent.extend({ version: z.number().int(), first: z.boolean() }) },
  'ground.changes_requested': { module: 'M09', version: 1, schema: groundEvent.extend({ isEdit: z.boolean(), reasonCode: z.string().max(40).nullable() }) },
  'ground.rejected': { module: 'M09', version: 1, schema: groundEvent.extend({ isEdit: z.boolean(), reasonCode: z.string().max(40).nullable() }) },
  'ground.withdrawn': { module: 'M09', version: 1, schema: groundEvent },
  'ground.paused': { module: 'M09', version: 1, schema: groundEvent.extend({ reason: z.string().max(300).nullable().optional() }) },
  'ground.resumed': { module: 'M09', version: 1, schema: groundEvent },
  'ground.suspended': { module: 'M09', version: 1, schema: groundEvent.extend({ reason: z.string().max(300).nullable().optional() }) },
  'ground.restored': { module: 'M09', version: 1, schema: groundEvent },
  'ground.removed': { module: 'M09', version: 1, schema: groundEvent.extend({ reason: z.string().max(300).nullable().optional() }) },
  'ground.pricing_published': { module: 'M09', version: 1, schema: groundEvent.extend({ version: z.number().int(), changedKeys: z.array(z.string().max(40)) }) },
  // ---------------- M12 market catalogue (step 1)
  'shop.submitted': { module: 'M12', version: 1, schema: shopEvent.extend({ version: z.number().int(), isEdit: z.boolean() }) },
  'shop.published': { module: 'M12', version: 1, schema: shopEvent.extend({ version: z.number().int(), first: z.boolean() }) },
  'shop.changes_requested': { module: 'M12', version: 1, schema: shopEvent.extend({ isEdit: z.boolean(), reasonCode: z.string().max(40).nullable() }) },
  'shop.rejected': { module: 'M12', version: 1, schema: shopEvent.extend({ isEdit: z.boolean(), reasonCode: z.string().max(40).nullable() }) },
  'shop.withdrawn': { module: 'M12', version: 1, schema: shopEvent },
  'shop.paused': { module: 'M12', version: 1, schema: shopEvent.extend({ reason: reasonText }) },
  'shop.resumed': { module: 'M12', version: 1, schema: shopEvent },
  'shop.suspended': { module: 'M12', version: 1, schema: shopEvent.extend({ reason: reasonText }) },
  'shop.restored': { module: 'M12', version: 1, schema: shopEvent },
  'shop.removed': { module: 'M12', version: 1, schema: shopEvent.extend({ reason: reasonText }) },
  'product.submitted': { module: 'M12', version: 1, schema: productEvent.extend({ version: z.number().int(), isEdit: z.boolean() }) },
  'product.published': { module: 'M12', version: 1, schema: productEvent.extend({ version: z.number().int(), first: z.boolean() }) },
  'product.changes_requested': { module: 'M12', version: 1, schema: productEvent.extend({ isEdit: z.boolean(), reasonCode: z.string().max(40).nullable() }) },
  'product.rejected': { module: 'M12', version: 1, schema: productEvent.extend({ isEdit: z.boolean(), reasonCode: z.string().max(40).nullable() }) },
  'product.withdrawn': { module: 'M12', version: 1, schema: productEvent },
  'product.paused': { module: 'M12', version: 1, schema: productEvent.extend({ reason: reasonText }) },
  'product.resumed': { module: 'M12', version: 1, schema: productEvent },
  'product.suspended': { module: 'M12', version: 1, schema: productEvent.extend({ reason: reasonText }) },
  'product.restored': { module: 'M12', version: 1, schema: productEvent },
  'product.removed': { module: 'M12', version: 1, schema: productEvent.extend({ reason: reasonText }) },
  'product.hidden': { module: 'M12', version: 1, schema: productEvent.extend({ reason: z.enum(['stock']) }) },
  'product.unhidden': { module: 'M12', version: 1, schema: productEvent.extend({ reason: z.enum(['stock']) }) },
  'product.price_lowered': { module: 'M12', version: 1, schema: productEvent.extend({ fromPoisha: poisha, toPoisha: poisha }) },
  'variant.low_stock_reached': { module: 'M12', version: 1, schema: variantEvent.extend({ available: z.number().int() }) },
  'variant.stock_depleted': { module: 'M12', version: 1, schema: variantEvent },
  'variant.restocked': { module: 'M12', version: 1, schema: variantEvent.extend({ available: z.number().int() }) },
  'variant.sale_blocked': { module: 'M12', version: 1, schema: variantEvent.extend({ expiryDate: z.string().max(10).nullable() }) },
  'variant.sale_unblocked': { module: 'M12', version: 1, schema: variantEvent.extend({ expiryDate: z.string().max(10).nullable() }) },
  'inventory.adjusted': { module: 'M12', version: 1, schema: z.object({ variantId: uuid, productId: uuid, shopId: uuid, delta: z.number().int(), reasonCode: z.string().max(30) }) },
  'saved_item.alerted': { module: 'M12', version: 1, schema: z.object({ savedItemId: uuid, userId: uuid, itemType: z.enum(['product', 'used_listing']), itemId: uuid, reason: z.enum(['back_in_stock', 'price_dropped']), pricePoisha: poisha }) },
  // step 2: closures and series (written as M10 booking slots)
  'closure.created': { module: 'M09', version: 1, schema: z.object({ closureId: uuid, groundId: uuid, start: iso, end: iso, reason: z.string().max(30) }) },
  'closure.reopened': { module: 'M09', version: 1, schema: z.object({ closureId: uuid, groundId: uuid, start: iso, end: iso, reason: z.string().max(30) }) },
  'closure.shortened': { module: 'M09', version: 1, schema: z.object({ closureId: uuid, groundId: uuid, start: iso, end: iso, reason: z.string().max(30) }) },
  'booking_series.created': { module: 'M09', version: 1, schema: z.object({ seriesId: uuid, groundId: uuid, ownerId: uuid, weeks: z.number().int(), skipped: z.number().int() }) },
  'booking_series.week_skipped': { module: 'M09', version: 1, schema: z.object({ seriesId: uuid, groundId: uuid, ownerId: uuid, week: z.number().int() }) },
  'booking_series.week_restored': { module: 'M09', version: 1, schema: z.object({ seriesId: uuid, groundId: uuid, ownerId: uuid, week: z.number().int() }) },
  'booking_series.ended': { module: 'M09', version: 1, schema: z.object({ seriesId: uuid, groundId: uuid, ownerId: uuid, cancelled: z.number().int() }) },

  // ---------------- M10 Bookings (ids, codes and amounts only; v3 money)
  'booking.held': { module: 'M10', version: 1, schema: bookingEvent.extend({ start: iso, online: poisha }) },
  'booking.confirmed': { module: 'M10', version: 1, schema: bookingEvent.extend({ start: iso, online: poisha, choice: z.enum(['advance', 'full']) }) },
  'booking.hold_expired': { module: 'M10', version: 1, schema: bookingEvent.extend({ reason: z.string().max(40) }) },
  'booking.check_in_recorded': { module: 'M10', version: 1, schema: bookingEvent.extend({ released: poisha, fee: poisha, lateMinutes: z.number().int() }) },
  'booking.extended': { module: 'M10', version: 1, schema: bookingEvent.extend({ amount: poisha, end: iso }) },
  'booking.balance_collected': { module: 'M10', version: 1, schema: bookingEvent.extend({ amount: poisha, method: z.enum(['cash', 'bkash_venue']) }) },
  'booking.completed': { module: 'M10', version: 1, schema: bookingEvent.extend({ auto: z.boolean(), released: poisha, fee: poisha }) },
  'booking.no_show_marked': { module: 'M10', version: 1, schema: bookingEvent.extend({ refund: poisha, retained: poisha }) },
  'booking.cancelled': { module: 'M10', version: 1, schema: bookingEvent.extend({ refund: poisha, retained: poisha }) },
  'booking.owner_cancelled': { module: 'M10', version: 1, schema: bookingEvent.extend({ refund: poisha, reason: z.string().max(40), penalised: z.boolean() }) },
  'booking.platform_cancelled': { module: 'M10', version: 1, schema: bookingEvent.extend({ refund: poisha, reason: z.string().max(40) }) },
  'booking.moved': { module: 'M10', version: 1, schema: bookingEvent.extend({ fromGroundId: uuid, newGround: z.boolean() }) },
  'booking.walk_in_recorded': { module: 'M10', version: 1, schema: bookingEvent.extend({ start: iso, price: poisha }) },
  'booking.reminded': { module: 'M10', version: 1, schema: bookingEvent.extend({ start: iso }) },
  'booking.no_show_settled': { module: 'M10', version: 1, schema: bookingEvent.extend({ released: poisha, fee: poisha }) },
  'booking.dispute_settled': { module: 'M10', version: 1, schema: bookingEvent.extend({ refund: poisha, released: poisha, fee: poisha }) },

  // ---------------- M17 Disputes, Reports and Reviews
  'dispute.opened': { module: 'M17', version: 1, schema: disputeEvent.extend({ money: z.boolean(), held: poisha }) },
  'dispute.response_submitted': { module: 'M17', version: 1, schema: disputeEvent },
  'dispute.respondent_reminded': { module: 'M17', version: 1, schema: disputeEvent.extend({ dueAt: iso.nullable() }) },
  'dispute.response_expired': { module: 'M17', version: 1, schema: disputeEvent },
  'dispute.escalated': { module: 'M17', version: 1, schema: disputeEvent },
  'dispute.returned': { module: 'M17', version: 1, schema: disputeEvent },
  'dispute.resolved': { module: 'M17', version: 1, schema: disputeEvent.extend({ outcome: z.string().max(20), refund: poisha }) },
  'dispute.withdrawn': { module: 'M17', version: 1, schema: disputeEvent },
  'dispute.sla_breached': { module: 'M17', version: 1, schema: disputeEvent.extend({ level: z.enum(['staff', 'master']) }) },
  'report.filed': { module: 'M17', version: 1, schema: z.object({ reportId: uuid, code: z.string().max(20), subjectType, subjectId: uuid, reporterId: uuid, reasonCode: z.string().max(30), eligible: z.boolean() }) },
  'report.threshold_reached': { module: 'M17', version: 1, schema: z.object({ subjectType, subjectId: uuid, reporters: z.number().int(), hidden: z.boolean() }) },
  'report.escalated': { module: 'M17', version: 1, schema: z.object({ subjectType, subjectId: uuid, reports: z.number().int() }) },
  'report.resolved': { module: 'M17', version: 1, schema: z.object({ subjectType, subjectId: uuid, subjectOwnerId: uuid.nullable().optional(), action: z.string().max(30), reports: z.number().int(), reporterIds: z.array(uuid) }) },
  'report.dismissed': { module: 'M17', version: 1, schema: z.object({ reportId: uuid, code: z.string().max(20), subjectType, subjectId: uuid, reporterId: uuid }) },
  'review.posted': { module: 'M17', version: 1, schema: reviewEvent.extend({ ownerId: uuid, stars: z.number().int().min(1).max(5), status: z.string().max(12) }) },
  'review.edited': { module: 'M17', version: 1, schema: reviewEvent.extend({ stars: z.number().int().min(1).max(5), status: z.string().max(12) }) },
  'review.hidden': { module: 'M17', version: 1, schema: reviewEvent.extend({ reason: z.string().max(60) }) },
  'review.restored': { module: 'M17', version: 1, schema: reviewEvent },
  'review.published': { module: 'M17', version: 1, schema: reviewEvent },
  'review.replied': { module: 'M17', version: 1, schema: reviewEvent },
  'review.aggregate_updated': { module: 'M17', version: 1, schema: z.object({ subjectType: z.literal('ground'), subjectId: uuid, count: z.number().int().nonnegative(), avg: z.number().nullable() }) },

  // ---------------- M02 document requests (for M18)
  'document_request.created': { module: 'M02', version: 1, schema: docRequestEvent },
  'document_request.fulfilled': { module: 'M02', version: 1, schema: docRequestEvent },
  'document_request.cancelled': { module: 'M02', version: 1, schema: docRequestEvent },
  'document_request.overdue_marked': { module: 'M02', version: 1, schema: docRequestEvent },

  // ---------------- M18 Risk and Trust
  'risk.flag_raised': { module: 'M18', version: 1, schema: riskFlagEvent.extend({ reopened: z.boolean() }) },
  'risk.flag_updated': { module: 'M18', version: 1, schema: riskFlagEvent.extend({ value: z.number().optional(), status: z.string().max(12).optional(), escalated: z.boolean().optional() }) },
  'risk.flag_cleared': { module: 'M18', version: 1, schema: riskFlagEvent.extend({ lapsed: z.boolean() }) },
  'risk.action_taken': { module: 'M18', version: 1, schema: z.object({ actionId: uuid, userId: uuid, action: z.string().max(30), flagId: uuid.nullable(), reversesActionId: uuid.nullable() }) },
  'trust.score_updated': { module: 'M18', version: 1, schema: z.object({ userId: uuid, kind: z.enum(['owner', 'booker']), score: z.number().int(), shown: z.boolean(), sample: z.number().int() }) },
  'trust.low_crossed': { module: 'M18', version: 1, schema: z.object({ userId: uuid, kind: z.enum(['owner', 'booker']), score: z.number().int() }) },

  // ---------------- M19 Dashboards and Analytics
  'analytics.drift_detected': { module: 'M19', version: 1, schema: z.object({ vertical: z.string().max(20), records: z.number().int(), amount: poisha, runAt: iso }) },
};
/** FR-19: `<aggregate>.<past_tense_verb>`, snake_case. Irregular past tenses are listed. */
const IRREGULAR = new Set(['sent', 'paid', 'held', 'won', 'lost', 'made', 'begun', 'done', 'drawn', 'shown', 'thrown', 'given', 'taken', 'built', 'set', 'put', 'cut', 'withdrawn', 'chosen', 'written', 'frozen', 'unfrozen', 'seen', 'broken', 'sold', 'told', 'found', 'left', 'met', 'read', 'run', 'spent', 'struck', 'hidden', 'unhidden']);
function nameError(name) {
  const m = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(name);
  if (!m) return 'Use <aggregate>.<verb> in snake_case';
  const verb = m[2].split('_').pop();
  if (verb.endsWith('ed') || IRREGULAR.has(verb)) return null;
  return `"${m[2]}" is not past tense`;
}

/** FR-18: banned payload field names, matched as any word of a camelCase or snake_case key (displayName, user_email, phoneNumber). */
const PII_WORDS = new Set(['phone', 'nid', 'dob', 'email', 'name']);
const words = (key) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split('_');
function piiFields(value, path = '') {
  if (Array.isArray(value)) return value.flatMap((v, i) => piiFields(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const here = path ? `${path}.${k}` : k;
    return [...(words(k).some((w) => PII_WORDS.has(w)) ? [here] : []), ...piiFields(v, here)];
  });
}

const definition = (name) => EVENTS[name];

module.exports = { EVENTS, definition, nameError, piiFields };
