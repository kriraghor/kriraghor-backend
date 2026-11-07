'use strict';

/**
 * Domain event registry (M04 §6.3, FR-12, FR-18, FR-19). Every event a module publishes is listed
 * here with its version and a zod schema for the payload. publish() rejects unknown events and
 * invalid payloads before commit. Payloads carry IDs, codes, amounts, statuses and timestamps only:
 * no phone, NID, DOB, email or names (consumers read details through the producer's service).
 *
 * Built so far: M01, M02, M03, M04, M05, M06, M07, M09, M10, M11, M12, M13, M14 lite, M17, M18, M19, M20, M21, M22, M23, M24 (prompt 1). Each later module adds its events here when it is built.
 */
const { z } = require('zod');

const id = z.string().min(1).max(64);
const uuid = z.uuid();
const role = z.string().max(32);
const iso = z.string().max(40);
const json = z.unknown();
const poisha = z.number().int().nonnegative();
const tournamentPostEvent = z.object({ postId: uuid, slug: z.string().max(110), title: z.string().max(120), authorId: uuid });
const paymentClosed = z.object({ paymentId: uuid, purpose: z.string(), purposeId: uuid, amount: poisha, payerId: uuid, reason: z.string().max(60) });
const refundEvent = z.object({ refundId: uuid, paymentId: uuid, amount: poisha, purpose: z.string(), purposeId: uuid, payerId: uuid });
const groundEvent = z.object({ groundId: uuid, ownerId: uuid });
const tourEvent = z.object({ tournamentId: uuid, organisationId: uuid });
const regEvent = z.object({ registrationId: uuid, tournamentId: uuid, teamId: uuid, captainId: uuid });
const matchEvent = z.object({ matchId: uuid, tournamentId: uuid, matchNo: z.number().int() });
const shopEvent = z.object({ shopId: uuid, ownerId: uuid });
const productEvent = z.object({ productId: uuid, shopId: uuid, ownerId: uuid });
const variantEvent = z.object({ variantId: uuid, productId: uuid, shopId: uuid, ownerId: uuid });
const reasonText = z.string().max(300).nullable().optional();
const orderEvent = z.object({ orderId: uuid, code: z.string().max(20), buyerId: uuid, total: poisha });
const hireProfileEvent = z.object({ profileId: uuid, userId: uuid, roleId: uuid });
const hireRequestEvent = z.object({ requestId: uuid, code: z.string().max(20), profileId: uuid, hirerId: uuid, proUserId: uuid, total: poisha });
const hireJobEvent = z.object({ jobId: uuid, code: z.string().max(24), requestId: uuid, hirerId: uuid, proUserId: uuid, quote: poisha });
const gymEvent = z.object({ gymId: uuid, ownerId: uuid });
// M24 §7.1: passes of the new package kinds (6 months, 12 months, custom days).
const gmKind = z.enum(['day', 'month', 'quarter', 'half_year', 'year', 'custom']);
const gymPassEvent = z.object({ passId: uuid, code: z.string().max(20), gymId: uuid, holderId: uuid, ownerId: uuid, kind: gmKind, price: poisha });
// M24 gym management (§2.2).
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const gmMember = z.object({ memberId: uuid, gymId: uuid, ownerId: uuid, by: uuid.nullable() });
const gmLink = z.object({ requestId: uuid, gymId: uuid, direction: z.enum(['gym_invite', 'join_request']), memberId: uuid.nullable(), userId: uuid.nullable() });
const gmMembership = z.object({ membershipId: uuid, memberId: uuid, gymId: uuid });
const gmDue = z.object({ dueId: uuid, memberId: uuid, gymId: uuid });
const gmMethod = z.enum(['cash', 'owner_bkash', 'owner_nagad', 'card_counter', 'other', 'online', 'opening']);
const gmTier = z.enum(['free', 'basic', 'standard', 'pro']);
const gmImport = z.object({ importId: uuid, gymId: uuid, rowsOk: z.number().int().nonnegative(), rowsFailed: z.number().int().nonnegative(), by: uuid.nullable() });
// M24 prompt 2: SMS (add-on, prompt 3b) only when an event carries { billingRef } (§6.7); counts, subscriptions, invoices, referrals, overrides.
const gmSms = z.object({ billingRef: uuid }).nullable();
const gmCount = z.number().int().nonnegative();
const gmPlan = z.object({ assignmentId: uuid, planId: uuid, version: z.number().int().positive(), kind: z.enum(['workout', 'diet']), memberId: uuid, gymId: uuid, userId: uuid.nullable() });
const gmSub = z.object({ subscriptionId: uuid, ownerId: uuid, invoiceId: uuid.nullable(), number: z.string().max(24).nullable() });
const gmInvoice = z.object({ invoiceId: uuid, number: z.string().max(24), ownerId: uuid, total: poisha, dueAt: iso, period: z.string().regex(/^\d{4}-\d{2}$/).nullable() });
const gmReferral = z.object({ referralId: uuid, gymId: uuid, ownerId: uuid, memberId: uuid, amount: poisha, source: z.enum(['setting', 'owner_override', 'gym_override']) });
const gmOverride = z.object({ overrideId: uuid, scopeType: z.enum(['owner', 'gym']), scopeId: uuid, ownerId: uuid, key: z.enum(['fees.gym_referral_poisha', 'fees.gym_pct']), value: z.number().nonnegative(), validFrom: iso, validTo: iso.nullable() });
const trainerSubEvent = z.object({ subscriptionId: uuid, code: z.string().max(20), memberId: uuid, trainerId: uuid, price: poisha });
const orgEvent = z.object({ organisationId: uuid, ownerId: uuid });
const qualEvent = z.object({ qualificationId: uuid, eventId: uuid, finalTournamentId: uuid });
const contractEvent = z.object({ contractId: uuid, organisationId: uuid });
const invoiceEvent = z.object({ invoiceId: uuid, number: z.string().max(24), organisationId: uuid, total: poisha });
const fundEvent = z.object({ fundId: uuid, tournamentId: uuid, organisationId: uuid, amount: poisha });
const subOrderEvent = z.object({ subOrderId: uuid, code: z.string().max(24), orderId: uuid, shopId: uuid, sellerId: uuid, buyerId: uuid, total: poisha });
const docEvent = z.object({ documentId: uuid, userId: uuid, docType: z.string().max(30), role: z.string().max(32).optional() });
const payoutEvent = z.object({ payoutId: uuid, code: z.string(), payeeId: uuid, amount: poisha });
const subEvent = z.object({ submissionId: uuid, kind: z.string().max(30), subjectId: uuid, version: z.number().int(), submittedBy: uuid });
const esReg = z.object({ registrationId: uuid, tournamentId: uuid, registrantUserId: uuid });
const esMatch = z.object({ matchId: uuid, tournamentId: uuid });
const esProfile = z.object({ profileId: uuid, userId: uuid, gameId: uuid });
const esShare = z.object({ shareId: uuid, tournamentId: uuid, userId: uuid, amount: poisha });
const bookingEvent = z.object({ bookingId: uuid, code: z.string().max(16), groundId: uuid, ownerId: uuid, bookerUserId: uuid.nullable() });
const disputeEvent = z.object({ disputeId: uuid, code: z.string().max(20), sourceType: z.enum(['booking', 'esports_result', 'sub_order', 'hire_job', 'trainer_subscription']), sourceId: uuid, category: z.string().max(30), claimantId: uuid, respondentId: uuid.nullable() });
const subjectType = z.enum(['ground', 'booking', 'user', 'review', 'esports_tournament', 'shop', 'product', 'tournament_post', 'tournament_comment']);
// M17 review subjects (Round B1): venues, pro profiles (M11), shops (M12), gyms (M20).
const reviewSubject = z.enum(['ground', 'hire_profile', 'shop', 'gym']);
const reviewEvent = z.object({ reviewId: uuid, subjectType: reviewSubject, subjectId: uuid, authorId: uuid });
const docRequestEvent = z.object({ requestId: uuid, userId: uuid, docType: z.string().max(30), sourceRef: uuid.nullable(), dueAt: iso.nullable() });
const riskFlagEvent = z.object({ flagId: uuid, userId: uuid, ruleKey: z.string().max(40), severity: z.enum(['info', 'medium', 'high', 'critical']) });
// Round B3 staff accounts for businesses (business-members, identity group).
const businessMemberEvent = z.object({ businessMemberId: uuid, businessType: z.enum(['venue', 'gym', 'shop']), businessId: uuid, ownerId: uuid, memberId: uuid });
const permissionList = z.array(z.string().max(40)).max(20);
const catalogItem = z.object({ table: z.string(), id: uuid, key: z.string(), version: z.number().int().optional(), isActive: z.boolean().optional() });

