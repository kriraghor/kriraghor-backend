'use strict';

// M17 reviews for pros, shops and gyms (Round B1; M17-FR-30 to FR-35, M11-FR-06, M20-FR-10):
//  - hire_job → hire_profile: only the manager who paid, only once the job's money is released;
//    the pro replies (contact details refused, REPLY_HAS_CONTACT), the author is told once;
//  - sub_order → shop: only the buyer, only once completed, inside reviews.window_days;
//  - gym_pass → gym: only the holder, only once the pass was used; one review per gym: a newer pass
//    updates it, the same pass is REVIEW_EXISTS, a hidden review stays hidden (REVIEW_HIDDEN);
//  - a dispute on the source holds its review and the aggregate drops it, release puts it back;
//  - the aggregates reach hire_profiles, shops and gyms, and the public views show the average only
//    from reviews.min_count_display reviews; GET /reviews lists any subject with the owner reply;
//  - "waiting to review" lists every source; the v1 body { bookingId } keeps working.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const x = require('../fixtures/hire');
const g = require('../fixtures/gym');
const reviewsService = require('../../src/modules/trust/reviews.service');

const { api, P, models } = h;

let master;
let reviewer;
let docsReviewer;
let seq = 0;
const key = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  reviewer = await f.staffWith(master, ['approve_listings']);
  docsReviewer = await f.staffWith(master, ['approve_documents']);
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const rate = (who, body) => api().post(`${P}/reviews`).set(h.bearer(who)).send(body);
const reply = (who, id, text) => api().post(`${P}/me/reviews/${id}/reply`).set(h.bearer(who)).send({ text });
const reviewable = async (who) => (await api().get(`${P}/me/reviewable`).set(h.bearer(who)).expect(200)).body.items;
const codesOf = async (userId) => (await models.Notification.findAll({ where: { userId } })).map((n) => n.code);
const inTx = (fn) => models.sequelize.transaction((transaction) => fn(transaction));

