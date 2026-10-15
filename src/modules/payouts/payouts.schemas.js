'use strict';

/**
 * M07 request and response schemas (zod → validation and OpenAPI). Amounts are integer poisha.
 * Account numbers appear in requests (add) and in the reveal response only; everything else carries
 * the masked form ("bKash ••• 4321").
 */
const { z } = require('zod');
const rules = require('./payouts.rules');

const dateTime = z.iso.datetime({ offset: true });
const poisha = z.number().int().nonnegative();
const signed = z.number().int();
const limit = (max, def) => z.coerce.number().int().min(1).max(max).default(def);
const PAYOUT_STATUSES = ['scheduled', 'needs_approval', 'on_hold', 'processing', 'paid', 'failed', 'cancelled'];
const ACCOUNT_STATUSES = ['pending_verification', 'active', 'rejected', 'superseded', 'disabled'];
const HOLD_TYPES = ['account_change', 'risk_freeze', 'dispute', 'kyc', 'account_suspended', 'manual'];

const idParam = z.object({ id: z.uuid() });
const reason = z.string().trim().min(3).max(300);

// ---------------- payee
const accountAdd = z.object({
  type: z.enum(['bkash', 'nagad']),
  accountNo: z.string().trim().min(11).max(20).meta({ description: 'Wallet number, e.g. 01712345678 (+880 accepted)' }),
  accountName: z.string().trim().min(3).max(120).meta({ description: 'Name on the wallet; must match the NID name' }),
  code: z.string().regex(/^\d{6}$/).meta({ description: 'Code sent to your registered phone (POST /me/payout-accounts/otp)' }),
});
const meListQuery = z.object({ cursor: z.uuid().optional(), limit: limit(50, 20) });
const statementQuery = z.object({ locale: z.enum(['en', 'bn']).default('en') });

// ---------------- admin
const adminListQuery = z.object({
  status: z.enum(PAYOUT_STATUSES).optional(),
  kind: z.enum(['earning', 'refund']).optional(),
  payeeId: z.uuid().optional(),
  batchId: z.uuid().optional(),
  cursor: z.uuid().optional(),
  limit: limit(100, 50),
});
const accountsQuery = z.object({ status: z.enum(ACCOUNT_STATUSES).default('pending_verification'), cursor: z.uuid().optional(), limit: limit(100, 50) });
const verifyBody = z.object({ note: z.string().trim().max(300).optional() });
const rejectBody = z.object({ note: reason });
const holdBody = z.object({ reason, scope: z.enum(['payout', 'payee']).default('payout').meta({ description: 'payee: every payout of this payee' }) });
const liftBody = z.object({ holdId: z.uuid(), reason });
const markPaidBody = z.object({
  reference: z.string().trim().min(4).max(120).meta({ description: 'bKash / Nagad transaction ID of the send' }),
  note: z.string().trim().max(300).optional(),
});
const markFailedBody = z.object({ reason: z.enum(Object.keys(rules.FAILURE_REASONS)), note: z.string().trim().max(300).optional() });
const cancelBody = z.object({ reason });
const runBody = z.object({ schedule: z.enum(['daily', 'ground_weekly', 'shop_weekly']) });
const batchesQuery = z.object({ cursor: z.uuid().optional(), limit: limit(100, 50) });

// ---------------- responses
const Account = z
  .object({
    id: z.uuid(),
    type: z.enum(['bkash', 'nagad']),
    masked: z.string(),
    last4: z.string(),
    accountName: z.string(),
    status: z.enum(ACCOUNT_STATUSES),
    reviewNote: z.string().nullable(),
    activatedAt: dateTime.nullable(),
    holdUntil: dateTime.nullable(),
    createdAt: dateTime,
  })
  .meta({ id: 'PayoutAccount' });
const AccountList = z.object({ items: z.array(Account) }).meta({ id: 'PayoutAccountList' });
const CodeSent = z.object({ sent: z.boolean(), expiresInSeconds: z.number().int(), resendInSeconds: z.number().int() }).meta({ id: 'PayoutAccountCodeSent' });
const ReviewRow = Account.extend({
  userId: z.uuid(),
  user: z.object({ displayName: z.string().nullable(), legalName: z.string().nullable(), kycStatus: z.string().nullable() }),
  sameWalletUsers: z.number().int().meta({ description: 'Other users with this wallet (pending or active)' }),
  reviewedBy: z.uuid().nullable(),
  reviewedAt: dateTime.nullable(),
});
const ReviewPage = z.object({ items: z.array(ReviewRow), nextCursor: z.string().nullable() }).meta({ id: 'PayoutAccountReviewPage' });

