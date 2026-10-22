'use strict';

/**
 * Builds postman/kriraghor-tournaments.postman_collection.json (M14 Tournaments step 1 with M15 lite
 * results): a sports organisation drafts a badminton league, staff approve it, four captains register
 * and pay into escrow (a fifth goes to the reserve list), the organiser approves, closes registration,
 * draws, generates and publishes fixtures, enters results (tranche 1 at the first, the rest at
 * completion), and the public hub shows the standings. node postman/build-collection-m14.js
 *
 * Variables: ownerToken, orgId (a verified sports organisation), orgStaffToken (a staff member of it),
 * cap1Token…cap5Token and team1…team5
 * (captains with an NID and a badminton team), cap1Id…cap5Id, venueArea, modToken (approve_listings),
 * dates (opensAt, closesAt, startDate, endDate), controlUrl (the runner: /approve, /pay, /settle,
 * /check). Unattended: `node postman/run-m14.js` (kriraghor_test database).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-tournaments.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const idem = (item) => {
  item.request.header.push({ key: 'Idempotency-Key', value: 'pm-{{$guid}}' });
  return item;
};
const own = as('ownerToken');
const mod = as('modToken');
const cap = (n) => as(`cap${n}Token`);
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  const [p, qs] = step.split('?');
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [p], ...(qs ? { query: qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
const con = (p) => `/org/{{orgId}}/sports${p}`;
const draftBody = {
  sportKey: 'badminton',
  name: 'Mirpur Badminton League {{run}}',
  format: 'league',
  minTeams: 4,
  maxTeams: 4,
  squadMin: 1,
  squadMax: 2,
  entryFeePoisha: 1800000,
  prizePoolPoisha: 5000000,
  prizeSplit: [
    { label: 'Winner', pct: 70 },
    { label: 'Runner-up', pct: 30 },
  ],
  registrationOpensAt: '{{opensAt}}',
  registrationClosesAt: '{{closesAt}}',
  startDate: '{{startDate}}',
  endDate: '{{endDate}}',
  venues: [{ venueText: 'Mirpur Indoor Stadium', areaId: '{{venueArea}}', courts: ['Court 1', 'Court 2'] }],
};
const register = (n) => [
  idem(cap(n)(`Captain ${n} registers`, 'POST', '/tournaments/{{tournamentId}}/registrations', { body: { teamId: `{{team${n}}}`, rosterUserIds: [`{{cap${n}Id}}`], acceptRules: true }, expect: { status: 201 }, save: { [`reg${n}`]: 'id', [`pay${n}`]: 'payment.id' } })),
];
const pay = (n) => control(`captain ${n} pays with bKash`, `pay?payment={{pay${n}}}&captain=${n}`);
const result = (i) => own(`Result of match ${i}`, 'PUT', `/org/{{orgId}}/sports/matches/{{m${i}}}/result`, { body: { sets: [[21, 15], [21, 17]] }, expect: { status: 200 } });

const collection = {
  info: {
    name: 'Kriraghor API: M14 Tournaments (step 1)',
    description: [
      'A verified sports organisation (M14 lite, kind sports) drafts a badminton league for four teams: ৳18,000 a team, a prize pool shown on the page (Q86: not held), a venue with two courts. Its submission fails without a venue; with one it goes to the Moderation desk (kind tournament) and the runner approves it: registration opens with the 5% fee and the 50% first release snapshotted.',
      'Four captains (NID members with a badminton team) register with a squad and pay into escrow (M06 purpose tournament_entry); a fifth joins the reserve list. Registering the same team twice is refused.',
      'The organiser exports the registrations as CSV (organisation admins only; team, status, fees, dates, squad counts, and with the roster display names and NID yes/no; never phones or ids).',
      'The organiser approves the four (squads ready), closes registration (the reserve team lapses), draws at random (the seed is published), dry-runs and then generates the schedule, and publishes the fixtures.',
      'Results: the first locks the rules and releases half of every entry less 5% (৳34,200 to the owner); a stale move is refused; an amendment needs a reason; the last result completes the tournament and releases the rest (৳68,400 in all, ৳3,600 fee). The public hub shows the standings without any personal data.',
      'Unattended: `node postman/run-m14.js` (kriraghor_test database). Rebuild with: node postman/build-collection-m14.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'controlUrl', 'tournamentId', 'slug', 'reg1', 'reg2', 'reg3', 'reg4', 'reg5', 'pay1', 'pay2', 'pay3', 'pay4', 'pay5', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'mv1', 'draftId'].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. Draft and review (M14-FR-04 to FR-08)',
      item: [
        req('The sport\'s rules for the wizard', 'GET', '/catalog/sport-rules/badminton', { as: false, expect: { status: 200 }, checks: [['presets and tiebreakers', "j.presets.length === 3 && j.tiebreakers.includes('game_difference')"]] }),
        own('Not the esports console (expect 404)', 'GET', '/org/{{orgId}}/esports/dashboard', { expect: { status: 404 } }),
        own('A draft without a venue', 'POST', con('/tournaments'), { body: { ...draftBody, name: 'Draft without a venue {{run}}', venues: [] }, expect: { status: 201 }, save: { draftId: 'id' } }),
        own('…cannot be submitted (expect 422)', 'POST', con('/tournaments/{{draftId}}/submit'), { expect: { status: 422, code: 'TOURNAMENT_INCOMPLETE' }, checks: [['venue check', "j.checks.includes('venue_present')"]] }),
        own('A rule out of range (expect 422)', 'POST', con('/tournaments'), { body: { ...draftBody, rules: { points: 50 } }, expect: { status: 422, code: 'RULE_OUT_OF_RANGE' } }),
        own('The league draft', 'POST', con('/tournaments'), { body: draftBody, expect: { status: 201 }, save: { tournamentId: 'id', slug: 'slug' }, checks: [['preset rules', "j.rules.presetKey === 'b3x21' && j.rules.tiebreakers[0] === 'points'"]] }),
        own('Choose the 1-game preset', 'PATCH', con('/tournaments/{{tournamentId}}'), { body: { presetKey: 'b1x21' }, expect: { status: 200 }, checks: [['summary', "j.rules.values.bestOf === '1' && /Games: 1 game/.test(j.rules.summaryEn)"]] }),
        own('Back to best of 3', 'PATCH', con('/tournaments/{{tournamentId}}'), { body: { presetKey: 'b3x21' }, expect: { status: 200 } }),
        own('Submit for review', 'POST', con('/tournaments/{{tournamentId}}/submit'), { expect: { status: 200 }, checks: [['in review', "j.status === 'pending_review'"]] }),
        req('Not public yet (expect 404)', 'GET', '/tournaments/{{slug}}', { as: false, expect: { status: 404 } }),
        control('staff approve it on the Moderation desk', 'approve?kind=tournament&id={{tournamentId}}'),
        own('Registration is open with the fee snapshotted', 'GET', con('/tournaments/{{tournamentId}}'), { expect: { status: 200 }, checks: [['open', "j.status === 'registration_open' && j.feeBps === 500 && j.releasePct === 50"]] }),
        req('Listed in discover', 'GET', '/tournaments?status=open&sport=badminton', { as: false, expect: { status: 200 }, checks: [['one', "j.items.some((t) => t.id === pm.collectionVariables.get('tournamentId'))"]] }),
      ],
    },
    {
      name: '2. Registrations and escrow (FR-10 to FR-13)',
      item: [
        ...register(1),
        pay(1),
        ...register(2),
        pay(2),
        ...register(3),
        pay(3),
        ...register(4),
        pay(4),
        idem(cap(1)('The same team again (expect 409)', 'POST', '/tournaments/{{tournamentId}}/registrations', { body: { teamId: '{{team1}}', rosterUserIds: ['{{cap1Id}}'], acceptRules: true }, expect: { status: 409, code: 'TEAM_ALREADY_REGISTERED' } })),
        idem(cap(5)('A fifth team: the reserve list', 'POST', '/tournaments/{{tournamentId}}/registrations', { body: { teamId: '{{team5}}', rosterUserIds: ['{{cap5Id}}'], acceptRules: true }, expect: { status: 201 }, save: { reg5: 'id' }, checks: [['reserve', "j.status === 'reserve' && j.reservePosition === 1 && j.payment === null"]] })),
        control('drain events', 'settle'),
        cap(1)('Paid: waiting for the organiser', 'GET', '/me/registrations', { expect: { status: 200 }, checks: [['waiting', "j.items[0].status === 'pending_approval'"]] }),
        own('The organiser sees four ready squads (NID booleans only)', 'GET', con('/tournaments/{{tournamentId}}/registrations?status=pending_approval'), { expect: { status: 200 }, checks: [['four ready', 'j.items.length === 4 && j.items.every((r) => r.roster.ready && r.roster.players[0].nidVerified)'], ['no personal data', '!/gender|dob|phone/i.test(JSON.stringify(j))']] }),
        own('Approve team 1', 'POST', con('/registrations/{{reg1}}/approve'), { expect: { status: 200 } }),
        own('Approve team 2', 'POST', con('/registrations/{{reg2}}/approve'), { expect: { status: 200 } }),
        own('Approve team 3', 'POST', con('/registrations/{{reg3}}/approve'), { expect: { status: 200 } }),
        own('Approve team 4', 'POST', con('/registrations/{{reg4}}/approve'), { expect: { status: 200 } }),
        own('Approve twice (expect 409)', 'POST', con('/registrations/{{reg1}}/approve'), { expect: { status: 409, code: 'REGISTRATION_STATE' } }),
        own('Overview: four approved, ৳72,000 held', 'GET', con('/tournaments/{{tournamentId}}/overview'), { expect: { status: 200 }, checks: [['kpis', 'j.kpis.approved === 4 && j.money.held === 7200000 && j.money.released === 0']] }),
        // Round B2: the registrations CSV for organisation admins (M19-FR-22/23 rules).
        own('Registrations as CSV (organisation admins)', 'GET', con('/tournaments/{{tournamentId}}/registrations.csv'), {
          expect: { status: 200 },
          checks: [
            ['a CSV download (Postman strips the byte-order mark; jest checks it)', "pm.response.headers.get('Content-Type').includes('text/csv') && pm.response.headers.get('Content-Disposition').includes('registrations')"],
            ['five registrations and the header', "pm.response.text().trim().split('\\r\\n').length === 6"],
            ['four approved with ready squads, the reserve team', "(pm.response.text().match(/\"approved\",\"\",/g) || []).length === 4 && pm.response.text().includes('\"reserve\",\"1\"')"],
            ['fees in taka', "pm.response.text().includes('\"18000.00\"')"],
            ['no phones or ids', '!/01[3-9]\\d{8}|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(pm.response.text())'],
          ],
        }),
        own('… with the roster: display names and NID verified yes/no', 'GET', con('/tournaments/{{tournamentId}}/registrations.csv?include=roster'), {
          expect: { status: 200 },
          checks: [
            ['player columns', "pm.response.text().includes('\"player\",\"nid_verified\"') && pm.response.text().includes('\"Rafi Ahmed\",\"yes\"')"],
            ['no phones or ids', '!/01[3-9]\\d{8}|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(pm.response.text())'],
          ],
        }),
        as('orgStaffToken')('Organisation staff cannot export (expect 404)', 'GET', con('/tournaments/{{tournamentId}}/registrations.csv'), { expect: { status: 404 } }),
        cap(1)('A captain cannot export (expect 404)', 'GET', con('/tournaments/{{tournamentId}}/registrations.csv'), { expect: { status: 404 } }),
        own('An unknown include (expect 422)', 'GET', con('/tournaments/{{tournamentId}}/registrations.csv?include=phones'), { expect: { status: 422, code: 'VALIDATION_FAILED' } }),
      ],
    },
    {
      name: '3. Draw and fixtures (FR-14 to FR-18)',
      item: [
        own('A draw before registration closes (expect 409)', 'POST', con('/tournaments/{{tournamentId}}/draw'), { body: { seeding: 'random' }, expect: { status: 409, code: 'REGISTRATION_STILL_OPEN' } }),
        own('Close registration', 'POST', con('/tournaments/{{tournamentId}}/registration/close'), { expect: { status: 200 }, checks: [['closed', "j.status === 'registration_closed'"]] }),
        cap(5)('The reserve team lapsed', 'GET', '/me/registrations', { expect: { status: 200 }, checks: [['lapsed', "j.items[0].status === 'lapsed'"]] }),
        own('Draw preview', 'POST', con('/tournaments/{{tournamentId}}/draw'), { body: { seeding: 'random' }, expect: { status: 200 }, checks: [['six matches', 'j.teams === 4 && j.matchCount === 6']] }),
        own('Confirm the random draw', 'POST', con('/tournaments/{{tournamentId}}/draw/confirm'), { body: { seeding: 'random' }, expect: { status: 200 }, checks: [['seed published', '/^[0-9a-f]{32}$/.test(j.draw.seed)']] }),
        own('Dry run with a schedule', 'POST', con('/tournaments/{{tournamentId}}/fixtures/generate'), {
          body: { dryRun: true, schedule: { weekdays: [5, 6], slots: ['17:00', '19:00'] } },
          expect: { status: 200 },
          checks: [['all placed', 'j.dryRun === true && j.matchCount === 6 && j.unscheduled.length === 0 && j.matches.every((m) => m.scheduledStart)']],
        }),
        own('Generate', 'POST', con('/tournaments/{{tournamentId}}/fixtures/generate'), { body: { schedule: { weekdays: [5, 6], slots: ['17:00', '19:00'] } }, expect: { status: 200 } }),
        own('Publish', 'POST', con('/tournaments/{{tournamentId}}/fixtures/publish'), {
          expect: { status: 200 },
          checks: [
            setVar('m1', 'j.fixtures.matches[0].id'),
            setVar('mv1', 'j.fixtures.matches[0].version'),
            setVar('m2', 'j.fixtures.matches[1].id'),
            setVar('m3', 'j.fixtures.matches[2].id'),
            setVar('m4', 'j.fixtures.matches[3].id'),
            setVar('m5', 'j.fixtures.matches[4].id'),
            setVar('m6', 'j.fixtures.matches[5].id'),
          ],
        }),
        control('captains are told', 'check', { checks: [['fixtures notice', 'j.fixturesNotices === 4']] }),
        own('A stale move (expect 409)', 'PATCH', con('/matches/{{m1}}'), { body: { court: 'Court 2', version: 999 }, expect: { status: 409, code: 'VERSION_CONFLICT' } }),
      ],
    },
    {
      name: '4. Results, money and the hub (FR-09, FR-16, FR-24, M15 lite)',
      item: [
        own('A result that does not fit the rules (expect 422)', 'PUT', con('/matches/{{m1}}/result'), { body: { sets: [[21, 20], [21, 15]] }, expect: { status: 422, code: 'RESULT_INVALID' } }),
        result(1),
        control('tranche 1 released', 'check', { checks: [['৳34,200', 'j.payable === 3420000']] }),
        own('The rules are locked (expect 409)', 'PATCH', con('/tournaments/{{tournamentId}}'), { body: { rules: { pW: 3 } }, expect: { status: 409, code: 'RULES_LOCKED' } }),
        own('Amend without a reason (expect 422)', 'POST', con('/matches/{{m1}}/result/amend'), { body: { sets: [[21, 11], [21, 13]] }, expect: { status: 422 } }),
        own('Amend with a reason', 'POST', con('/matches/{{m1}}/result/amend'), { body: { sets: [[21, 11], [21, 13]], reason: 'Points were typed wrong' }, expect: { status: 200 }, checks: [['version 2', 'j.result.version === 2']] }),
        req('The hub is live', 'GET', '/tournaments/{{slug}}', { as: false, expect: { status: 200 }, checks: [['live', "j.status === 'live' && j.rulesLockedAt !== null"]] }),
        result(2),
        result(3),
        result(4),
        result(5),
        result(6),
        control('the rest released', 'check', { checks: [['৳68,400', 'j.payable === 6840000']] }),
        req('The hub: completed with standings', 'GET', '/tournaments/{{slug}}', {
          as: false,
          expect: { status: 200 },
          checks: [['completed', "j.status === 'completed' && j.standings[0].rows.length === 4 && j.standings[0].rows.reduce((s, r) => s + r.played, 0) === 12"], ['no personal data', '!/gender|"dob"|phone/i.test(JSON.stringify(j))']],
        }),
        own('Overview money', 'GET', con('/tournaments/{{tournamentId}}/overview'), { expect: { status: 200 }, checks: [['all released', 'j.money.released === 7200000 && j.money.fees === 360000 && j.money.held === 0']] }),
        mod('Staff see it with its money', 'GET', '/admin/tournaments/{{tournamentId}}', { expect: { status: 200 }, checks: [['registrations', 'j.registrationList.length === 5 && j.money.collected === 7200000']] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
