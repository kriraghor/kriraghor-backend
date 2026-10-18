'use strict';

/**
 * M19 request and response schemas. Money in poisha; rates as fractions (0.382 = 38.2%); days are Dhaka
 * dates; deltas are percent (amounts, counts) or points (rates); null when there is nothing to compare.
 */
const { z } = require('zod');

const period = z.enum(['7w', 'qtr', 'yr']);
const locale = z.enum(['en', 'bn']).default('en');
const day = z.string();

const dashboardQuery = z.object({ role: z.enum(['member', 'ground_owner']).default('member'), period: period.default('7w'), groundId: z.uuid().optional(), locale });
const actionsQuery = z.object({ role: z.enum(['member', 'ground_owner', 'shop_owner', 'gym_owner']).default('member') });
const exportQuery = z.object({ dataset: z.enum(['owner_bookings', 'owner_revenue', 'member_payments']), period: period.default('7w') });
const platformQuery = z.object({ period: period.default('yr'), locale });
const platformExportQuery = z.object({ dataset: z.enum(['platform_daily']), period: period.default('yr') });
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
const Actions = z
  .object({ items: z.array(z.object({ key: z.string(), count: z.number(), severity: z.enum(['high', 'normal', 'low']), dueAt: z.string().nullable(), href: z.string() })), total: z.number() })
  .meta({ id: 'PendingActions' });
const KpiDefinition = z.object({ key: z.string(), text: z.string() }).meta({ id: 'KpiDefinition' });

module.exports = { dashboardQuery, actionsQuery, exportQuery, platformQuery, platformExportQuery, kpiParam, kpiQuery, OwnerDashboard, MemberDashboard, PlatformOverview, Actions, KpiDefinition };