describe('M17 reviews: pros (hire jobs)', () => {
  it('the manager rates a released job; the pro replies; the rating reaches the profile; a dispute holds it', async () => {
    const { pro, profile } = await x.liveProfile({ docsReviewer, reviewer });
    const manager = await h.signupUser({ name: 'Rafi Ahmed' });
    const r = await api()
      .post(`${P}/hire/requests`)
      .set(h.bearer(manager))
      .set('Idempotency-Key', key('hr'))
      .send(await x.matchRequest(profile.id, [x.at1930(4)]))
      .expect(201);
    await api().post(`${P}/pro/requests/${r.body.request.id}/accept`).set(h.bearer(pro)).expect(200);
    await h.payWithSimulator(manager, (await models.HireRequest.findByPk(r.body.request.id)).paymentId);
    await h.drainEvents();
    const job = await models.HireJob.findOne({ where: { requestId: r.body.request.id } });
    const body = { sourceType: 'hire_job', sourceId: job.id, rating: 4, text: 'On time and fair calls' };

    // Scheduled, then marked complete: not yet (JOB_NOT_RELEASED); never for someone else.
    expect((await rate(manager, body).expect(409)).body.code).toBe('JOB_NOT_RELEASED');
    await x.moveJob(job.id, 5);
    await api().post(`${P}/pro/jobs/${job.id}/check-in`).set(h.bearer(pro)).expect(200);
    await api().post(`${P}/pro/jobs/${job.id}/complete`).set(h.bearer(pro)).send({ note: 'Umpired the full match' }).expect(200);
    expect((await rate(manager, body).expect(409)).body.code).toBe('JOB_NOT_RELEASED');
    await api().post(`${P}/me/hire-jobs/${job.id}/confirm`).set(h.bearer(manager)).send({}).expect(200);
    await h.drainEvents();
    expect((await rate(pro, body).expect(403)).body.code).toBe('NOT_YOUR_JOB');
    expect((await rate(manager, { ...body, sourceId: '00000000-0000-4000-8000-000000000000' }).expect(404)).body.code).toBe('NOT_FOUND');

    // Waiting to review, then rated (rating is another name for stars), once.
    expect((await reviewable(manager)).map((i) => [i.sourceType, i.sourceId, i.subjectType, i.subjectId])).toEqual([['hire_job', job.id, 'hire_profile', profile.id]]);
    const posted = (await rate(manager, body).expect(201)).body.review;
    expect(posted).toMatchObject({ subjectType: 'hire_profile', subjectId: profile.id, sourceType: 'hire_job', sourceId: job.id, bookingId: null, stars: 4, status: 'published' });
    expect((await rate(manager, body).expect(409)).body.code).toBe('REVIEW_EXISTS');
    expect(await reviewable(manager)).toEqual([]);
    expect((await models.Review.findByPk(posted.id)).subjectOwnerId).toBe(pro.user.id);
    await h.drainEvents();
    expect(await codesOf(pro.user.id)).toContain('REVIEW_NEW');

    // The pro replies: not someone else, not with contact details; the author hears once.
    expect((await reply(manager, posted.id, 'Thanks to me').expect(403)).body.code).toBe('NOT_OWNER');
    expect((await reply(pro, posted.id, 'Call me direct on 01711223344').expect(422)).body.code).toBe('REPLY_HAS_CONTACT');
    expect((await reply(pro, posted.id, 'Thank you, good luck in the league').expect(200)).body.review.reply.text).toContain('good luck');
    await reply(pro, posted.id, 'Thank you, good luck this season').expect(200);
    await h.drainEvents();
    expect((await codesOf(manager.user.id)).filter((c) => c === 'REVIEW_REPLIED')).toHaveLength(1);

    // The owner's list and the author's list.
    const mine = (await api().get(`${P}/me/reviews?role=owner`).set(h.bearer(pro)).expect(200)).body.items;
    expect(mine.map((i) => i.id)).toEqual([posted.id]);
    expect((await api().get(`${P}/me/reviews?subjectType=shop`).set(h.bearer(pro)).expect(200)).body.items).toEqual([]);
    expect((await api().get(`${P}/me/reviews`).set(h.bearer(manager)).expect(200)).body.items.map((i) => i.id)).toEqual([posted.id]);

    // The public list (no source ids), the profile's rating, and min_count_display on the directory.
    const pub = (await api().get(`${P}/reviews?subjectType=hire_profile&subjectId=${profile.id}`).expect(200)).body;
    expect(pub.summary).toEqual({ count: 1, avg: null, histogram: [0, 0, 0, 1, 0] });
    expect(pub.items[0]).toMatchObject({ id: posted.id, reply: { text: 'Thank you, good luck this season' } });
    expect(pub.items[0].sourceId).toBeUndefined();
    expect(await models.HireProfile.findByPk(profile.id)).toMatchObject({ ratingCount: 1, ratingAvg: 4 });
    const card = async () => (await api().get(`${P}/hire/profiles`).expect(200)).body.items.find((c) => c.id === profile.id);
    expect(await card()).toMatchObject({ ratingAvg: null, ratingCount: 1 });
    await h.setSettingForTest('reviews.min_count_display', 1);
    expect(await card()).toMatchObject({ ratingAvg: 4, ratingCount: 1 });

    // A dispute on the job holds the review (the profile drops it); its end publishes it again.
    expect(await inTx((transaction) => reviewsService.holdForSource('hire_job', job.id, { transaction }))).toBe(1);
    await h.drainEvents();
    expect(await models.Review.findByPk(posted.id)).toMatchObject({ status: 'held', heldReason: 'dispute' });
    expect(await models.HireProfile.findByPk(profile.id)).toMatchObject({ ratingCount: 0, ratingAvg: null });
    expect((await reply(pro, posted.id, 'Another reply').expect(409)).body.code).toBe('REVIEW_STATE');
    expect(await inTx((transaction) => reviewsService.releaseForSource('hire_job', job.id, { transaction }))).toBe(1);
    await h.drainEvents();
    expect(await models.Review.findByPk(posted.id)).toMatchObject({ status: 'published', heldReason: null });
    expect(await models.HireProfile.findByPk(profile.id)).toMatchObject({ ratingCount: 1, ratingAvg: 4 });
    // Disputes on sources without reviews hold nothing.
    expect(await inTx((transaction) => reviewsService.holdForSource('trainer_subscription', job.id, { transaction }))).toBe(0);
  });
});

