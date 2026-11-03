'use strict';

// M26 tournament feed end to end: posting (M26-FR-01 to FR-04), the feed's filters and sorts (FR-05),
// comments (FR-06), private messages (FR-07), every status change (FR-08, FR-09), reports through the
// M17 desk, notifications and the job. No money moves anywhere in this module.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const rules = require('../../src/modules/tournament-posts/tournament-posts.rules');
const jobs = require('../../src/modules/tournament-posts/tournament-posts.jobs');

const { api, P, models } = h;

let master;
let dhaka;
const today = () => rules.dhakaDate(new Date());
const inDays = (n) => rules.addDays(today(), n);

beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  dhaka = (await models.Area.findOne({ where: { key: 'mirpur' } })) ?? (await models.Area.findOne());
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const form = async (over = {}) => ({
  title: 'Mirpur Futsal Cup 2026',
  sport: (await models.Sport.findOne({ where: { key: 'football' } }))?.key ?? (await models.Sport.findOne()).key,
  format: 'knockout',
  districtId: dhaka.districtId,
  areaId: dhaka.id,
  venueName: 'Kick Off Arena',
  address: 'Road 11, Mirpur 10',
  startDate: inDays(20),
  endDate: inDays(22),
  registrationDeadline: inDays(10),
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
  ...over,
});

const newPost = (who, body) => api().post(`${P}/me/tournament-posts`).set(h.bearer(who)).send(body);
const feed = (q = '') => api().get(`${P}/tournament-posts${q}`).expect(200);
const codesOf = async (userId) => (await models.Notification.findAll({ where: { userId } })).map((n) => n.code);

