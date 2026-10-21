'use strict';

/**
 * Round B1 reviews in the full profile (M17-FR-30 to FR-35, M11-FR-06 and FR-52, M20-FR-10): past hire
 * jobs, shop orders and gym visits, each rated by the member who paid, with a few owner replies, so
 * the demo referee, the umpire, Iron Supply Tejgaon and PowerHouse Gym Mirpur show a rating (from
 * reviews.min_count_display reviews), the referee's /pro/insights shows earnings, and the demo member
 * has one item of each kind waiting for a rating on /me/reviews.
 *
 * Past activity is made as in full.js: created in the near future (or now), played through the real
 * routes (accept, pay, check-in, complete, confirm; ship and receive), then the stored times of
 * those demo rows are moved back. Ledger postings, order lines and front-desk admissions are
 * append-only and keep their real (today's) times, so gym visits are made today.
 * A re-run finds each item by its demo buyer, hirer or holder and skips what was already moved back
 * (demo_records lists accounts and listings only); a review that exists is not posted again
 * (REVIEW_EXISTS and REVIEW_WINDOW_CLOSED are accepted answers).
 */
const { Op } = require('sequelize');
const rt = require('../runtime');
const L = require('./listings');
const D = require('../data');
const { pay, order } = require('./full');
const { dhakaMidnight, dhakaTime } = require('./availability');

const { models } = rt;
const { sequelize } = models;
const day = 86400000;
const hour = 3600000;

// ---------------------------------------------------------------- moving demo rows back in time

/** Already moved back by an earlier run (every item here is at least a day old once moved). */
const moved = (at) => Boolean(at) && Date.now() - new Date(at).getTime() > 12 * hour;

/**
 * Move the stored times of demo rows `ms` back: every timestamp column, every date column (whole
 * days) and every time range; never updated_at. `by` picks the rows by another column than id.
 */
async function shiftBack(model, ids, ms, { by = 'id', only } = {}) {
  const sets = [];
  for (const [name, a] of Object.entries(model.rawAttributes)) {
    if (name === 'updatedAt' || (only && !only.includes(name))) continue;
    const col = `"${a.field ?? name}"`;
    const key = a.type?.key;
    if (key === 'DATE') sets.push(`${col} = ${col} - make_interval(secs => :secs)`);
    else if (key === 'DATEONLY') sets.push(`${col} = ${col} - :days`);
    else if (key === 'RANGE') sets.push(`${col} = tstzrange(lower(${col}) - make_interval(secs => :secs), upper(${col}) - make_interval(secs => :secs), '[)')`);
  }
  if (!sets.length) return;
  await sequelize.query(`UPDATE "${model.tableName}" SET ${sets.join(', ')} WHERE "${by}" IN (:ids)`, { replacements: { secs: ms / 1000, days: Math.round(ms / day), ids: [].concat(ids) } });
}

// ---------------------------------------------------------------- reviews and replies

const done = [];

/** The author rates a source once, the day after it was done (or now); the owner replies once, hours later. */
async function rate(author, sourceType, sourceId, doneAt, [stars, text], reply, owner) {
  let r = await models.Review.findOne({ where: { authorId: author.userId, sourceType, sourceId } });
  if (!r) {
    const res = await rt.post(author, '/reviews', { sourceType, sourceId, stars, text }, { ok: [409, 422] });
    if (!res?.review) {
      done.push(`${sourceType} not rated (${res?.code})`);
      return null;
    }
    r = await models.Review.findByPk(res.review.id);
    const at = new Date(doneAt).getTime() + 14 * hour;
    if (at < Date.now()) await shiftBack(models.Review, r.id, Date.now() - at, { only: ['createdAt', 'editUntil'] });
    r = await r.reload();
  }
  if (reply && owner && !r.replyText && r.status === 'published') {
    const res = await rt.post(owner, `/me/reviews/${r.id}/reply`, { text: reply }, { ok: [409, 422] });
    if (res?.review) await sequelize.query("UPDATE reviews SET replied_at = LEAST(created_at + interval '6 hours', now()) WHERE id = :id", { replacements: { id: r.id } });
  }
  return r;
}