describe('M17 reviews: shops (sub-orders)', () => {
  it('the buyer rates a completed sub-order inside the window; the seller replies; the rating reaches the shop', async () => {
    const owner = await f.shopOwner(docsReviewer, 'Nayeem Sports');
    const shop = await f.liveShop(owner, reviewer, { name: 'Nayeem Sports' });
    const ready = await f.readyBoots(owner, { sizes: ['42'], stock: 2 });
    const product = await f.liveProduct(owner, reviewer, ready);
    const buyer = await h.signupUser({ name: 'Tanvir Hasan' });
    await api().put(`${P}/me/cart/items/${product.variants[0].id}`).set(h.bearer(buyer)).send({ qty: 1 }).expect(200);
    const ship = { name: 'Tanvir Hasan', phone: '01711000111', areaId: await f.areaId('dhanmondi'), line: 'House 12, Road 5, Dhanmondi' };
    const total = (await api().post(`${P}/checkout/quote`).set(h.bearer(buyer)).send({ areaId: ship.areaId }).expect(200)).body.total;
    const placed = await api().post(`${P}/checkout`).set(h.bearer(buyer)).set('Idempotency-Key', key('co')).send({ ship, expectedTotal: total }).expect(201);
    await h.payWithSimulator(buyer, placed.body.payment.id);
    await h.drainEvents();
    const sub = await models.SubOrder.findOne({ where: { orderId: placed.body.order.id } });
    const body = { sourceType: 'sub_order', sourceId: sub.id, stars: 5, text: 'Genuine boots, fast delivery' };

    expect((await rate(buyer, body).expect(409)).body.code).toBe('ORDER_NOT_COMPLETED');
    const shopPost = (action, extra) => api().post(`${P}/shop/sub-orders/${sub.id}/${action}`).set(h.bearer(owner)).send(extra ?? {});
    await shopPost('accept').expect(200);
    await shopPost('ship', { courierName: 'Pathao', trackingNo: 'PTH-1001' }).expect(200);
    await shopPost('delivered').expect(200);
    expect((await rate(buyer, body).expect(409)).body.code).toBe('ORDER_NOT_COMPLETED');
    await api().post(`${P}/me/sub-orders/${sub.id}/received`).set(h.bearer(buyer)).send({}).expect(200);
    await h.drainEvents();
    expect((await rate(owner, body).expect(403)).body.code).toBe('NOT_YOUR_ORDER');

    // Outside reviews.window_days (30) it is closed and no longer waiting.
    const completedAt = (await sub.reload()).completedAt;
    await sub.update({ completedAt: new Date(Date.now() - 31 * 86400000) });
    expect((await rate(buyer, body).expect(409)).body.code).toBe('REVIEW_WINDOW_CLOSED');
    expect(await reviewable(buyer)).toEqual([]);
    await sub.update({ completedAt });
    expect((await reviewable(buyer)).map((i) => [i.sourceType, i.ref, i.subjectType, i.subjectName])).toEqual([['sub_order', sub.code, 'shop', 'Nayeem Sports']]);

    const posted = (await rate(buyer, body).expect(201)).body.review;
    expect(posted).toMatchObject({ subjectType: 'shop', subjectId: shop.id, status: 'published', stars: 5 });
    await h.drainEvents();
    expect(await models.Shop.findByPk(shop.id)).toMatchObject({ ratingCount: 1, ratingAvg: 5 });
    const page = async () => (await api().get(`${P}/market/shops/${shop.slug}`).expect(200)).body;
    expect(await page()).toMatchObject({ ratingAvg: null, ratingCount: 1 });
    await h.setSettingForTest('reviews.min_count_display', 1);
    expect(await page()).toMatchObject({ ratingAvg: 5, ratingCount: 1 });

    // The seller replies (any link refused); the buyer is told.
    expect((await reply(owner, posted.id, 'Order again at www.nayeemsports.com').expect(422)).body.code).toBe('REPLY_HAS_CONTACT');
    await reply(owner, posted.id, 'Thank you for shopping with us').expect(200);
    await h.drainEvents();
    expect(await codesOf(buyer.user.id)).toContain('REVIEW_REPLIED');
    expect((await api().get(`${P}/me/reviews?subjectType=shop&subjectId=${shop.id}`).set(h.bearer(owner)).expect(200)).body.items.map((i) => i.id)).toEqual([posted.id]);

    // A dispute on the sub-order holds the review; the shop's rating follows.
    await inTx((transaction) => reviewsService.holdForSource('sub_order', sub.id, { transaction }));
    await h.drainEvents();
    expect(await models.Shop.findByPk(shop.id)).toMatchObject({ ratingCount: 0, ratingAvg: null });
    expect((await api().get(`${P}/reviews?subjectType=shop&subjectId=${shop.id}`).expect(200)).body.items).toEqual([]);
    await inTx((transaction) => reviewsService.releaseForSource('sub_order', sub.id, { transaction }));
    await h.drainEvents();
    expect(await models.Shop.findByPk(shop.id)).toMatchObject({ ratingCount: 1, ratingAvg: 5 });

    // The v1 body still names a booking; a mixed body is refused.
    expect((await rate(buyer, { bookingId: sub.id, stars: 5 }).expect(404)).body.code).toBe('NOT_FOUND');
    await rate(buyer, { sourceType: 'gym_pass', bookingId: sub.id, stars: 5 }).expect(422);
    await rate(buyer, { sourceType: 'sub_order', sourceId: sub.id }).expect(422);
    await api().get(`${P}/reviews?subjectType=planet&subjectId=${shop.id}`).expect(422);
  });
});

