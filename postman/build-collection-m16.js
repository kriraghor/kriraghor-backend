'use strict';

/**
 * Builds postman/kriraghor-teams.postman_collection.json (M16 Teams and players step 1: teams with a
 * verified-phone gate, invites by phone with one answer for every number and a share link, linking on
 * sign-up and on a phone added later, roles, hand-over, the player profile and public page, gender
 * and eligibility, the staff desk). node postman/build-collection-m16.js
 *
 * Variables: capToken (the captain, phone sign-up), sakibToken / sakibPhone (a member), strangerPhone
 * (a number with no account yet), laterPhone (the number the email account adds), emailToken (an
 * email-only account), modToken (staff, manage_users), controlUrl (the runner: /settle, /signup,
 * /otp, /refresh-email, /check).
 * Unattended: `node postman/run-m16.js` (kriraghor_test database).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-teams.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const cap = as('capToken');
const sakib = as('sakibToken');
const stranger = as('strangerToken');
const email = as('emailToken');
const mod = as('modToken');
const email2 = as('emailToken2');
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  const [p, qs] = step.split('?');
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [p], ...(qs ? { query: qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
const tm = (p) => `/teams/{{teamId}}${p}`;

const collection = {
  info: {
    name: 'Kriraghor API: M16 Teams and players (step 1)',
    description: [
      'A captain creates Gulshan Gladiators (football). An email-only account cannot create a team until it adds a phone.',
      'Inviting a member with an account and a number with no account gives the same answer: a share link. Inviting the same number again reuses the invite; a self-invite is refused. The link page shows the team, sport, the inviter\'s first name and the masked number.',
      'The number signs up (the runner does the OTP): its invite is waiting, and it accepts. The member accepts too. The email account adds and verifies a phone and finds the invite sent to it.',
      'Roles: one vice-captain at a time, jersey numbers, hand-over, a captain must hand over before leaving.',
      'The player profile with positions from the sport\'s list; the public page by username, which never shows gender, DOB or phone; gender set once; the eligibility readiness and a preview for the member only.',
      'Staff (manage_users): search and view a team (masked phones), correct a gender, archive with a reason.',
      'Unattended: `node postman/run-m16.js` (kriraghor_test database). Rebuild with: node postman/build-collection-m16.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'controlUrl', 'teamId', 'sakibInvite', 'strangerInvite', 'linkToken', 'strangerToken', 'strangerId', 'sakibId', 'code', 'firstKeys', 'emailToken2'].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. A team',
      item: [
        email('No verified phone (expect 403)', 'POST', '/teams', { body: { sportKey: 'football', name: 'Mirpur Kings' }, expect: { status: 403, code: 'PHONE_REQUIRED' } }),
        cap('A link in the name (expect 422)', 'POST', '/teams', { body: { sportKey: 'football', name: 'Join www.spam.com' }, expect: { status: 422, code: 'TEAM_NAME_INVALID' } }),
        cap('Not a team sport (expect 422)', 'POST', '/teams', { body: { sportKey: 'gym', name: 'Lifters' }, expect: { status: 422, code: 'TEAM_SPORT_UNKNOWN' } }),
        cap('Gulshan Gladiators', 'POST', '/teams', {
          body: { sportKey: 'football', name: 'Gulshan Gladiators', shortCode: 'ggl' },
          expect: { status: 201 },
          save: { teamId: 'id' },
          checks: [['captain', "j.myRole === 'captain' && j.shortCode === 'GGL' && j.members.length === 1 && j.members[0].nidVerified === false"]],
        }),
      ],
    },
    {
      name: '2. Invites (FR-02)',
      item: [
        cap('Invite a member with an account', 'POST', tm('/invites'), { body: { phone: '{{sakibPhone}}' }, expect: { status: 201 }, save: { sakibInvite: 'invite.id' }, checks: [setVar('firstKeys', "Object.keys(j).sort().join() + '|' + Object.keys(j.invite).sort().join()")] }),
        cap('Invite a number with no account: the same answer', 'POST', tm('/invites'), {
          body: { phone: '{{strangerPhone}}' },
          expect: { status: 201 },
          save: { strangerInvite: 'invite.id' },
          checks: [['same shape', "Object.keys(j).sort().join() + '|' + Object.keys(j.invite).sort().join() === pm.collectionVariables.get('firstKeys')"], ['a share link', "/\\/teams\\/join\\/[A-Za-z0-9_-]{20,}$/.test(j.shareUrl)"]],
        }),
        cap('The same number again: the same invite, a new link', 'POST', tm('/invites'), {
          body: { phone: '{{strangerPhone}}' },
          expect: { status: 201 },
          checks: [['reused', "j.invite.id === pm.collectionVariables.get('strangerInvite')"], setVar('linkToken', "j.shareUrl.split('/').pop()")],
        }),
        cap('Myself (expect 422)', 'POST', tm('/invites'), { body: { phone: '{{capPhone}}' }, expect: { status: 422, code: 'INVITE_SELF' } }),
        req('The share link page', 'GET', '/team-invites/{{linkToken}}', { as: false, expect: { status: 200 }, checks: [['team, inviter, masked number', "j.team.name === 'Gulshan Gladiators' && j.invitedBy === 'Rafi' && /•••/.test(j.phoneMasked)"]] }),
        cap('Pending invites on the team', 'GET', tm(''), { expect: { status: 200 }, checks: [['two, masked', "j.invites.length === 2 && j.invites.every((i) => /•••/.test(i.phoneMasked))"]] }),
        control('the number signs up', 'signup?phone={{strangerPhone}}', { save: { strangerToken: 'accessToken', strangerId: 'userId' } }),
        stranger('Its invite is waiting', 'GET', '/me/team-invites', { expect: { status: 200 }, checks: [['one', "j.items.length === 1 && j.items[0].id === pm.collectionVariables.get('strangerInvite')"]] }),
        stranger('Accept', 'POST', '/me/team-invites/{{strangerInvite}}/accept', { expect: { status: 200 }, checks: [['player', "j.role === 'player'"]] }),
        sakib('The member accepts', 'POST', '/me/team-invites/{{sakibInvite}}/accept', { expect: { status: 200 } }),
        sakib('Twice (expect 409)', 'POST', '/me/team-invites/{{sakibInvite}}/accept', { expect: { status: 409, code: 'INVITE_STATE' } }),
        cap('Invite the number the email account will add', 'POST', tm('/invites'), { body: { phone: '{{laterPhone}}' }, expect: { status: 201 } }),
        email('A number used by another account (expect 409)', 'POST', '/me/phone', { body: { phone: '{{capPhone}}' }, expect: { status: 409, code: 'PHONE_IN_USE' } }),
        email('Add a phone', 'POST', '/me/phone', { body: { phone: '{{laterPhone}}' }, expect: { status: 202 } }),
        control('read the code', 'otp?phone={{laterPhone}}', { save: { code: 'code' } }),
        email('Verify it', 'POST', '/me/phone/verify', { body: { phone: '{{laterPhone}}', code: '{{code}}' }, expect: { status: 200 }, checks: [['verified', 'j.phoneVerified === true']] }),
        control('a fresh token for the email account', 'refresh-email', { checks: [setVar('emailToken2', 'j.accessToken')] }),
        email2('The invite sent to that number is there', 'GET', '/me/team-invites', { expect: { status: 200 }, checks: [['one', 'j.items.length === 1']] }),
        control('drain events', 'settle'),
        control('notices sent', 'check', { checks: [['in-app invites', 'j.sakibInvites === 1 && j.strangerInvites === 1 && j.emailInvites === 1'], ['captain told', 'j.capAccepted === 2']] }),
      ],
    },
    {
      name: '3. Members and captaincy (FR-04)',
      item: [
        cap('The member is vice-captain, number 7', 'PUT', tm('/members/{{sakibId}}'), { body: { role: 'vice_captain', jerseyNo: 7 }, expect: { status: 200 }, checks: [['vice', "j.members.find((m) => m.userId === pm.variables.get('sakibId')).role === 'vice_captain'"]] }),
        cap('The new player becomes vice-captain: only one', 'PUT', tm('/members/{{strangerId}}'), {
          body: { role: 'vice_captain' },
          expect: { status: 200 },
          checks: [['one vice', "j.members.filter((m) => m.role === 'vice_captain').length === 1 && j.members.find((m) => m.userId === pm.variables.get('sakibId')).jerseyNo === 7"]],
        }),
        stranger('The vice-captain cannot remove the captain (expect 409)', 'POST', tm('/members/{{capId}}/remove'), { expect: { status: 409, code: 'CANNOT_REMOVE_CAPTAIN' } }),
        cap('Leave before handing over (expect 409)', 'POST', tm('/leave'), { expect: { status: 409, code: 'CAPTAIN_MUST_HAND_OVER' } }),
        cap('Hand over to the member', 'POST', tm('/captain'), { body: { userId: '{{sakibId}}' }, expect: { status: 200 }, checks: [['handed over', "j.myRole === 'player' && j.members.find((m) => m.role === 'captain').userId === pm.variables.get('sakibId')"]] }),
        sakib('My teams', 'GET', '/me/teams', { expect: { status: 200 }, checks: [['captain of three', "j.items.length === 1 && j.items[0].myRole === 'captain' && j.items[0].members === 3"]] }),
      ],
    },
    {
      name: '4. Player profile, gender and eligibility (FR-05, FR-08)',
      item: [
        cap('A position from another sport (expect 422)', 'PUT', '/me/player-profile', { body: { sports: [{ sportKey: 'football', positions: ['wicketkeeper'] }] }, expect: { status: 422, code: 'PROFILE_SPORTS_INVALID' } }),
        cap('Football keeper and cricket wicketkeeper', 'PUT', '/me/player-profile', { body: { sports: [{ sportKey: 'football', positions: ['goalkeeper'] }, { sportKey: 'cricket', positions: ['wicketkeeper'] }], bio: 'Weekend keeper.' }, expect: { status: 200 } }),
        cap('A username for the page', 'PUT', '/me/username', { body: { username: 'rafi{{run}}' }, expect: { status: 200 } }),
        cap('My gender, once', 'PUT', '/me/gender', { body: { gender: 'male' }, expect: { status: 200 } }),
        cap('Again (expect 409)', 'PUT', '/me/gender', { body: { gender: 'female' }, expect: { status: 409, code: 'GENDER_ALREADY_SET' } }),
        req('The public page', 'GET', '/players/rafi{{run}}', {
          as: false,
          expect: { status: 200 },
          checks: [['profile and teams', "j.displayName === 'Rafi Ahmed' && j.sports.length === 2 && j.sports[0].positions[0].en === 'Goalkeeper' && j.teams.length === 1"], ['never gender, DOB or phone', "!/gender|male|dob|phone/i.test(JSON.stringify(j))"]],
        }),
        cap('My readiness and a preview of a women\'s over-30 event', 'GET', '/me/eligibility?gender=women&ageMin=30', {
          expect: { status: 200 },
          checks: [['readiness', "j.readiness.map((r) => r.status).join() === 'pass,missing,pass'"], ['preview', "j.preview.eligible === false && j.preview.checks.find((c) => c.key === 'gender').status === 'fail'"]],
        }),
        cap('The team shows only the NID boolean', 'GET', tm(''), { expect: { status: 200 }, checks: [['booleans only', "j.members.every((m) => typeof m.nidVerified === 'boolean') && !/gender|dob|phone/i.test(JSON.stringify(j.members))"]] }),
      ],
    },
    {
      name: '5. Staff (manage_users)',
      item: [
        mod('Search teams', 'GET', '/admin/teams?q=gladiators', { expect: { status: 200 }, checks: [['found', 'j.items.length === 1']] }),
        mod('The team with members and masked invites', 'GET', '/admin/teams/{{teamId}}', { expect: { status: 200 }, checks: [['members', 'j.members.length === 3']] }),
        mod('Correct a gender (with a reason)', 'PUT', '/admin/users/{{capId}}/gender', { body: { gender: 'female', reason: 'Member wrote in to correct it' }, expect: { status: 200 }, checks: [['corrected', "j.gender === 'female' && j.genderSource === 'staff_corrected'"]] }),
        mod('Archive with a reason', 'POST', '/admin/teams/{{teamId}}/archive', { body: { reason: 'Offensive team name' }, expect: { status: 200 }, checks: [['archived', "j.status === 'archived'"]] }),
        sakib('Inviting into an archived team (expect 409)', 'POST', tm('/invites'), { body: { phone: '{{freshPhone}}' }, expect: { status: 409, code: 'TEAM_ARCHIVED' } }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
