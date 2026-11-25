'use strict';

/**
 * M19 request and response schemas. Money in poisha; rates as fractions (0.382 = 38.2%); days are Dhaka
 * dates; deltas are percent (amounts, counts) or points (rates); null when there is nothing to compare.
 */
const { z } = require('zod');

// 30d: 30 Dhaka days (dashboards round 2); the tiles cover the whole 30 days against the 30 before.
const period = z.enum(['30d', '7w', 'qtr', 'yr']);
const locale = z.enum(['en', 'bn']).default('en');
const day = z.string();

const dashboardQuery = z
  .object({
    role: z.enum(['member', 'ground_owner', 'shop_owner', 'gym_owner', 'organiser']).default('member'),
    period: period.default('7w'),
    groundId: z.uuid().optional(),
    orgId: z.uuid().optional().describe('The sports organisation (role organiser only; you must be a member)'),
    locale,
  })
  .refine((q) => q.role !== 'organiser' || Boolean(q.orgId), { path: ['orgId'], message: 'Choose the organisation (orgId) for the organiser dashboard' });
const actionsQuery = z.object({ role: z.enum(['member', 'ground_owner', 'shop_owner', 'gym_owner', 'organiser', 'business_staff']).default('member').meta({ description: 'business_staff (Round B3): the to-do of every venue, gym or shop the caller works at' }) });
const EXPORTS = ['owner_bookings', 'owner_revenue', 'member_payments', 'shop_orders', 'shop_sales_by_product', 'gym_passes', 'gym_admissions'];
const exportQuery = z.object({ dataset: z.enum(EXPORTS), period: period.default('7w') });
const platformQuery = z.object({ period: period.default('yr'), locale });
const platformExportQuery = z.object({ dataset: z.enum(['platform_daily']), period: period.default('yr') });
const reviewsQuery = z.object({ scope: z.enum(['me', 'team']).default('me').meta({ description: "me: your own decisions; team: everyone's decisions in the kinds you may review (no one is named)" }), locale });
const kpiParam = z.object({ key: z.string().max(40) });
const kpiQuery = z.object({ locale });

const Tile = z
  .object({ value: z.number().nullable(), delta: z.number().nullable(), spark: z.array(z.number().nullable()).nullable(), note: z.record(z.string(), z.number()).nullable().optional() })
  .meta({ id: 'KpiTile' });
const Meta = { period, buckets: z.array(z.object({ key: z.string(), from: day, to: day })), asOf: z.string().nullable(), definitions: z.record(z.string(), z.string()) };
const OwnerDashboard = z
  .object({
    role: z.literal('ground_owner'),
    tiles: z.object({ revenue: Tile, occupancy: Tile, bookings: Tile, repeatTeams: Tile }),
    charts: z.object({
      weeklyRevenue: z.object({ points: z.array(z.object({ key: z.string(), from: day, value: z.number(), lastYear: z.number() })), lastYearShown: z.boolean() }),
      bookingsByDay: z.array(z.object({ day, value: z.number() })),
      busiestHours: z.array(z.object({ hour: z.number(), hours: z.number() })),
      revenueByGround: z.array(z.object({ groundId: z.uuid(), name: z.string(), value: z.number() })),
    }),
    ...Meta,
  })
  .meta({ id: 'OwnerDashboard' });
const MemberDashboard = z
  .object({
    role: z.literal('member'),
    tiles: z.object({ spent: Tile, bookings: Tile, upcoming: Tile }),
    charts: z.object({ whereItWent: z.array(z.object({ vertical: z.string(), value: z.number() })) }),
    ...Meta,
  })
  .meta({ id: 'MemberDashboard' });
const PlatformOverview = z
  .object({
    role: z.literal('platform'),
    tiles: z.object({ gtv: Tile, feeRevenue: Tile, takeRate: Tile, bookings: Tile, esportsEntries: Tile, prizesPaid: Tile, verifiedMembers: Tile, waitingForReview: Tile }),
    charts: z.object({
      volume: z.array(z.object({ key: z.string(), from: day, value: z.number(), online: z.number() })),
      volumeByVertical: z.array(z.object({ vertical: z.string(), value: z.number() })),
      topAreas: z.array(z.object({ areaId: z.uuid().nullable(), name: z.string(), bookings: z.number() })),
    }),
    ...Meta,
  })
  .meta({ id: 'PlatformOverview' });
const Line = z.object({ points: z.array(z.object({ key: z.string(), from: day, value: z.number(), lastYear: z.number() })), lastYearShown: z.boolean() });
const ShopDashboard = z
  .object({
    role: z.literal('shop_owner'),
    tiles: z.object({ sales: Tile, orders: Tile, averageOrder: Tile, repeatBuyers: Tile }),
    charts: z.object({
      weeklySales: Line,
      ordersByDay: z.array(z.object({ day, value: z.number() })),
      salesByCategory: z.array(z.object({ categoryId: z.uuid().nullable(), name: z.string(), units: z.number(), value: z.number() })),
      bestSellers: z.array(z.object({ productId: z.uuid(), title: z.string(), units: z.number(), value: z.number() })).describe('Top 10 by units over the last 30 days'),
    }),
    comingLater: z.array(z.string()).describe('Tiles that need product-view counts (conversion, shopper funnel)'),
    ...Meta,
  })
  .meta({ id: 'ShopDashboard' });
