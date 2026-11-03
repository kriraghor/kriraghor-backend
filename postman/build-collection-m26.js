'use strict';

/**
 * Builds postman/kriraghor-tournament-feed.postman_collection.json (M26: the tournament feed).
 * node postman/build-collection-m26.js
 *
 * Variables (set by the runner, postman/run-m26.js): authorToken, playerToken, strangerToken,
 * noPhoneToken, staffToken (approve_listings), deskToken (resolve_reports), sportKey, districtId,
 * areaId and the dates in20, in22, in10, past. controlUrl (the runner): /drain, /expire.
 * Unattended: `node postman/run-m26.js`.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-tournament-feed.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const anon = (name, method, p, opts = {}) => req(name, method, p, { ...opts, as: false });
const author = as('authorToken');
const player = as('playerToken');
const stranger = as('strangerToken');
const noPhone = as('noPhoneToken');
const staff = as('staffToken');
const desk = as('deskToken');
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [step] };
  return r;
};

const FORM = {
  title: 'Mirpur Futsal Cup 2026',
  sport: '{{sportKey}}',
  format: 'knockout',
  districtId: '{{districtId}}',
  areaId: '{{areaId}}',
  venueName: 'Kick Off Arena',
  address: 'Road 11, Mirpur 10',
  mapLink: 'https://maps.app.goo.gl/abc',
  startDate: '{{in20}}',
  endDate: '{{in22}}',
  registrationDeadline: '{{in10}}',
  entryFee: 200000,
  prizePool: 5000000,
  prizeDetails: 'Winner takes the trophy and the prize money',
  teamLimit: 16,
  playersPerTeam: 7,
  gender: 'open',
  ageGroup: 'Under 25',
  skillLevel: 'intermediate',
  organiserName: 'Mirpur Sports Club',
  description: 'Sixteen teams play over a weekend, seven a side, on the turf at Mirpur 10.',
  rules: 'Standard futsal rules. Bring your own kit.',
};
const POST = '/me/tournament-posts';

const collection = {
  info: {
    name: 'Kriraghor API: M26 Tournament feed',
    description: [
      'M26 (product owner, 3 Nov 2026; ADR-008). Nobody organises tournaments on Kriraghor: people post about the ones they run. A verified phone posts, and it shows at once. The feed filters and sorts. Phones, emails and links are refused in public text and allowed in private messages. Authors close their posts, a job expires old ones, staff remove and restore them, and reports reach the M17 desk. No money moves in this module.',
      'Requests named "Runner" go to the local test runner. Unattended: `node postman/run-m26.js`. Rebuild this file with: node postman/build-collection-m26.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'controlUrl', 'authorToken', 'playerToken', 'strangerToken', 'noPhoneToken', 'staffToken', 'deskToken', 'sportKey', 'districtId', 'areaId', 'in20', 'in22', 'in10', 'past', 'postId', 'slug', 'commentId', 'threadId'].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. Posting (M26-FR-01 to FR-04)',
      item: [
        anon('Posting needs an account (expect 401)', 'POST', POST, { body: FORM, expect: { status: 401 } }),
        noPhone('Posting needs a verified phone (expect 403)', 'POST', POST, { body: FORM, expect: { status: 403, code: 'PHONE_REQUIRED' } }),
        author('A start in the past (expect 422)', 'POST', POST, { body: { ...FORM, startDate: '{{past}}', endDate: null, registrationDeadline: '{{past}}' }, expect: { status: 422, code: 'TOURNAMENT_POST_DATE_PAST' } }),
        author('Registration closing after the start (expect 422)', 'POST', POST, { body: { ...FORM, registrationDeadline: '{{in22}}' }, expect: { status: 422, code: 'TOURNAMENT_POST_DEADLINE_AFTER_START' } }),
        author('A phone number in the description (expect 422)', 'POST', POST, { body: { ...FORM, description: 'Sixteen teams this weekend. Call 01712345678 to join in.' }, expect: { status: 422, code: 'CONTACT_NOT_ALLOWED' }, checks: [['names the field', "j.field === 'description'"]] }),
        author('A map link that is not Google Maps (expect 422)', 'POST', POST, { body: { ...FORM, mapLink: 'https://example.com/map' }, expect: { status: 422, code: 'TOURNAMENT_POST_MAP_LINK' } }),
        author('A sport that does not exist (expect 422)', 'POST', POST, { body: { ...FORM, sport: 'not_a_sport' }, expect: { status: 422, code: 'TOURNAMENT_POST_SPORT_UNKNOWN' } }),
        author('Post a tournament: live at once', 'POST', POST, { body: FORM, expect: { status: 201 }, save: { postId: 'id', slug: 'slug' } }),
        anon('Its page has every detail, signed out', 'GET', '/tournament-posts/{{slug}}', { expect: { status: 200 }, checks: [['the details', "j.title === 'Mirpur Futsal Cup 2026' && j.status === 'open' && j.entryFee === 200000 && j.prizePool === 5000000 && j.teamLimit === 16 && j.organiserName === 'Mirpur Sports Club' && j.registrationOpen === true"], ['the place', "j.district.id === pm.variables.get('districtId') && j.area.id === pm.variables.get('areaId')"], ['no phone on it', '!/01[3-9]\\d{8}/.test(pm.response.text())']] }),
        author('Its author can edit and close it', 'GET', '/tournament-posts/{{slug}}', { expect: { status: 200 }, checks: [['can', 'j.mine === true && j.can.edit === true && j.can.close === true && j.can.message === false']] }),
        author('Edit it', 'PATCH', `${POST}/{{postId}}`, { body: { ...FORM, prizePool: 6000000 }, expect: { status: 200 } }),
        stranger('Someone else cannot edit it (expect 403)', 'PATCH', `${POST}/{{postId}}`, { body: FORM, expect: { status: 403, code: 'TOURNAMENT_POST_NOT_YOURS' } }),
      ],
    },
    {
      name: '2. The feed (M26-FR-05)',
      item: [
        anon('The feed, signed out', 'GET', '/tournament-posts', { expect: { status: 200 }, checks: [['it is there', "j.total === 1 && j.items[0].id === pm.variables.get('postId') && j.items[0].prizePool === 6000000"]] }),
        anon('By sport', 'GET', '/tournament-posts?sport={{sportKey}}', { expect: { status: 200 }, checks: [['one', 'j.total === 1']] }),
        anon('By a sport nobody posted', 'GET', '/tournament-posts?sport=nothing', { expect: { status: 200 }, checks: [['none', 'j.total === 0']] }),
        anon('By district', 'GET', '/tournament-posts?districtId={{districtId}}', { expect: { status: 200 }, checks: [['one', 'j.total === 1']] }),
        anon('Paid', 'GET', '/tournament-posts?fee=paid', { expect: { status: 200 }, checks: [['one', 'j.total === 1']] }),
        anon('Free', 'GET', '/tournament-posts?fee=free', { expect: { status: 200 }, checks: [['none', 'j.total === 0']] }),
        anon('Registration open', 'GET', '/tournament-posts?registrationOpen=true', { expect: { status: 200 }, checks: [['one', 'j.total === 1']] }),
        anon('Search', 'GET', '/tournament-posts?q=mirpur', { expect: { status: 200 }, checks: [['found', 'j.total === 1']] }),
        anon('Starts soonest', 'GET', '/tournament-posts?sort=starts_soon', { expect: { status: 200 } }),
        anon('Most discussed', 'GET', '/tournament-posts?sort=most_discussed', { expect: { status: 200 } }),
        anon('A bad sort (expect 422)', 'GET', '/tournament-posts?sort=random', { expect: { status: 422, code: 'VALIDATION_FAILED' } }),
      ],
    },
    {
      name: '3. Comments (M26-FR-06)',
      item: [
        anon('Commenting needs an account (expect 401)', 'POST', '/tournament-posts/{{postId}}/comments', { body: { body: 'Hello' }, expect: { status: 401 } }),
        player('A phone number in a comment (expect 422)', 'POST', '/tournament-posts/{{postId}}/comments', { body: { body: 'Call me on 01712345678' }, expect: { status: 422, code: 'CONTACT_NOT_ALLOWED' } }),
        player('Comment', 'POST', '/tournament-posts/{{postId}}/comments', { body: { body: 'Is it open to school teams?' }, expect: { status: 201 }, save: { commentId: 'id' } }),
        anon('Anyone reads it', 'GET', '/tournament-posts/{{postId}}/comments', { expect: { status: 200 }, checks: [['the comment', "j.total === 1 && j.items[0].body === 'Is it open to school teams?' && j.items[0].canRemove === false"]] }),
        control('deliver the events', 'drain'),
        author('The author is told', 'GET', '/me/notifications', { expect: { status: 200 }, checks: [['the notice', "j.items.some((n) => n.code === 'TOURNAMENT_POST_COMMENT' && n.link.endsWith('/tournaments/' + pm.variables.get('slug')))"]] }),
        stranger('Someone else cannot remove it (expect 403)', 'POST', '/tournament-posts/{{postId}}/comments/{{commentId}}/remove', { expect: { status: 403, code: 'TOURNAMENT_COMMENT_NOT_YOURS' } }),
        author('The post\'s author removes it', 'POST', '/tournament-posts/{{postId}}/comments/{{commentId}}/remove', { expect: { status: 200 } }),
        anon('It is gone', 'GET', '/tournament-posts/{{postId}}/comments', { expect: { status: 200 }, checks: [['none', 'j.total === 0']] }),
        player('Comment again, for the report', 'POST', '/tournament-posts/{{postId}}/comments', { body: { body: 'This is a rude comment' }, expect: { status: 201 }, save: { commentId: 'id' } }),
      ],
    },
    {
      name: '4. Private messages (M26-FR-07)',
      item: [
        author('Not on your own post (expect 422)', 'POST', '/tournament-posts/{{postId}}/threads', { expect: { status: 422, code: 'TOURNAMENT_THREAD_OWN_POST' } }),
        player('Message the organiser: opens a thread', 'POST', '/tournament-posts/{{postId}}/threads', { expect: { status: 201 }, save: { threadId: 'id' }, checks: [['from my side', "j.role === 'player' && j.unread === 0"]] }),
        player('Again finds the same thread', 'POST', '/tournament-posts/{{postId}}/threads', { expect: { status: 201 }, checks: [['same', "j.id === pm.variables.get('threadId')"]] }),
        player('A phone number is fine here', 'POST', '/me/tournament-threads/{{threadId}}/messages', { body: { body: 'My number is 01712345678, please call' }, expect: { status: 201 } }),
        author('The organiser has one unread', 'GET', '/me/tournament-threads', { expect: { status: 200 }, checks: [['unread', "j.items[0].role === 'organiser' && j.items[0].unread === 1"]] }),
        author('Reads the conversation', 'GET', '/me/tournament-threads/{{threadId}}/messages', { expect: { status: 200 }, checks: [['the message', 'j.canSend === true && j.items.length === 1 && j.items[0].mine === false']] }),
        author('Marks it read', 'POST', '/me/tournament-threads/{{threadId}}/read', { expect: { status: 200 }, checks: [['one read', 'j.read === 1']] }),
        author('Replies', 'POST', '/me/tournament-threads/{{threadId}}/messages', { body: { body: 'Thanks, I will call tonight' }, expect: { status: 201 } }),
        stranger('Nobody else can read it (expect 404)', 'GET', '/me/tournament-threads/{{threadId}}/messages', { expect: { status: 404, code: 'TOURNAMENT_THREAD_NOT_FOUND' } }),
        stranger('Nobody else can write in it (expect 404)', 'POST', '/me/tournament-threads/{{threadId}}/messages', { body: { body: 'Hello there' }, expect: { status: 404, code: 'TOURNAMENT_THREAD_NOT_FOUND' } }),
        control('deliver the events', 'drain'),
        player('The player is told about the reply', 'GET', '/me/notifications', { expect: { status: 200 }, checks: [['the notice', "j.items.some((n) => n.code === 'TOURNAMENT_POST_MESSAGE')"]] }),
      ],
    },
    {
      name: '5. Reports and staff (M26-FR-09)',
      item: [
        player('Report the post', 'POST', '/reports', { body: { subjectType: 'tournament_post', subjectId: '{{postId}}', reasonCode: 'fraud' }, expect: { status: 201 } }),
        author('Report the comment', 'POST', '/reports', { body: { subjectType: 'tournament_comment', subjectId: '{{commentId}}', reasonCode: 'offensive' }, expect: { status: 201 } }),
        desk('They reach the Reports desk', 'GET', '/admin/reports', { expect: { status: 200 }, checks: [['both', "['tournament_post', 'tournament_comment'].every((s) => j.items.some((r) => r.subjectType === s))"]] }),
        desk('Upholding removes the comment', 'POST', '/admin/reports/resolve', { body: { subjectType: 'tournament_comment', subjectId: '{{commentId}}', action: 'content_removed', note: 'Rude' }, expect: { status: 200 } }),
        anon('The comment is gone', 'GET', '/tournament-posts/{{postId}}/comments', { expect: { status: 200 }, checks: [['none', 'j.total === 0']] }),
        desk('Dismiss the post report as no violation', 'POST', '/admin/reports/resolve', { body: { subjectType: 'tournament_post', subjectId: '{{postId}}', action: 'no_violation', note: 'Looks genuine' }, expect: { status: 200 } }),
        author('Not staff (expect 401)', 'GET', '/admin/tournament-posts', { expect: { status: 401 } }),
        staff('Staff list every post', 'GET', '/admin/tournament-posts', { expect: { status: 200 }, checks: [['there', 'j.total === 1']] }),
        staff('A removal needs a reason (expect 422)', 'POST', '/admin/tournament-posts/{{postId}}/remove', { body: { reason: 'x' }, expect: { status: 422, code: 'VALIDATION_FAILED' } }),
        staff('Remove it', 'POST', '/admin/tournament-posts/{{postId}}/remove', { body: { reason: 'A fake tournament' }, expect: { status: 200 }, checks: [['removed', "j.status === 'removed'"]] }),
        anon('Off the feed', 'GET', '/tournament-posts', { expect: { status: 200 }, checks: [['none', 'j.total === 0']] }),
        anon('Gone for the public (expect 404)', 'GET', '/tournament-posts/{{slug}}', { expect: { status: 404, code: 'TOURNAMENT_POST_NOT_FOUND' } }),
        author('Its author sees why', 'GET', '/tournament-posts/{{slug}}', { expect: { status: 200 }, checks: [['the reason', "j.status === 'removed' && j.removedReason === 'A fake tournament'"]] }),
        player('No more messages (expect 409)', 'POST', '/me/tournament-threads/{{threadId}}/messages', { body: { body: 'Hello?' }, expect: { status: 409, code: 'TOURNAMENT_POST_STATE' } }),
        control('deliver the events', 'drain'),
        author('Its author is told', 'GET', '/me/notifications', { expect: { status: 200 }, checks: [['the notice', "j.items.some((n) => n.code === 'TOURNAMENT_POST_REMOVED')"]] }),
        staff('Restore it', 'POST', '/admin/tournament-posts/{{postId}}/restore', { body: { reason: 'It was real after all' }, expect: { status: 200 }, checks: [['open', "j.status === 'open'"]] }),
        staff('Restore again (expect 409)', 'POST', '/admin/tournament-posts/{{postId}}/restore', { body: { reason: 'It was real after all' }, expect: { status: 409, code: 'TOURNAMENT_POST_STATE' } }),
      ],
    },
    {
      name: '6. Closing and expiry (M26-FR-08)',
      item: [
        stranger('Someone else cannot close it (expect 403)', 'POST', `${POST}/{{postId}}/close`, { expect: { status: 403, code: 'TOURNAMENT_POST_NOT_YOURS' } }),
        author('Close it', 'POST', `${POST}/{{postId}}/close`, { expect: { status: 200 }, checks: [['closed', "j.status === 'closed'"]] }),
        anon('Off the feed, still readable', 'GET', '/tournament-posts/{{slug}}', { expect: { status: 200 }, checks: [['read-only', "j.status === 'closed' && j.registrationOpen === false && j.can.comment === false"]] }),
        player('No more comments (expect 409)', 'POST', '/tournament-posts/{{postId}}/comments', { body: { body: 'Too late?' }, expect: { status: 409, code: 'TOURNAMENT_POST_STATE' } }),
        author('Close again (expect 409)', 'POST', `${POST}/{{postId}}/close`, { expect: { status: 409, code: 'TOURNAMENT_POST_STATE' } }),
        author('Post another', 'POST', POST, { body: { ...FORM, title: 'Dhanmondi Badminton Open' }, expect: { status: 201 }, save: { postId: 'id', slug: 'slug' } }),
        control('its dates pass and the job runs', 'expire?postId={{postId}}', { checks: [['one expired', 'j.expired === 1']] }),
        anon('Expired: readable, off the feed', 'GET', '/tournament-posts/{{slug}}', { expect: { status: 200 }, checks: [['expired', "j.status === 'expired'"]] }),
        author('My posts keep them all', 'GET', POST, { expect: { status: 200 }, checks: [['two', "j.total === 2 && j.items.map((p) => p.status).sort().join() === 'closed,expired'"]] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
