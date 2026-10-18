'use strict';

/** M22 request and response schemas (zod → validation and OpenAPI). Money in poisha; dates YYYY-MM-DD. */
const { z } = require('zod');

const id = z.uuid();
const poisha = z.number().int().nonnegative();
const date = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });
const nullable = (t) => t.nullable();
const hex = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, '#rrggbb');

// ---------------- requests
const orgParam = z.object({ orgId: id });
const orgIdParam = z.object({ orgId: id, id });
const orgMatchParam = z.object({ orgId: id, matchId: id });
const idParam = z.object({ id });
const subdomainParam = z.object({ subdomain: z.string().trim().min(3).max(30) });
const contractBody = z.object({
  model: z.enum(['percentage', 'flat']),
  pct: z.number().min(0).max(100).nullable().optional().meta({ description: 'Percentage contracts: the fee percent (empty = fees.esports_saas_pct)' }),
  flatFee: poisha.min(1).nullable().optional().meta({ description: 'Flat contracts: the fee per billing cycle, in poisha' }),
  billingCycle: z.enum(['monthly', 'quarterly', 'per_tournament']),
  startsOn: date,
  endsOn: date.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});
const contractPatch = contractBody.partial().refine((b) => Object.keys(b).length > 0, 'Nothing to change');
const reasonBody = z.object({ reason: z.string().trim().min(5).max(300) });
const invoicesQuery = z.object({ organisationId: id.optional(), status: z.enum(['draft', 'issued', 'paid', 'overdue', 'voided']).optional() });
const tournamentsQuery = z.object({ status: z.string().max(200).optional() });
const brandingBody = z.object({ primaryHex: hex, accentHex: hex, taglineEn: z.string().trim().max(120).nullable().optional(), taglineBn: z.string().trim().max(120).nullable().optional() });
const subdomainBody = z.object({ subdomain: z.string().trim().min(3).max(30) });
const finaliseBody = z.object({ code: z.string().trim().regex(/^\d{4,8}$/).meta({ description: 'The code sent to your phone (POST …/finalise/code)' }) });

// ---------------- responses
const Contract = z
  .object({
    id,
    organisationId: id,
    model: z.enum(['percentage', 'flat']),
    pct: nullable(z.number()),
    flatFee: nullable(poisha),
    billingCycle: z.enum(['monthly', 'quarterly', 'per_tournament']),
    startsOn: date,
    endsOn: nullable(date),
    status: z.enum(['draft', 'active', 'suspended', 'ended']),
    hasSignedDocument: z.boolean(),
    notes: nullable(z.string()),
    activatedAt: nullable(dateTime),
    suspendedAt: nullable(dateTime),
    suspendReason: nullable(z.string()),
    endedAt: nullable(dateTime),
    endReason: nullable(z.string()),
    effectivePct: nullable(z.number()),
  })
  .meta({ id: 'OrganiserContract' });
const ContractList = z.object({ items: z.array(Contract) }).meta({ id: 'OrganiserContractList' });
const InvoiceLine = z.object({ id, kind: z.enum(['flat_fee', 'percentage_fee', 'adjustment']), tournamentId: nullable(id), description: z.string(), amount: z.number().int(), payable: z.boolean() });
const Invoice = z
  .object({
    id,
    number: z.string(),
    organisationId: id,
    contractId: id,
    periodStart: date,
    periodEnd: date,
    subtotal: poisha,
    vat: poisha,
    total: poisha,
    status: z.enum(['draft', 'issued', 'paid', 'overdue', 'voided']),
    dueAt: nullable(dateTime),
    issuedAt: nullable(dateTime),
    paidAt: nullable(dateTime),
    voidedAt: nullable(dateTime),
    voidReason: nullable(z.string()),
    lines: z.array(InvoiceLine).optional(),
  })
  .meta({ id: 'OrganiserInvoice' });
const InvoiceList = z.object({ items: z.array(Invoice) }).meta({ id: 'OrganiserInvoiceList' });
const PayResult = z.object({ invoice: Invoice, payment: z.object({ id, payUrl: z.string() }) }).meta({ id: 'OrganiserInvoicePayment' });
const Fund = z
  .object({ id: nullable(id), tournamentId: id, required: poisha, deposited: poisha, paid: poisha, returned: poisha, status: z.enum(['pending', 'funded', 'consumed', 'returned']), fundedAt: nullable(dateTime), settledAt: nullable(dateTime) })
  .meta({ id: 'OrganiserPrizeFund' });
const FundPayment = z.object({ fund: Fund, payment: z.object({ id, amount: poisha, payUrl: z.string() }) }).meta({ id: 'OrganiserPrizeFundPayment' });
const Branding = z
  .object({
    organisationId: id,
    name: z.string(),
    slug: z.string(),
    subdomain: nullable(z.string()),
    logoUrl: nullable(z.string()),
    primaryHex: z.string(),
    accentHex: z.string(),
    taglineEn: nullable(z.string()),
    taglineBn: nullable(z.string()),
    status: z.enum(['draft', 'live', 'suspended']),
    version: z.number().int(),
  })
  .meta({ id: 'OrganisationBranding' });
const Organiser = z.object({ organiser: Branding, tournaments: z.array(z.object({}).loose()) }).meta({ id: 'PublicOrganiser' });
const Dashboard = z
  .object({
    organisation: z.object({ id, name: z.string(), status: z.string(), role: z.string() }),
    contract: Contract.extend({}).nullable(),
    canSubmit: z.boolean(),
    unpaidInvoices: z.number().int(),
    unpaidTotal: poisha,
    tournaments: z.record(z.string(), z.number().int()),
    upcoming: z.array(z.object({}).loose()),
  })
  .meta({ id: 'OrganiserDashboard' });
const CodeSent = z.object({ sent: z.boolean() }).loose().meta({ id: 'OrganiserCodeSent' });

module.exports = {
  orgParam,
  orgIdParam,
  orgMatchParam,
  idParam,
  subdomainParam,
  contractBody,
  contractPatch,
  reasonBody,
  invoicesQuery,
  tournamentsQuery,
  brandingBody,
  subdomainBody,
  finaliseBody,
  Contract,
  ContractList,
  Invoice,
  InvoiceList,
  PayResult,
  Fund,
  FundPayment,
  Branding,
  Organiser,
  Dashboard,
  CodeSent,
};
