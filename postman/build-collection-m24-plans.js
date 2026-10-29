'use strict';

/**
 * Builds postman/kriraghor-gym-manage-plans.postman_collection.json ("M24 prompt 3 · Public and
 * plans"): the directory by distance and monthly price and the landing page's founding offer; join
 * requests from a live gym's page, the gym's answer with a membership and the first payment (the
 * referral fee), a decline and a cancel; trainers; workout plans and diet charts (checks, versions, the
 * assign scope, the member's day, ticks and their window, who sees what, retire, end); the entrance QR
 * check-in. node postman/build-collection-m24-plans.js
 *
 * Variables (set by the runner, postman/run-m24-plans.js): ownerToken (a gym owner with a live,
 * Standard gym, short code IY, at Gulshan's pin), gymId, slug, monthPackageId, bashirId (a desk member),
 * personToken (Ayesha, who asks to join), person2Token (Rafiq: declined, then a stranger at the door),
 * person3Token (Nadia: joins with no membership), trainerToken (staff with members.trainer and
 * plans.manage), cashierToken and cashierBm (staff with members.view and fees.collect, and their team id), adminAccessToken (master A),
 * today, startsOn (10 days ago), day7 and day8 (7 and 8 days ago), lat and lng (a position in Banani),
 * controlUrl (the runner: /drain, /old-entrance-token, /daily). Unattended: `node postman/run-m24-plans.js`.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-gym-manage-plans.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('ownerToken');
const person = as('personToken');
const person2 = as('person2Token');
const person3 = as('person3Token');
const trainer = as('trainerToken');
const cashier = as('cashierToken');
const idem = (item, value = 'pl-{{$guid}}') => {
  item.request.header.push({ key: 'Idempotency-Key', value });
  return item;
};
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  const [p, qs] = step.split('?');
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [p], ...(qs ? { query: qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
const G = '/manage/gyms/{{gymId}}';
const PHONE = /(\+?880|"0)1[3-9]\d{8}/.source;
const noPhone = ['no full phone numbers', `!new RegExp(${JSON.stringify(PHONE)}).test(pm.response.text())`];

const WORKOUT = {
  kind: 'workout',
  days: [
    {
      key: 'd1',
      name: { en: 'Chest and triceps', bn: 'বুক ও ট্রাইসেপস' },
      items: [
        { ref: 'i1', name: { en: 'Bench press', bn: 'বেঞ্চ প্রেস' }, sets: 4, reps: '8-10', restSec: 90, weightNote: '70% of max', videoUrl: 'https://example.com/v' },
        { ref: 'i2', name: { en: 'Dips' }, sets: 3, reps: '12' },
      ],
    },
    { key: 'd2', name: { en: 'Legs', bn: 'পা' }, items: [{ ref: 'i3', name: { en: 'Squat' }, sets: 5, reps: '5' }] },
  ],
};
const WORKOUT_V2 = { ...WORKOUT, days: [WORKOUT.days[0], { ...WORKOUT.days[1], items: [{ ref: 'i3', name: { en: 'Front squat' }, sets: 4, reps: '6' }] }] };
const DIET = {
  kind: 'diet',
  meals: [{ ref: 'm1', name: { en: 'Breakfast', bn: 'সকালের নাস্তা' }, time: '08:00', items: [{ ref: 'f1', name: { en: 'Two eggs', bn: 'দুটি ডিম' }, portion: '2 pcs', kcal: 140, proteinG: 12 }] }],
  notes: { en: '3 litres of water a day', bn: 'দিনে ৩ লিটার পানি' },
};

const collection = {
  info: {
    name: 'Kriraghor API: M24 prompt 3 · Public and plans',
    description: [
      'M24 Gym management, prompt 3. The gym directory sorts by distance from a position sent with the query (a gym without a pin uses its area’s centre) and caps the monthly price; the landing page reads the tiers and the founding partner offer.',
      'Ayesha asks to join a live gym from its page; the gym sees her name and the last 4 digits of her phone, accepts with the monthly package and a first cash payment (the ৳200 referral fee charges once); Rafiq is declined; Nadia joins with no membership. Staff to-dos and notices follow.',
      'The owner gives Bashir a trainer; the trainer may give plans only to their members. A workout plan and a diet chart are written (content checked, https links only, source gym), assigned, edited into version 2 for the members who have it; Ayesha sees today’s workout day and meals, ticks items for today and 7 days back (8 days back is refused). A cashier sees only titles; the owner sees ticks, notes and the health note.',
      'The entrance tablet shows a rotating QR; Ayesha scans it (counted, then a repeat); an old code, a stranger and a blocked newcomer are refused.',
      'Requests named "Runner" go to the local test runner (draining events, an old entrance token, the daily job).',
      'Unattended: `node postman/run-m24-plans.js`. Rebuild this file with: node postman/build-collection-m24-plans.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'ownerToken', 'personToken', 'person2Token', 'person3Token', 'trainerToken', 'cashierToken', 'adminAccessToken', 'gymId', 'slug', 'monthPackageId', 'bashirId',
    'today', 'startsOn', 'day7', 'day8', 'lat', 'lng',
    'requestId', 'request2Id', 'request3Id', 'request4Id', 'memberId', 'dueId', 'coachBm', 'cashierBm', 'planId', 'chartId', 'assignmentId', 'bashirAssignmentId', 'entranceToken', 'oldToken',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. The directory and the landing page (§4.1)',
      item: [
        req('Nearest first from a position in Banani', 'GET', '/gym/gyms?lat={{lat}}&lng={{lng}}', { as: false, expect: { status: 200 }, checks: [['distances on every card, in order', 'j.items.length === 2 && j.items.every((x) => typeof x.distanceM === "number") && j.items[0].distanceM <= j.items[1].distanceM']] }),
        req('Within 5 km', 'GET', '/gym/gyms?lat={{lat}}&lng={{lng}}&radiusKm=5', { as: false, expect: { status: 200 }, checks: [['the Banani gym only', "j.items.length === 1 && j.items[0].id === pm.variables.get('gymId')"]] }),
        req('Monthly at most ৳3,500', 'GET', '/gym/gyms?priceMax=350000', { as: false, expect: { status: 200 }, checks: [['the cheaper gym', "j.items.length === 1 && j.items[0].id !== pm.variables.get('gymId') && j.items[0].distanceM === null"]] }),
        req('Nearest without a position (expect 422)', 'GET', '/gym/gyms?sort=nearest', { as: false, expect: { status: 422, code: 'VALIDATION_FAILED' } }),
        req('The gym page: Join this gym shows', 'GET', '/gym/gyms/{{slug}}', { as: false, expect: { status: 200 }, checks: [['joinRequestsOpen', 'j.joinRequestsOpen === true']] }),
        req('Pricing with the founding offer', 'GET', '/gym-manage/pricing', { as: false, expect: { status: 200 }, checks: [['tiers, 20 places, 2 free months, 25% for 12 months', 'j.tiers.length === 4 && j.foundingPlacesLeft === 20 && j.founding.freeMonths === 2 && j.founding.discountPct === 25 && j.founding.discountMonths === 12']] }),
      ],
    },
    {
      name: '2. Join requests (FR-16, FR-17, FR-91, FR-92)',
      item: [
        person('Ask to join with the monthly package and a note', 'POST', '/me/gym-join-requests', { body: { gymId: '{{gymId}}', packageId: '{{monthPackageId}}', note: 'Evenings after 6' }, expect: { status: 201 }, save: { requestId: 'request.id' }, checks: [['pending, mine to cancel', "j.request.direction === 'join_request' && j.request.status === 'pending' && j.request.canCancel === true && j.request.package.kind === 'month'"]] }),
        person('Asking again (expect 409)', 'POST', '/me/gym-join-requests', { body: { gymId: '{{gymId}}' }, expect: { status: 409, code: 'GYM_LINK_REQUEST_PENDING' } }),
        owner('The owner asking their own gym (expect 409)', 'POST', '/me/gym-join-requests', { body: { gymId: '{{gymId}}' }, expect: { status: 409, code: 'GYM_JOIN_NOT_OPEN' }, checks: [['own gym', "j.reason === 'own_gym'"]] }),
        person('My requests: the join request', 'GET', '/me/gym-requests?direction=join_request', { expect: { status: 200 }, checks: [['one', "j.items.length === 1 && j.items[0].id === pm.variables.get('requestId')"]] }),
        person('Accepting my own join request as if it were an invite (expect 404)', 'POST', '/me/gym-requests/{{requestId}}/accept', { expect: { status: 404 } }),
        control('deliver events', 'drain'),
        owner('The gym’s requests: who asks, the package, the note', 'GET', `${G}/requests?direction=join_request`, { expect: { status: 200 }, checks: [['name and last 4 digits only', "j.items[0].requester.displayName === 'Ayesha Rahman' && /^\\d{4}$/.test(j.items[0].requester.phoneLast4) && j.items[0].package.pricePoisha === 450000 && j.items[0].note === 'Evenings after 6'"], noPhone] }),
        owner('The dashboard counts it', 'GET', `${G}/overview`, { expect: { status: 200 }, checks: [['one waiting', 'j.tiles.requestsWaiting === 1']] }),
        idem(cashier('A cashier cannot answer (expect 403)', 'POST', `${G}/requests/{{requestId}}/accept`, { body: {}, expect: { status: 403, code: 'PERMISSION_REQUIRED' }, checks: [['members.edit', "j.permission === 'members.edit'"]] })),
        owner('Accept without an Idempotency-Key (expect 400)', 'POST', `${G}/requests/{{requestId}}/accept`, { body: {}, expect: { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' } }),
        idem(owner('Accept with the monthly package and ৳2,000 cash', 'POST', `${G}/requests/{{requestId}}/accept`, {
          body: { packageId: '{{monthPackageId}}', startsOn: '{{today}}', payment: { amountPoisha: 200000, method: 'cash' } },
          expect: { status: 200 },
          save: { memberId: 'member.id', dueId: 'due.id' },
          checks: [['a new platform member, linked, with a membership and a receipt', "j.linkedExisting === false && j.member.source === 'platform' && j.member.linked === true && j.request.status === 'accepted' && j.membership.packageKind === 'month' && j.payment.amountPoisha === 200000"], noPhone],
        })),
        idem(owner('Accept it again (expect 409)', 'POST', `${G}/requests/{{requestId}}/accept`, { body: {}, expect: { status: 409, code: 'GYM_LINK_REQUEST_STATE' } })),
        person('My gyms: linked, no plans yet', 'GET', '/me/gym-memberships', { expect: { status: 200 }, checks: [['linked', "j.items.length === 1 && j.items[0].linked === true && j.items[0].memberId === pm.variables.get('memberId') && j.items[0].plans.length === 0"]] }),
        person2('Rafiq asks to join', 'POST', '/me/gym-join-requests', { body: { gymId: '{{gymId}}' }, expect: { status: 201 }, save: { request2Id: 'request.id' } }),
        owner('Decline it', 'POST', `${G}/requests/{{request2Id}}/decline`, { body: { reason: 'Full this month' }, expect: { status: 200 }, checks: [['declined', "j.request.status === 'declined'"]] }),
        person2('Rafiq asks again and cancels', 'POST', '/me/gym-join-requests', { body: { gymId: '{{gymId}}' }, expect: { status: 201 }, save: { request3Id: 'request.id' } }),
        person2('Cancel my request', 'POST', '/me/gym-requests/{{request3Id}}/cancel', { expect: { status: 200 }, checks: [['cancelled', "j.request.status === 'cancelled'"]] }),
        person2('Cancel it again (expect 409)', 'POST', '/me/gym-requests/{{request3Id}}/cancel', { expect: { status: 409, code: 'GYM_LINK_REQUEST_STATE' } }),
        person3('Nadia asks to join', 'POST', '/me/gym-join-requests', { body: { gymId: '{{gymId}}' }, expect: { status: 201 }, save: { request4Id: 'request.id' } }),
        idem(owner('Accept Nadia without a membership', 'POST', `${G}/requests/{{request4Id}}/accept`, { body: {}, expect: { status: 200 }, checks: [['linked, no membership', 'j.member.linked === true && j.membership === null']] })),
      ],
    },
    {
      name: '3. Trainers (FR-21, FR-23)',
      item: [
        owner('Who can be picked', 'GET', `${G}/trainers`, { expect: { status: 200 }, checks: [['the coach only', "j.items.length === 1 && j.items[0].displayName === 'Coach Sabbir' && j.items[0].permissions.includes('plans.manage')"], setVar('coachBm', 'j.items[0].businessMemberId')] }),
        owner('A cashier is not a trainer (expect 422)', 'PUT', `${G}/members/{{bashirId}}/trainer`, { body: { businessMemberId: '{{cashierBm}}' }, expect: { status: 422, code: 'GYM_TRAINER_INVALID' } }),
        owner('Give Bashir the coach', 'PUT', `${G}/members/{{bashirId}}/trainer`, { body: { businessMemberId: '{{coachBm}}' }, expect: { status: 200 }, checks: [['the trainer on the profile', "j.member.trainer.displayName === 'Coach Sabbir' && j.can.assignTrainer === true"]] }),
        owner('Members of the coach', 'GET', `${G}/members?trainerId={{coachBm}}`, { expect: { status: 200 }, checks: [['Bashir only', "j.items.length === 1 && j.items[0].id === pm.variables.get('bashirId') && j.items[0].trainer.businessMemberId === pm.variables.get('coachBm')"]] }),
        trainer('The coach sees only their members', 'GET', `${G}/members`, { expect: { status: 200 }, checks: [['Bashir only', "j.items.length === 1 && j.items[0].id === pm.variables.get('bashirId')"]] }),
      ],
    },
    {
      name: '4. Plans and diet charts (FR-62 to FR-69)',
      item: [
        owner('Invalid content: a javascript: link, source ai, an empty name (expect 422)', 'POST', `${G}/plans`, {
          body: { kind: 'workout', title: 'Push', source: 'ai', content: { kind: 'workout', days: [{ key: 'd1', name: {}, items: [{ ref: 'i1', name: { en: 'A' }, videoUrl: 'javascript:alert(1)' }] }] } },
          expect: { status: 422, code: 'VALIDATION_FAILED' },
          checks: [['paths named', "['source', 'content.days.0.name', 'content.days.0.items.0.videoUrl'].every((f) => j.errors.some((e) => e.field === f))"]],
        }),
        owner('Write a workout plan (a template)', 'POST', `${G}/plans`, { body: { kind: 'workout', title: 'Push and legs', isTemplate: true, content: WORKOUT }, expect: { status: 201 }, save: { planId: 'id' }, checks: [['version 1', "j.currentVersion === 1 && j.source === 'gym' && j.isTemplate === true && j.versions.length === 1"]] }),
        owner('Write a diet chart', 'POST', `${G}/plans`, { body: { kind: 'diet', title: 'Lean bulk', content: DIET }, expect: { status: 201 }, save: { chartId: 'id' } }),
        owner('Templates', 'GET', `${G}/plans?template=true`, { expect: { status: 200 }, checks: [['the workout plan', "j.items.length === 1 && j.items[0].id === pm.variables.get('planId')"]] }),
        trainer('The coach gives it to Ayesha, who is not theirs (expect 403)', 'POST', `${G}/plans/{{planId}}/assign`, { body: { memberIds: ['{{memberId}}'], startsOn: '{{startsOn}}' }, expect: { status: 403, code: 'GYM_PLAN_ASSIGN_SCOPE' } }),
        trainer('The coach gives it to Bashir', 'POST', `${G}/plans/{{planId}}/assign`, { body: { memberIds: ['{{bashirId}}'], startsOn: '{{startsOn}}' }, expect: { status: 201 }, save: { bashirAssignmentId: 'assignments.0.id' } }),
        owner('The owner gives it to Ayesha from 10 days ago', 'POST', `${G}/plans/{{planId}}/assign`, { body: { memberIds: ['{{memberId}}'], startsOn: '{{startsOn}}' }, expect: { status: 201 }, save: { assignmentId: 'assignments.0.id' }, checks: [['version 1', "j.replaced === 0 && j.assignments[0].version === 1 && j.assignments[0].status === 'active'"]] }),
        owner('And the diet chart', 'POST', `${G}/plans/{{chartId}}/assign`, { body: { memberIds: ['{{memberId}}'], startsOn: '{{startsOn}}' }, expect: { status: 201 } }),
        control('deliver events', 'drain'),
        person('My plans: today’s workout day and meals, the week, the safety line', 'GET', '/me/gym-plans', {
          expect: { status: 200 },
          checks: [['day 0 of 2 (10 days in), diet today', "j.items.length === 2 && j.items.find((x) => x.kind === 'workout').todayIndex === 0 && j.items.find((x) => x.kind === 'workout').week.length === 7 && j.items.find((x) => x.kind === 'diet').todayIndex === 0 && j.items[0].safety.en.endsWith('not medical advice')"]],
        }),
        person('Tick the bench press done today', 'POST', '/me/gym-plans/{{assignmentId}}/logs', { body: { localDate: '{{today}}', itemRef: 'i1', done: true }, expect: { status: 201 } }),
        person('Untick it with a note (the latest wins)', 'POST', '/me/gym-plans/{{assignmentId}}/logs', { body: { localDate: '{{today}}', itemRef: 'i1', done: false, note: 'Shoulder hurt' }, expect: { status: 201 } }),
        person('An item of another day (expect 422)', 'POST', '/me/gym-plans/{{assignmentId}}/logs', { body: { localDate: '{{today}}', itemRef: 'i3', done: true }, expect: { status: 422, code: 'VALIDATION_FAILED' } }),
        person('7 days back', 'POST', '/me/gym-plans/{{assignmentId}}/logs', { body: { localDate: '{{day7}}', itemRef: 'i3', done: true }, expect: { status: 201 } }),
        person('8 days back (expect 422)', 'POST', '/me/gym-plans/{{assignmentId}}/logs', { body: { localDate: '{{day8}}', itemRef: 'i1', done: true }, expect: { status: 422, code: 'GYM_PLAN_LOG_WINDOW' } }),
        owner('Version 2 for the members who have it', 'PATCH', `${G}/plans/{{planId}}`, { body: { title: 'Push and legs v2', content: WORKOUT_V2 }, expect: { status: 200 }, checks: [['moved both', 'j.currentVersion === 2 && j.movedAssignments === 2']] }),
        person('My plan: version 2, the versions given, my ticks', 'GET', '/me/gym-plans/{{assignmentId}}', { expect: { status: 200 }, checks: [['v2, v1', "j.version === 2 && j.versions.length === 2 && j.logs.length === 2 && j.logs.some((l) => l.itemRef === 'i1' && l.done === false && l.note === 'Shoulder hurt')"]] }),
        person('My health note', 'PUT', '/me/gym-memberships/{{memberId}}/health-note', { body: { text: 'Asthma' }, expect: { status: 200 } }),
        owner('The owner: content, ticks and the health note', 'GET', `${G}/members/{{memberId}}/plans`, { expect: { status: 200 }, checks: [['full', "j.healthNote === 'Asthma' && j.items.some((x) => x.kind === 'workout' && x.logs.length === 2 && x.content.kind === 'workout')"]] }),
        cashier('A cashier: titles only', 'GET', `${G}/members/{{memberId}}/plans`, { expect: { status: 200 }, checks: [['no content, ticks or health note', "!('healthNote' in j) && j.items.every((x) => !('content' in x) && !('logs' in x))"]] }),
        cashier('A cashier cannot list plans (expect 403)', 'GET', `${G}/plans`, { expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        owner('The plan page with adherence', 'GET', `${G}/plans/{{planId}}`, { expect: { status: 200 }, checks: [['two assigned', "j.activeAssignments === 2 && j.versions.length === 2 && j.assignments.some((x) => x.memberId === pm.variables.get('memberId') && x.lastTickOn === pm.variables.get('today'))"]] }),
        trainer('The coach ends Bashir’s plan', 'POST', `${G}/plan-assignments/{{bashirAssignmentId}}/end`, { expect: { status: 200 }, checks: [['ended', "j.assignment.status === 'ended'"]] }),
        owner('Retire the diet chart', 'POST', `${G}/plans/{{chartId}}/retire`, { expect: { status: 200 }, checks: [['retired', "j.status === 'retired'"]] }),
        owner('Assigning a retired chart (expect 409)', 'POST', `${G}/plans/{{chartId}}/assign`, { body: { memberIds: ['{{bashirId}}'], startsOn: '{{today}}' }, expect: { status: 409, code: 'GYM_PLAN_STATE' } }),
        control('the daily job twice', 'daily', { checks: [['nothing past its end date', 'j.first.plansEnded === 0 && j.second.plansEnded === 0']] }),
        person('My gyms list today’s plan titles', 'GET', '/me/gym-memberships', { expect: { status: 200 }, checks: [['two titles', 'j.items[0].plans.length === 2']] }),
      ],
    },
    {
      name: '5. The entrance QR (FR-51)',
      item: [
        owner('The tablet’s code (no-store)', 'GET', `${G}/entrance-token`, { expect: { status: 200 }, save: { entranceToken: 'token' }, checks: [['v1.ge., 30 s, no-store', "j.token.startsWith('v1.ge.') && j.seconds === 30 && pm.response.headers.get('Cache-Control') === 'no-store'"]] }),
        cashier('A cashier without attendance.mark (expect 403)', 'GET', `${G}/entrance-token`, { expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        person('Ayesha scans it', 'POST', '/me/gym-checkins', { body: { token: '{{entranceToken}}' }, expect: { status: 201 }, checks: [['counted, allowed', "j.counted === true && j.method === 'entrance_qr' && j.decision === 'allow' && j.membership.status === 'active'"]] }),
        person('And again', 'POST', '/me/gym-checkins', { body: { token: '{{entranceToken}}' }, expect: { status: 200 }, checks: [['a repeat', 'j.counted === false && j.firstCheckInToday !== null']] }),
        control('a code from two windows ago', 'old-entrance-token', { save: { oldToken: 'token' } }),
        person('A photo of an old code (expect 422)', 'POST', '/me/gym-checkins', { body: { token: '{{oldToken}}' }, expect: { status: 422, code: 'GYM_CHECKIN_TOKEN_INVALID' } }),
        person2('Someone not linked to the gym (expect 403)', 'POST', '/me/gym-checkins', { body: { token: '{{entranceToken}}' }, expect: { status: 403, code: 'GYM_NOT_A_MEMBER' } }),
        owner('Entry policy: block', 'PATCH', `${G}/settings`, { body: { entryPolicy: 'block' }, expect: { status: 200 } }),
        person3('Nadia, with no membership, is blocked with the gym’s message (expect 409)', 'POST', '/me/gym-checkins', { body: { token: '{{entranceToken}}' }, expect: { status: 409, code: 'GYM_ENTRY_BLOCKED' }, checks: [['no override', "j.canOverride === false && j.reasons[0] === 'none' && j.detail.includes('front desk')"]] }),
        owner('Today’s check-ins', 'GET', `${G}/checkins`, { expect: { status: 200 }, checks: [['one counted at the entrance', "j.counted === 1 && j.items.every((x) => x.method === 'entrance_qr')"]] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${collection.item.reduce((n, f) => n + f.item.length, 0)} requests)`);