// ---------------------------------------------------------------- hire jobs (M11)

const JOB_PLACE = {
  football_referee: ['Kick Off Arena Mirpur', 'mirpur', 'Full match, two yellow cards, no injuries.'],
  cricket_umpire: ['Pallabi Cricket Ground', 'pallabi', 'Umpired the full match with the home umpire. No incidents.'],
  physiotherapist: ['Pallabi Cricket Ground', 'pallabi', 'Pre-match taping for four players; treated one hamstring strain.'],
};
const NOTES = {
  football_referee: 'League match on the 7-a-side turf, please bring your own whistle and cards',
  cricket_umpire: 'Corporate league match, white ball',
  physiotherapist: 'Match-day cover for our club side',
};

/** A free evening (19:00 Dhaka, with room either side) for a pro, two to thirteen days ahead. */
async function freeEvening(profileId) {
  const q = `from=${encodeURIComponent(dhakaMidnight(0).toISOString())}&to=${encodeURIComponent(dhakaMidnight(14).toISOString())}`;
  const { busy } = await rt.get(null, `/hire/profiles/${profileId}/availability?${q}`);
  for (let d = 2; d < 14; d += 1) {
    const s = dhakaTime(d, '17:30').getTime();
    const e = dhakaTime(d, '23:00').getTime();
    if (!busy.some((b) => Date.parse(b.start) < e && Date.parse(b.end) > s)) return dhakaTime(d, '19:00');
  }
  throw new Error(`no free evening for hire profile ${profileId} in the next two weeks`);
}

/** A request from the hirer to the pro, answered `replyMin` minutes after it was sent. */
async function request(pro, hirer, h) {
  const [venueText, area] = JOB_PLACE[pro.roleKey];
  const start = await freeEvening(pro.profileId);
  const engagement = { start: start.toISOString(), ...(h.format ? { format: h.format } : {}), venueText, venueAreaId: (await L.byKey('Area', area)).id };
  const r = await rt.post(hirer, '/hire/requests', { profileId: pro.profileId, unit: 'match', engagements: [engagement], note: NOTES[pro.roleKey] }, { idem: `demo-hire-${pro.n}-${hirer.n}` });
  await sequelize.query('UPDATE hire_requests SET created_at = created_at - make_interval(mins => :m) WHERE id = :id', { replacements: { m: h.replyMin, id: r.request.id } });
  return models.HireRequest.findByPk(r.request.id);
}

/** A released job, played now through the routes, then moved to 19:00 Dhaka `daysAgo` days ago. */
async function pastJob(pro, hirer, h) {
  let req = await models.HireRequest.findOne({ where: { hirerId: hirer.userId, profileId: pro.profileId }, order: [['createdAt', 'DESC']] });
  const earlier = req && (await models.HireJob.findOne({ where: { requestId: req.id } }));
  if (earlier?.status === 'released' && moved(earlier.startAt)) return earlier; // an earlier run finished it
  req = req ?? (await request(pro, hirer, h));
  if (req.status === 'pending') await rt.post(pro.actor, `/pro/requests/${req.id}/accept`, {});
  req = await req.reload();
  if (req.status === 'accepted_unpaid') await pay(hirer, req.paymentId);
  req = await req.reload();
  let job = await models.HireJob.findOne({ where: { requestId: req.id } });
  if (!job) throw new Error(`hire request ${req.code} has no job (${req.status})`);
  if (job.status === 'scheduled') {
    // Match day now: starts in five minutes (as tests/fixtures/hire.js moveJob), the pro checks in.
    const len = new Date(job.endAt).getTime() - new Date(job.startAt).getTime();
    const start = new Date(Date.now() + 5 * 60000);
    const end = new Date(start.getTime() + len);
    await job.update({ startAt: start, endAt: end, busy: [{ value: new Date(start.getTime() - 1800000), inclusive: true }, { value: new Date(end.getTime() + 1800000), inclusive: false }] });
    await rt.post(pro.actor, `/pro/jobs/${job.id}/check-in`);
    job = await job.reload();
  }
  if (['checked_in', 'live'].includes(job.status)) {
    await rt.post(pro.actor, `/pro/jobs/${job.id}/complete`, { note: JOB_PLACE[pro.roleKey][2], ...(h.result ? { result: h.result } : {}) });
    job = await job.reload();
  }
  if (job.status === 'completed_marked') {
    await rt.post(hirer, `/me/hire-jobs/${job.id}/confirm`, {});
    await rt.drain();
    job = await job.reload();
  }
  if (job.status !== 'released') throw new Error(`hire job ${job.code} is ${job.status}, not released`);

  // Then it becomes a past job; the request was sent three days before the match.
  const shift = new Date(job.startAt).getTime() - dhakaTime(-h.daysAgo, '19:00').getTime();
  await shiftBack(models.HireJob, job.id, shift);
  await sequelize.query(
    "UPDATE hire_jobs SET checked_in_at = start_at - interval '20 minutes', completed_at = end_at + interval '10 minutes', release_at = end_at + interval '10 minutes' + (release_at - completed_at), released_at = end_at + interval '45 minutes' WHERE id = :id",
    { replacements: { id: job.id } }
  );
  await shiftBack(models.HireRequest, req.id, shift + 3 * day, { only: ['createdAt', 'replyBy', 'payBy', 'decidedAt', 'confirmedAt'] });
  await sequelize.query('UPDATE hire_requests SET closed_at = (SELECT released_at FROM hire_jobs WHERE id = :job) WHERE id = :id', { replacements: { job: job.id, id: req.id } });
  return job.reload();
}

