'use strict';

/**
 * M06 request and response schemas (zod → validation and OpenAPI). Amounts are integer poisha.
 */
const { z } = require('zod');

const dateTime = z.iso.datetime({ offset: true });
const poisha = z.number().int().nonnegative();
const amountIn = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).meta({ description: 'Poisha (৳1 = 100)' });
const limit = (max, def) => z.coerce.number().int().min(1).max(max).default(def);
const PAYMENT_STATUSES = ['initiated', 'pending', 'succeeded', 'failed', 'cancelled', 'expired', 'partially_refunded', 'refunded'];
const REFUND_STATUSES = ['pending_master', 'approved', 'processing', 'succeeded', 'failed', 'manual_required', 'rejected'];
const HOLD_STATUSES = ['holding', 'partially_released', 'released', 'refunded', 'frozen', 'closed'];
const ITEM_TYPES = ['matched', 'missing_internal', 'missing_provider', 'amount_mismatch', 'status_mismatch', 'refund_mismatch', 'fee_mismatch'];

const idParam = z.object({ id: z.uuid() });
const attemptBody = z.object({ method: z.enum(['bkash', 'nagad', 'card']) });
const meListQuery = z.object({ cursor: z.uuid().optional(), limit: limit(50, 20) });

// Gateway return: SSLCommerz POSTs a form, the simulator redirects with a query. Read loosely, verify strictly.
const returnInput = z.object({ pid: z.string().max(64).optional(), tran_id: z.string().max(64).optional(), val_id: z.string().max(120).optional() }).loose();

const testChargeBody = z.object({
  payerId: z.uuid(),
  payeeId: z.uuid(),
  amount: amountIn,
  title: z.string().trim().min(3).max(120).optional(),
});

const adminPaymentsQuery = z.object({
  status: z.enum(PAYMENT_STATUSES).optional(),
  purpose: z.string().max(30).optional(),
  payerId: z.uuid().optional(),
  code: z.string().trim().max(20).optional(),
  cursor: z.uuid().optional(),
  limit: limit(100, 50),
});

const refundCreate = z.object({
  paymentId: z.uuid(),
  amount: amountIn,
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use a short code like customer_request'),
  reasonText: z.string().trim().max(500).optional(),
  goodwill: z.boolean().optional().meta({ description: 'Master only: refund money already released to the payee, as a platform expense' }),
});
const refundsQuery = z.object({ status: z.enum(REFUND_STATUSES).optional(), paymentId: z.uuid().optional(), cursor: z.uuid().optional(), limit: limit(100, 50) });
const approveBody = z.object({ note: z.string().trim().max(500).optional() });
const rejectBody = z.object({ note: z.string().trim().min(3).max(500) });

const accountsQuery = z.object({ code: z.string().trim().max(120).optional(), limit: limit(200, 50) });
const entriesQuery = z.object({ cursor: z.coerce.number().int().positive().optional(), limit: limit(200, 50) });

const escrowQuery = z.object({
  purpose: z.string().max(30).optional(),
  status: z.enum(HOLD_STATUSES).optional(),
  groupRef: z.uuid().optional(),
  payeeId: z.uuid().optional(),
  cursor: z.uuid().optional(),
  limit: limit(100, 50),
});
const releaseBody = z.object({ amount: amountIn.optional().meta({ description: 'Default: everything still held' }), reason: z.string().trim().min(3).max(300) });
const freezeBody = z.object({ reason: z.string().trim().min(3).max(200) });

const runBody = z.object({ businessDate: z.iso.date().optional().meta({ description: 'Asia/Dhaka business day; default yesterday' }) });
const itemsQuery = z.object({ type: z.enum(ITEM_TYPES).optional(), open: z.enum(['true', 'false']).transform((v) => v === 'true').optional() });
const resolveBody = z.object({ resolution: z.enum(['resolved', 'ignored']), note: z.string().trim().min(3).max(500) });

// ---------------- responses ----------------
const RefundLine = z.object({ id: z.uuid(), amount: poisha, status: z.enum(REFUND_STATUSES), reasonCode: z.string(), createdAt: dateTime, completedAt: dateTime.nullable() });