describe('M26 tournament feed', () => {
  it('a verified phone posts and it shows at once; every detail is on its page (M26-FR-01, FR-02)', async () => {
    const author = await h.signupUser({ name: 'Rafi Karim' });
    const made = (await newPost(author, await form()).expect(201)).body;
    const page = (await api().get(`${P}/tournament-posts/${made.slug}`).expect(200)).body;
    expect(page).toMatchObject({
      title: 'Mirpur Futsal Cup 2026',
      format: 'knockout',
      venueName: 'Kick Off Arena',
      address: 'Road 11, Mirpur 10',
      entryFee: 200000,
      prizePool: 5000000,
      teamLimit: 16,
      playersPerTeam: 7,
      ageGroup: 'Under 25',
      skillLevel: 'intermediate',
      organiserName: 'Mirpur Sports Club',
      status: 'open',
      registrationOpen: true,
      commentCount: 0,
      mine: false,
      author: { displayName: 'Rafi Karim' },
    });
    expect(page.district.id).toBe(dhaka.districtId);
    expect(page.area.id).toBe(dhaka.id);
    expect(page.can).toMatchObject({ edit: false, close: false, comment: true, message: true });
    const own = (await api().get(`${P}/tournament-posts/${made.slug}`).set(h.bearer(author)).expect(200)).body;
    expect(own).toMatchObject({ mine: true, can: { edit: true, close: true, message: false } });
    expect((await feed()).body.items.map((p) => p.id)).toEqual([made.id]);
    expect(await models.AuditLog.count({ where: { action: 'tournament_post.created', entityId: made.id } })).toBe(1);
    // No money: nothing reaches the ledger, whatever the post says about fees.
    expect(await models.Payment.count()).toBe(0);
  });

  it('needs sign-in and a verified phone to post; reading needs neither (gate post_tournament)', async () => {
    await api().post(`${P}/me/tournament-posts`).send(await form()).expect(401);
    const who = await h.signupUser({ name: 'No Phone' });
    await models.User.update({ phoneVerifiedAt: null }, { where: { id: who.user.id } });
    const r = await newPost(who, await form()).expect(403);
    expect(r.body.code).toBe('PHONE_REQUIRED');
    await feed();
  });

  it('refuses bad dates, unknown places and sports, and contact details in public text (M26-FR-03, FR-04)', async () => {
    const a = await h.signupUser({ name: 'Rafi Karim' });
    const code = async (over, status = 422) => (await newPost(a, await form(over)).expect(status)).body.code;
    expect(await code({ startDate: inDays(-1), endDate: null, registrationDeadline: inDays(-2) })).toBe('TOURNAMENT_POST_DATE_PAST');
    expect(await code({ registrationDeadline: inDays(21) })).toBe('TOURNAMENT_POST_DEADLINE_AFTER_START');
    expect(await code({ endDate: inDays(19) })).toBe('TOURNAMENT_POST_END_BEFORE_START');
    expect(await code({ mapLink: 'https://example.com/here' })).toBe('TOURNAMENT_POST_MAP_LINK');
    expect(await code({ sport: 'not_a_sport' })).toBe('TOURNAMENT_POST_SPORT_UNKNOWN');
    const other = await models.Area.findOne({ where: { districtId: { [require('sequelize').Op.ne]: dhaka.districtId } } });
    if (other) expect(await code({ areaId: other.id })).toBe('TOURNAMENT_POST_PLACE_UNKNOWN');
    const phone = await newPost(a, await form({ description: 'Sixteen teams play over a weekend. Call 01712345678 to join in.' })).expect(422);
    expect(phone.body).toMatchObject({ code: 'CONTACT_NOT_ALLOWED', field: 'description' });
    expect(await code({ organiserName: 'book at turfbd.com' })).toBe('CONTACT_NOT_ALLOWED');
    expect(await code({ title: 'Hi' })).toBe('VALIDATION_FAILED');
    await newPost(a, await form({ mapLink: 'https://maps.app.goo.gl/abc' })).expect(201);
    expect(await models.TournamentPost.count()).toBe(1);
  });

  it('caps the open posts per person (setting tournament_posts.max_active_per_user)', async () => {
    const a = await h.signupUser({ name: 'Rafi Karim' });
    const max = 5;
    const author = (await models.User.findByPk(a.user.id)).id;
    const sportId = (await models.Sport.findOne()).id;
    const district = await models.District.findByPk(dhaka.districtId);
    for (let i = 0; i < max; i += 1) {
      await models.TournamentPost.create({ slug: `seed-${i}`, authorId: author, title: `Seeded ${i}`, sportId, format: 'other', divisionId: district.divisionId, districtId: district.id, venueName: 'Somewhere', startDate: inDays(5), registrationDeadline: inDays(1), entryFeePoisha: 0, organiserName: 'Rafi', description: 'Seeded for the limit test' });
    }
    expect((await newPost(a, await form()).expect(409)).body.code).toBe('TOURNAMENT_POST_LIMIT');
  });

  it('allows the setting\'s posts a day; a refused form does not use one up (tournament_posts.posts_per_day)', async () => {
    const a = await h.signupUser({ name: 'Rafi Karim' });
    const phone = await form({ description: 'Sixteen teams this weekend. Call 01712345678 to join in.' });
    for (let i = 0; i < 5; i += 1) await newPost(a, phone).expect(422);
    for (let i = 0; i < 3; i += 1) {
      const p = (await newPost(a, await form()).expect(201)).body;
      await api().post(`${P}/me/tournament-posts/${p.id}/close`).set(h.bearer(a)).expect(200);
    }
    expect((await newPost(a, await form()).expect(429)).body.code).toBe('TOURNAMENT_POST_DAILY_LIMIT');
    // Tomorrow it opens again.
    await models.TournamentPost.update({ createdAt: new Date(Date.now() - 2 * 86400000) }, { where: { authorId: a.user.id }, silent: true });
    await newPost(a, await form()).expect(201);
  });

  it('the feed filters and sorts (M26-FR-05)', async () => {
    const a = await h.signupUser({ name: 'Rafi Karim' });
    const b = await h.signupUser({ name: 'Nadia Rahman' });
    const sports = await models.Sport.findAll({ limit: 2 });
    const free = (await newPost(a, await form({ title: 'Banani Free Open', sport: sports[0].key, entryFee: 0, format: 'league', gender: 'women', startDate: inDays(30), endDate: null, registrationDeadline: inDays(2), organiserName: 'Banani Club', skillLevel: 'beginner' })).expect(201)).body;
    const paid = (await newPost(b, await form({ title: 'Gulshan Paid Cup', sport: sports[1].key, entryFee: 150000, format: 'knockout', gender: 'men', startDate: inDays(5), endDate: null, registrationDeadline: inDays(4), organiserName: 'Gulshan Club', skillLevel: 'advanced' })).expect(201)).body;
    const ids = async (q) => (await feed(q)).body.items.map((p) => p.id);
    expect(await ids('?fee=free')).toEqual([free.id]);
    expect(await ids('?fee=paid')).toEqual([paid.id]);
    expect(await ids(`?sport=${sports[0].key}`)).toEqual([free.id]);
    expect(await ids('?sport=nothing')).toEqual([]);
    expect(await ids('?format=league')).toEqual([free.id]);
    expect(await ids('?gender=men')).toEqual([paid.id]);
    expect(await ids('?skill=beginner')).toEqual([free.id]);
    expect(await ids('?q=gulshan')).toEqual([paid.id]);
    expect(await ids('?q=banani%20club')).toEqual([free.id]);
    expect(await ids('?q=%25')).toEqual([]);
    expect(await ids(`?districtId=${dhaka.districtId}`)).toHaveLength(2);
    expect(await ids(`?areaId=${dhaka.id}`)).toHaveLength(2);
    expect(await ids(`?from=${inDays(10)}`)).toEqual([free.id]);
    expect(await ids(`?to=${inDays(10)}`)).toEqual([paid.id]);
    expect(await ids('?sort=starts_soon')).toEqual([paid.id, free.id]);
    expect(await ids('?sort=deadline_soon')).toEqual([free.id, paid.id]);
    expect((await ids('?sort=newest'))[0]).toBe(paid.id);
    // Most discussed follows the comments; registration open follows the deadline.
    await api().post(`${P}/tournament-posts/${free.id}/comments`).set(h.bearer(b)).send({ body: 'How many teams so far?' }).expect(201);
    expect(await ids('?sort=most_discussed')).toEqual([free.id, paid.id]);
    await models.TournamentPost.update({ registrationDeadline: inDays(-1) }, { where: { id: free.id } });
    expect(await ids('?registrationOpen=true')).toEqual([paid.id]);
    // Paging.
    const first = (await feed('?limit=1')).body;
    expect(first).toMatchObject({ total: 2, nextCursor: '1' });
    expect((await feed('?limit=1&cursor=1')).body).toMatchObject({ total: 2, nextCursor: null });
  });

  it('comments: public, no contact details; the writer or the post\'s author removes them; the author is told (M26-FR-06)', async () => {
    const author = await h.signupUser({ name: 'Rafi Karim' });
    const player = await h.signupUser({ name: 'Nadia Rahman' });
    const stranger = await h.signupUser({ name: 'Tanvir Ahmed' });
    const p = (await newPost(author, await form()).expect(201)).body;
    const say = (who, body) => api().post(`${P}/tournament-posts/${p.id}/comments`).set(h.bearer(who)).send({ body });
    const one = (await say(player, 'Is it open to school teams?').expect(201)).body;
    const two = (await say(player, 'And is there parking?').expect(201)).body;
    expect((await say(player, 'Call me on 01712345678').expect(422)).body.code).toBe('CONTACT_NOT_ALLOWED');
    expect((await say(player, 'x'.repeat(1001)).expect(422)).body.code).toBe('TOURNAMENT_COMMENT_TOO_LONG');
    await h.drainEvents();
    expect(await codesOf(author.user.id)).toContain('TOURNAMENT_POST_COMMENT');
    const list = (await api().get(`${P}/tournament-posts/${p.id}/comments`).expect(200)).body;
    expect(list.items.map((c) => c.body)).toEqual(['Is it open to school teams?', 'And is there parking?']);
    expect(list.items[0]).toMatchObject({ mine: false, canRemove: false, author: { displayName: 'Nadia Rahman' } });
    const seen = (await api().get(`${P}/tournament-posts/${p.id}/comments`).set(h.bearer(author)).expect(200)).body;
    expect(seen.items[0]).toMatchObject({ mine: false, canRemove: true });
    const rm = (id, who) => api().post(`${P}/tournament-posts/${p.id}/comments/${id}/remove`).set(h.bearer(who));
    expect((await rm(one.id, stranger).expect(403)).body.code).toBe('TOURNAMENT_COMMENT_NOT_YOURS');
    await rm(one.id, player).expect(200);
    await rm(two.id, author).expect(200);
    expect((await rm(two.id, author).expect(404)).body.code).toBe('TOURNAMENT_COMMENT_NOT_FOUND');
    expect((await api().get(`${P}/tournament-posts/${p.id}/comments`).expect(200)).body.items).toEqual([]);
    const after = await models.TournamentPost.findByPk(p.id);
    expect(after.commentCount).toBe(0);
    // Rows stay: removal is a status.
    expect(await models.TournamentPostComment.count({ where: { postId: p.id, status: 'removed' } })).toBe(2);
    // Your own comment on your own post tells nobody.
    await models.Notification.destroy({ where: { userId: author.user.id } });
    await say(author, 'Yes, school teams are welcome').expect(201);
    await h.drainEvents();
    expect(await codesOf(author.user.id)).not.toContain('TOURNAMENT_POST_COMMENT');
  });

  it('messages: one private thread per post and player, phones allowed, only its two people (M26-FR-07)', async () => {
    const author = await h.signupUser({ name: 'Rafi Karim' });
    const player = await h.signupUser({ name: 'Nadia Rahman' });
    const stranger = await h.signupUser({ name: 'Tanvir Ahmed' });
    const p = (await newPost(author, await form()).expect(201)).body;
    expect((await api().post(`${P}/tournament-posts/${p.id}/threads`).set(h.bearer(author)).expect(422)).body.code).toBe('TOURNAMENT_THREAD_OWN_POST');
    const t = (await api().post(`${P}/tournament-posts/${p.id}/threads`).set(h.bearer(player)).expect(201)).body;
    expect(t).toMatchObject({ role: 'player', other: { displayName: 'Rafi Karim' }, unread: 0, lastMessage: null });
    // Opening again finds the same thread.
    expect((await api().post(`${P}/tournament-posts/${p.id}/threads`).set(h.bearer(player)).expect(201)).body.id).toBe(t.id);
    expect(await models.TournamentPostThread.count()).toBe(1);
    expect((await api().get(`${P}/tournament-posts/${(await models.TournamentPost.findByPk(p.id)).slug}`).set(h.bearer(player)).expect(200)).body.threadId).toBe(t.id);

    const msgs = `${P}/me/tournament-threads/${t.id}/messages`;
    const sent = (await api().post(msgs).set(h.bearer(player)).send({ body: 'My number is 01712345678, please call' }).expect(201)).body;
    expect(sent).toMatchObject({ mine: true, body: 'My number is 01712345678, please call' });
    await h.drainEvents();
    expect(await codesOf(author.user.id)).toContain('TOURNAMENT_POST_MESSAGE');
    expect(await codesOf(player.user.id)).not.toContain('TOURNAMENT_POST_MESSAGE');

    // The other person sees it, unread, until they read it.
    const inbox = (await api().get(`${P}/me/tournament-threads`).set(h.bearer(author)).expect(200)).body;
    expect(inbox.items[0]).toMatchObject({ id: t.id, role: 'organiser', unread: 1, other: { displayName: 'Nadia Rahman' }, lastMessage: { mine: false } });
    const read = (await api().get(msgs).set(h.bearer(author)).expect(200)).body;
    expect(read).toMatchObject({ canSend: true, thread: { id: t.id } });
    expect(read.items.map((m) => m.mine)).toEqual([false]);
    expect((await api().post(`${P}/me/tournament-threads/${t.id}/read`).set(h.bearer(author)).expect(200)).body.read).toBe(1);
    expect((await api().get(`${P}/me/tournament-threads`).set(h.bearer(author)).expect(200)).body.items[0].unread).toBe(0);

    await api().post(msgs).set(h.bearer(author)).send({ body: 'Thanks, I will call tonight' }).expect(201);
    await new Promise((r) => setTimeout(r, 5));
    const polled = (await api().get(`${msgs}?after=${encodeURIComponent(sent.at)}`).set(h.bearer(player)).expect(200)).body;
    expect(polled.items.map((m) => m.body)).toEqual(['Thanks, I will call tonight']);

    // Nobody else can read or write it.
    expect((await api().get(msgs).set(h.bearer(stranger)).expect(404)).body.code).toBe('TOURNAMENT_THREAD_NOT_FOUND');
    expect((await api().post(msgs).set(h.bearer(stranger)).send({ body: 'Hello there' }).expect(404)).body.code).toBe('TOURNAMENT_THREAD_NOT_FOUND');
    expect((await api().post(msgs).set(h.bearer(player)).send({ body: 'x'.repeat(2001) }).expect(422)).body.code).toBe('TOURNAMENT_MESSAGE_TOO_LONG');
  });

  it('open → closed by the author: off the feed, no new comments or threads, an old thread goes on (M26-FR-08)', async () => {
    const author = await h.signupUser({ name: 'Rafi Karim' });
    const player = await h.signupUser({ name: 'Nadia Rahman' });
    const late = await h.signupUser({ name: 'Tanvir Ahmed' });
    const p = (await newPost(author, await form()).expect(201)).body;
    const t = (await api().post(`${P}/tournament-posts/${p.id}/threads`).set(h.bearer(player)).expect(201)).body;
    expect((await api().post(`${P}/me/tournament-posts/${p.id}/close`).set(h.bearer(player)).expect(403)).body.code).toBe('TOURNAMENT_POST_NOT_YOURS');
    expect((await api().post(`${P}/me/tournament-posts/${p.id}/close`).set(h.bearer(author)).expect(200)).body.status).toBe('closed');
    expect((await feed()).body.items).toEqual([]);
    const page = (await api().get(`${P}/tournament-posts/${p.slug}`).expect(200)).body;
    expect(page).toMatchObject({ status: 'closed', registrationOpen: false, can: { comment: false, message: false } });
    expect((await api().post(`${P}/tournament-posts/${p.id}/comments`).set(h.bearer(player)).send({ body: 'Too late?' }).expect(409)).body.code).toBe('TOURNAMENT_POST_STATE');
    expect((await api().post(`${P}/tournament-posts/${p.id}/threads`).set(h.bearer(late)).expect(409)).body.code).toBe('TOURNAMENT_POST_STATE');
    await api().post(`${P}/me/tournament-threads/${t.id}/messages`).set(h.bearer(player)).send({ body: 'Still on for Friday?' }).expect(201);
    expect((await api().patch(`${P}/me/tournament-posts/${p.id}`).set(h.bearer(author)).send(await form()).expect(409)).body.code).toBe('TOURNAMENT_POST_STATE');
    expect((await api().post(`${P}/me/tournament-posts/${p.id}/close`).set(h.bearer(author)).expect(409)).body.code).toBe('TOURNAMENT_POST_STATE');
  });

  it('the author edits an open post; only the author can (M26-FR-03)', async () => {
    const author = await h.signupUser({ name: 'Rafi Karim' });
    const other = await h.signupUser({ name: 'Nadia Rahman' });
    const p = (await newPost(author, await form()).expect(201)).body;
    const changed = await form({ title: 'Mirpur Futsal Cup, new date', startDate: inDays(25), endDate: null, entryFee: 0 });
    expect((await api().patch(`${P}/me/tournament-posts/${p.id}`).set(h.bearer(other)).send(changed).expect(403)).body.code).toBe('TOURNAMENT_POST_NOT_YOURS');
    await api().patch(`${P}/me/tournament-posts/${p.id}`).set(h.bearer(author)).send(changed).expect(200);
    const page = (await api().get(`${P}/tournament-posts/${p.slug}`).expect(200)).body;
    expect(page).toMatchObject({ title: 'Mirpur Futsal Cup, new date', startDate: inDays(25), endDate: null, entryFee: 0 });
    expect((await api().patch(`${P}/me/tournament-posts/${p.id}`).set(h.bearer(author)).send(await form({ description: 'Sixteen teams play over a weekend, call 01712345678 now.' })).expect(422)).body.code).toBe('CONTACT_NOT_ALLOWED');
    const mine = (await api().get(`${P}/me/tournament-posts`).set(h.bearer(author)).expect(200)).body;
    expect(mine.items.map((x) => x.id)).toEqual([p.id]);
  });

  it('photos: checked by their bytes, up to the setting; the first is the cover; removal is a status', async () => {
    const author = await h.signupUser({ name: 'Rafi Karim' });
    const other = await h.signupUser({ name: 'Nadia Rahman' });
    const p = (await newPost(author, await form()).expect(201)).body;
    const send = (who, type, buf) => api().post(`${P}/me/tournament-posts/${p.id}/photos`).set(h.bearer(who)).set('Content-Type', type).send(buf);
    expect((await send(author, 'image/png', Buffer.from('not a png at all')).expect(415)).body.code).toBe('FILE_TYPE_MISMATCH');
    expect((await send(other, 'image/png', f.PNG).expect(403)).body.code).toBe('TOURNAMENT_POST_NOT_YOURS');
    const one = (await send(author, 'image/png', f.PNG).expect(201)).body;
    const two = (await send(author, 'image/png', f.PNG).expect(201)).body;
    const page = async () => (await api().get(`${P}/tournament-posts/${p.slug}`).expect(200)).body;
    expect((await page()).photos.map((x) => x.id)).toEqual([one.id, two.id]);
    expect((await page()).cover).toBe(one.url);
    await api().post(`${P}/me/tournament-posts/${p.id}/photos/${one.id}/remove`).set(h.bearer(author)).expect(200);
    expect((await api().post(`${P}/me/tournament-posts/${p.id}/photos/${one.id}/remove`).set(h.bearer(author)).expect(404)).body.code).toBe('PHOTO_NOT_FOUND');
    expect((await page()).cover).toBe(two.url);
    expect(await models.TournamentPostPhoto.count({ where: { postId: p.id } })).toBe(2);
    for (let i = 0; i < 5; i += 1) await send(author, 'image/png', f.PNG).expect(201);
    expect((await send(author, 'image/png', f.PNG).expect(409)).body.code).toBe('PHOTO_LIMIT');
  });

  it('staff: open → removed with a reason, its author is told and still sees it; restored as it was (M26-FR-09)', async () => {
    const author = await h.signupUser({ name: 'Rafi Karim' });
    const player = await h.signupUser({ name: 'Nadia Rahman' });
    const staff = await f.staffWith(master, ['approve_listings']);
    const noPerm = await f.staffWith(master, ['refund_small']);
    const p = (await newPost(author, await form()).expect(201)).body;
    const t = (await api().post(`${P}/tournament-posts/${p.id}/threads`).set(h.bearer(player)).expect(201)).body;
    await api().get(`${P}/admin/tournament-posts`).set(h.bearer(noPerm)).expect(403);
    await api().post(`${P}/admin/tournament-posts/${p.id}/remove`).set(h.bearer(author)).send({ reason: 'Not staff at all' }).expect(401);
    await api().post(`${P}/admin/tournament-posts/${p.id}/remove`).set(h.bearer(staff)).send({ reason: 'x' }).expect(422);
    expect((await api().post(`${P}/admin/tournament-posts/${p.id}/restore`).set(h.bearer(staff)).send({ reason: 'Nothing to restore' }).expect(409)).body.code).toBe('TOURNAMENT_POST_STATE');
    expect((await api().post(`${P}/admin/tournament-posts/${p.id}/remove`).set(h.bearer(staff)).send({ reason: 'A fake tournament' }).expect(200)).body.status).toBe('removed');
    await h.drainEvents();
    expect(await codesOf(author.user.id)).toContain('TOURNAMENT_POST_REMOVED');
    expect((await feed()).body.items).toEqual([]);
    expect((await api().get(`${P}/tournament-posts/${p.slug}`).expect(404)).body.code).toBe('TOURNAMENT_POST_NOT_FOUND');
    expect((await api().get(`${P}/tournament-posts/${p.slug}`).set(h.bearer(author)).expect(200)).body).toMatchObject({ status: 'removed', removedReason: 'A fake tournament' });
    expect((await api().get(`${P}/me/tournament-posts`).set(h.bearer(author)).expect(200)).body.items[0]).toMatchObject({ status: 'removed', removedReason: 'A fake tournament' });
    expect((await api().get(`${P}/tournament-posts/${p.id}/comments`).expect(404)).body.code).toBe('TOURNAMENT_POST_NOT_FOUND');
    expect((await api().post(`${P}/tournament-posts/${p.id}/threads`).set(h.bearer(player)).expect(404)).body.code).toBe('TOURNAMENT_POST_NOT_FOUND');
    expect((await api().post(`${P}/me/tournament-threads/${t.id}/messages`).set(h.bearer(player)).send({ body: 'Hello?' }).expect(409)).body.code).toBe('TOURNAMENT_POST_STATE');
    expect((await api().get(`${P}/admin/tournament-posts?status=removed`).set(h.bearer(staff)).expect(200)).body.items).toHaveLength(1);
    expect((await api().get(`${P}/admin/tournament-posts/${p.id}`).set(h.bearer(staff)).expect(200)).body.removedReason).toBe('A fake tournament');

    expect((await api().post(`${P}/admin/tournament-posts/${p.id}/restore`).set(h.bearer(staff)).send({ reason: 'It was real after all' }).expect(200)).body.status).toBe('open');
    await h.drainEvents();
    expect(await codesOf(author.user.id)).toContain('TOURNAMENT_POST_RESTORED');
    expect((await feed()).body.items).toHaveLength(1);
    expect(await models.AuditLog.count({ where: { action: ['tournament_post.removed', 'tournament_post.restored'], entityId: p.id } })).toBe(2);
    // A closed post goes back to closed.
    await api().post(`${P}/me/tournament-posts/${p.id}/close`).set(h.bearer(author)).expect(200);
    await api().post(`${P}/admin/tournament-posts/${p.id}/remove`).set(h.bearer(staff)).send({ reason: 'A fake tournament' }).expect(200);
    expect((await api().post(`${P}/admin/tournament-posts/${p.id}/restore`).set(h.bearer(staff)).send({ reason: 'It was real after all' }).expect(200)).body.status).toBe('closed');
  });

  it('open → expired by the job after the last day plus the setting; other posts stay (M26-FR-08)', async () => {
    const author = await h.signupUser({ name: 'Rafi Karim' });
    const p = (await newPost(author, await form()).expect(201)).body;
    const soon = (await newPost(author, await form({ title: 'A later tournament' })).expect(201)).body;
    await models.TournamentPost.update({ startDate: inDays(-20), endDate: inDays(-8), registrationDeadline: inDays(-21) }, { where: { id: p.id } });
    await models.TournamentPost.update({ startDate: inDays(-20), endDate: inDays(-7), registrationDeadline: inDays(-21) }, { where: { id: soon.id } });
    expect(await jobs.tick()).toEqual({ expired: 1 });
    expect((await models.TournamentPost.findByPk(p.id)).status).toBe('expired');
    expect((await models.TournamentPost.findByPk(soon.id)).status).toBe('open');
    expect(await jobs.tick()).toEqual({ expired: 0 });
    expect((await feed()).body.items.map((x) => x.id)).toEqual([soon.id]);
    // Still readable, and read-only.
    expect((await api().get(`${P}/tournament-posts/${p.slug}`).expect(200)).body).toMatchObject({ status: 'expired', can: { comment: false } });
  });

  it('reports reach the M17 desk: upholding removes the post or the comment', async () => {
    const author = await h.signupUser({ name: 'Rafi Karim' });
    const r1 = await h.signupUser({ name: 'Nadia Rahman' });
    const staff = await f.staffWith(master, ['resolve_reports']);
    const p = (await newPost(author, await form()).expect(201)).body;
    const c = (await api().post(`${P}/tournament-posts/${p.id}/comments`).set(h.bearer(r1)).send({ body: 'This is a rude comment' }).expect(201)).body;
    await api().post(`${P}/reports`).set(h.bearer(r1)).send({ subjectType: 'tournament_post', subjectId: p.id, reasonCode: 'fraud' }).expect(201);
    await api().post(`${P}/reports`).set(h.bearer(author)).send({ subjectType: 'tournament_comment', subjectId: c.id, reasonCode: 'offensive' }).expect(201);
    const desk = (await api().get(`${P}/admin/reports`).set(h.bearer(staff)).expect(200)).body;
    expect(desk.items.map((x) => x.subjectType).sort()).toEqual(['tournament_comment', 'tournament_post']);
    const subj = (await api().get(`${P}/admin/reports/subjects/tournament_post/${p.id}`).set(h.bearer(staff)).expect(200)).body;
    expect(subj.subject).toMatchObject({ title: 'Mirpur Futsal Cup 2026' });
    await api().post(`${P}/admin/reports/resolve`).set(h.bearer(staff)).send({ subjectType: 'tournament_comment', subjectId: c.id, action: 'content_removed', note: 'Rude' }).expect(200);
    expect((await models.TournamentPostComment.findByPk(c.id)).status).toBe('removed');
    expect((await models.TournamentPost.findByPk(p.id)).commentCount).toBe(0);
    await api().post(`${P}/admin/reports/resolve`).set(h.bearer(staff)).send({ subjectType: 'tournament_post', subjectId: p.id, action: 'content_removed', note: 'Confirmed fake' }).expect(200);
    expect(await models.TournamentPost.findByPk(p.id)).toMatchObject({ status: 'removed', removedReason: 'Confirmed fake' });
    await api().post(`${P}/reports`).set(h.bearer(r1)).send({ subjectType: 'tournament_post', subjectId: author.user.id, reasonCode: 'fraud' }).expect(404);
  });
});
