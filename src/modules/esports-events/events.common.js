'use strict';

/** Shared bits of M23: the error catalogue, settings read per call, events, realtime pings. */
const { AppError } = require('../../common/errors');
const realtime = require('../../common/realtime');
const events = require('../events/events.service');
const settings = require('../settings/settings.service');

const ERRORS = {
  EVENT_DATES_INVALID: [422, 'The showcase must end after it starts'],
  EVENT_ACCENT_INVALID: [422, 'Use a colour like #f2a33a'],
  EVENT_STATE: [409, 'The showcase cannot do that in its current state'],
  EVENT_NOT_PUBLISHABLE: [409, 'Link at least one published event before publishing the showcase'],
  EVENT_TOURNAMENT_RUNNING: [409, 'An event of this showcase is running. Let it finish (or cancel it on the esports desk) first'],
  EVENT_STAGES_INVALID: [422, 'Each event once; every qualifier names a final in this showcase and how many go through'],
  EVENT_TOURNAMENT_IN_OTHER_EVENT: [409, 'That event is already in another showcase'],
  EVENT_TOURNAMENT_NOT_OURS: [422, 'Only Kriraghor\'s own events can be in a showcase'],
  EVENT_TOURNAMENT_STATE: [409, 'A finished or cancelled event cannot be linked'],
  EVENT_FINAL_NOT_INVITE: [422, 'Make the final invite only, so only qualified entries can enter'],
  EVENT_LINK_MISMATCH: [422, 'A qualifier must be the same game, mode and entry type as its final'],
  EVENT_FINAL_SLOTS: [422, 'The final needs a slot for every qualifying entry'],
  EVENT_FINAL_MIN: [422, 'The final\'s minimum entries is more than can qualify'],
  EVENT_QUALIFY_GAP: [422, 'The final\'s registration closes too soon after a qualifier starts for its results to be final'],
  EVENT_NOT_QUALIFIED: [403, 'This entry has not qualified for the final'],
  EVENT_CORE_PLAYERS: [422, 'Bring enough of the players who qualified'],
  EVENT_QUALIFICATION_STATE: [409, 'This qualification cannot do that in its current state'],
  EVENT_INVITE_INVALID: [422, 'Invite a squad that plays this game, or a player with a verified UID for it'],
  EVENT_ALREADY_QUALIFIED: [409, 'This entry already has a place in the final'],
  STREAM_URL_INVALID: [422, 'Use an https link on YouTube, Facebook or TikTok'],
  SPONSOR_URL_INVALID: [422, 'Use an https link'],
  SPONSOR_LIMIT: [409, 'This showcase has the most sponsors allowed'],
  POLL_OPTIONS_INVALID: [422, 'Give 2 or more different options'],
  POLL_CLOSED: [409, 'This poll is closed'],
  POLL_OPTION_UNKNOWN: [422, 'Choose one of the poll\'s options'],
  POLL_ALREADY_VOTED: [409, 'You have already voted in this poll'],
  POLL_STATE: [409, 'The poll cannot do that in its current state'],
  FILE_EMPTY: [422, 'The file is empty'],
  FILE_TOO_LARGE: [413, 'The file is too large'],
  FILE_TYPE_NOT_ALLOWED: [415, 'Upload a JPEG, PNG or WebP image'],
  FILE_TYPE_MISMATCH: [415, 'The file is not the type it says it is'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

const config = () => ({
  gapMinutes: settings.get('esports_events.min_qualify_gap_minutes'),
  minCore: settings.get('esports_events.min_core_players'),
  reminderMinutes: settings.get('esports_events.final_reminder_minutes'),
  cooldownMinutes: settings.get('esports_events.alert_cooldown_minutes'),
  fanoutBatch: settings.get('esports_events.fanout_batch'),
  pollOptionsMax: settings.get('esports_events.poll_options_max'),
  pollPushMs: settings.get('esports_events.poll_push_ms'),
  pollCacheSeconds: settings.get('esports_events.poll_cache_seconds'),
  feedPageSize: settings.get('esports_events.feed_page_size'),
  maxStages: settings.get('esports_events.max_stages'),
  maxSponsors: settings.get('esports_events.max_sponsors'),
  bannerMaxBytes: settings.get('esports_events.banner_max_bytes'),
});

const publish = (transaction, name, aggregateType, aggregateId, payload, actor = null) => events.publish(transaction, { name, aggregateType, aggregateId, payload, actor });

const room = (eventId) => `esports_event:${eventId}`;
/** A ping to the event's room after commit (clients re-fetch; payloads carry ids only). */
const ping = (transaction, eventId, name, payload = {}) => {
  const send = () => realtime.toRoom(room(eventId), name, { eventId, ...payload });
  return transaction ? transaction.afterCommit(send) : send();
};

const money = (poisha) => ({ amount: poisha, currency: 'BDT' });
const iso = (d) => (d ? new Date(d).toISOString() : null);

module.exports = { ERRORS, fail, config, publish, room, ping, money, iso };
