'use strict';

/** Shared bits of M16: the error catalogue, settings read per call, events, phone hashing. */
const { AppError } = require('../../common/errors');
const { hmac } = require('../../common/crypto');
const events = require('../events').events;
const settings = require('../settings').settings;

const ERRORS = {
  TEAM_NAME_INVALID: [422, 'Use 2 to 40 characters, with no links or phone numbers'],
  TEAM_SHORT_CODE_INVALID: [422, 'Use 2 to 4 letters or digits for the short code'],
  TEAM_SPORT_UNKNOWN: [422, 'Choose a team sport'],
  TEAM_ARCHIVED: [409, 'This team is archived'],
  TEAM_FULL: [409, 'This team has the most members allowed'],
  TOO_MANY_TEAMS: [409, 'You are in the most teams allowed. Leave one first'],
  ALREADY_MEMBER: [409, 'This person is already in the team'],
  INVITE_SELF: [422, 'You are already in the team'],
  INVITE_STATE: [409, 'This invite is no longer open'],
  INVITE_EXPIRED: [409, 'This invite has expired. Ask the captain for a new one'],
  INVITE_RESEND_TOO_SOON: [429, 'You can send this invite again a little later'],
  INVITE_NOT_YOURS: [404, 'Invite not found'],
  PHONE_INVALID: [422, 'Enter a Bangladeshi mobile number'],
  ACCOUNT_INACTIVE: [403, 'Your account cannot join teams right now'],
  CAPTAIN_MUST_HAND_OVER: [409, 'Hand the captaincy to another member before you leave'],
  CAPTAIN_ONLY: [403, 'Only the captain can do this'],
  NOT_A_MEMBER: [404, 'Member not found'],
  CANNOT_REMOVE_CAPTAIN: [409, 'The captain cannot be removed. Hand the captaincy over first'],
  PROFILE_SPORTS_INVALID: [422, 'Choose each sport once, with its own positions'],
  USERNAME_REQUIRED: [409, 'Choose a username first: it is the address of your player page'],
  FILE_EMPTY: [422, 'The file is empty'],
  FILE_TOO_LARGE: [413, 'The file is too large'],
  FILE_TYPE_NOT_ALLOWED: [415, 'Upload a JPEG, PNG or WebP image'],
  FILE_TYPE_MISMATCH: [415, 'The file is not the type it says it is'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

const config = () => ({
  inviteDays: settings.get('teams.invite_expiry_days'),
  maxMembers: settings.get('teams.max_members'),
  maxMemberships: settings.get('teams.max_memberships'),
  resendMinutes: settings.get('teams.invite_resend_minutes'),
});

const publish = (transaction, name, aggregateType, aggregateId, payload, actor = null) => events.publish(transaction, { name, aggregateType, aggregateId, payload, actor });

/** The same hash sms_log uses, so a phone is never stored in the clear. */
const phoneHash = (e164) => hmac(`phone:${e164}`);
/** `+880171•••412`-style mask for the inviter's list. */
const phoneMask = (e164) => `${e164.slice(0, 7)}•••${e164.slice(-3)}`;

const DHAKA_MS = 6 * 3600000;
const today = (now = new Date()) => new Date(now.getTime() + DHAKA_MS).toISOString().slice(0, 10);

module.exports = { ERRORS, fail, config, publish, phoneHash, phoneMask, today };