/** One request the demo referee declined (so the acceptance rate is a real figure). */
async function declinedRequest(pro, hirer, h) {
  if (await models.HireRequest.findOne({ where: { hirerId: hirer.userId, profileId: pro.profileId } })) return;
  const req = await request(pro, hirer, h);
  await rt.post(pro.actor, `/pro/requests/${req.id}/decline`, { reason: h.reason, text: 'Sorry, I already have a league match that evening.' });
}

async function hireHistory(pros, who) {
  const proOf = (n) => pros.find((p) => p.n === n);
  for (const h of D.HIRE_HISTORY) {
    const pro = proOf(h.pro);
    const hirer = who.get(h.hirer);
    const job = await pastJob(pro, hirer, h);
    if (h.review) await rate(hirer, 'hire_job', job.id, job.releasedAt, h.review, h.reply, pro.actor);
  }
  await declinedRequest(proOf(D.HIRE_DECLINED.pro), who.get(D.HIRE_DECLINED.hirer), D.HIRE_DECLINED);
}

// ---------------------------------------------------------------- shop orders (M13)

/** A one-line order, received by the buyer, then moved `daysAgo` days back (the order and its shop part). */
async function receivedOrder(buyer, s, owners) {
  const shop = await models.Shop.findOne({ where: { name: s.shop } });
  await order(buyer, [[s.shop, s.title, s.attr ?? null, 1]], owners, 'received', `rv-${buyer.n}`);
  const sub = await models.SubOrder.findOne({ where: { buyerId: buyer.userId, shopId: shop.id }, order: [['createdAt', 'DESC']] });
  if (sub?.status !== 'completed') {
    done.push(`order of ${buyer.name} is ${sub?.status ?? 'missing'}`);
    return null;
  }
  if (!moved(sub.completedAt)) {
    const shift = s.daysAgo * day;
    await shiftBack(models.Order, sub.orderId, shift);
    await shiftBack(models.SubOrder, sub.id, shift);
    // order_items is append-only: its lines keep their real time.
  }
  return sub.reload();
}

const ownerOf = (owners, userId) => Object.values(owners).find((a) => a.userId === userId);

async function shopReviews(owners, who, member) {
  for (const s of D.SHOP_REVIEWS) {
    const buyer = who.get(s.buyer);
    const sub = await receivedOrder(buyer, s, owners);
    if (sub) await rate(buyer, 'sub_order', sub.id, sub.completedAt, s.review, s.reply, ownerOf(owners, sub.sellerId));
  }
  // The demo member rates one shop of their received order; the other stays waiting for a rating.
  const shop = await models.Shop.findOne({ where: { name: D.MEMBER_SHOP_REVIEW.shop } });
  const sub = await models.SubOrder.findOne({ where: { buyerId: member.userId, shopId: shop.id, status: 'completed' } });
  if (sub) await rate(member, 'sub_order', sub.id, sub.completedAt, D.MEMBER_SHOP_REVIEW.review);
}

