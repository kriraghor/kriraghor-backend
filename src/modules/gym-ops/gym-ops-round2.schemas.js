'use strict';

/**
 * M27 round 2 request and response schemas (zod → validation and OpenAPI): classes, points and rewards,
 * notices, enquiries. Dates are Dhaka calendar dates; times ISO 8601; money in poisha.
 */
const { z } = require('zod');
const rules = require('./gym-ops.rules');

const id = z.uuid();
const date = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });
const nullable = (t) => t.nullable();
const text = (min, max) => z.string().trim().min(min).max(max);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour, Dhaka time');
const person = z.object({ id, displayName: nullable(z.string()) });
const memberRef = z.object({ id, memberCode: z.string(), displayName: z.string() });

// ---------------- params and queries
const classParam = z.object({ gymId: id, classId: id });
const sessionParam = z.object({ gymId: id, sessionId: id });
const bookingParam = z.object({ gymId: id, bookingId: id });
const memberParam = z.object({ gymId: id, memberId: id });
const leadParam = z.object({ gymId: id, leadId: id });
const mySessionParam = z.object({ sessionId: id });
const myBookingParam = z.object({ bookingId: id });
const slugParam = z.object({ slug: z.string().min(1).max(120) });
const classQuery = z.object({ status: z.enum(['active', 'retired']).optional() });
const sessionQuery = z
  .object({ from: date.optional(), to: date.optional(), classId: id.optional() })
  .refine((q) => !q.from || !q.to || (q.from <= q.to && rules.daysBetween(q.from, q.to) <= 62), { message: 'from on or before to, at most 62 days', path: ['from'] });
const myQuery = z.object({ memberId: id, from: date.optional() });
const myMemberQuery = z.object({ memberId: id });
const leadQuery = z.object({ status: z.enum(['new', 'contacted', 'joined', 'lost']).optional() });