const AccountRef = z.object({ id: z.uuid(), type: z.string(), masked: z.string(), status: z.string() }).nullable();
const Payout = z
  .object({
    id: z.uuid(),
    code: z.string(),
    kind: z.enum(['earning', 'refund']),
    payeeId: z.uuid(),
    batchId: z.uuid().nullable(),
    refundId: z.uuid().nullable(),
    status: z.enum(PAYOUT_STATUSES),
    gross: poisha,
    deductions: poisha,
    netting: poisha,
    adjustments: signed,
    amount: poisha,
    threshold: poisha,
    account: AccountRef,
    channel: z.string().nullable(),
    providerRef: z.string().nullable(),
    attempts: z.number().int(),
    failureCode: z.string().nullable(),
    failureNote: z.string().nullable(),
    periodStart: dateTime.nullable(),
    periodEnd: dateTime.nullable(),
    releasedBy: z.uuid().nullable(),
    releasedAt: dateTime.nullable(),
    paidAt: dateTime.nullable(),
    createdAt: dateTime,
  })
  .meta({ id: 'Payout' });
const Item = z.object({
  id: z.uuid(),
  sourceType: z.string(),
  sourceId: z.uuid(),
  ledgerEntryId: z.number().int().nullable(),
  gross: poisha,
  fee: poisha,
  net: signed,
  description: z.string(),
  status: z.enum(['included', 'returned']),
});
const Hold = z.object({
  id: z.uuid(),
  scope: z.enum(['payee', 'payout', 'item_source']),
  type: z.enum(HOLD_TYPES),
  payeeId: z.uuid(),
  payoutId: z.uuid().nullable(),
  sourceType: z.string().nullable(),
  sourceId: z.uuid().nullable(),
  reason: z.string().nullable(),
  until: dateTime.nullable(),
  placedBy: z.uuid().nullable(),
  placedAt: dateTime,
  liftedBy: z.uuid().nullable(),
  liftedAt: dateTime.nullable(),
  liftReason: z.string().nullable(),
});
const Approval = z.object({ step: z.number().int(), by: z.uuid(), name: z.string().nullable(), at: dateTime });
const PayoutDetail = Payout.extend({
  payee: z.object({ id: z.uuid(), name: z.string().nullable() }),
  items: z.array(Item),
  holds: z.array(Hold),
  approvals: z.array(Approval),
  reveals: z.number().int(),
  ledger: z.array(z.uuid()),
}).meta({ id: 'PayoutDetail' });
const Approved = Payout.extend({ approvals: z.array(Approval) }).meta({ id: 'PayoutApproved' });
const AdminPage = z
  .object({ items: z.array(Payout.extend({ payee: z.object({ id: z.uuid(), name: z.string().nullable() }) })), nextCursor: z.string().nullable(), counts: z.record(z.string(), z.number().int()) })
  .meta({ id: 'PayoutPage' });
const Reveal = z
  .object({ payoutId: z.uuid(), code: z.string(), amount: poisha, type: z.enum(['bkash', 'nagad']), accountName: z.string(), number: z.string(), showForSeconds: z.number().int() })
  .meta({ id: 'PayoutReveal', description: 'The full wallet number, for sending this payout by hand. Audited; never stored or logged; do not cache.' });

const MePage = z.object({ items: z.array(Payout), nextCursor: z.string().nullable() }).meta({ id: 'MyPayoutPage' });
const MeDetail = Payout.extend({
  payee: z.object({ id: z.uuid(), name: z.string().nullable() }),
  items: z.array(Item),
  holds: z.array(z.object({ id: z.uuid(), type: z.enum(HOLD_TYPES), until: dateTime.nullable(), scope: z.string() })),
  approvals: z.array(Approval),
}).meta({ id: 'MyPayoutDetail' });
const Summary = z
  .object({
    nextPayout: z.object({ date: dateTime.nullable(), projected: poisha, minimum: poisha }),
    inPayouts: poisha,
    onHold: z.object({ amount: signed, reasons: z.array(z.enum(HOLD_TYPES)), until: dateTime.nullable() }),
    feesOwed: poisha,
    paidThisMonth: poisha,
    account: Account.nullable(),
    pendingAccount: Account.nullable(),
  })
  .meta({ id: 'PayoutSummary' });

const Batch = z
  .object({ id: z.uuid(), schedule: z.string(), windowEnd: dateTime, status: z.string(), totals: z.object({}).loose().nullable(), createdBy: z.uuid().nullable(), createdAt: dateTime })
  .meta({ id: 'PayoutBatch' });
const BatchPage = z.object({ items: z.array(Batch), nextCursor: z.string().nullable() }).meta({ id: 'PayoutBatchPage' });
const BatchRun = z.object({ batch: Batch, created: z.boolean() }).meta({ id: 'PayoutBatchRun' });

module.exports = {
  idParam,
  accountAdd,
  meListQuery,
  statementQuery,
  adminListQuery,
  accountsQuery,
  verifyBody,
  rejectBody,
  holdBody,
  liftBody,
  markPaidBody,
  markFailedBody,
  cancelBody,
  runBody,
  batchesQuery,
  Account,
  AccountList,
  CodeSent,
  ReviewPage,
  Payout,
  PayoutDetail,
  Approved,
  AdminPage,
  Reveal,
  MePage,
  MeDetail,
  Summary,
  Batch,
  BatchPage,
  BatchRun,
};
