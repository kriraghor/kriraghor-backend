'use strict';

/**
 * Builds postman/kriraghor-events.postman_collection.json (M23 Esports big events step 1: an event
 * over M21 tournaments with link checks, qualifiers putting their top 2 into an invite-only final,
 * only qualified or invited entries entering, withdraw / disqualify / invite / revoke / missed places,
 * streams with embeds and follow alerts, sponsors, a poll, the feed, cancel rules).
 * node postman/build-collection-m23.js
 *
 * Variables: adminAccessToken (master A), q1Id / q2Id / lateId / finId / openId (published tournaments
 * the runner made: two solo qualifiers, one starting too late, an invite-only final, an open final),
 * aToken / aProfile, bToken / bProfile, cToken / cProfile, gToken / gProfile / gUserId (players; a and b
 * finish 1st and 2nd in Q1, c 3rd; g is a wildcard), dUserId (2nd in Q2: never enters), fanToken (a
 * member), stepUpQueueA (unused), controlUrl (the runner: /settle, /play, /open, /close, /tick, /check).
 * Unattended: `node postman/run-m23.js` (kriraghor_test database).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-events.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const a = as('aToken');
const b = as('bToken');
const cc = as('cToken');
const g = as('gToken');
const fan = as('fanToken');
const master = (name, method, p, opts = {}) => req(name, method, p, { ...opts, as: 'A' });
const idem = (item) => {
  item.request.header.push({ key: 'Idempotency-Key', value: 'pm-{{$guid}}' });
  return item;
};
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  const [p, qs] = step.split('?');
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [p], ...(qs ? { query: qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
const ev = (p) => `/admin/esports/events/{{eventId}}${p}`;
const stage = (t, role, extra = {}) => ({ tournamentId: `{{${t}}}`, role, labelEn: role === 'final' ? 'Grand final' : 'Qualifier', labelBn: role === 'final' ? 'গ্র্যান্ড ফাইনাল' : 'কোয়ালিফায়ার', ...extra });
const qual = (t, n = 2) => stage(t, 'qualifier', { qualifyCount: n, finalTournamentId: '{{finId}}' });
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const collection = {
  info: {
    name: 'Kriraghor API: M23 Esports big events (step 1)',
    description: [
      'The runner publishes five tournaments: two free solo qualifiers, one starting too late, an invite-only final (5 slots) and an open final, and signs up seven players and a fan.',
      'Master A creates "Kriraghor FF Championship 2026". Publishing with nothing linked is refused. Linking is checked: an open final fed by a qualifier, too few final slots, a qualifier finishing too late, a tournament listed twice. Then two qualifiers (top 2 each) feed the final, and the event is published. The public page shows the stages and the prize total.',
      'Q1 finishes A, B, C and Q2 D, E, F (the runner plays and finalises them). The top 2 of each are qualified. C is refused at the final; A enters, withdraws (the place comes back) and enters again. E is disqualified after qualifying (the place is withdrawn). G is invited as a wildcard and enters; B\'s place is revoked. When the final\'s registration closes, D\'s unused place is missed.',
      'The fan follows. A live YouTube stream embeds (youtube-nocookie) and alerts followers once; a second live stream within the cooldown only adds a feed item. Sponsors (https only), a poll (one vote, final; totals only), an announcement, the fan\'s follow and votes. Cancelling the event is refused while its final runs.',
      'Requests named "Runner" go to the local test runner. Unattended: `node postman/run-m23.js` (kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m23.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'controlUrl', 'eventId', 'slug', 'aRegId', 'bQualId', 'aQualId', 'pollId', 'optA', 'optB', 'sponsorId', 'eRegId'].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. The event and its links',
      item: [
        master('A draft event', 'POST', '/admin/esports/events', {
          body: { titleEn: 'Kriraghor FF Championship 2026', titleBn: 'ক্রীড়াঘর এফএফ চ্যাম্পিয়নশিপ ২০২৬', taglineEn: 'Qualify online, win the final', startsAt: '{{eventStart}}', endsAt: '{{eventEnd}}', featured: true },
          expect: { status: 201 },
          save: { eventId: 'id', slug: 'slug' },
          checks: [['draft', "j.status === 'draft' && j.phase === 'draft' && j.accentHex === '#f2a33a'"]],
        }),
        master('Ends before it starts (expect 422)', 'POST', '/admin/esports/events', { body: { titleEn: 'Broken', titleBn: 'ভাঙা', startsAt: '{{eventEnd}}', endsAt: '{{eventStart}}' }, expect: { status: 422, code: 'EVENT_DATES_INVALID' } }),
        master('Publish with nothing linked (expect 409)', 'POST', ev('/publish'), { expect: { status: 409, code: 'EVENT_NOT_PUBLISHABLE' } }),
        master('An open final fed by a qualifier (expect 422)', 'PUT', ev('/stages'), { body: { stages: [stage('openId', 'final'), stage('q1Id', 'qualifier', { qualifyCount: 2, finalTournamentId: '{{openId}}' })] }, expect: { status: 422, code: 'EVENT_FINAL_NOT_INVITE' } }),
        master('Too few final slots (expect 422)', 'PUT', ev('/stages'), { body: { stages: [stage('finId', 'final'), qual('q1Id', 3), qual('q2Id', 3)] }, expect: { status: 422, code: 'EVENT_FINAL_SLOTS' } }),
        master('A qualifier finishing too late (expect 422)', 'PUT', ev('/stages'), { body: { stages: [stage('finId', 'final'), qual('lateId')] }, expect: { status: 422, code: 'EVENT_QUALIFY_GAP' } }),
        master('A tournament twice (expect 422)', 'PUT', ev('/stages'), { body: { stages: [stage('finId', 'final'), qual('q1Id'), qual('q1Id')] }, expect: { status: 422, code: 'EVENT_STAGES_INVALID' } }),
        master('Two qualifiers, top 2 each, feed the final', 'PUT', ev('/stages'), { body: { stages: [stage('finId', 'final'), qual('q1Id'), qual('q2Id')] }, expect: { status: 200 }, checks: [['three', 'j.items.length === 3']] }),
        master('Publish', 'POST', ev('/publish'), { expect: { status: 200 }, checks: [['published', "j.status === 'published'"]] }),
        req('The public page', 'GET', '/esports/events/{{slug}}', { as: false, expect: { status: 200 }, checks: [['stages and prizes', "j.event.phase === 'live' && j.stages.length === 3 && j.stages[0].tournament.entryPolicy === 'invite' && j.event.prizeTotal.amount === 210000"]] }),
        req('The event list', 'GET', '/esports/events?featured=true', { as: false, expect: { status: 200 }, checks: [['listed', "j.items.length === 1 && j.items[0].slug === pm.collectionVariables.get('slug')"]] }),
        master('The link check on the desk', 'GET', ev(''), { expect: { status: 200 }, checks: [['passes', 'j.linkCheck.length === 1 && j.linkCheck[0].block === null && j.linkCheck[0].qualifying === 4']] }),
      ],
    },
    {
      name: '2. Qualifiers put their top 2 into the final',
      item: [
        control('Q1 finishes A, B, C', 'play?which=q1'),
        control('Q2 finishes D, E, F', 'play?which=q2', { checks: [setVar('eRegId', 'j.regs.e')] }),
        master('The qualifications', 'GET', ev('/qualifications'), { expect: { status: 200 }, checks: [['four qualified, ranks 1 and 2', "j.items.length === 4 && j.items.every((q) => q.status === 'qualified' && q.rank <= 2)"]] }),
        req('The feed', 'GET', '/esports/events/{{eventId}}/feed', { as: false, expect: { status: 200 }, checks: [['qualified items', "j.items.filter((i) => i.kind === 'qualified').length === 2"]] }),
        master('E is disqualified in Q2 after qualifying', 'POST', '/admin/esports/registrations/{{eRegId}}/disqualify', { body: { reasonCode: 'cheating', note: 'Emulator in a mobile lobby' }, expect: { status: 200 } }),
        control('drain events', 'settle'),
        master('E\'s place is withdrawn', 'GET', ev('/qualifications'), { expect: { status: 200 }, checks: [['one revoked', "j.items.filter((q) => q.status === 'revoked').length === 1"], setVar('bQualId', "j.items.find((q) => q.entry.id === pm.variables.get('bUserId')).id")] }),
      ],
    },
    {
      name: '3. The invite-only final',
      item: [
        control('the final opens', 'open?which=fin'),
        idem(cc('C did not qualify (expect 403)', 'POST', '/esports/tournaments/{{finId}}/registrations', { body: { players: ['{{cProfile}}'] }, expect: { status: 403, code: 'EVENT_NOT_QUALIFIED' } })),
        idem(a('A enters', 'POST', '/esports/tournaments/{{finId}}/registrations', { body: { players: ['{{aProfile}}'] }, expect: { status: 201 }, save: { aRegId: 'registration.id' }, checks: [['confirmed', "j.registration.status === 'confirmed'"]] })),
        a('A withdraws', 'POST', '/me/esports/registrations/{{aRegId}}/withdraw', { expect: { status: 200 } }),
        control('drain events', 'settle'),
        idem(a('The place came back: A enters again', 'POST', '/esports/tournaments/{{finId}}/registrations', { body: { players: ['{{aProfile}}'] }, expect: { status: 201 } })),
        master('Invite G as a wildcard', 'POST', ev('/qualifications'), { body: { finalTournamentId: '{{finId}}', userId: '{{gUserId}}', reason: 'Wildcard for the final' }, expect: { status: 201 }, checks: [['invited', "j.status === 'invited' && j.rank === null"]] }),
        master('Twice (expect 409)', 'POST', ev('/qualifications'), { body: { finalTournamentId: '{{finId}}', userId: '{{gUserId}}', reason: 'Wildcard again' }, expect: { status: 409, code: 'EVENT_ALREADY_QUALIFIED' } }),
        idem(g('G enters', 'POST', '/esports/tournaments/{{finId}}/registrations', { body: { players: ['{{gProfile}}'] }, expect: { status: 201 } })),
        master('Revoke B\'s unused place', 'POST', ev('/qualifications/{{bQualId}}/revoke'), { body: { reason: 'Account shared with another player' }, expect: { status: 200 }, checks: [['revoked', "j.status === 'revoked'"]] }),
        idem(b('B is refused now (expect 403)', 'POST', '/esports/tournaments/{{finId}}/registrations', { body: { players: ['{{bProfile}}'] }, expect: { status: 403, code: 'EVENT_NOT_QUALIFIED' } })),
        control('registration closes; the tick', 'close?which=fin', { checks: [['one missed', 'j.tick.missed === 1']] }),
        req('Qualifications on the public page', 'GET', '/esports/events/{{slug}}', { as: false, expect: { status: 200 }, checks: [['entered, entered, missed', "j.qualifications.map((q) => q.status).sort().join() === 'entered,entered,missed'"]] }),
      ],
    },
    {
      name: '4. Viewers: follow, streams, sponsors, a poll',
      item: [
        fan('Follow', 'POST', '/esports/events/{{eventId}}/follow', { expect: { status: 200 }, checks: [['following', 'j.following === true && j.followers === 1']] }),
        master('A plain-http stream (expect 422)', 'PUT', ev('/streams'), { body: { streams: [{ platform: 'youtube', url: 'http://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Main' }] }, expect: { status: 422, code: 'STREAM_URL_INVALID' } }),
        master('The main stage goes live (embed)', 'PUT', ev('/streams'), {
          body: { streams: [{ platform: 'youtube', url: YT, title: 'Main stage', isLive: true }, { platform: 'tiktok', url: 'https://www.tiktok.com/@kriraghor/live', title: 'TikTok' }] },
          expect: { status: 200 },
          checks: [['embed and link', "j.items[0].embedUrl === 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' && j.items[1].embedUrl === null"]],
        }),
        master('A second live stream within the cooldown', 'PUT', ev('/streams'), { body: { streams: [{ platform: 'facebook', url: 'https://www.facebook.com/kriraghor/videos/1234567890/', title: 'Backup', isLive: true }] }, expect: { status: 200 } }),
        control('alerts sent', 'check', { checks: [['one alert, one notification', 'j.streamAlerts === 1 && j.fanStreamLive === 1']] }),
        master('A sponsor on http (expect 422)', 'POST', ev('/sponsors'), { body: { name: 'Walton', tier: 'title', url: 'http://walton.example' }, expect: { status: 422, code: 'SPONSOR_URL_INVALID' } }),
        master('The title sponsor', 'POST', ev('/sponsors'), { body: { name: 'Walton', tier: 'title', url: 'https://walton.example' }, expect: { status: 201 }, save: { sponsorId: 'id' } }),
        master('A gold sponsor', 'POST', ev('/sponsors'), { body: { name: 'Grameenphone', tier: 'gold' }, expect: { status: 201 } }),
        master('Duplicate options (expect 422)', 'POST', ev('/polls'), { body: { questionEn: 'Who wins the final?', questionBn: 'ফাইনালে কে জিতবে?', options: [{ labelEn: 'Ana', labelBn: 'আনা' }, { labelEn: 'ana', labelBn: 'আনা' }] }, expect: { status: 422, code: 'POLL_OPTIONS_INVALID' } }),
        master('A poll', 'POST', ev('/polls'), {
          body: { questionEn: 'Who wins the final?', questionBn: 'ফাইনালে কে জিতবে?', options: [{ labelEn: 'Ana', labelBn: 'আনা' }, { labelEn: 'Gias', labelBn: 'গিয়াস' }] },
          expect: { status: 201 },
          save: { pollId: 'id', optA: 'options.0.id', optB: 'options.1.id' },
        }),
        fan('A draft takes no votes (expect 409)', 'POST', '/esports/events/{{eventId}}/polls/{{pollId}}/vote', { body: { optionId: '{{optA}}' }, expect: { status: 409, code: 'POLL_CLOSED' } }),
        master('Open it', 'POST', ev('/polls/{{pollId}}/open'), { expect: { status: 200 } }),
        fan('Vote', 'POST', '/esports/events/{{eventId}}/polls/{{pollId}}/vote', { body: { optionId: '{{optA}}' }, expect: { status: 200 }, checks: [['totals', "j.myVote === pm.collectionVariables.get('optA') && j.results.total === 1 && j.results.items[0].pct === 100"]] }),
        fan('Again (expect 409)', 'POST', '/esports/events/{{eventId}}/polls/{{pollId}}/vote', { body: { optionId: '{{optB}}' }, expect: { status: 409, code: 'POLL_ALREADY_VOTED' } }),
        fan('My follow and votes', 'GET', '/esports/events/{{eventId}}/me', { expect: { status: 200 }, checks: [['mine', "j.following === true && j.votes[pm.collectionVariables.get('pollId')] === pm.collectionVariables.get('optA')"]] }),
        master('An announcement', 'POST', ev('/feed'), { body: { textEn: 'The final starts in 10 minutes', textBn: 'ফাইনাল ১০ মিনিটে শুরু' }, expect: { status: 201 } }),
        req('The page: sponsors in order, embeds, the poll, the feed', 'GET', '/esports/events/{{slug}}', {
          as: false,
          expect: { status: 200 },
          checks: [
            ['sponsors', "j.sponsors.map((s) => s.tier).join() === 'title,gold'"],
            ['poll totals only', 'j.polls.length === 1 && j.polls[0].results.total === 1 && j.polls[0].myVote === undefined'],
            ['feed', "j.feed.items[0].kind === 'announcement' && j.feed.items.some((i) => i.kind === 'stream_live')"],
          ],
        }),
        fan('My events', 'GET', '/me/esports/events', { expect: { status: 200 }, checks: [['one', 'j.items.length === 1']] }),
        master('Remove the title sponsor', 'POST', ev('/sponsors/{{sponsorId}}/remove'), { expect: { status: 200 } }),
        control('the final starts', 'start?which=fin'),
        master('Cancel while the final runs (expect 409)', 'POST', ev('/cancel'), { body: { reason: 'Venue power cut' }, expect: { status: 409, code: 'EVENT_TOURNAMENT_RUNNING' } }),
        fan('Unfollow', 'POST', '/esports/events/{{eventId}}/unfollow', { expect: { status: 200 }, checks: [['not following', 'j.following === false && j.followers === 0']] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