const Payment = z
  .object({
    id: z.uuid(),
    code: z.string(),
    purpose: z.string(),
    purposeId: z.uuid(),
    title: z.string(),
    amount: poisha,
    captured: poisha,
    refunded: poisha,
    status: z.enum(PAYMENT_STATUSES),
    method: z.enum(['bkash', 'nagad', 'card', 'other']).nullable(),
    methodDisplay: z.string().nullable(),
    expiresAt: dateTime,
    succeededAt: dateTime.nullable(),
    createdAt: dateTime,
    refunds: z.array(RefundLine),
  })
  .meta({ id: 'Payment' });

const PayerPayment = Payment.extend({ methods: z.array(z.enum(['bkash', 'nagad', 'card'])) }).meta({ id: 'PayerPayment' });
const PaymentPage = z.object({ items: z.array(Payment), nextCursor: z.string().nullable() }).meta({ id: 'PaymentPage' });
const AttemptStarted = z.object({ attemptId: z.uuid(), redirectUrl: z.url(), expiresAt: dateTime }).meta({ id: 'PaymentAttemptStarted' });
const TestCharge = z.object({ payment: Payment, payUrl: z.url() }).meta({ id: 'TestCharge' });

const Person = z.object({ id: z.uuid(), name: z.string().nullable() }).nullable();
const AdminPaymentRow = Payment.extend({ payer: Person, payee: Person, provider: z.string().nullable() });
const AdminPaymentPage = z.object({ items: z.array(AdminPaymentRow), nextCursor: z.string().nullable() }).meta({ id: 'AdminPaymentPage' });

const Refund = z
  .object({
    id: z.uuid(),
    paymentId: z.uuid(),
    amount: poisha,
    reasonCode: z.string(),
    reasonText: z.string().nullable(),
    kind: z.enum(['policy', 'manual', 'dispute', 'late_capture', 'amount_mismatch', 'goodwill']),
    source: z.enum(['escrow', 'goodwill', 'suspense']),
    status: z.enum(REFUND_STATUSES),
    initiatedBy: z.uuid().nullable(),
    initiatorKind: z.enum(['system', 'staff', 'master']),
    recommended: poisha.nullable(),
    approvedBy: z.uuid().nullable(),
    decisionNote: z.string().nullable(),
    attempts: z.number().int(),
    lastError: z.string().nullable(),
    createdAt: dateTime,
    completedAt: dateTime.nullable(),
  })
  .meta({ id: 'Refund' });
const RefundPage = z
  .object({ items: z.array(Refund.extend({ payment: z.object({ code: z.string(), title: z.string(), payerId: z.uuid(), methodDisplay: z.string().nullable() }) })), nextCursor: z.string().nullable() })
  .meta({ id: 'RefundPage' });

const Hold = z
  .object({
    id: z.uuid(),
    purpose: z.string(),
    purposeId: z.uuid(),
    paymentId: z.uuid(),
    groupRef: z.uuid().nullable(),
    payeeId: z.uuid().nullable(),
    vertical: z.string(),
    fee: z.object({ bps: z.number().int(), settingKey: z.string(), settingVersion: z.number().int() }),
    held: poisha,
    released: poisha,
    refunded: poisha,
    feeTaken: poisha,
    available: poisha,
    releaseRule: z.object({ type: z.string() }).loose(),
    releaseAt: dateTime.nullable(),
    status: z.enum(HOLD_STATUSES),
    frozenReason: z.string().nullable(),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'EscrowHold' });
const HoldPage = z
  .object({ items: z.array(Hold), nextCursor: z.string().nullable(), totals: z.record(z.string(), z.object({ amount: poisha, count: z.number().int() })) })
  .meta({ id: 'EscrowHoldPage' });
const Release = z.object({ hold: Hold, gross: poisha, fee: poisha, net: poisha, transactionId: z.uuid() }).meta({ id: 'EscrowRelease' });

const LedgerRef = z.object({ id: z.uuid(), kind: z.string(), refType: z.string(), refId: z.string(), total: poisha, postedAt: dateTime });
const AdminPayment = AdminPaymentRow.extend({
  providerTrxId: z.string().nullable(),
  escrow: z.object({}).loose(),
  attempts: z.array(z.object({ id: z.uuid(), provider: z.string(), method: z.string().nullable(), status: z.string(), failureCode: z.string().nullable(), startedAt: dateTime, finishedAt: dateTime.nullable() })),
  refunds: z.array(Refund),
  hold: z.union([Hold, z.null()]),
  ledger: z.array(LedgerRef),
}).meta({ id: 'AdminPayment' });