describe('M17 reviews: gyms (passes, M20-FR-10)', () => {
  it('the holder rates a used pass; a newer pass updates the one review; the owner replies; hidden stays hidden', async () => {
    const owner = await g.gymOwner(docsReviewer);
    const gym = await g.liveGym(owner, reviewer);
    const member = await h.signupUser({ name: 'Nadia Islam' });
    const buy = async (validFrom) => {
      const r = await api().post(`${P}/gym/passes`).set(h.bearer(member)).set('Idempotency-Key', key('gp')).send({ packageId: gym.packages.find((p) => p.kind === 'day').id, validFrom }).expect(201);
      await h.payWithSimulator(member, r.body.payment.id);
      await h.drainEvents();
      return (await api().get(`${P}/me/passes/${r.body.pass.code}`).set(h.bearer(member)).expect(200)).body.pass;
    };
    const pass = await buy(g.today());
    const passRow = await models.GymPass.findOne({ where: { code: pass.code } });
    const body = { sourceType: 'gym_pass', sourceId: passRow.id, stars: 3, text: 'Good racks, crowded at 7' };

    expect((await rate(member, body).expect(409)).body.code).toBe('PASS_NOT_REDEEMED');
    await api().post(`${P}/me/gyms/${gym.id}/redemptions`).set(h.bearer(owner)).send({ token: pass.token }).expect(201);
    expect((await rate(owner, body).expect(403)).body.code).toBe('NOT_YOUR_PASS');
    expect((await reviewable(member)).map((i) => [i.sourceType, i.sourceId, i.subjectType, i.subjectId])).toEqual([['gym_pass', passRow.id, 'gym', gym.id]]);
    const first = (await rate(member, body).expect(201)).body.review;
    expect(first).toMatchObject({ subjectType: 'gym', subjectId: gym.id, stars: 3, status: 'published' });
    expect((await rate(member, body).expect(409)).body.code).toBe('REVIEW_EXISTS');
    expect(await reviewable(member)).toEqual([]);

    // A newer pass, used at the desk: posting again updates the same review (stars, text, checks).
    const usedPass = async () => {
      const p = await buy(g.inDays(1));
      const row = await models.GymPass.findOne({ where: { code: p.code } });
      await row.update({ status: 'redeemed', firstRedeemedAt: new Date(), lastRedeemedAt: new Date() });
      return row;
    };
    const second = await usedPass();
    // The later visit brings the gym back, pointing at the review a post will update.
    expect((await reviewable(member)).map((i) => [i.sourceId, i.subjectId, i.existingReviewId])).toEqual([[second.id, gym.id, first.id]]);
    const updated = await rate(member, { sourceType: 'gym_pass', sourceId: second.id, stars: 5, text: 'Now with more racks, see irongym.com' }).expect(200);
    expect(updated.body).toMatchObject({ updated: true, review: { id: first.id, stars: 5, status: 'held', heldReason: 'content', sourceId: second.id } });
    expect(await models.Review.count({ where: { authorId: member.user.id, subjectType: 'gym' } })).toBe(1);
    await h.drainEvents();
    expect(await models.Gym.findByPk(gym.id)).toMatchObject({ ratingCount: 0, ratingAvg: null }); // held for staff
    const staff = await f.staffWith(master, ['resolve_reports']);
    await api().post(`${P}/admin/reviews/${first.id}/publish`).set(h.bearer(staff)).expect(200);
    await h.drainEvents();
    expect(await models.Gym.findByPk(gym.id)).toMatchObject({ ratingCount: 1, ratingAvg: 5 });
    expect((await api().get(`${P}/gym/gyms/${gym.slug}`).expect(200)).body).toMatchObject({ ratingAvg: null, ratingCount: 1 });
    await h.setSettingForTest('reviews.min_count_display', 1);
    expect((await api().get(`${P}/gym/gyms/${gym.slug}`).expect(200)).body).toMatchObject({ ratingAvg: 5, ratingCount: 1 });

    // The gym owner replies; the admin desk filters by subject.
    await reply(owner, first.id, 'Thanks Nadia, the new racks are in').expect(200);
    await h.drainEvents();
    expect(await codesOf(member.user.id)).toContain('REVIEW_REPLIED');
    // The member's and the owner's lists name the gym.
    const mine = (await api().get(`${P}/me/reviews`).set(h.bearer(member)).expect(200)).body.items;
    expect(mine.find((i) => i.id === first.id)).toMatchObject({ subjectName: expect.any(String), subjectSlug: gym.slug });
    const owned = (await api().get(`${P}/me/reviews?role=owner&subjectType=gym`).set(h.bearer(owner)).expect(200)).body.items;
    expect(owned.map((i) => [i.id, i.subjectSlug])).toEqual([[first.id, gym.slug]]);
    expect(await reviewable(member)).toEqual([]); // updated after the visit: nothing left to rate
    expect((await api().get(`${P}/admin/reviews?status=published&subjectType=gym`).set(h.bearer(staff)).expect(200)).body.items.map((i) => i.id)).toEqual([first.id]);

    // Hidden by staff: a third pass cannot bring it back.
    await api().post(`${P}/admin/reviews/${first.id}/hide`).set(h.bearer(staff)).send({ reason: 'Advertising' }).expect(200);
    const third = await usedPass();
    expect((await rate(member, { sourceType: 'gym_pass', sourceId: third.id, stars: 5 }).expect(409)).body.code).toBe('REVIEW_HIDDEN');
    await h.drainEvents();
    expect(await models.Gym.findByPk(gym.id)).toMatchObject({ ratingCount: 0 });
  });
});
