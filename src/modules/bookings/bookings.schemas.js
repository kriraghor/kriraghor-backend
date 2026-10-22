'use strict';

/**
 * M10 request and response schemas (zod → validation and OpenAPI), plus the M09 step-2 closure and
 * series bodies. Money in poisha; times are ISO instants on the half-hour grid; days are Dhaka dates.
 */
const { z } = require('zod');
const { normalizePhone } = require('../../common/identifiers');
const { staffHidden } = require('../business-members').schemas;

const id = z.uuid();
const dateTime = z.iso.datetime({ offset: true });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const poisha = z.number().int().nonnegative();
const minutes = z.number().int().min(30).max(600).multipleOf(30);
const phone = z.string().transform((v, ctx) => {
  const p = normalizePhone(v);
  if (!p) ctx.addIssue({ code: 'custom', message: 'Enter a Bangladesh mobile number' });
  return p ?? v;
});

const idParam = z.object({ id });

// ---------------- requests
const availabilityQuery = z.object({ date: day.optional() });
const holdBody = z.object({
  groundId: id,
  courtIds: z.array(id).min(1).max(4),
  start: dateTime,
  minutes,
  payment: z.enum(['advance', 'full']).meta({ description: 'Pay the advance online (the rest at the venue) or the full price online (v3)' }),
});
const myListQuery = z.object({ scope: z.enum(['upcoming', 'past']).default('upcoming'), cursor: dateTime.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
const cancelBody = z.object({ expectedRefund: poisha.meta({ description: 'The refund shown in the cancel preview (409 REFUND_CHANGED if it moved)' }) });
const timelineQuery = z.object({ groundId: id, date: day.optional() });
const ownerSearchQuery = z.object({
  q: z.string().trim().min(2).max(60).meta({ description: 'A booking code (or part of it), the last 4+ digits of the contact phone, or a team or contact name' }),
  groundId: id.optional(),
  cursor: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const balanceBody = z.object({ method: z.enum(['cash', 'bkash_venue']), amount: poisha });
const OWNER_CANCEL_REASONS = ['weather', 'waterlogged', 'maintenance', 'closure', 'double_booked_offline', 'other'];
const ownerCancelBody = z.object({ reason: z.enum(OWNER_CANCEL_REASONS), note: z.string().trim().max(200).optional() });
const moveBody = z.object({ courtId: id });
const walkInBody = z.object({ courtIds: z.array(id).min(1).max(4), start: dateTime, minutes, name: z.string().trim().min(2).max(80), phone: phone.optional() });
const staffListQuery = z.object({
  status: z.enum(['pending_payment', 'confirmed', 'checked_in', 'completed', 'no_show', 'cancelled', 'cancelled_by_owner', 'cancelled_by_platform', 'expired', 'skipped']).optional(),
  groundId: id.optional(),
  code: z.string().max(16).optional(),
  cursor: dateTime.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const reasonBody = z.object({ reason: z.string().trim().min(5).max(300) });


// ---------------- responses
const Money = z
  .object({
    price: poisha,
    extensions: poisha,
    total: poisha,
    advancePct: z.number(),
    advance: poisha,
    paymentChoice: z.enum(['advance', 'full', 'venue']),
    paidOnline: poisha,
    dueAtVenue: poisha,
    // Round B3: the venue's staff never receive these (business-members forStaff).
    fee: staffHidden(poisha),
    released: staffHidden(poisha),
    retained: staffHidden(poisha),
    refund: poisha,
    balanceStatus: z.enum(['not_due', 'due', 'collected', 'unrecorded', 'waived']),
    balanceMethod: z.enum(['cash', 'bkash_venue']).nullable(),
  })
  .meta({ id: 'BookingMoney' });
const Booking = z
  .object({
    id,
    code: z.string(),
    status: z.string(),
    groundId: id,
    ground: z.object({ id }).nullable(),
    courtIds: z.array(id),
    courts: z.array(z.object({ id, name: z.string() })),
    start: dateTime,
    end: dateTime,
    holdExpiresAt: dateTime.nullable(),
    late: z.boolean(),
    money: Money,
    freeCancelUntil: dateTime.nullable(),
    cancelReason: z.string().nullable(),
    paymentId: id.nullable(),
    createdAt: dateTime.nullable(),
  })
  .meta({ id: 'Booking' });
const OwnerBooking = Booking.extend({
  source: z.enum(['app', 'walk_in', 'series']),
  teamName: z.string().nullable(),
  contactName: z.string().nullable(),
  phoneLast4: z.string().nullable(),
  bookerUserId: id.nullable(),
  seriesId: id.nullable(),
  seriesWeek: z.number().int().nullable(),
  graceMin: z.number().int(),
  checkedInAt: dateTime.nullable(),
  moveCount: z.number().int(),
  cancelActor: z.string().nullable(),
}).meta({ id: 'OwnerBooking' });
const HoldResult = z.object({ booking: Booking, payment: z.object({ id, payUrl: z.string() }).nullable() }).meta({ id: 'HoldResult' });
const CancelTerms = z.object({ allowed: z.boolean(), reasonCode: z.string().nullable(), refund: poisha, retained: poisha, free: z.boolean() }).meta({ id: 'CancelTerms' });
const MyBooking = z.object({ booking: Booking, cancel: CancelTerms.nullable() }).meta({ id: 'MyBooking' });
const MyBookings = z.object({ items: z.array(Booking), nextCursor: z.string().nullable() }).meta({ id: 'MyBookings' });
const CancelResult = z.object({ booking: Booking, refund: poisha }).meta({ id: 'BookingCancelResult' });
const Cell = z.object({ start: dateTime, time: z.string(), state: z.enum(['open', 'booked', 'yours', 'closed', 'past']), rate: poisha.nullable() });
const Availability = z
  .object({
    groundId: id,
    date: day,
    window: z.object({ from: day, to: day }),
    bookable: z.boolean(),
    cutoffMin: z.number().int(),
    minBookingMin: z.number().int().nullable(),
    lengths: z.array(z.number().int()),
    courts: z.array(z.object({ id, name: z.string(), combinableGroup: z.string().nullable(), cells: z.array(Cell) })),
  })
  .meta({ id: 'Availability' });
const HoursRow = z.object({ courtId: id, dow: z.number().int(), isClosed: z.boolean(), openTime: z.string().nullable(), closeTime: z.string().nullable() });
const Timeline = z
  .object({
    groundId: id,
    date: day,
    courts: z.array(z.object({ id, name: z.string(), hours: z.array(HoursRow) })),
    bookings: z.array(OwnerBooking),
    closures: z.array(z.object({ closureId: id, courtId: id, start: dateTime, end: dateTime })),
  })
  .meta({ id: 'BookingTimeline' });
const OwnerResult = z.object({ booking: OwnerBooking }).passthrough().meta({ id: 'OwnerBookingResult' });
const OwnerDetail = z.object({ booking: OwnerBooking, checkIn: z.object({}).passthrough().nullable() }).meta({ id: 'OwnerBookingDetail' });
const MoveTargets = z.object({ items: z.array(z.object({ groundId: id, groundName: z.string(), courtId: id, courtName: z.string(), sameGround: z.boolean(), sameArea: z.boolean() })) }).meta({ id: 'MoveTargets' });
const StaffList = z.object({ items: z.array(OwnerBooking), nextCursor: z.string().nullable() }).meta({ id: 'StaffBookingList' });
const OwnerSearch = z.object({ items: z.array(OwnerBooking), nextCursor: z.string().nullable() }).meta({ id: 'OwnerBookingSearch' });
const StaffDetail = OwnerDetail.extend({ ledger: z.array(z.object({ id, kind: z.string(), refType: z.string(), refId: id, total: poisha, postedAt: z.string() }).passthrough()) }).meta({ id: 'StaffBooking' });

module.exports = {
  idParam,
  availabilityQuery,
  holdBody,
  myListQuery,
  cancelBody,
  timelineQuery,
  ownerSearchQuery,
  balanceBody,
  ownerCancelBody,
  moveBody,
  walkInBody,
  staffListQuery,
  reasonBody,
  OWNER_CANCEL_REASONS,
  Booking,
  OwnerBooking,
  HoldResult,
  CancelTerms,
  MyBooking,
  MyBookings,
  CancelResult,
  Availability,
  Timeline,
  OwnerResult,
  OwnerDetail,
  OwnerSearch,
  MoveTargets,
  StaffList,
  StaffDetail,
};
