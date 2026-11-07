'use strict';

/**
 * M27 Gym operations, round 2 (migration 20261120000001), owned by the gym-ops module (gym group, ADR-007):
 * classes (timetable, sessions, bookings with a waitlist), reward points (rewards, append-only entries,
 * member referrals), notices and enquiries (leads). index.js re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const enumOf = (values, extra = {}) => ({ type: DataTypes.ENUM(...values), allowNull: false, ...extra });
const ACTIVE = () => enumOf(['active', 'retired'], { defaultValue: 'active' });

class GymClass extends Model {}
GymClass.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    name: req(DataTypes.STRING(80)),
    description: DataTypes.STRING(500),
    trainerUserId: DataTypes.UUID,
    capacity: req(DataTypes.SMALLINT),
    minutes: req(DataTypes.SMALLINT),
    room: DataTypes.STRING(40),
    status: ACTIVE(),
    createdBy: req(DataTypes.UUID),
  },
  { sequelize, modelName: 'GymClass', tableName: 'gym_classes' }
);

class GymClassSchedule extends Model {}
GymClassSchedule.init(
  { id, gymId: req(DataTypes.UUID), classId: req(DataTypes.UUID), dow: req(DataTypes.SMALLINT), startTime: req(DataTypes.STRING(5)), status: ACTIVE() },
  { sequelize, modelName: 'GymClassSchedule', tableName: 'gym_class_schedules' }
);

class GymClassSession extends Model {}
GymClassSession.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    classId: req(DataTypes.UUID),
    scheduleId: DataTypes.UUID,
    localDate: req(DataTypes.DATEONLY),
    startsAt: req(DataTypes.DATE(3)),
    endsAt: req(DataTypes.DATE(3)),
    capacity: req(DataTypes.SMALLINT),
    trainerUserId: DataTypes.UUID,
    status: enumOf(['scheduled', 'cancelled', 'done'], { defaultValue: 'scheduled' }),
    cancelReason: DataTypes.STRING(300),
    cancelledBy: DataTypes.UUID,
    cancelledAt: DataTypes.DATE(3),
    remindedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'GymClassSession', tableName: 'gym_class_sessions' }
);

class GymClassBooking extends Model {}
GymClassBooking.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    sessionId: req(DataTypes.UUID),
    memberId: req(DataTypes.UUID),
    status: enumOf(['booked', 'waitlisted', 'cancelled', 'attended', 'no_show']),
    bookedBy: req(DataTypes.UUID),
    source: enumOf(['member', 'desk']),
    promotedAt: DataTypes.DATE(3),
    cancelledAt: DataTypes.DATE(3),
    markedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'GymClassBooking', tableName: 'gym_class_bookings' }
);

class GymReward extends Model {}
GymReward.init(
  { id, gymId: req(DataTypes.UUID), title: req(DataTypes.STRING(80)), points: req(DataTypes.INTEGER), kind: enumOf(['days', 'discount']), value: req(DataTypes.INTEGER), status: ACTIVE() },
  { sequelize, modelName: 'GymReward', tableName: 'gym_rewards' }
);

class GymPointEntry extends Model {}
GymPointEntry.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    memberId: req(DataTypes.UUID),
    kind: enumOf(['checkin', 'streak', 'referral', 'redeem', 'expire', 'adjust']),
    points: req(DataTypes.INTEGER),
    refId: DataTypes.UUID,
    localDate: req(DataTypes.DATEONLY),
    expiresOn: DataTypes.DATEONLY,
    note: DataTypes.STRING(200),
    byUser: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymPointEntry', tableName: 'gym_point_entries', updatedAt: false }
);

class GymMemberReferral extends Model {}
GymMemberReferral.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    referrerMemberId: req(DataTypes.UUID),
    referredMemberId: req(DataTypes.UUID),
    status: enumOf(['pending', 'rewarded'], { defaultValue: 'pending' }),
    rewardedAt: DataTypes.DATE(3),
    byUser: req(DataTypes.UUID),
  },
  { sequelize, modelName: 'GymMemberReferral', tableName: 'gym_member_referrals' }
);

class GymNotice extends Model {}
GymNotice.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    title: req(DataTypes.STRING(80)),
    body: req(DataTypes.STRING(500)),
    segment: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    channels: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    targetCount: req(DataTypes.INTEGER),
    localDate: req(DataTypes.DATEONLY),
    sentBy: req(DataTypes.UUID),
  },
  { sequelize, modelName: 'GymNotice', tableName: 'gym_notices', updatedAt: false }
);

class GymLead extends Model {}
GymLead.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    name: req(DataTypes.STRING(80)),
    phoneEnc: req(DataTypes.TEXT),
    phoneLast4: req(DataTypes.CHAR(4)),
    phoneHash: req(DataTypes.STRING(64)),
    message: DataTypes.STRING(500),
    bestTime: DataTypes.STRING(40),
    status: enumOf(['new', 'contacted', 'joined', 'lost'], { defaultValue: 'new' }),
    note: DataTypes.STRING(300),
    memberId: DataTypes.UUID,
    source: enumOf(['gym_page', 'desk'], { defaultValue: 'gym_page' }),
    updatedBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymLead', tableName: 'gym_leads' }
);

module.exports = { GymClass, GymClassSchedule, GymClassSession, GymClassBooking, GymReward, GymPointEntry, GymMemberReferral, GymNotice, GymLead };