const Account = z
  .object({ id: z.uuid(), code: z.string(), type: z.string(), ownerUserId: z.uuid().nullable(), vertical: z.string().nullable(), debit: poisha, credit: poisha, balance: z.number().int(), entries: z.number().int() })
  .meta({ id: 'LedgerAccount' });
const AccountList = z.object({ items: z.array(Account) }).meta({ id: 'LedgerAccountList' });
const Entries = z
  .object({
    account: z.object({ id: z.uuid(), code: z.string(), type: z.string(), balance: z.number().int() }),
    items: z.array(
      z.object({ id: z.number().int(), txnId: z.uuid(), kind: z.string(), refType: z.string(), refId: z.string(), memo: z.string().nullable(), postedAt: dateTime, holdId: z.uuid().nullable(), debit: poisha, credit: poisha })
    ),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'LedgerEntries' });
const Transaction = z
  .object({
    id: z.uuid(),
    kind: z.string(),
    refType: z.string(),
    refId: z.string(),
    memo: z.string().nullable(),
    total: poisha,
    reversesTxnId: z.uuid().nullable(),
    postedBy: z.uuid().nullable(),
    postedAt: dateTime,
    lines: z.array(z.object({ entryId: z.number().int(), account: z.string(), type: z.string(), holdId: z.uuid().nullable(), debit: poisha, credit: poisha })),
  })
  .meta({ id: 'LedgerTransaction' });
const TrialBalance = z
  .object({ debit: poisha, credit: poisha, difference: z.number().int(), byType: z.record(z.string(), z.object({ debit: poisha, credit: poisha })), invariants: z.object({}).loose().optional() })
  .meta({ id: 'TrialBalance' });

const Run = z
  .object({
    id: z.uuid(),
    provider: z.string(),
    businessDate: z.string(),
    status: z.enum(['running', 'completed', 'failed']),
    totals: z.object({}).loose().nullable(),
    error: z.string().nullable(),
    startedBy: z.uuid().nullable(),
    startedAt: dateTime,
    finishedAt: dateTime.nullable(),
  })
  .meta({ id: 'ReconciliationRun' });
const RunPage = z.object({ items: z.array(Run), nextCursor: z.string().nullable() }).meta({ id: 'ReconciliationRunPage' });
const Item = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    type: z.enum(ITEM_TYPES),
    paymentId: z.uuid().nullable(),
    refundId: z.uuid().nullable(),
    providerRef: z.string().nullable(),
    internalAmount: poisha.nullable(),
    providerAmount: poisha.nullable(),
    detail: z.string().nullable(),
    resolution: z.enum(['auto_healed', 'resolved', 'ignored']).nullable(),
    resolvedBy: z.uuid().nullable(),
    resolvedAt: dateTime.nullable(),
    note: z.string().nullable(),
    createdAt: dateTime,
  })
  .meta({ id: 'ReconciliationItem' });
const ItemList = z.object({ run: Run, items: z.array(Item) }).meta({ id: 'ReconciliationItems' });
const WebhookAck = z.object({ result: z.string() }).meta({ id: 'WebhookAck' });

module.exports = {
  idParam,
  attemptBody,
  meListQuery,
  returnInput,
  testChargeBody,
  adminPaymentsQuery,
  refundCreate,
  refundsQuery,
  approveBody,
  rejectBody,
  accountsQuery,
  entriesQuery,
  escrowQuery,
  releaseBody,
  freezeBody,
  runBody,
  itemsQuery,
  resolveBody,
  Payment,
  PayerPayment,
  PaymentPage,
  AttemptStarted,
  TestCharge,
  AdminPaymentPage,
  AdminPayment,
  Refund,
  RefundPage,
  Hold,
  HoldPage,
  Release,
  AccountList,
  Entries,
  Transaction,
  TrialBalance,
  Run,
  RunPage,
  Item,
  ItemList,
  WebhookAck,
};
