'use strict';

/**
 * Builds postman/kriraghor-esports.postman_collection.json (M21 esports step 1: the whole player loop).
 * node postman/build-collection-m21.js
 *
 * Variables: adminAccessToken / adminAccessToken2 (masters A and B), playerA / playerB (members),
 * userA / userB, profileB, screenshotKeyA, takenUid (player B's verified UID), gameId, modeId, mapId, presetId,
 * opensAt, startsAt, profileTicks / tournamentTicks (rubric keys as JSON), controlUrl.
 * Unattended: `node postman/run-m21.js` prepares all of that, then serves {{controlUrl}}: a local,
 * test-only clock the collection calls between steps (the lifecycle job decides from stored times,
 * so the runner moves them and runs one tick), plus the payment simulator for each entry fee.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-esports.postman_collection.json');

/** Requests as player A or B (member tokens). */
const as = (who) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{player${who}}}` });
  return r;
};
const playerA = as('A');
const playerB = as('B');
const idem = (item, value = 'pm-{{$guid}}') => {
  item.request.header.push({ key: 'Idempotency-Key', value });
  return item;
};
/** A raw JSON value from a variable (arrays): the body keeps the {{var}} unquoted. */
const rawVar = (item, marker, variable) => {
  item.request.body.raw = item.request.body.raw.replace(`"${marker}"`, `{{${variable}}}`);
  return item;
};
/** A call to the runner's clock (never part of the API). */
const clock = (name, step, query = '') => {
  const r = req(`Runner clock: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 } });
  r.request.url = { raw: `{{controlUrl}}/${step}${query}`, host: ['{{controlUrl}}'], path: [step], ...(query ? { query: query.slice(1).split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};

/** Claim, tick every rubric item and approve the open submission saved in `idVar`, as master `who`. */
const approve = (label, idVar, ticksVar, who) => [
  req(`${label}: claim`, 'POST', `/admin/submissions/{{${idVar}}}/claim`, { as: who, expect: { status: 200 }, checks: [['automatic checks pass', "j.checks.every((c) => c.result !== 'fail')"]] }),
  rawVar(req(`${label}: tick the rubric`, 'PUT', `/admin/submissions/{{${idVar}}}/ticks`, { as: who, body: { ticks: '__TICKS__' }, expect: { status: 200 } }), '__TICKS__', ticksVar),
  idem(req(`${label}: approve`, 'POST', `/admin/submissions/{{${idVar}}}/decide`, { as: who, body: { decision: 'approve' }, expect: { status: 200 }, checks: [['approved', "j.status === 'approved'"]] })),
];

const draft = {
  gameId: '{{gameId}}',
  modeId: '{{modeId}}',
  titleEn: 'Postman Free Fire Daily',
  titleBn: 'পোস্টম্যান ফ্রি ফায়ার ডেইলি',
  tier: 'daily',
  format: 'single_match',
  entryFee: 5000,
  maxSlots: 4,
  minParticipants: 2,
  prizes: [{ place: 1, amount: 5000 }, { place: 2, amount: 2000 }],
  killReward: 500,
  pointsPresetId: '{{presetId}}',
  registrationOpensAt: '{{opensAt}}',
  matches: [{ mapId: '{{mapId}}', startsAt: '{{startsAt}}' }],
  rulesMd: 'Mobile only. No emulators.',
  featured: true,
};
const rows = (bad) => ({
  rows: [
    { registrationId: '{{regA}}', placement: 1, kills: [{ userId: '{{userA}}', kills: 3 }] },
    { registrationId: '{{regB}}', placement: bad ? 1 : 2, kills: [{ userId: '{{userB}}', kills: 1 }] },
  ],
});

const collection = {
  info: {
    name: 'Kriraghor API: M21 Esports',
    description: [
      'The player loop on one Free Fire solo tournament: player A adds a UID and master A approves it on the Moderation desk; master A drafts the tournament and master B approves it (no self-review); both players register and pay ৳50 into the pool; they check in; the room is set and revealed only to them, with every view audited; results are posted, B disputes and the dispute is rejected; the window closes and master A finalises with step-up. A wins ৳50 + 3 kills × ৳5 = ৳65, B wins ৳20 + ৳5 = ৳25, Kriraghor keeps ৳10, escrow ends at zero. A tops the leaderboard, and withdrawing asks for NID KYC.',
      'Requests named "Runner clock" go to the local test runner, not the API: it moves the stored times and runs one lifecycle tick.',
      'Unattended: `node postman/run-m21.js` (uses the kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m21.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'adminAccessToken', 'adminAccessToken2', 'playerA', 'playerB', 'userA', 'userB', 'screenshotKeyA', 'takenUid',
    'gameId', 'modeId', 'mapId', 'presetId', 'opensAt', 'startsAt', 'profileTicks', 'tournamentTicks', 'stepUpToken', 'stepUpTokenB',
    'profileB', 'profileId', 'profileSubmissionId', 'tournamentId', 'slug', 'tournamentSubmissionId', 'regA', 'regB', 'paymentA', 'paymentB', 'matchId', 'disputeId',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '0. Guards',
      item: [
        req('Public list works signed out', 'GET', '/esports/tournaments', { as: false, expect: { status: 200 }, checks: [['nothing published yet', 'Array.isArray(j.items) && j.items.length === 0']] }),
        req('Create without a staff token (expect 401)', 'POST', '/admin/esports/tournaments', { as: false, body: draft, expect: { status: 401 } }),
        playerA('A member token is refused on the staff API (expect 401)', 'GET', '/admin/esports/tournaments', { expect: { status: 401 } }),
      ],
    },
    {
      name: '1. Game UID through review (FR-02 to FR-04)',
      item: [
        playerA("Player A tries player B's UID (expect 409)", 'POST', '/me/esports/profiles', {
          body: { gameId: '{{gameId}}', uid: '{{takenUid}}', ign: 'Rahim', screenshotKey: '{{screenshotKeyA}}' },
          expect: { status: 409, code: 'ESPORTS_UID_TAKEN' },
        }),
        playerA('Player A adds a Free Fire UID with a screenshot', 'POST', '/me/esports/profiles', {
          body: { gameId: '{{gameId}}', uid: '712345601', ign: 'Rahim', screenshotKey: '{{screenshotKeyA}}' },
          expect: { status: 201 },
          save: { profileId: 'id' },
          checks: [['pending, masked', "j.status === 'pending' && j.uidMasked === '7123•••601' && !JSON.stringify(j).includes('screenshot')"]],
        }),
        req('It is on the Moderation desk', 'GET', '/admin/submissions?status=pending_review&kind=game_profile', {
          expect: { status: 200 },
          save: { profileSubmissionId: 'items.0.id' },
          checks: [['one UID to review', "j.items.length === 1 && j.items[0].kind === 'game_profile'"]],
        }),
        ...approve('UID', 'profileSubmissionId', 'profileTicks', 'A').slice(0, 1),
        req('The reviewer sees the screenshot (audited, never cached)', 'GET', '/admin/esports/profiles/{{profileId}}/screenshot', {
          expect: { status: 200 },
          checks: [['an image, no-store', "pm.response.headers.get('Content-Type').startsWith('image/') && pm.response.headers.get('Cache-Control') === 'no-store'"]],
        }),
        ...approve('UID', 'profileSubmissionId', 'profileTicks', 'A').slice(1),
        clock('apply the decisions', 'settle'),
        playerA('Player A sees the UID verified', 'GET', '/me/esports/profiles', { expect: { status: 200 }, checks: [['verified', "j.items.length === 1 && j.items[0].status === 'verified'"]] }),
      ],
    },
    {
      name: '2. Authoring and review (FR-06, FR-07)',
      item: [
        req('Master A drafts the tournament', 'POST', '/admin/esports/tournaments', {
          body: draft,
          expect: { status: 201 },
          save: { tournamentId: 'id', slug: 'slug' },
          checks: [['draft with a ৳70 prize table', "j.status === 'draft' && j.prizePool.amount === 7000"]],
        }),
        req('Master A submits it', 'POST', '/admin/esports/tournaments/{{tournamentId}}/submit', { expect: { status: 200 }, checks: [['in review', "j.status === 'review'"]] }),
        req('Not public while in review (expect 404)', 'GET', '/esports/tournaments/{{slug}}', { as: false, expect: { status: 404 } }),
        req('The queue has it', 'GET', '/admin/submissions?status=pending_review&kind=esports_tournament', { as: 'B', expect: { status: 200 }, save: { tournamentSubmissionId: 'items.0.id' } }),
        req('The author cannot review their own (expect 403)', 'POST', '/admin/submissions/{{tournamentSubmissionId}}/claim', { expect: { status: 403, code: 'SELF_REVIEW_FORBIDDEN' } }),
        ...approve('Master B', 'tournamentSubmissionId', 'tournamentTicks', 'B'),
        clock('apply the decisions', 'settle'),
        req('Published: the prize table is public', 'GET', '/esports/tournaments/{{slug}}', {
          as: false,
          expect: { status: 200 },
          save: { matchId: 'matches.0.id' },
          checks: [['scheduled, ৳50 entry, places 1 and 2', "j.status === 'scheduled' && j.entryFee.amount === 5000 && j.prizes.length === 2 && j.prizes[0].amount.amount === 5000"]],
        }),
        req('The prize table is locked (expect 409)', 'PATCH', '/admin/esports/tournaments/{{tournamentId}}', { body: { entryFee: 100 }, expect: { status: 409, code: 'ESPORTS_PRIZE_TABLE_LOCKED' } }),
      ],
    },
    {
      name: '3. Registration and payment (FR-08, FR-09)',
      item: [
        idem(playerA('Too early (expect 409)', 'POST', '/esports/tournaments/{{tournamentId}}/registrations', { body: { players: ['{{profileId}}'] }, expect: { status: 409, code: 'ESPORTS_REGISTRATION_CLOSED' } })),
        clock('open registration', 'open-registration'),
        idem(
          playerA('Player A registers', 'POST', '/esports/tournaments/{{tournamentId}}/registrations', {
            body: { players: ['{{profileId}}'] },
            expect: { status: 201 },
            save: { regA: 'registration.id', paymentA: 'payment.id' },
            checks: [['slot 1 held, pay ৳50', "j.registration.status === 'pending_payment' && j.registration.slotNo === 1 && j.payment.payUrl.includes('/pay/')"]],
          }),
          'pm-m21-reg-a'
        ),
        idem(
          playerA('The same key replays the same entry', 'POST', '/esports/tournaments/{{tournamentId}}/registrations', {
            body: { players: ['{{profileId}}'] },
            expect: { status: 201 },
            checks: [['same registration', "j.registration.id === pm.collectionVariables.get('regA')"]],
          }),
          'pm-m21-reg-a'
        ),
        clock('player A pays with the simulator', 'pay', '?who=A&payment={{paymentA}}'),
        idem(
          playerB('Player B registers', 'POST', '/esports/tournaments/{{tournamentId}}/registrations', {
            body: { players: ['{{profileB}}'] },
            expect: { status: 201 },
            save: { regB: 'registration.id', paymentB: 'payment.id' },
          })
        ),
        clock('player B pays with the simulator', 'pay', '?who=B&payment={{paymentB}}'),
        playerA('Player A is confirmed', 'GET', '/me/esports/registrations', {
          expect: { status: 200 },
          checks: [['confirmed', "j.items.some((r) => r.id === pm.collectionVariables.get('regA') && r.status === 'confirmed')"]],
        }),
        req('Two of four slots taken', 'GET', '/esports/tournaments/{{slug}}', { as: false, expect: { status: 200 }, checks: [['2/4', 'j.slotsTaken === 2 && j.maxSlots === 4']] }),
      ],
    },
    {
      name: '4. Check-in and the room (FR-13 to FR-17)',
      item: [
        clock('close registration (minimum met) and open check-in', 'open-checkin'),
        playerA('Player A checks in', 'POST', '/me/esports/registrations/{{regA}}/check-in', { expect: { status: 200 } }),
        playerB('Player B checks in', 'POST', '/me/esports/registrations/{{regB}}/check-in', { expect: { status: 200 } }),
        req('Master A sets the room', 'PUT', '/admin/esports/matches/{{matchId}}/room', {
          body: { roomId: '84512379', password: 'kg2024' },
          expect: { status: 200 },
          checks: [['the reply never echoes the secret', "!JSON.stringify(j).includes('kg2024') && !JSON.stringify(j).includes('84512379')"]],
        }),
        playerA('Before the reveal (expect 409)', 'GET', '/me/esports/matches/{{matchId}}/room', { expect: { status: 409, code: 'ESPORTS_ROOM_NOT_REVEALED' } }),
        clock('reveal time', 'reveal'),
        playerA('Player A reads the room', 'GET', '/me/esports/matches/{{matchId}}/room', {
          expect: { status: 200 },
          checks: [
            ['room and password', "j.roomId === '84512379' && j.password === 'kg2024' && j.version === 1"],
            ['never cached', "pm.response.headers.get('Cache-Control') === 'no-store'"],
          ],
        }),
        req('Every view is logged, without the secret', 'GET', '/admin/esports/matches/{{matchId}}/room/views', {
          expect: { status: 200 },
          checks: [['socket pushes and the read', "j.items.length >= 3 && !JSON.stringify(j).includes('kg2024')"]],
        }),
        req('Audit log has the views', 'GET', '/admin/audit-logs?action=esports_room.viewed', { expect: { status: 200 }, checks: [['audited', 'j.items.length >= 1']] }),
      ],
    },
    {
      name: '5. Results and a dispute (FR-18 to FR-21)',
      item: [
        clock('the match starts', 'start'),
        req('Duplicate placements (expect 422)', 'PUT', '/admin/esports/matches/{{matchId}}/results', { body: rows(true), expect: { status: 422, code: 'ESPORTS_PLACEMENT_DUPLICATE' } }),
        req('Master A enters the results', 'PUT', '/admin/esports/matches/{{matchId}}/results', { body: rows(false), expect: { status: 200 } }),
        req('Master A posts them', 'POST', '/admin/esports/matches/{{matchId}}/results/post', { expect: { status: 200 } }),
        req('Public standings: A first', 'GET', '/esports/tournaments/{{tournamentId}}/standings', {
          as: false,
          expect: { status: 200 },
          checks: [['A rank 1, B rank 2', "j.items[0].registrationId === pm.collectionVariables.get('regA') && j.items[0].rank === 1 && j.items[1].rank === 2"]],
        }),
        playerB('Player B disputes', 'POST', '/me/esports/matches/{{matchId}}/disputes', { body: { reason: 'I had two kills, not one' }, expect: { status: 201 }, save: { disputeId: 'id' } }),
        idem(req('Finalise while disputed (expect 409)', 'POST', '/admin/esports/tournaments/{{tournamentId}}/finalise', { stepUp: true, expect: { status: 409, code: 'ESPORTS_NOT_FINALISABLE' } })),
        req('Master A rejects the dispute', 'POST', '/admin/esports/disputes/{{disputeId}}/resolve', {
          body: { outcome: 'rejected', note: 'The kill feed shows one kill' },
          expect: { status: 200 },
          checks: [['rejected', "j.status === 'rejected'"]],
        }),
        clock('the dispute window closes', 'close-window'),
      ],
    },
    {
      name: '6. Finalise and pay (FR-23 to FR-25)',
      item: [
        req('Preview the settlement', 'GET', '/admin/esports/tournaments/{{tournamentId}}/finalise-preview', {
          expect: { status: 200 },
          checks: [['৳100 in, ৳90 out, ৳10 revenue', 'j.finalisable === true && j.totals.collected.amount === 10000 && j.totals.paid.amount === 9000 && j.totals.revenue.amount === 1000 && j.totals.subsidy.amount === 0']],
        }),
        idem(req('Finalise without step-up (expect 403)', 'POST', '/admin/esports/tournaments/{{tournamentId}}/finalise', { expect: { status: 403, code: 'STEP_UP_REQUIRED' } })),
        idem(req('Master A finalises with step-up', 'POST', '/admin/esports/tournaments/{{tournamentId}}/finalise', {
          stepUp: true,
          expect: { status: 200 },
          checks: [['paid out', "j.status === 'paid_out' && j.settlement.collected === 10000 && j.settlement.paid === 9000 && j.settlement.fee === 1000"]],
        })),
        playerA('Player A has ৳65 to withdraw', 'GET', '/me/esports/winnings', { expect: { status: 200 }, checks: [['৳50 + 3 × ৳5', 'j.available.amount === 6500 && j.totalWon.amount === 6500']] }),
        playerB('Player B has ৳25', 'GET', '/me/esports/winnings', { expect: { status: 200 }, checks: [['৳20 + 1 × ৳5', 'j.available.amount === 2500']] }),
        req('Trial balance is zero', 'GET', '/admin/ledger/trial-balance', { expect: { status: 200 }, checks: [['balanced', 'j.difference === 0']] }),
        req('Invariant checks pass', 'GET', '/admin/ledger/invariants', { expect: { status: 200 }, checks: [['all ok', 'j.ok === true']] }),
      ],
    },
    {
      name: '7. Rankings and withdrawal (FR-26 to FR-28)',
      item: [
        req('Free Fire leaderboard: A first', 'GET', '/esports/leaderboards?game=free_fire', {
          as: false,
          expect: { status: 200 },
          checks: [['A rank 1', "j.items[0].rank === 1 && j.items[0].userId === pm.variables.get('userA')"]],
        }),
        req("Player A's public page", 'GET', '/esports/players/{{userA}}', { as: false, expect: { status: 200 }, checks: [['UID masked', "!JSON.stringify(j).includes('712345601')"]] }),
        idem(playerA('Withdrawing needs NID KYC (expect 403)', 'POST', '/me/withdrawals', { expect: { status: 403, code: 'KYC_REQUIRED' } })),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
const count = collection.item.reduce((n, f) => n + f.item.length, 0);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${count} requests)`);
