'use strict';

/** Shared bits of M26: the error catalogue, settings read per call (M03), locks and events. */
const { AppError } = require('../../common/errors');
const { TournamentPost } = require('../../models');
const settings = require('../settings').settings;
const events = require('../events').events;

const ERRORS = {
  TOURNAMENT_POST_NOT_FOUND: [404, 'This tournament post was not found'],
  TOURNAMENT_POST_NOT_YOURS: [403, 'This is not your post'],
  TOURNAMENT_POST_STATE: [409, 'This post can no longer be changed'],
  TOURNAMENT_POST_LIMIT: [409, 'You have too many open posts. Close one first'],
  TOURNAMENT_POST_DAILY_LIMIT: [429, 'You have posted the most tournaments allowed today. Try again tomorrow'],
  TOURNAMENT_POST_DATE_PAST: [422, 'The start date has passed'],
  TOURNAMENT_POST_DEADLINE_AFTER_START: [422, 'Registration must close on or before the start date'],
  TOURNAMENT_POST_END_BEFORE_START: [422, 'The end date is before the start date'],
  TOURNAMENT_POST_MAP_LINK: [422, 'Use a Google Maps link'],
  TOURNAMENT_POST_SPORT_UNKNOWN: [422, 'Choose a sport from the list'],
  TOURNAMENT_POST_PLACE_UNKNOWN: [422, 'Choose a district and area from the list'],
  CONTACT_NOT_ALLOWED: [422, 'Phone numbers, emails and links can only be shared in private messages'],
  TOURNAMENT_COMMENT_TOO_LONG: [422, 'This comment is too long'],
  TOURNAMENT_COMMENT_NOT_FOUND: [404, 'This comment was not found'],
  TOURNAMENT_COMMENT_NOT_YOURS: [403, 'You can only remove your own comments, or comments on your post'],
  TOURNAMENT_MESSAGE_TOO_LONG: [422, 'This message is too long'],
  TOURNAMENT_THREAD_NOT_FOUND: [404, 'This conversation was not found'],
  TOURNAMENT_THREAD_OWN_POST: [422, 'This is your own post'],
  PHOTO_LIMIT: [409, 'This post has the most photos allowed'],
  PHOTO_NOT_FOUND: [404, 'This photo was not found'],
  FILE_EMPTY: [422, 'The file is empty'],
  FILE_TOO_LARGE: [413, 'The photo is too large'],
  FILE_TYPE_NOT_ALLOWED: [415, 'Upload a JPEG, PNG or WebP photo'],
  FILE_TYPE_MISMATCH: [415, 'The file is not the type it says it is'],
};

const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

const config = () => ({
  maxPhotos: settings.get('tournament_posts.max_photos'),
  photoMaxBytes: settings.get('tournament_posts.photo_max_bytes'),
  maxActivePerUser: settings.get('tournament_posts.max_active_per_user'),
  postsPerDay: settings.get('tournament_posts.posts_per_day'),
  commentMaxLength: settings.get('tournament_posts.comment_max_length'),
  messageMaxLength: settings.get('tournament_posts.message_max_length'),
  expireDaysAfterEnd: settings.get('tournament_posts.expire_days_after_end'),
});

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** The post, locked for the transaction, or TOURNAMENT_POST_NOT_FOUND. */
async function lockPost(id, transaction) {
  const p = await TournamentPost.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!p) throw fail('TOURNAMENT_POST_NOT_FOUND');
  return p;
}

const publish = (transaction, name, post, payload, actor) =>
  events.publish(transaction, { name, aggregateType: 'tournament_post', aggregateId: post.id, payload: { postId: post.id, slug: post.slug, title: post.title, authorId: post.authorId, ...payload }, actor });

module.exports = { ERRORS, fail, config, iso, lockPost, publish };
