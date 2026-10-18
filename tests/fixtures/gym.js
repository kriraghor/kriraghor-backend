'use strict';

/**
 * M20 test fixtures (jest and the Postman runner): a gym owner onboarded through M02 (the ground
 * owner's documents, kept under gym_owner), a live gym reviewed on the Moderation desk (open all day
 * by default, so an admission never depends on the clock), a fitness trainer with a live M11 profile,
 * and helpers that move trainer months in time.
 */
const h = require('../helpers');
const f = require('./market');
const x = require('./hire');
const { subjectIdFor } = require('../../src/modules/kyc/kyc.moderation');
const rules = require('../../src/modules/gym/gym.rules');

const { api, P, models } = h;
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, openTime: '00:00', closeTime: '24:00', womenOnly: false }));
/** The design's Iron Yard: day ৳400, month ৳4,500, quarter ৳12,000. */
const IRON_YARD = [
  { kind: 'day', title: 'Day pass', price: 40000 },
  { kind: 'month', title: 'Monthly', price: 450000 },
  { kind: 'quarter', title: 'Quarterly', price: 1200000 },
];

/** A member who applied for gym_owner and whose trade licence and lease were approved (role active). */
async function gymOwner(docsReviewer, name = 'Iron Yard Fitness') {
  const m = await h.signupUser({ name });
  await h.verifyMember(m.user.id);
  await f.refresh(m);
  await api().post(`${P}/me/roles`).set(h.bearer(m)).send({ role: 'gym_owner' }).expect(201);
  await f.refresh(m);
  await f.sendDoc(m, 'trade_license', { number: `TL-${f.uniq('g')}`.slice(0, 40), holderName: name, expiresOn: f.future(300) });
  await f.sendDoc(m, 'deed_or_lease', { kind: 'lease', expiresOn: f.future(700) });
  await h.drainEvents();
  for (const t of ['trade_license', 'deed_or_lease']) await f.review(docsReviewer, 'document', subjectIdFor(m.user.id, t, 'gym_owner'));
  return f.refresh(m);
}

/** A gym ready for review: basics, three photos, hours and packages. */
async function readyGym(owner, { name = 'Iron Yard Banani', area = 'banani', hours = ALL_DAY, packages = IRON_YARD, capacity = null } = {}) {
  const g = await api()
    .post(`${P}/me/gyms`)
    .set(h.bearer(owner))
    .send({ name, areaId: await f.areaId(area), addressLine: 'House 9, Road 11, Banani, Dhaka', about: 'Free weights, squat racks and showers.', dailyCapacity: capacity })
    .expect(201);
  for (const [buf, type] of [
    [f.JPEG, 'image/jpeg'],
    [f.PNG, 'image/png'],
    [f.WEBP, 'image/webp'],
  ])
    await api().post(`${P}/me/gyms/${g.body.id}/photos`).set(h.bearer(owner)).set('Content-Type', type).send(Buffer.concat([buf, Buffer.from(f.uniq('gp'))])).expect(201);
  await api().put(`${P}/me/gyms/${g.body.id}/hours`).set(h.bearer(owner)).send({ hours }).expect(200);
  await api().put(`${P}/me/gyms/${g.body.id}/packages`).set(h.bearer(owner)).send({ packages }).expect(200);
  return g.body;
}

/** A live gym (approved on the Moderation desk); returns the public page. */
async function liveGym(owner, reviewer, opts = {}) {
  const g = await readyGym(owner, opts);
  await api().post(`${P}/me/gyms/${g.id}/submit`).set(h.bearer(owner)).expect(200);
  await h.drainEvents();
  await f.review(reviewer, 'gym', g.id);
  return (await api().get(`${P}/gym/gyms/${g.slug}`).expect(200)).body;
}

/** A fitness trainer with a live M11 profile (no credential needed for the role). */
async function trainer({ docsReviewer, reviewer, name = 'Sabbir Hossain' }) {
  return x.liveProfile({
    docsReviewer,
    reviewer,
    name,
    roleKey: 'fitness_trainer',
    level: 'semi_pro',
    credentialLevel: null,
    card: { items: [{ unit: 'hourly', rate: 80000 }], nightPct: 0, shortNoticePct: 0, shortNoticeHours: 24, travel: { north: 0, south: 0, outside: 0 }, maxJobsPerDay: 4 },
  });
}

/** Today's Dhaka date and a date `days` from it. */
const today = () => rules.dhakaDate(new Date());
const inDays = (days) => rules.addDays(today(), days);

/** Move a subscription so its latest paid month ends `endsIn` days from today (negative = ended). */
async function shiftSubscription(subscriptionId, endsIn) {
  const periods = await models.TrainerSubscriptionPeriod.findAll({ where: { subscriptionId }, order: [['seq', 'ASC']] });
  const paid = periods.filter((p) => ['paid', 'released', 'disputed'].includes(p.status)).at(-1);
  const shift = rules.daysBetween(paid.periodEnd, inDays(endsIn));
  for (const p of periods) {
    const periodEnd = rules.addDays(p.periodEnd, shift);
    await p.update({ periodStart: rules.addDays(p.periodStart, shift), periodEnd, ...(p.releaseAt ? { releaseAt: rules.releaseAtOf(periodEnd, 24) } : {}) });
  }
  const s = await models.TrainerSubscription.findByPk(subscriptionId);
  await s.update({ startedOn: rules.addDays(s.startedOn, shift), paidThrough: s.paidThrough ? rules.addDays(s.paidThrough, shift) : null });
  return s.reload();
}

module.exports = { ALL_DAY, IRON_YARD, gymOwner, readyGym, liveGym, trainer, today, inDays, shiftSubscription };