// ---------------- bodies
const slot = z.object({ dow: z.number().int().min(0).max(6).meta({ description: '0 = Sunday … 6 = Saturday' }), startTime: hhmm });
const classBody = z.object({
  name: text(1, 80),
  description: nullable(text(1, 500)).optional(),
  trainerUserId: nullable(id).optional().meta({ description: 'The owner or staff of the gym' }),
  capacity: z.number().int().min(1).max(500),
  minutes: z.number().int().min(10).max(480),
  room: nullable(text(1, 40)).optional(),
  slots: z.array(slot).max(100),
});
const classPatch = z
  .object({
    name: text(1, 80).optional(),
    description: nullable(text(1, 500)).optional(),
    trainerUserId: nullable(id).optional(),
    capacity: z.number().int().min(1).max(500).optional(),
    minutes: z.number().int().min(10).max(480).optional(),
    room: nullable(text(1, 40)).optional(),
    status: z.literal('retired').optional().meta({ description: 'Retiring cancels the future sessions; everyone booked is told' }),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
const slotsBody = z.object({ slots: z.array(slot).max(100) });
const reasonBody = z.object({ reason: text(3, 300) });
const bookBody = z.object({ memberId: id });
const attendanceBody = z.object({ attended: z.array(id).max(500) });
const rewardsBody = z.object({
  rewards: z
    .array(
      z.object({
        id: id.optional(),
        title: text(1, 80),
        points: z.number().int().min(1).max(1000000),
        kind: z.enum(['days', 'discount']),
        value: z.number().int().min(1).max(100000000).meta({ description: 'days: extra days (at most 90); discount: poisha off what the member owes' }),
        status: z.enum(['active', 'retired']).default('active'),
      })
    )
    .max(100),
}).refine((b) => b.rewards.every((r) => r.kind !== 'days' || r.value <= 90), { message: 'At most 90 extra days', path: ['rewards'] });
const redeemBody = z.object({ rewardId: id });
const adjustBody = z.object({ points: z.number().int().min(-100000).max(100000).refine((n) => n !== 0, 'Not zero'), note: text(3, 200) });
const referralBody = z.object({ referrerMemberId: id });
const segment = z
  .object({
    kind: z.enum(rules.NOTICE_SEGMENTS),
    days: z.number().int().optional().meta({ description: 'expiring, expired, not_seen: 1 to gym_ops.notice_days_max' }),
    packageId: id.optional(),
    classId: id.optional(),
  })
  .meta({ id: 'GymNoticeSegment' });
const estimateBody = z.object({ segment });
const noticeBody = z.object({ title: text(1, 80), body: text(1, 500), segment });
const enquiryBody = z.object({
  name: text(1, 80),
  phone: text(6, 20),
  message: nullable(text(1, 500)).optional(),
  bestTime: nullable(text(1, 40)).optional(),
  website: z.string().max(200).optional().meta({ description: 'Leave empty (a trap for robots)' }),
});
const leadPatch = z
  .object({ status: z.enum(['contacted', 'joined', 'lost']).optional(), note: nullable(text(1, 300)).optional(), memberId: id.optional() })
  .refine((b) => b.status !== undefined || b.note !== undefined, 'Nothing to change');

// ---------------- responses
const ClassView = z
  .object({
    id,
    name: z.string(),
    description: nullable(z.string()),
    trainer: nullable(person),
    capacity: z.number().int(),
    minutes: z.number().int(),
    room: nullable(z.string()),
    status: z.enum(['active', 'retired']),
    slots: z.array(z.object({ id, dow: z.number().int(), startTime: z.string() })),
  })
  .meta({ id: 'GymClass' });
const Classes = z.object({ items: z.array(ClassView) }).meta({ id: 'GymClasses' });
const ClassTrainers = z.object({ items: z.array(z.object({ userId: id, displayName: nullable(z.string()), owner: z.boolean() })) }).meta({ id: 'GymClassTrainers' });
const SessionView = z
  .object({
    id,
    classId: id,
    name: z.string(),
    room: nullable(z.string()),
    trainer: nullable(person),
    localDate: date,
    startsAt: dateTime,
    endsAt: dateTime,
    capacity: z.number().int(),
    booked: z.number().int(),
    waitlisted: z.number().int(),
    spaces: z.number().int(),
    status: z.enum(['scheduled', 'cancelled', 'done']),
    cancelReason: nullable(z.string()),
  })
  .meta({ id: 'GymClassSession' });
const Sessions = z.object({ from: date, to: date, items: z.array(SessionView) }).meta({ id: 'GymClassSessions' });
const SessionDetail = SessionView.extend({
  bookings: z.array(z.object({ id, member: memberRef, status: z.enum(['booked', 'waitlisted', 'cancelled', 'attended', 'no_show']), source: z.enum(['member', 'desk']), createdAt: dateTime })),
}).meta({ id: 'GymClassSessionDetail' });
const Booking = z
  .object({ id, sessionId: id, memberId: id, status: z.enum(['booked', 'waitlisted', 'cancelled', 'attended', 'no_show']), source: z.enum(['member', 'desk']), startsAt: nullable(dateTime), promoted: z.boolean() })
  .meta({ id: 'GymClassBooking' });
const MyTimetable = z
  .object({ memberId: id, gymId: id, items: z.array(SessionView.extend({ myBooking: nullable(z.object({ id, status: z.string() })) })) })
  .meta({ id: 'MyGymTimetable' });
const MyBookings = z.object({ items: z.array(Booking.extend({ session: SessionView.optional() })) }).meta({ id: 'MyGymBookings' });
const PublicTimetable = z
  .object({ gymId: id, enquiries: z.boolean().meta({ description: 'The gym takes enquiries from its page (plan feature leads)' }), items: z.array(z.object({ id, name: z.string(), room: nullable(z.string()), trainer: nullable(person), localDate: date, startsAt: dateTime, endsAt: dateTime, capacity: z.number().int(), spaces: z.number().int() })) })
  .meta({ id: 'GymPublicTimetable' });
const Reward = z.object({ id, title: z.string(), points: z.number().int(), kind: z.enum(['days', 'discount']), value: z.number().int(), status: z.enum(['active', 'retired']) }).meta({ id: 'GymReward' });
const Rewards = z.object({ items: z.array(Reward) }).meta({ id: 'GymRewards' });
const PointEntry = z.object({ id, kind: z.enum(['checkin', 'streak', 'referral', 'redeem', 'expire', 'adjust']), points: z.number().int(), localDate: date, expiresOn: nullable(date), note: nullable(z.string()), at: dateTime });
const MemberPoints = z
  .object({ memberId: id, balance: z.number().int(), expiringIn30Days: z.number().int(), history: z.array(PointEntry), rewards: z.array(Reward), referredBy: nullable(memberRef.extend({ status: z.enum(['pending', 'rewarded']) })) })
  .meta({ id: 'GymMemberPoints' });
const Redeemed = z
  .object({ memberId: id, entryId: id, balance: z.number().int(), applied: z.union([z.object({ kind: z.literal('days'), days: z.number().int(), endsOn: date }), z.object({ kind: z.literal('discount'), waivedPoisha: z.number().int() })]) })
  .meta({ id: 'GymPointsRedeemed' });
const MyPoints = z
  .object({
    memberId: id,
    gymId: id,
    on: z.boolean(),
    balance: z.number().int(),
    expiringIn30Days: z.number().int(),
    history: z.array(PointEntry),
    rewards: z.array(Reward),
    earn: nullable(z.object({ perCheckin: z.number().int(), streakDays: z.number().int(), streakBonus: z.number().int(), referral: z.number().int() })),
  })
  .meta({ id: 'MyGymPoints' });
const Estimate = z
  .object({ members: z.number().int(), reach: z.object({ app: z.number().int(), email: z.number().int(), none: z.number().int() }), sentToday: z.number().int(), dailyCap: z.number().int() })
  .meta({ id: 'GymNoticeEstimate' });
const NoticeView = z
  .object({ id, title: z.string(), body: z.string(), segment, channels: z.array(z.enum(['in_app', 'push', 'email'])), targetCount: z.number().int(), sentBy: person, sentAt: dateTime })
  .meta({ id: 'GymNotice' });
const Notices = z.object({ items: z.array(NoticeView), sentToday: z.number().int(), dailyCap: z.number().int() }).meta({ id: 'GymNotices' });
const Accepted = z.object({ accepted: z.literal(true) }).meta({ id: 'GymEnquiryAccepted' });
const Lead = z
  .object({
    id,
    name: z.string(),
    phoneLast4: z.string(),
    message: nullable(z.string()),
    bestTime: nullable(z.string()),
    status: z.enum(['new', 'contacted', 'joined', 'lost']),
    note: nullable(z.string()),
    memberId: nullable(id),
    source: z.enum(['gym_page', 'desk']),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'GymLead' });
const Leads = z.object({ items: z.array(Lead), counts: z.object({ new: z.number().int(), contacted: z.number().int(), joined: z.number().int(), lost: z.number().int() }) }).meta({ id: 'GymLeads' });
const LeadPhone = z.object({ leadId: id, phone: z.string() }).meta({ id: 'GymLeadPhone' });
const Exercises = z
  .object({
    items: z.array(
      z.object({
        key: z.string(),
        nameEn: z.string(),
        nameBn: z.string(),
        muscle: z.enum(['chest', 'back', 'shoulders', 'arms', 'legs', 'glutes', 'core', 'full_body', 'cardio']),
        equipment: z.enum(['none', 'dumbbell', 'barbell', 'machine', 'cable', 'kettlebell', 'band', 'bench', 'other']),
        level: z.enum(['beginner', 'intermediate', 'advanced']),
        stepsEn: z.array(z.string()),
        stepsBn: z.array(z.string()),
        videoUrl: nullable(z.string()),
      })
    ),
  })
  .meta({ id: 'CatalogExercises' });

module.exports = {
  classParam,
  sessionParam,
  bookingParam,
  memberParam,
  leadParam,
  mySessionParam,
  myBookingParam,
  slugParam,
  classQuery,
  sessionQuery,
  myQuery,
  myMemberQuery,
  leadQuery,
  classBody,
  classPatch,
  slotsBody,
  reasonBody,
  bookBody,
  attendanceBody,
  rewardsBody,
  redeemBody,
  adjustBody,
  referralBody,
  estimateBody,
  noticeBody,
  enquiryBody,
  leadPatch,
  ClassView,
  Classes,
  ClassTrainers,
  SessionView,
  Sessions,
  SessionDetail,
  Booking,
  MyTimetable,
  MyBookings,
  PublicTimetable,
  Reward,
  Rewards,
  MemberPoints,
  Redeemed,
  MyPoints,
  Estimate,
  NoticeView,
  Notices,
  Accepted,
  Lead,
  Leads,
  LeadPhone,
  Exercises,
};