const EVENTS = {
  // ---------------- M01 Identity ----------------
  'user.registered': { module: 'M01', version: 1, schema: z.object({ userId: uuid, roles: z.array(role) }) },
  'user.suspended': { module: 'M01', version: 1, schema: z.object({ userId: uuid, sanctionId: uuid, until: iso.nullable() }) },
  'user.banned': { module: 'M01', version: 1, schema: z.object({ userId: uuid, sanctionId: uuid }) },
  'user.restored': { module: 'M01', version: 1, schema: z.object({ userId: uuid }) },
  'user.phone_verified': { module: 'M01', version: 1, schema: z.object({ userId: uuid }) },
  'user.password_changed': { module: 'M01', version: 1, schema: z.object({ userId: uuid, via: z.enum(['reset', 'change']), at: iso }) },
  'user.identity_changed': { module: 'M01', version: 1, schema: z.object({ userId: uuid, fields: z.array(z.enum(['gender', 'dob', 'legal_name'])) }) },
  'user.email_changed': { module: 'M01', version: 1, schema: z.object({ userId: uuid }) },
  'user_role.applied': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role }) },
  'user_role.activated': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role }) },
  'user_role.reinstated': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role }) },
  'user_role.rejected': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role, reasonCode: z.string().max(40).nullable() }) },
  'user_role.suspended': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role, reasonCode: z.string().max(40).nullable() }) },
  // Round B3: an owner's staff (Q69, Q169, Q170).
  'business_member.added': { module: 'M01', version: 1, schema: businessMemberEvent.extend({ permissions: permissionList }) },
  'business_member.permissions_changed': { module: 'M01', version: 1, schema: businessMemberEvent.extend({ added: permissionList, removed: permissionList }) },
  'business_member.removed': { module: 'M01', version: 1, schema: businessMemberEvent },
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
    schema: z.object({ holdId: uuid, paymentId: uuid, purpose: z.string(), purposeId: uuid, amount: poisha, payeeId: uuid.nullable(), groupRef: uuid.nullable(), splitRef: uuid.nullable().optional() }),
  },
  'escrow.released': {
    module: 'M06',
    version: 1,
    schema: z.object({ holdId: uuid, purpose: z.string(), purposeId: uuid, gross: poisha, fee: poisha, net: poisha, payeeId: uuid, transactionId: uuid, providerCharge: poisha.optional() }),
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
  // consentVersion (M02-FR-05, 25 Oct 2026): the consent version accepted; optional so older events stay valid.
  'document.submitted': { module: 'M02', version: 1, schema: docEvent.extend({ version: z.number().int(), consentVersion: z.number().int().optional() }) },
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
  'esports_stream.live_started': { module: 'M21', version: 1, schema: z.object({ tournamentId: uuid, streamId: uuid, platform: z.string().max(20) }) },

  // ---------------- M16 Teams and players (ids only; never phones)
  'team.created': { module: 'M16', version: 1, schema: z.object({ teamId: uuid, sportId: uuid, captainId: uuid }) },
  'team.archived': { module: 'M16', version: 1, schema: z.object({ teamId: uuid }) },
  'team.captain_changed': { module: 'M16', version: 1, schema: z.object({ teamId: uuid, fromUserId: uuid.nullable(), toUserId: uuid }) },
  'team_member.added': { module: 'M16', version: 1, schema: z.object({ teamId: uuid, userId: uuid, role: z.enum(['captain', 'vice_captain', 'player']) }) },
  'team_member.removed': { module: 'M16', version: 1, schema: z.object({ teamId: uuid, userId: uuid, reasonCode: z.string().max(40) }) },
  'team_member.role_changed': { module: 'M16', version: 1, schema: z.object({ teamId: uuid, userId: uuid, role: z.enum(['vice_captain', 'player']) }) },
  'team_invite.sent': { module: 'M16', version: 1, schema: z.object({ inviteId: uuid, teamId: uuid, linked: z.boolean(), resent: z.boolean() }) },
  'team_invite.linked': { module: 'M16', version: 1, schema: z.object({ inviteId: uuid, teamId: uuid, userId: uuid }) },
  'team_invite.accepted': { module: 'M16', version: 1, schema: z.object({ inviteId: uuid, teamId: uuid, userId: uuid }) },
  'team_invite.declined': { module: 'M16', version: 1, schema: z.object({ inviteId: uuid, teamId: uuid }) },
  'team_invite.cancelled': { module: 'M16', version: 1, schema: z.object({ inviteId: uuid, teamId: uuid }) },
  'team_invite.expired': { module: 'M16', version: 1, schema: z.object({ inviteId: uuid, teamId: uuid }) },
  'eligibility.changed': { module: 'M16', version: 1, schema: z.object({ tournamentId: uuid, userId: uuid, eligible: z.boolean() }) },

  // ---------------- M14 Tournaments and M15 lite results (ids only) ----------------
  'tournament.created': { module: 'M14', version: 1, schema: tourEvent },
  'tournament.submitted': { module: 'M14', version: 1, schema: tourEvent },
  'tournament.approved': { module: 'M14', version: 1, schema: tourEvent },
  'tournament.changes_requested': { module: 'M14', version: 1, schema: tourEvent.extend({ reasonCode: z.string().max(40).nullable() }) },
  'tournament.rejected': { module: 'M14', version: 1, schema: tourEvent.extend({ reasonCode: z.string().max(40).nullable() }) },
  'tournament.registration_closed': { module: 'M14', version: 1, schema: tourEvent.extend({ approved: z.number().int(), belowMin: z.boolean() }) },
  'tournament.rules_changed': { module: 'M14', version: 1, schema: z.object({ tournamentId: uuid }) },
  'tournament.rules_unlocked': { module: 'M14', version: 1, schema: z.object({ tournamentId: uuid, until: iso }) },
  'tournament.rules_relocked': { module: 'M14', version: 1, schema: z.object({ tournamentId: uuid }) },
  'tournament.fixtures_published': { module: 'M14', version: 1, schema: tourEvent.extend({ matches: z.number().int() }) },
  'tournament.first_match_completed': { module: 'M14', version: 1, schema: z.object({ tournamentId: uuid, released: poisha }) },
  'tournament.completed': { module: 'M14', version: 1, schema: z.object({ tournamentId: uuid, released: poisha }) },
  'tournament.cancelled': { module: 'M14', version: 1, schema: tourEvent },
  'tournament.lots_needed': { module: 'M14', version: 1, schema: z.object({ tournamentId: uuid, stageId: uuid, groupId: uuid.nullable() }) },
  'registration.submitted': { module: 'M14', version: 1, schema: regEvent.extend({ status: z.string().max(20), organisationId: uuid }) },
  'registration.paid': { module: 'M14', version: 1, schema: regEvent.extend({ amount: poisha }) },
  'registration.approved': { module: 'M14', version: 1, schema: regEvent },
  'registration.rejected': { module: 'M14', version: 1, schema: regEvent.extend({ reason: z.string().max(255).nullable() }) },
  'registration.withdrawn': { module: 'M14', version: 1, schema: regEvent.extend({ reason: z.string().max(255).nullable() }) },
  'registration.removed': { module: 'M14', version: 1, schema: regEvent.extend({ reason: z.string().max(255).nullable() }) },
  'registration.lapsed': { module: 'M14', version: 1, schema: regEvent.extend({ reason: z.string().max(255).nullable() }) },
  'registration.cancelled': { module: 'M14', version: 1, schema: regEvent.extend({ reason: z.string().max(255).nullable() }) },
  'registration.promoted': { module: 'M14', version: 1, schema: regEvent.extend({ offerExpiresAt: iso }) },
  'registration.fee_waived': { module: 'M14', version: 1, schema: regEvent },
  'match.rescheduled': { module: 'M14', version: 1, schema: matchEvent },
  'match.postponed': { module: 'M14', version: 1, schema: matchEvent },
  'match.cancelled': { module: 'M14', version: 1, schema: matchEvent },
  'match.walkover_awarded': { module: 'M14', version: 1, schema: z.object({ matchId: uuid, tournamentId: uuid, winnerTeamId: uuid.nullable() }) },
  'match.teams_resolved': { module: 'M14', version: 1, schema: z.object({ matchId: uuid, tournamentId: uuid, teamAId: uuid, teamBId: uuid }) },
  'match.result_saved': { module: 'M15', version: 1, schema: matchEvent.extend({ outcome: z.string().max(20), winnerTeamId: uuid.nullable() }) },
  'match.result_corrected': { module: 'M15', version: 1, schema: matchEvent.extend({ outcome: z.string().max(20), winnerTeamId: uuid.nullable() }) },
  'standings.updated': { module: 'M15', version: 1, schema: z.object({ tournamentId: uuid, stageId: uuid, groupId: uuid.nullable() }) },

  // ---------------- M23 Esports big events (ids only; follower pages are user-id ranges, never lists) ----------------
  'esports_event.published': { module: 'M23', version: 1, schema: z.object({ eventId: uuid, startsAt: iso }) },
  'esports_event.cancelled': { module: 'M23', version: 1, schema: z.object({ eventId: uuid }) },
  'esports_event.followers_alerted': { module: 'M23', version: 1, schema: z.object({ eventId: uuid, alertId: uuid, kind: z.enum(['event_started', 'stream_live', 'final_soon']), fromUserId: uuid, toUserId: uuid }) },
  'esports_event_qualification.granted': { module: 'M23', version: 1, schema: qualEvent.extend({ status: z.enum(['qualified', 'invited']) }) },
  'esports_event_qualification.revoked': { module: 'M23', version: 1, schema: qualEvent.extend({ reasonCode: z.string().max(40) }) },
  'esports_event_qualification.missed': { module: 'M23', version: 1, schema: qualEvent },
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
  // ---------------- M13 orders, step 1 (shop orders)
  'order.created': { module: 'M13', version: 1, schema: orderEvent.extend({ subOrders: z.number().int() }) },
  'order.placed': { module: 'M13', version: 1, schema: orderEvent.extend({ subOrders: z.number().int() }) },
  'order.cancelled': { module: 'M13', version: 1, schema: orderEvent },
  'order.completed': { module: 'M13', version: 1, schema: orderEvent },
  'sub_order.placed': { module: 'M13', version: 1, schema: subOrderEvent.extend({ acceptBy: iso, items: z.number().int() }) },
  'sub_order.accept_reminded': { module: 'M13', version: 1, schema: subOrderEvent.extend({ acceptBy: iso.nullable() }) },
  'sub_order.accepted': { module: 'M13', version: 1, schema: subOrderEvent.extend({ shipBy: iso.nullable() }) },
  'sub_order.rejected': { module: 'M13', version: 1, schema: subOrderEvent.extend({ reason: z.string().max(40), refund: poisha }) },
  'sub_order.expired': { module: 'M13', version: 1, schema: subOrderEvent.extend({ reason: z.string().max(40), refund: poisha, by: z.string().max(10) }) },
  'sub_order.shipped': { module: 'M13', version: 1, schema: subOrderEvent.extend({ courier: z.string().max(60), tracking: z.string().max(40) }) },
  'sub_order.delivered': { module: 'M13', version: 1, schema: subOrderEvent.extend({ completeBy: iso.nullable(), proof: z.boolean() }) },
  'sub_order.completed': { module: 'M13', version: 1, schema: subOrderEvent.extend({ by: z.enum(['buyer', 'auto', 'dispute']), released: poisha, fee: poisha, net: poisha, refund: poisha.optional() }) },
  'sub_order.cancelled': { module: 'M13', version: 1, schema: subOrderEvent.extend({ reason: z.string().max(40), refund: poisha, by: z.string().max(10).optional() }) },
  'sub_order.disputed': { module: 'M13', version: 1, schema: subOrderEvent.extend({ disputeId: uuid }) },
  'sub_order.refunded': { module: 'M13', version: 1, schema: subOrderEvent.extend({ refund: poisha, disputeId: uuid }) },
  // ---------------- M11 hire, step 1
  'hire_profile.submitted': { module: 'M11', version: 1, schema: hireProfileEvent.extend({ version: z.number().int(), isEdit: z.boolean() }) },
  'hire_profile.published': { module: 'M11', version: 1, schema: hireProfileEvent.extend({ version: z.number().int(), first: z.boolean(), platformRole: z.enum(['player', 'pro']) }) },
  'hire_profile.changes_requested': { module: 'M11', version: 1, schema: hireProfileEvent.extend({ isEdit: z.boolean(), reasonCode: z.string().max(40).nullable() }) },
  'hire_profile.rejected': { module: 'M11', version: 1, schema: hireProfileEvent.extend({ isEdit: z.boolean(), reasonCode: z.string().max(40).nullable() }) },
  'hire_profile.paused': { module: 'M11', version: 1, schema: hireProfileEvent.extend({ reason: z.string().max(40).optional() }) },
  'hire_profile.resumed': { module: 'M11', version: 1, schema: hireProfileEvent },
  'hire_profile.suspended': { module: 'M11', version: 1, schema: hireProfileEvent.extend({ reason: reasonText }) },
  'hire_profile.restored': { module: 'M11', version: 1, schema: hireProfileEvent.extend({ reason: reasonText }) },
  'hire_request.sent': { module: 'M11', version: 1, schema: hireRequestEvent.extend({ replyBy: iso, jobs: z.number().int() }) },
  'hire_request.accepted': { module: 'M11', version: 1, schema: hireRequestEvent.extend({ payBy: iso }) },
  'hire_request.declined': { module: 'M11', version: 1, schema: hireRequestEvent.extend({ reason: z.string().max(40) }) },
  'hire_request.expired': { module: 'M11', version: 1, schema: hireRequestEvent },
  'hire_request.withdrawn': { module: 'M11', version: 1, schema: hireRequestEvent },
  'hire_request.lapsed': { module: 'M11', version: 1, schema: hireRequestEvent },
  'hire_request.paid': { module: 'M11', version: 1, schema: hireRequestEvent.extend({ paymentId: uuid }) },
  'hire_request.completed': { module: 'M11', version: 1, schema: hireRequestEvent },
  'hire_request.cancelled': { module: 'M11', version: 1, schema: hireRequestEvent },
  ...Object.fromEntries(['created', 'closed', 'expired', 'restored'].map((k) => [`tournament_post.${k}`, { module: 'M26', version: 1, schema: tournamentPostEvent }])),
  'tournament_post.removed': { module: 'M26', version: 1, schema: tournamentPostEvent.extend({ reason: z.string().max(300) }) },
  'tournament_post.commented': { module: 'M26', version: 1, schema: tournamentPostEvent.extend({ commentId: uuid, commenterId: uuid }) },
  'tournament_message.posted': { module: 'M26', version: 1, schema: z.object({ postId: uuid, title: z.string().max(120), threadId: uuid, messageId: uuid, senderId: uuid, recipientId: uuid }) },
  'hire_message.posted': { module: 'M11', version: 1, schema: z.object({ requestId: uuid, code: z.string().max(20), messageId: uuid, authorId: uuid, recipientId: uuid }) },
  'hire_job.checkin_opened': { module: 'M11', version: 1, schema: hireJobEvent.extend({ start: iso }) },
  'hire_job.check_in_recorded': { module: 'M11', version: 1, schema: hireJobEvent.extend({ late: z.boolean() }) },
  'hire_job.started': { module: 'M11', version: 1, schema: hireJobEvent },
  'hire_job.completed_marked': { module: 'M11', version: 1, schema: hireJobEvent.extend({ releaseAt: iso }) },
  'hire_job.released': { module: 'M11', version: 1, schema: hireJobEvent.extend({ by: z.enum(['hirer', 'auto', 'dispute']), gross: poisha, fee: poisha, net: poisha, refund: poisha.optional() }) },
  'hire_job.cancelled': { module: 'M11', version: 1, schema: hireJobEvent.extend({ by: z.enum(['hirer', 'staff']), refund: poisha, fee: poisha, proGets: poisha }) },
  'hire_job.withdrawn': { module: 'M11', version: 1, schema: hireJobEvent.extend({ refund: poisha, reason: z.string().max(40) }) },
  'hire_job.disputed': { module: 'M11', version: 1, schema: hireJobEvent.extend({ disputeId: uuid }) },
  'hire_job.refunded': { module: 'M11', version: 1, schema: hireJobEvent.extend({ by: z.literal('dispute'), gross: poisha, fee: poisha, net: poisha, refund: poisha }) },
  // ---------------- M20 gym, step 1
  'gym.submitted': { module: 'M20', version: 1, schema: gymEvent.extend({ version: z.number().int(), isEdit: z.boolean() }) },
  'gym.published': { module: 'M20', version: 1, schema: gymEvent.extend({ version: z.number().int(), first: z.boolean() }) },
  'gym.changes_requested': { module: 'M20', version: 1, schema: gymEvent.extend({ isEdit: z.boolean(), reasonCode: z.string().max(40).nullable() }) },
  'gym.rejected': { module: 'M20', version: 1, schema: gymEvent.extend({ isEdit: z.boolean(), reasonCode: z.string().max(40).nullable() }) },
  'gym.paused': { module: 'M20', version: 1, schema: gymEvent.extend({ reason: z.string().max(40).optional() }) },
  'gym.resumed': { module: 'M20', version: 1, schema: gymEvent },
  'gym.removed': { module: 'M20', version: 1, schema: gymEvent },
  'gym.suspended': { module: 'M20', version: 1, schema: gymEvent.extend({ reason: reasonText }) },
  'gym.restored': { module: 'M20', version: 1, schema: gymEvent.extend({ reason: reasonText }) },
  'gym_pass.paid': { module: 'M20', version: 1, schema: gymPassEvent.extend({ validFrom: iso, validTo: iso, paymentId: uuid }) },
  // M24-FR-52: the redemption row and its Dhaka day (gym-manage records a linked member's check-in).
  'gym_pass.redeemed': { module: 'M20', version: 1, schema: gymPassEvent.extend({ method: z.enum(['qr', 'code']), released: poisha, net: poisha, redemptionId: uuid.optional(), redeemedOn: z.string().max(10).optional() }) },
  'gym_pass.expired': { module: 'M20', version: 1, schema: gymPassEvent.extend({ used: z.boolean(), released: poisha, net: poisha }) },
  'gym_pass.cancelled': { module: 'M20', version: 1, schema: gymPassEvent.extend({ refund: poisha, by: z.enum(['holder', 'staff']) }) },
  'trainer_subscription.started': { module: 'M20', version: 1, schema: trainerSubEvent.extend({ seq: z.number().int(), periodStart: iso, periodEnd: iso, paymentId: uuid }) },
  'trainer_subscription.renewed': { module: 'M20', version: 1, schema: trainerSubEvent.extend({ seq: z.number().int(), periodStart: iso, periodEnd: iso, paymentId: uuid }) },
  'trainer_subscription.renewal_opened': { module: 'M20', version: 1, schema: trainerSubEvent.extend({ seq: z.number().int(), periodStart: iso, payBy: iso }) },
  // M14 lite organisations and M22 organiser SaaS
  'organisation.submitted': { module: 'M14', version: 1, schema: orgEvent },
  'organisation.verified': { module: 'M14', version: 1, schema: orgEvent },
  'organisation.changes_requested': { module: 'M14', version: 1, schema: orgEvent.extend({ reasonCode: z.string().max(40).nullable() }) },
  'organisation.rejected': { module: 'M14', version: 1, schema: orgEvent.extend({ reasonCode: z.string().max(40).nullable() }) },
  'organisation.suspended': { module: 'M14', version: 1, schema: orgEvent.extend({ reason: reasonText }) },
  'organisation.restored': { module: 'M14', version: 1, schema: orgEvent.extend({ reason: reasonText }) },
  'organisation.member_added': { module: 'M14', version: 1, schema: orgEvent.extend({ userId: uuid, role: z.enum(['admin', 'staff']) }) },
  'organiser_contract.activated': { module: 'M22', version: 1, schema: contractEvent.extend({ model: z.enum(['percentage', 'flat']), reinstated: z.boolean() }) },
  'organiser_contract.suspended': { module: 'M22', version: 1, schema: contractEvent.extend({ reason: reasonText }) },
  'organiser_contract.ended': { module: 'M22', version: 1, schema: contractEvent.extend({ reason: reasonText }) },
  'organiser_contract.expiry_notified': { module: 'M22', version: 1, schema: contractEvent.extend({ endsOn: z.string().max(10) }) },
  'organiser_invoice.issued': { module: 'M22', version: 1, schema: invoiceEvent },
  'organiser_invoice.paid': { module: 'M22', version: 1, schema: invoiceEvent },
  'organiser_invoice.overdue_flagged': { module: 'M22', version: 1, schema: invoiceEvent },
  'organiser_invoice.voided': { module: 'M22', version: 1, schema: invoiceEvent },
  'organiser_prize_fund.deposited': { module: 'M22', version: 1, schema: fundEvent.extend({ deposited: poisha, funded: z.boolean() }) },
  'organiser_prize_fund.returned': { module: 'M22', version: 1, schema: fundEvent },
  'organisation_branding.published': { module: 'M22', version: 1, schema: z.object({ organisationId: uuid, version: z.number().int(), subdomain: z.string().max(30).nullable() }) },
  'trainer_subscription.cancelled': { module: 'M20', version: 1, schema: trainerSubEvent.extend({ refund: poisha, seq: z.number().int().optional(), endsOn: iso.nullable().optional() }) },
  'trainer_subscription.ended': { module: 'M20', version: 1, schema: trainerSubEvent },
  'trainer_subscription.lapsed': { module: 'M20', version: 1, schema: trainerSubEvent },
  'trainer_subscription.released': { module: 'M20', version: 1, schema: trainerSubEvent.extend({ seq: z.number().int(), gross: poisha, fee: poisha, net: poisha, refund: poisha.optional(), by: z.literal('dispute').optional() }) },
  'trainer_subscription.disputed': { module: 'M20', version: 1, schema: trainerSubEvent.extend({ seq: z.number().int(), disputeId: uuid }) },
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
  'review.replied': { module: 'M17', version: 1, schema: reviewEvent.extend({ firstReply: z.boolean().optional() }) },
  'review.aggregate_updated': { module: 'M17', version: 1, schema: z.object({ subjectType: reviewSubject, subjectId: uuid, count: z.number().int().nonnegative(), avg: z.number().nullable() }) },

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

  // ---------------- M24 Gym management, prompt 1 (§2.2): ids, codes, poisha, Dhaka dates; never a name, phone, email or health note
  'gym_member.added': { module: 'M24', version: 1, schema: gmMember.extend({ source: z.enum(['desk', 'platform', 'import', 'pass']), linked: z.boolean() }) },
  'gym_member.left': { module: 'M24', version: 1, schema: gmMember.extend({ reason: z.string().max(12) }) },
  'gym_member.rejoined': { module: 'M24', version: 1, schema: gmMember },
  'gym_member.removed': { module: 'M24', version: 1, schema: gmMember },
  'gym_member.linked': { module: 'M24', version: 1, schema: gmMember.extend({ userId: uuid }) },
  'gym_member.unlinked': { module: 'M24', version: 1, schema: gmMember.extend({ userId: uuid }) },
  'gym_link.requested': { module: 'M24', version: 1, schema: gmLink.extend({ ownerId: uuid, expiresAt: iso, attached: z.boolean().optional() }) },
  'gym_link.accepted': { module: 'M24', version: 1, schema: gmLink },
  'gym_link.declined': { module: 'M24', version: 1, schema: gmLink },
  'gym_link.expired': { module: 'M24', version: 1, schema: gmLink },
  'gym_link.cancelled': { module: 'M24', version: 1, schema: gmLink },
  'gym_membership.started': { module: 'M24', version: 1, schema: gmMembership.extend({ packageKind: gmKind, startsOn: day, endsOn: day, userId: uuid.nullable() }) },
  'gym_membership.renewed': { module: 'M24', version: 1, schema: gmMembership.extend({ packageKind: gmKind, startsOn: day, endsOn: day, userId: uuid.nullable() }) },
  'gym_membership.changed': { module: 'M24', version: 1, schema: gmMembership.extend({ packageKind: gmKind, startsOn: day, endsOn: day, userId: uuid.nullable(), previousId: uuid }) },
  'gym_membership.frozen': { module: 'M24', version: 1, schema: gmMembership.extend({ fromOn: day, toOn: day, endsOn: day }) },
  'gym_membership.unfrozen': { module: 'M24', version: 1, schema: gmMembership.extend({ fromOn: day, toOn: day, endsOn: day }) },
  'gym_membership.expired': { module: 'M24', version: 1, schema: gmMembership.extend({ endsOn: day }) },
  'gym_membership.cancelled': { module: 'M24', version: 1, schema: gmMembership.extend({ endsOn: day, reason: z.string().max(40).nullable() }) },
  'gym_due.created': { module: 'M24', version: 1, schema: gmDue.extend({ membershipId: uuid, amount: poisha, dueOn: day }) },
  // §2.2 calls it gym_due.overdue; FR-19 needs a past-tense verb (as document_request.overdue_marked).
  'gym_due.overdue_marked': { module: 'M24', version: 1, schema: gmDue.extend({ outstanding: poisha, dueOn: day }) },
  'gym_due.paid': { module: 'M24', version: 1, schema: gmDue.extend({ amount: poisha }) },
  // M27 gym operations, round 1: the gym's own books (no ledger).
  'gym_expense.recorded': { module: 'M27', version: 1, schema: z.object({ expenseId: uuid, gymId: uuid, amount: poisha, categoryKey: z.string().max(30).nullable(), method: z.string().max(20), fromDrawer: z.boolean(), spentOn: day }) },
  'gym_expense.voided': { module: 'M27', version: 1, schema: z.object({ expenseId: uuid, gymId: uuid, amount: poisha }) },
  'gym_cash.opened': { module: 'M27', version: 1, schema: z.object({ sessionId: uuid, gymId: uuid, date: day, opening: poisha }) },
  'gym_cash.closed': { module: 'M27', version: 1, schema: z.object({ sessionId: uuid, gymId: uuid, date: day, expected: z.number().int(), counted: poisha, difference: z.number().int() }) },
  'gym_sale.recorded': { module: 'M27', version: 1, schema: z.object({ saleId: uuid, gymId: uuid, kind: z.enum(['pos', 'locker']), amount: poisha, method: z.string().max(20), receiptNo: z.string().max(24), memberId: uuid.nullable() }) },
  'gym_sale.reversed': { module: 'M27', version: 1, schema: z.object({ saleId: uuid, gymId: uuid, kind: z.enum(['pos', 'locker']), amount: poisha, method: z.string().max(20), receiptNo: z.string().max(24) }) },
  'gym_stock.low_reached': { module: 'M27', version: 1, schema: z.object({ productId: uuid, gymId: uuid, item: z.string().max(80), stockQty: z.number().int().nonnegative(), reorderLevel: z.number().int().nonnegative() }) },
  'gym_product.expiry_warned': { module: 'M27', version: 1, schema: z.object({ productId: uuid, gymId: uuid, item: z.string().max(80), expiresOn: day, stockQty: z.number().int().nonnegative(), expired: z.boolean() }) },
  'gym_locker.rented': { module: 'M27', version: 1, schema: z.object({ rentalId: uuid, gymId: uuid, lockerId: uuid, memberId: uuid, startsOn: day, endsOn: day, fee: poisha }) },
  'gym_locker.end_reminded': { module: 'M27', version: 1, schema: z.object({ rentalId: uuid, gymId: uuid, lockerId: uuid, memberId: uuid, endsOn: day }) },
  // M27 round 2: visits, classes, points, notices, enquiries.
  'gym_attendance.exited': { module: 'M27', version: 1, schema: z.object({ attendanceId: uuid, gymId: uuid, memberId: uuid, method: z.enum(['desk', 'entrance_qr', 'auto']), visitMinutes: z.number().int().nonnegative().nullable(), localDate: day }) },
  'gym_class.session_cancelled': { module: 'M27', version: 1, schema: z.object({ sessionId: uuid, gymId: uuid, classId: uuid, startsAt: z.string().max(40), memberIds: z.array(uuid).max(1000) }) },
  'gym_class.reminded': { module: 'M27', version: 1, schema: z.object({ sessionId: uuid, gymId: uuid, classId: uuid, startsAt: z.string().max(40), memberIds: z.array(uuid).max(1000) }) },
  'gym_booking.made': { module: 'M27', version: 1, schema: z.object({ bookingId: uuid, sessionId: uuid, gymId: uuid, memberId: uuid, status: z.enum(['booked', 'waitlisted']), source: z.enum(['member', 'desk']) }) },
  'gym_booking.cancelled': { module: 'M27', version: 1, schema: z.object({ bookingId: uuid, sessionId: uuid, gymId: uuid, memberId: uuid, source: z.enum(['member', 'desk']) }) },
  'gym_booking.promoted': { module: 'M27', version: 1, schema: z.object({ bookingId: uuid, sessionId: uuid, gymId: uuid, memberId: uuid, startsAt: z.string().max(40) }) },
  'gym_points.earned': { module: 'M27', version: 1, schema: z.object({ gymId: uuid, memberId: uuid, points: z.number().int().positive(), streak: z.boolean(), balance: z.number().int() }) },
  'gym_points.redeemed': { module: 'M27', version: 1, schema: z.object({ gymId: uuid, memberId: uuid, rewardId: uuid, points: z.number().int().positive(), kind: z.enum(['days', 'discount']) }) },
  'gym_notice.sent': { module: 'M27', version: 1, schema: z.object({ noticeId: uuid, gymId: uuid, targetCount: z.number().int().nonnegative() }) },
  'gym_lead.received': { module: 'M27', version: 1, schema: z.object({ leadId: uuid, gymId: uuid, ownerId: uuid }) },
  'gym_locker.ended': { module: 'M27', version: 1, schema: z.object({ rentalId: uuid, gymId: uuid, lockerId: uuid, memberId: uuid, by: z.enum(['staff', 'job']) }) },
  'gym_due.waived': { module: 'M24', version: 1, schema: gmDue.extend({ amount: poisha }) },
  'gym_fee.recorded': {
    module: 'M24',
    version: 1,
    schema: gmDue.extend({ feePaymentId: uuid, ownerId: uuid, amount: poisha, method: gmMethod, receiptNo: z.string().max(24), paidOn: day, outstandingAfter: poisha, by: uuid.nullable(), sms: z.object({ billingRef: uuid }).nullable() }),
  },
  'gym_fee.reversed': { module: 'M24', version: 1, schema: z.object({ feePaymentId: uuid, reversesId: uuid, dueId: uuid, memberId: uuid, gymId: uuid, amount: poisha, reason: z.string().max(300) }) },
  'gym_attendance.recorded': { module: 'M24', version: 1, schema: z.object({ attendanceId: uuid, gymId: uuid, memberId: uuid, method: z.enum(['desk', 'member_qr', 'entrance_qr', 'pass']), localDate: day }) },
  'gym_subscription.tier_changed': { module: 'M24', version: 1, schema: z.object({ subscriptionId: uuid, ownerId: uuid, from: gmTier, to: gmTier }) },
  'gym_import.previewed': { module: 'M24', version: 1, schema: gmImport },
  'gym_import.applied': { module: 'M24', version: 1, schema: gmImport },
  'gym_import.undone': { module: 'M24', version: 1, schema: gmImport },

  // ---------------- M24 Gym management, prompt 2 (§2.2): online fees, reminders, billing. Names the
  // past-tense rule (FR-19) refuses are built as: gym_membership.expiring → renewal_reminded,
  // .ends_today → end_reminded, gym_owner.morning_summary → summary_prepared, .monthly_report →
  // report_prepared, gym_subscription.past_due → past_due_marked, gym_invoice.overdue → overdue_marked.
  // The expired reminder (§6.9, the day after the end, once) is gym_membership.expiry_reminded.
  'gym_payment_link.created': {
    module: 'M24',
    version: 1,
    schema: gmDue.extend({ linkId: uuid, ownerId: uuid, amount: poisha, expiresAt: iso, origin: z.enum(['staff', 'member']), channels: z.array(z.enum(['in_app', 'email', 'sms'])), sms: gmSms }),
  },
  'gym_membership.renewal_reminded': { module: 'M24', version: 1, schema: gmMembership.extend({ endsOn: day, outstanding: poisha, linkId: uuid.nullable(), sms: gmSms }) },
  'gym_membership.end_reminded': { module: 'M24', version: 1, schema: gmMembership.extend({ endsOn: day, sms: gmSms }) },
  'gym_membership.expiry_reminded': { module: 'M24', version: 1, schema: gmMembership.extend({ endsOn: day }) },
  'gym_due.overdue_reminded': { module: 'M24', version: 1, schema: gmDue.extend({ outstanding: poisha, dueOn: day, daysOverdue: z.number().int().positive(), linkId: uuid.nullable(), sms: gmSms }) },
  'gym_owner.summary_prepared': {
    module: 'M24',
    version: 1,
    schema: z.object({ gymId: uuid, ownerId: uuid, localDate: day, expiringToday: gmCount, overdue: gmCount, notSeen: gmCount, requestsWaiting: gmCount }),
  },
  'gym_owner.report_prepared': {
    module: 'M24',
    version: 1,
    schema: z.object({ gymId: uuid, ownerId: uuid, month: z.string().regex(/^\d{4}-\d{2}$/), collected: z.number().int(), outstanding: poisha, newMembers: gmCount, left: gmCount }),
  },
  'gym_active_members.counted': { module: 'M24', version: 1, schema: z.object({ ownerId: uuid, localDate: day, count: gmCount, gymsCount: gmCount, tierLimit: z.number().int().nullable(), chosenTier: gmTier, notice: z.boolean() }) },
  'gym_subscription.past_due_marked': { module: 'M24', version: 1, schema: gmSub },
  'gym_subscription.restricted': { module: 'M24', version: 1, schema: gmSub },
  'gym_subscription.restored': { module: 'M24', version: 1, schema: gmSub },
  'gym_invoice.issued': { module: 'M24', version: 1, schema: gmInvoice },
  'gym_invoice.paid': { module: 'M24', version: 1, schema: gmInvoice },
  'gym_invoice.overdue_marked': { module: 'M24', version: 1, schema: gmInvoice.extend({ restrictOn: day }) },
  'gym_invoice.voided': { module: 'M24', version: 1, schema: gmInvoice },
  'gym_invoice.reminded': { module: 'M24', version: 1, schema: gmInvoice.extend({ offsetKey: z.enum(['d-3', 'd0']) }) },
  'gym_referral.charged': { module: 'M24', version: 1, schema: gmReferral },
  'gym_referral.voided': { module: 'M24', version: 1, schema: gmReferral.extend({ reason: z.string().max(40) }) },
  'gym_fee_override.set': { module: 'M24', version: 1, schema: gmOverride },
  'gym_fee_override.ended': { module: 'M24', version: 1, schema: gmOverride.extend({ reason: z.string().max(40) }) },

  // ---------------- M24 Gym management, prompt 3 (§2.2): plans and diet charts, trainer assignment.
  // Join requests reuse gym_link.requested / .accepted / .declined / .cancelled / .expired (direction join_request).
  'gym_plan.assigned': { module: 'M24', version: 1, schema: gmPlan },
  'gym_plan.updated': { module: 'M24', version: 1, schema: gmPlan.extend({ previousVersion: z.number().int().positive() }) },
  'gym_plan.ended': { module: 'M24', version: 1, schema: gmPlan.extend({ reason: z.enum(['replaced', 'ended', 'end_date', 'member_removed']) }) },
  'gym_member.trainer_assigned': {
    module: 'M24',
    version: 1,
    schema: gmMember.extend({ businessMemberId: uuid.nullable(), previousBusinessMemberId: uuid.nullable(), reason: z.enum(['assigned', 'cleared', 'staff_removed', 'permissions_removed']) }),
  },
};
/** FR-19: `<aggregate>.<past_tense_verb>`, snake_case. Irregular past tenses are listed. */
const IRREGULAR = new Set(['sent', 'paid', 'held', 'won', 'lost', 'made', 'begun', 'done', 'drawn', 'shown', 'thrown', 'given', 'taken', 'built', 'set', 'put', 'cut', 'withdrawn', 'chosen', 'written', 'frozen', 'unfrozen', 'undone', 'seen', 'broken', 'sold', 'told', 'found', 'left', 'met', 'read', 'run', 'spent', 'struck', 'hidden', 'unhidden']);
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
