'use strict';

/**
 * Module groups and model ownership (ADR-007 §2). A group is where a service could be cut later; every
 * model (table) has exactly one owning module, and only that module writes it. The boundary test
 * (tests/unit/boundaries.test.js) reads this file. Add new modules and models here when they are built.
 */

/** Module groups (future service boundaries). `shared` stays a library: audit log and outbox. */
const GROUPS = {
  identity: ['auth', 'users', 'admin', 'business-members'],
  platform: ['settings', 'catalog', 'analytics'],
  shared: ['audit', 'events'],
  notification: ['notifications'],
  payment: ['payments', 'payouts'],
  trust: ['kyc', 'moderation', 'risk', 'trust'],
  booking: ['grounds', 'bookings'],
  marketplace: ['market', 'orders'],
  hiring: ['hire'],
  gym: ['gym', 'gym-manage', 'gym-ops'],
  esports: ['esports', 'esports-events', 'organisations', 'organiser-saas'],
  tournament: ['teams', 'tournaments', 'scoring', 'tournament-posts'],
};

/** Sequelize model name → owning module. */
const OWNERS = {
  'auth': ['Session', 'OtpCode', 'OAuthIdentity', 'StepUpToken'],
  'users': ['User', 'UserRole', 'UserSanction'],
  'admin': ['StaffMember', 'StaffPermission'],
  // Round B3 (Q69, Q169, Q170): staff accounts working at one venue, gym or shop for its owner.
  'business-members': ['BusinessMember'],
  'settings': ['PlatformSetting', 'SettingsHistory', 'SettingsChangeRequest'],
  'catalog': ['Sport', 'Division', 'District', 'Area', 'Facility', 'Surface', 'SportRuleSchema', 'Exercise', 'ItemCategory', 'ItemType', 'ItemTypeField', 'HireCategory', 'HireRole', 'EsportsGame', 'EsportsMode', 'EsportsMap', 'EsportsPointsPreset'],
  'analytics': ['KpiFactBooking', 'KpiFactCourtDay', 'KpiFactPayment', 'KpiFactLedgerTxn', 'KpiFactEsportsEntry', 'KpiFactEsportsTournament', 'KpiProcessedEvent', 'KpiDrift', 'KpiFactSubOrder', 'KpiFactOrderLine', 'KpiFactGymPass', 'KpiFactGymAdmission'],
  'audit': ['AuditLog', 'AuditChain', 'AuditExport'],
  'events': ['OutboxEvent', 'ConsumedEvent'],
  'notifications': ['Notification', 'NotificationPref', 'MessageTemplate', 'NotificationDelivery', 'NotificationExternalDelivery', 'SmsLog', 'PushSubscription', 'PushReceipt'],
  'payments': ['Payment', 'PaymentAttempt', 'ProviderWebhookEvent', 'Refund', 'LedgerAccount', 'LedgerTransaction', 'LedgerEntry', 'EscrowHold', 'ReconciliationRun', 'ReconciliationItem', 'IdempotencyKey', 'IdSequence'],
  'payouts': ['PayoutAccount', 'PayoutBatch', 'Payout', 'PayoutItem', 'PayoutHold', 'PayoutApproval', 'PayoutReveal'],
  'kyc': ['DocumentRequirement', 'VerificationDocument', 'DocumentFile', 'DocumentRequest'],
  'moderation': ['RejectionReason', 'ReviewRubric', 'Submission', 'SubmissionCheck', 'ReviewClaim'],
  'trust': ['Dispute', 'DisputeEvidence', 'Report', 'Review', 'ReviewAggregate'],
  'risk': ['RiskRule', 'RiskMetric', 'RiskFlag', 'RiskAction', 'TrustScore'],
  'grounds': ['Ground', 'GroundPhoto', 'Court', 'CourtHours', 'PricingRule', 'Closure', 'BookingSeries'],
  'bookings': ['Booking', 'BookingSlot', 'CheckIn'],
  'market': ['Shop', 'Product', 'ProductVariant', 'ProductPhoto', 'InventoryMovement', 'SavedItem'],
  'orders': ['Cart', 'CartItem', 'Order', 'SubOrder', 'OrderItem'],
  'hire': ['HireProfile', 'RateCard', 'RateCardItem', 'HireRequest', 'HireJob', 'HireMessage', 'HireShortlist', 'AvailabilityBlock'],
  'gym': ['Gym', 'GymHours', 'GymSpecialDay', 'GymPhoto', 'GymPackage', 'GymPass', 'PassRedemption', 'TrainerPlan', 'TrainerSubscription', 'TrainerSubscriptionPeriod'],
  // M24 gym management (prompts 1 and 2 of 3b: 18 of the 24 tables, §7.2); reads M20 only through gym/index.js.
  'gym-manage': ['GymManageSettings', 'GymVisit', 'GymBodyEntry', 'GymDeskPin', 'GymDeskSession', 'GymDeskUnlock', 'GymDeskOfflineItem', 'GymMember', 'GymLinkRequest', 'GymMembership', 'GymFreeze', 'GymDue', 'GymFeePayment', 'GymAttendance', 'GymAttendanceExit', 'GymMemberNote', 'GymImport', 'GymOwnerSubscription', 'GymPaymentLink', 'GymReminder', 'GymOwnerAddon', 'GymSmsEntry', 'GymActiveMemberCount', 'GymSubscriptionInvoice', 'GymSubscriptionInvoiceLine', 'GymFeeOverride', 'GymReferral', 'GymPlan', 'GymPlanVersion', 'GymPlanAssignment', 'GymPlanLog'],
  'organisations': ['Organisation', 'OrganisationMember'],
  'organiser-saas': ['OrganiserContract', 'OrganiserInvoice', 'OrganiserInvoiceLine', 'OrganiserPrizeFund', 'OrganisationBranding'],
  'esports-events': ['EsportsEvent', 'EsportsEventStage', 'EsportsEventQualification', 'EsportsEventStream', 'EsportsEventSponsor', 'EsportsEventPoll', 'EsportsEventPollOption', 'EsportsEventPollVote', 'EsportsEventFollow', 'EsportsEventFeedItem', 'EsportsEventAlert'],
  'esports': ['EsportsGameProfile', 'EsportsUidBan', 'EsportsSquad', 'EsportsSquadMember', 'EsportsTournament', 'EsportsPrizePlace', 'EsportsStage', 'EsportsMatch', 'EsportsRegistration', 'EsportsRegistrationPlayer', 'EsportsCheckin', 'EsportsRoomCredential', 'EsportsCredentialView', 'EsportsResult', 'EsportsResultPlayer', 'EsportsResultEvidence', 'EsportsResultDispute', 'EsportsDisqualification', 'EsportsStanding', 'EsportsPrizeAward', 'EsportsPrizeShare', 'EsportsStream', 'EsportsRankingEntry', 'EsportsRanking'],
  // M27 gym operations (round 1): expenses, the cash drawer, the counter shop and lockers.
  'gym-ops': ['GymExpenseCategory', 'GymExpense', 'GymCashSession', 'GymProduct', 'GymStockMove', 'GymSale', 'GymSaleLine', 'GymLocker', 'GymLockerRental', 'GymClass', 'GymClassSchedule', 'GymClassSession', 'GymClassBooking', 'GymReward', 'GymPointEntry', 'GymMemberReferral', 'GymNotice', 'GymLead', 'GymStaffShift', 'GymStaffTime', 'GymStaffPay', 'GymPayrollRun', 'GymPayrollLine', 'GymAsset', 'GymAssetLog'],
  'tournament-posts': ['TournamentPost', 'TournamentPostPhoto', 'TournamentPostComment', 'TournamentPostThread', 'TournamentPostMessage'],
  'teams': ['Team', 'TeamMember', 'TeamInvite', 'PlayerProfile', 'Roster', 'RosterPlayer', 'EligibilityCheck'],
  'tournaments': ['Tournament', 'TournamentRules', 'TournamentVenue', 'Stage', 'Group', 'GroupTeam', 'Registration', 'Match', 'Standing'],
  'scoring': ['MatchResult'],
  // Not a module: the demo seeder (scripts/demo) owns its bookkeeping table. It has no group, so any
  // module that reads or writes it fails the boundary test.
  'scripts/demo': ['DemoRecord'],
};

const groupOf = Object.fromEntries(Object.entries(GROUPS).flatMap(([g, ms]) => ms.map((m) => [m, g])));
const ownerOf = Object.fromEntries(Object.entries(OWNERS).flatMap(([m, models]) => models.map((n) => [n, m])));

module.exports = { GROUPS, OWNERS, groupOf, ownerOf };