// ---------------------------------------------------------------- gym visits (M20)

const todayDhaka = () => new Date(Date.now() + 6 * hour).toISOString().slice(0, 10);

/** The front desk admits the pass (the gym's owner scans the member's QR). Null when the desk refuses (e.g. closed now). */
async function admit(owner, gym, member, pass) {
  const view = await rt.get(member, `/me/passes/${pass.code}`);
  const r = await rt.post(owner, `/me/gyms/${gym.id}/redemptions`, { token: view.pass.token }, { ok: [409, 422] });
  if (r?.code) {
    done.push(`${gym.name} front desk: ${r.code} (re-run when the gym is open)`);
    return null;
  }
  return pass.reload();
}

/**
 * A day pass bought, paid and used at the front desk today. It stays today: pass_redemptions is
 * append-only, and the front desk's day view must match the pass.
 */
async function gymVisit(owners, g, member) {
  const gym = await models.Gym.findOne({ where: { name: g.gym } });
  let pass = await models.GymPass.findOne({ where: { holderId: member.userId, gymId: gym.id, firstRedeemedAt: { [Op.ne]: null } } });
  if (!pass) {
    const today = todayDhaka();
    pass = await models.GymPass.findOne({ where: { holderId: member.userId, gymId: gym.id, status: 'active', validFrom: { [Op.lte]: today }, validTo: { [Op.gte]: today } } });
    if (!pass) {
      const pkg = await models.GymPackage.findOne({ where: { gymId: gym.id, kind: 'day' } });
      const r = await rt.post(member, '/gym/passes', { packageId: pkg.id, validFrom: today }, { idem: `demo-pass-${member.n}-${gym.id.slice(0, 8)}-${today}` });
      if (r.payment?.id) await pay(member, r.payment.id);
      pass = await models.GymPass.findOne({ where: { code: r.pass.code } });
    }
    pass = await admit(ownerOf(owners, gym.ownerId), gym, member, pass);
    if (!pass) return null;
  }
  return pass;
}

async function gymReviews(owners, who, member) {
  for (const g of D.GYM_REVIEWS) {
    const m = who.get(g.member);
    const pass = await gymVisit(owners, g, m);
    if (pass) await rate(m, 'gym_pass', pass.id, pass.lastRedeemedAt, g.review, g.reply, ownerOf(owners, pass.ownerId));
  }
  // The demo member's monthly pass (full.js) is used today, and waits for a rating.
  const iron = await models.Gym.findOne({ where: { name: 'Iron Yard Banani' } });
  const monthly = await models.GymPass.findOne({ where: { holderId: member.userId, gymId: iron.id, status: 'active', firstRedeemedAt: null } });
  if (monthly) await admit(ownerOf(owners, iron.ownerId), iron, member, monthly);
}

// ---------------------------------------------------------------- the step

async function run({ owner, players, pros, member }) {
  done.length = 0;
  const who = new Map(players.map((p) => [p.n, p]));
  who.set(member.n, member);
  await hireHistory(pros, who);
  await shopReviews(owner, who, member);
  await gymReviews(owner, who, member);
  await rt.drain();
  // What the nightly hire.stats-recompute job does, so acceptance rate and reply time show now.
  await require('../../../src/modules/hire/hire.jobs').recomputeStats();
  await rt.drain();
  const counts = await models.Review.findAll({ where: { subjectType: ['hire_profile', 'shop', 'gym'] }, attributes: ['subjectType', [sequelize.fn('COUNT', '*'), 'n']], group: ['subjectType'], raw: true });
  return [`reviews: ${counts.map((c) => `${c.subjectType} ${c.n}`).join(', ') || 'none'}`, ...done].join('; ');
}

module.exports = { run, shiftBack };
