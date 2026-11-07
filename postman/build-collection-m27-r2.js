'use strict';

/**
 * Builds postman/kriraghor-gym-ops-r2.postman_collection.json ("M27 round 2 · Members and engagement"):
 * check-out at the desk and by a second entrance scan, the live count; classes (weekly slots, sessions
 * ahead, a booking, the waitlist and its promotion, the desk booking, the reminder, attendance, a
 * cancelled session, the public timetable); reward points (a check-in, the rewards list, redeeming at the
 * desk, adjusting, a referral); notices to a segment (estimate, send, the daily cap); enquiries from the
 * gym page (the trap field, the phone kept encrypted, the audited reveal, the follow-up states); the
 * exercise library. node postman/build-collection-m27-r2.js
 *
 * Variables (set by the runner, postman/run-m27-r2.js): ownerToken (a Standard gym, published), gymId,
 * gymSlug, trainerToken + trainerUserId (staff with classes.manage, members.view), cashierToken (staff
 * with members.view, rewards.redeem), deskToken (staff with attendance.mark, members.view), limaToken +
 * limaId and rafiToken + rafiId (two linked members with a month's membership), friendId (a member who
 * has not paid yet, with friendDueId), tomorrow and dow (its day of the week), from and to (four weeks),
 * controlUrl (the runner: /drain, /visits-close, /soon, /reminders).
 * Unattended: `node postman/run-m27-r2.js`.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-gym-ops-r2.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  if (token) r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  // {{dow}} is a number: it goes into the raw body without quotes.
  if (r.request.body) r.request.body.raw = r.request.body.raw.replace(/"{{dow}}"/g, '{{dow}}');
  return r;
};
const owner = as('ownerToken');
const trainer = as('trainerToken');
const cashier = as('cashierToken');
const desk = as('deskToken');
const lima = as('limaToken');
const rafi = as('rafiToken');
const visitor = as(null);
const idem = (item, value = 'go2-{{$guid}}') => {
  item.request.header.push({ key: 'Idempotency-Key', value });
  return item;
};
const control = (name, step) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 } });
  const [pathname, qs] = step.split('?');
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [pathname], ...(qs ? { query: qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};
const G = '/manage/gyms/{{gymId}}';

const collection = {
  info: {
    name: 'Kriraghor API: M27 round 2 · Members and engagement',
    description: [
      'M27 Gym operations, round 2, on a published Standard gym. The desk checks a member in and out; a second entrance scan checks out once the minimum visit has passed (a scan at once is a repeat); open visits close on their own after the window. The live “in the gym now” count follows. Check-ins and check-outs go to the owner and staff with attendance.mark over Socket.IO (not tested here).',
      'Classes: a class with a trainer from the staff, places and a weekly slot; sessions are made weeks ahead. Lima books the only place, Rafi joins the waitlist; Lima cancels and Rafi is promoted and told. The desk books for anyone until the start. The reminder goes once before the class, members cannot cancel inside the cutoff, the trainer marks who came. Cancelling a session tells everyone booked. The gym page shows the timetable without member data.',
      'Reward points: a counted check-in earns points; the owner keeps the rewards list, a cashier with rewards.redeem redeems one at the desk (extra days on the membership), the owner adjusts with a note. A referral rewards the member who brought a friend once the friend pays. Notices: estimate the reach of a segment, send by the app, push and email (never SMS), up to the daily cap. Enquiries: the gym page form (a hidden trap field drops robots), the phone kept encrypted and shown by an audited reveal, new → contacted → joined.',
      'Requests named "Runner" go to the local test runner (delivering events, the visits job, moving a session close to its start, the reminder job).',
      'Unattended: `node postman/run-m27-r2.js`. Rebuild this file with: node postman/build-collection-m27-r2.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'ownerToken', 'trainerToken', 'trainerUserId', 'cashierToken', 'deskToken', 'limaToken', 'rafiToken', 'gymId', 'gymSlug',
    'limaId', 'rafiId', 'friendId', 'friendDueId', 'tomorrow', 'dow', 'from', 'to', 'attendanceId', 'entranceToken', 'classId', 'sessionId', 'laterId',
    'limaBooking', 'rafiBooking', 'daysReward', 'leadId',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. Permissions (M27-FR-34, FR-47, FR-62, FR-68)',
      item: [
        desk('Staff without notices.send (expect 403)', 'POST', `${G}/notices/estimate`, { body: { segment: { kind: 'active' } }, expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        desk('Staff without leads.manage (expect 403)', 'GET', `${G}/leads`, { expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        desk('Only the owner keeps the rewards list (expect 403)', 'PUT', `${G}/rewards`, { body: { rewards: [] }, expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        lima('A member is not staff (expect 404)', 'GET', `${G}/classes`, { expect: { status: 404 } }),
      ],
    },
    {
      name: '2. Check-out and the live count (M27-FR-40 to FR-45)',
      item: [
        desk('The desk checks Lima in', 'POST', `${G}/checkins`, { body: { memberId: '{{limaId}}' }, expect: { status: 201 }, save: { attendanceId: 'attendanceId' } }),
        desk('One in the gym now', 'GET', `${G}/checkins`, { expect: { status: 200 }, checks: [['counted 1, in the gym 1', 'j.counted === 1 && j.inGymNow === 1']] }),
        desk('The desk checks Lima out', 'POST', `${G}/checkins/{{attendanceId}}/out`, { expect: { status: 200 }, checks: [['by the desk, with a length', "j.method === 'desk' && typeof j.visitMinutes === 'number'"]] }),
        desk('Out twice (expect 409)', 'POST', `${G}/checkins/{{attendanceId}}/out`, { expect: { status: 409, code: 'GYM_VISIT_CLOSED' } }),
        desk('The day shows the visit closed', 'GET', `${G}/checkins`, { expect: { status: 200 }, checks: [['nobody in, out time kept', 'j.inGymNow === 0 && j.items[0].checkedOutAt !== null']] }),
        owner('The entrance QR token', 'GET', `${G}/entrance-token`, { expect: { status: 200 }, save: { entranceToken: 'token' } }),
        rafi('Rafi scans in at the entrance', 'POST', '/me/gym-checkins', { body: { token: '{{entranceToken}}' }, expect: { status: 201 }, checks: [['in, not out', 'j.checkedOut === false']] }),
        rafi('A second scan at once is a repeat, not a check-out', 'POST', '/me/gym-checkins', { body: { token: '{{entranceToken}}' }, expect: { status: 200 }, checks: [['not counted again', 'j.counted === false && j.checkedOut !== true']] }),
        owner('The dashboard tile', 'GET', `${G}/overview`, { expect: { status: 200 }, checks: [['Rafi is in', 'j.tiles.inGymNow === 1']] }),
        control('the visits job (nothing is stale yet)', 'visits-close'),
      ],
    },
    {
      name: '3. Classes (M27-FR-46 to FR-55)',
      item: [
        owner('The trainers to pick from', 'GET', `${G}/class-trainers`, { expect: { status: 200 }, checks: [['the trainer is there', "j.items.some((x) => x.userId === pm.variables.get('trainerUserId'))"]] }),
        owner('Morning HIIT: 1 place, 45 min, a weekly slot', 'POST', `${G}/classes`, {
          body: { name: 'Morning HIIT', trainerUserId: '{{trainerUserId}}', capacity: 1, minutes: 45, room: 'Studio', slots: [{ dow: '{{dow}}', startTime: '06:30' }] },
          expect: { status: 201 },
          save: { classId: 'id' },
          checks: [['the trainer and the slot', "j.trainer.displayName === 'Coach Tania' && j.slots.length === 1 && j.slots[0].startTime === '06:30'"]],
        }),
        owner('Sessions made ahead', 'GET', `${G}/class-sessions?from={{from}}&to={{to}}`, {
          expect: { status: 200 },
          checks: [
            ['three or more weeks', 'j.items.length >= 3'],
            ['tomorrow 06:30 Dhaka is 00:30 UTC, saves ids', "(() => { const t = pm.variables.get('tomorrow'); const s = j.items.find((x) => x.localDate === t); const l = j.items.find((x) => x.localDate > t); pm.collectionVariables.set('sessionId', s.id); pm.collectionVariables.set('laterId', l.id); return s.startsAt === `${t}T00:30:00.000Z` && s.spaces === 1; })()"],
          ],
        }),
        lima('Lima sees the timetable', 'GET', '/me/gym-classes?memberId={{limaId}}', { expect: { status: 200 }, checks: [['one place, not booked', "(() => { const s = j.items.find((x) => x.id === pm.variables.get('sessionId')); return s.spaces === 1 && s.myBooking === null; })()"]] }),
        idem(lima('Lima books the place', 'POST', '/me/gym-classes/{{sessionId}}/book', { body: { memberId: '{{limaId}}' }, expect: { status: 201 }, save: { limaBooking: 'id' }, checks: [['booked', "j.status === 'booked'"]] })),
        idem(lima('Twice (expect 409)', 'POST', '/me/gym-classes/{{sessionId}}/book', { body: { memberId: '{{limaId}}' }, expect: { status: 409, code: 'GYM_CLASS_BOOKED' } })),
        idem(rafi('Rafi: full, so the waitlist', 'POST', '/me/gym-classes/{{sessionId}}/book', { body: { memberId: '{{rafiId}}' }, expect: { status: 201 }, save: { rafiBooking: 'id' }, checks: [['waitlisted', "j.status === 'waitlisted'"]] })),
        idem(rafi('Booking as someone else (expect 404)', 'POST', '/me/gym-classes/{{sessionId}}/book', { body: { memberId: '{{limaId}}' }, expect: { status: 404 } })),
        lima('Lima cancels', 'POST', '/me/gym-bookings/{{limaBooking}}/cancel', { expect: { status: 200 }, checks: [['cancelled', "j.status === 'cancelled'"]] }),
        rafi('Rafi is promoted', 'GET', '/me/gym-bookings?memberId={{rafiId}}', { expect: { status: 200 }, checks: [['booked, promoted', "j.items[0].status === 'booked' && j.items[0].promoted === true"]] }),
        idem(trainer('The trainer books Lima again: the waitlist', 'POST', `${G}/class-sessions/{{sessionId}}/bookings`, { body: { memberId: '{{limaId}}' }, expect: { status: 201 }, checks: [['waitlisted', "j.status === 'waitlisted'"]] })),
        control('the session starts in 30 minutes', 'soon?sessionId={{sessionId}}&minutes=30'),
        control('the reminder job: once', 'reminders'),
        rafi('Inside the cutoff a member cannot cancel (expect 409)', 'POST', '/me/gym-bookings/{{rafiBooking}}/cancel', { expect: { status: 409, code: 'GYM_CLASS_CANCEL_CLOSED' } }),
        control('the session started 10 minutes ago', 'soon?sessionId={{sessionId}}&minutes=-10'),
        trainer('The trainer marks who came', 'POST', `${G}/class-sessions/{{sessionId}}/attendance`, { body: { attended: ['{{rafiId}}'] }, expect: { status: 200 }, checks: [['done, Rafi came', "j.status === 'done' && j.bookings.find((b) => b.member.id === pm.variables.get('rafiId')).status === 'attended'"]] }),
        idem(lima('Lima books a later session', 'POST', '/me/gym-classes/{{laterId}}/book', { body: { memberId: '{{limaId}}' }, expect: { status: 201 } })),
        owner('The owner cancels it with a reason', 'POST', `${G}/class-sessions/{{laterId}}/cancel`, { body: { reason: 'Trainer is ill' }, expect: { status: 200 }, checks: [['cancelled', "j.status === 'cancelled'"]] }),
        owner('Yoga: 20 places at 18:00', 'POST', `${G}/classes`, { body: { name: 'Yoga', capacity: 20, minutes: 60, slots: [{ dow: '{{dow}}', startTime: '18:00' }] }, expect: { status: 201 } }),
        visitor('The gym page timetable, no member data', 'GET', '/gym/gyms/{{gymSlug}}/timetable', { expect: { status: 200 }, checks: [['Yoga with 20 places, enquiries on', "j.enquiries === true && j.items.some((x) => x.name === 'Yoga' && x.spaces === 20) && !JSON.stringify(j).includes('Lima')"]] }),
        owner('Retire Morning HIIT', 'PATCH', `${G}/classes/{{classId}}`, { body: { status: 'retired' }, expect: { status: 200 } }),
      ],
    },
    {
      name: '4. Reward points (M27-FR-56 to FR-61)',
      item: [
        control('deliver events (the check-ins earn points)', 'drain'),
        cashier('Lima has points for her check-in', 'GET', `${G}/members/{{limaId}}/points`, { expect: { status: 200 }, checks: [['10 for a visit', "j.balance === 10 && j.history.some((x) => x.kind === 'checkin' && x.points === 10)"]] }),
        owner('The rewards list', 'PUT', `${G}/rewards`, {
          body: { rewards: [{ title: '3 extra days', points: 10, kind: 'days', value: 3 }, { title: '৳200 off', points: 300, kind: 'discount', value: 20000 }] },
          expect: { status: 200 },
          checks: [['two, saves the days reward', "(pm.collectionVariables.set('daysReward', j.items.find((x) => x.kind === 'days').id), j.items.length === 2)"]],
        }),
        idem(cashier('The cashier redeems 3 extra days', 'POST', `${G}/members/{{limaId}}/redeem`, { body: { rewardId: '{{daysReward}}' }, expect: { status: 201 }, checks: [['0 left, 3 days on', "j.balance === 0 && j.applied.kind === 'days' && j.applied.days === 3"]] })),
        idem(cashier('Again with no points (expect 409)', 'POST', `${G}/members/{{limaId}}/redeem`, { body: { rewardId: '{{daysReward}}' }, expect: { status: 409, code: 'GYM_POINTS_SHORT' } })),
        owner('The owner adds 50 with a note', 'POST', `${G}/members/{{limaId}}/points/adjust`, { body: { points: 50, note: 'Welcome gift' }, expect: { status: 200 } }),
        owner('Lima brought a friend', 'POST', `${G}/members/{{friendId}}/referral`, { body: { referrerMemberId: '{{limaId}}' }, expect: { status: 200 } }),
        owner('A second referrer (expect 409)', 'POST', `${G}/members/{{friendId}}/referral`, { body: { referrerMemberId: '{{rafiId}}' }, expect: { status: 409, code: 'GYM_REFERRAL_EXISTS' } }),
        idem(owner('The friend pays ৳1,000 cash', 'POST', `${G}/dues/{{friendDueId}}/payments`, { body: { amountPoisha: 100000, method: 'cash' }, expect: { status: 201 } })),
        control('deliver events (the referral reward)', 'drain'),
        lima('Lima sees her points', 'GET', '/me/gym-points?memberId={{limaId}}', { expect: { status: 200 }, checks: [['50 + 200 for the referral', "j.on === true && j.balance === 250 && j.earn.perCheckin === 10"]] }),
        lima('Not someone else’s (expect 404)', 'GET', '/me/gym-points?memberId={{rafiId}}', { expect: { status: 404 } }),
      ],
    },
    {
      name: '5. Notices (M27-FR-62 to FR-65)',
      item: [
        owner('Who a notice to all active reaches', 'POST', `${G}/notices/estimate`, { body: { segment: { kind: 'active' } }, expect: { status: 200 }, checks: [['by the app, cap 3', 'j.reach.app >= 2 && j.sentToday === 0 && j.dailyCap === 3']] }),
        owner('Expired 0 days ago (expect 422)', 'POST', `${G}/notices/estimate`, { body: { segment: { kind: 'expired', days: 0 } }, expect: { status: 422, code: 'GYM_NOTICE_SEGMENT' } }),
        idem(owner('Send: closed on Friday', 'POST', `${G}/notices`, { body: { title: 'Closed on Friday', body: 'The gym is closed this Friday for cleaning.', segment: { kind: 'active' } }, expect: { status: 201 }, checks: [['app and push (email when a member has one); never SMS', "j.targetCount >= 2 && j.channels.includes('in_app') && j.channels.includes('push') && !j.channels.includes('sms')"]] })),
        idem(owner('Two', 'POST', `${G}/notices`, { body: { title: 'Two', body: 'Second notice.', segment: { kind: 'active' } }, expect: { status: 201 } })),
        idem(owner('Three', 'POST', `${G}/notices`, { body: { title: 'Three', body: 'Third notice.', segment: { kind: 'active' } }, expect: { status: 201 } })),
        idem(owner('A fourth today (expect 429)', 'POST', `${G}/notices`, { body: { title: 'Four', body: 'One too many.', segment: { kind: 'active' } }, expect: { status: 429, code: 'GYM_NOTICE_CAP' } })),
        control('deliver events (the notices)', 'drain'),
        lima('Lima has the notice in the app', 'GET', '/me/notifications', { expect: { status: 200 }, checks: [['GYM_NOTICE', "JSON.stringify(j).includes('Closed on Friday')"]] }),
      ],
    },
    {
      name: '6. Enquiries and the exercise library (M27-FR-66 to FR-71)',
      item: [
        visitor('A robot fills the hidden field: accepted, dropped', 'POST', '/gym/gyms/{{gymSlug}}/enquiries', { body: { name: 'Robot', phone: '01711000999', website: 'http://spam.example' }, expect: { status: 202 } }),
        visitor('Nadia asks about the ladies batch', 'POST', '/gym/gyms/{{gymSlug}}/enquiries', { body: { name: 'Nadia', phone: '01711000111', message: 'Ladies batch?', bestTime: 'Evening' }, expect: { status: 202 } }),
        owner('One new enquiry, the phone masked', 'GET', `${G}/leads`, {
          expect: { status: 200 },
          save: { leadId: 'items.0.id' },
          checks: [['one new, last 4 only', "j.counts.new === 1 && j.items[0].phoneLast4 === '0111' && !JSON.stringify(j).includes('01711000111')"]],
        }),
        owner('Reveal the number (audited, no-store)', 'POST', `${G}/leads/{{leadId}}/reveal-phone`, { expect: { status: 200 }, checks: [['E.164', "j.phone === '+8801711000111'"], ['no-store', "pm.response.headers.get('Cache-Control') === 'no-store'"]] }),
        owner('Contacted, with a note', 'PATCH', `${G}/leads/{{leadId}}`, { body: { status: 'contacted', note: 'Called, coming Saturday' }, expect: { status: 200 } }),
        owner('Joined without a member (expect 422)', 'PATCH', `${G}/leads/{{leadId}}`, { body: { status: 'joined' }, expect: { status: 422, code: 'GYM_MEMBER_UNKNOWN' } }),
        owner('Joined as the friend', 'PATCH', `${G}/leads/{{leadId}}`, { body: { status: 'joined', memberId: '{{friendId}}' }, expect: { status: 200 }, checks: [['joined', "j.status === 'joined'"]] }),
        owner('Lost after joined (expect 409)', 'PATCH', `${G}/leads/{{leadId}}`, { body: { status: 'lost' }, expect: { status: 409, code: 'GYM_LEAD_STATE' } }),
        visitor('The exercise library', 'GET', '/catalog/exercises', { expect: { status: 200 }, checks: [['60 or more, EN and BN with steps', "j.items.length >= 60 && j.items.find((x) => x.key === 'push_up').nameBn === 'পুশ-আপ' && j.items[0].stepsEn.length > 0"]] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${collection.item.reduce((n, f) => n + f.item.length, 0)} requests)`);