const GymDashboard = z
  .object({
    role: z.literal('gym_owner'),
    tiles: z.object({ passSales: Tile, passesSold: Tile, admissions: Tile, unusedShare: Tile }),
    charts: z.object({
      sales: Line,
      admissionsByDay: z.array(z.object({ day, value: z.number() })),
      busiestHours: z.array(z.object({ hour: z.number(), admissions: z.number() })),
      salesByPackage: z.array(z.object({ packageId: z.uuid(), kind: z.enum(['day', 'month', 'quarter']), title: z.string(), passes: z.number(), value: z.number() })),
    }),
    ...Meta,
  })
  .meta({ id: 'GymDashboard' });
const OrganiserDashboard = z
  .object({
    role: z.literal('organiser'),
    organisation: z.object({ id: z.uuid(), name: z.string() }),
    tiles: z.object({ teams: Tile, entryFees: Tile, matchesPlayed: Tile }),
    charts: z.object({
      registrationsOverTime: z.array(z.object({ key: z.string(), from: day, registered: z.number(), approved: z.number() })),
      feesByEvent: z.array(z.object({ tournamentId: z.uuid(), name: z.string(), status: z.string(), collected: z.number(), held: z.number(), released: z.number(), refunded: z.number() })),
    }),
    ...Meta,
  })
  .meta({ id: 'SportsOrganiserDashboard' });
const Actions = z
  .object({
    items: z.array(
      z.object({
        key: z.string().meta({
          description:
            'What the item is about. Staff (GET /admin/analytics/actions, FR-29): review_queue, risk_flags, disputes_to_review, disputes_escalated, reports_open, reports_escalated, payouts_to_approve, payouts_failed, results_to_enter, tournaments_to_review, settings_to_approve',
        }),
        count: z.number(),
        severity: z.enum(['high', 'normal', 'low']),
        dueAt: z.string().nullable(),
        href: z.string(),
        businessType: z.enum(['venue', 'gym', 'shop']).optional().meta({ description: 'role business_staff only (Round B3): the workplace the item belongs to' }),
        businessId: z.uuid().optional().meta({ description: 'role business_staff only (Round B3): the workplace the item belongs to' }),
      })
    ),
    total: z.number(),
  })
  .meta({ id: 'PendingActions' });
const Decision = z.enum(['approved', 'changes_requested', 'rejected']);
const ReviewFigures = z
  .object({
    scope: z.enum(['me', 'team']),
    window: z.object({ days: z.number(), from: day, to: day }).meta({ description: 'The Dhaka days counted (analytics.review_window_days), today the last' }),
    tiles: z.object({
      waiting: z.object({ value: z.number(), delta: z.null(), note: z.object({ overdue: z.number() }) }).meta({ description: 'Live queue in the kinds you may review (not scoped)' }),
      reviewedToday: z.object({ value: z.number(), delta: z.number().nullable(), note: z.object({ lastWeek: z.number() }) }).meta({ description: 'Since Dhaka midnight; delta in percent against the same weekday last week up to the same time' }),
      medianMinutes: z.object({ value: z.number().nullable(), delta: z.number().nullable() }).meta({ description: 'Median minutes from submission to decision in the window; delta in percent against the window before (lower is better)' }),
      approvalRate: z.object({ value: z.number().nullable(), delta: z.number().nullable() }).meta({ description: 'Approved of all decisions in the window (a fraction); delta in points against the window before' }),
    }),
    perDay: z.array(z.object({ day, approved: z.number(), changesRequested: z.number(), rejected: z.number() })),
    whyNo: z.array(z.object({ code: z.string(), label: z.string(), count: z.number() })).meta({ description: 'Reasons given for changes asked and rejections in the window, most first' }),
    recent: z
      .array(z.object({ submissionId: z.uuid(), kind: z.string(), decision: Decision, reasonCode: z.string().nullable(), reason: z.string().nullable(), decidedAt: z.string() }))
      .meta({ description: 'scope me only: your latest decisions (analytics.recent_decisions)' }),
    asOf: z.string(),
    definitions: z.record(z.string(), z.string()),
  })
  .meta({ id: 'ReviewFigures' });
const KpiDefinition = z.object({ key: z.string(), text: z.string() }).meta({ id: 'KpiDefinition' });

module.exports = {
  dashboardQuery,
  actionsQuery,
  exportQuery,
  platformQuery,
  platformExportQuery,
  reviewsQuery,
  kpiParam,
  kpiQuery,
  OwnerDashboard,
  MemberDashboard,
  PlatformOverview,
  ShopDashboard,
  GymDashboard,
  OrganiserDashboard,
  Actions,
  ReviewFigures,
  KpiDefinition,
};
