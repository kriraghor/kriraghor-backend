'use strict';

// Round B1 end to end: the M01 avatar (/me/avatar, Me and the public views), the pro's availability
// calendar (M11 §4, §7, §9, FR-05, FR-14: blocks, weekly repeats, the public busy strip, requests over
// blocked time, the `available` check on accept, BLOCK_OVER_JOB, the horizon), the stats consumer
// (FR-52: jobs done, acceptance rate, reply time), the pro insights from the ledger (M19 §6.3 Pro), and
// profile completeness (hire and player).
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const x = require('../fixtures/hire');
const rules = require('../../src/modules/hire/hire.rules');

const { api, P, models } = h;
const DAY = 86400000;

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

const send = (who, body) => api().post(`${P}/hire/requests`).set(h.bearer(who)).set('Idempotency-Key', key('hr')).send(body);
const pro = (who, path, body) => api().post(`${P}/pro/${path}`).set(h.bearer(who)).send(body ?? {});
const me = (who, path, body) => api().post(`${P}/me/${path}`).set(h.bearer(who)).send(body ?? {});
const get = (who, path) => api().get(`${P}${path}`).set(h.bearer(who));
const putBlocks = (who, body) => api().put(`${P}/pro/availability/blocks`).set(h.bearer(who)).send(body);

/** Today's 00:00 Dhaka and `days` days on (ISO). */
const dayStart = (days = 0) => rules.dhakaMidnight(rules.addDays(rules.dhakaDay(new Date()), days)).toISOString();
/** hh:mm Dhaka on the day `days` from today (ISO). */
const dhakaAt = (days, hh, mm = 0) => new Date(Date.parse(dayStart(days)) + (hh * 60 + mm) * 60000).toISOString();

/** A confirmed request: sent, accepted and paid. */
async function confirmed(profile, proUser, { days = 4, manager } = {}) {
  const m = manager ?? (await h.signupUser({ name: 'Rafi Ahmed' }));
  const r = await send(m, await x.matchRequest(profile.id, [x.at1930(days)]));
  expect(r.status).toBe(201);
  await pro(proUser, `requests/${r.body.request.id}/accept`).expect(200);
  await h.payWithSimulator(m, (await models.HireRequest.findByPk(r.body.request.id)).paymentId);
  await h.drainEvents();
  return { manager: m, request: await models.HireRequest.findByPk(r.body.request.id), job: await models.HireJob.findOne({ where: { requestId: r.body.request.id } }) };
}

describe('Round B1', () => {
  it('M01 avatar: upload, type and size checks, Me and the public hire and player views, remove', async () => {
    const { pro: kamrul, profile } = await x.liveProfile({ docsReviewer, reviewer });
    // The profile went live with a photo (M11-FR-17); start this test without one.
    await api().delete(`${P}/me/avatar`).set(h.bearer(kamrul)).expect(200);
    expect((await get(kamrul, '/me').expect(200)).body.avatarUrl).toBeNull();
    const upload = (buf, type) => api().post(`${P}/me/avatar`).set(h.bearer(kamrul)).set('Content-Type', type).send(buf);
    expect((await upload(f.PNG, 'image/jpeg').expect(415)).body.code).toBe('FILE_TYPE_MISMATCH');
    expect((await upload(Buffer.from('%PDF-1.4'), 'application/pdf').expect(415)).body.code).toBe('FILE_TYPE_NOT_ALLOWED');
    await h.setSettingForTest('users.avatar_max_bytes', 262144);
    expect((await upload(Buffer.concat([f.PNG, Buffer.alloc(262144)]), 'image/png').expect(413)).body.code).toBe('FILE_TOO_LARGE');
    const done = (await upload(f.PNG, 'image/png').expect(200)).body;
    expect(done.avatarUrl).toMatch(new RegExp(`/avatars/${kamrul.user.id}/[0-9a-f]{16}\\.png$`));
    // The photo the profile went live with, then this one.
    expect(await models.AuditLog.count({ where: { action: 'user.avatar_updated', entityId: kamrul.user.id } })).toBe(2);

    const card = (await api().get(`${P}/hire/profiles?category=officials`).expect(200)).body.items[0];
    expect(card).toMatchObject({ id: profile.id, avatarUrl: done.avatarUrl, availableToday: true, acceptanceRate: null, medianReplyMinutes: null });
    expect((await api().get(`${P}/hire/profiles/${profile.slug}`).expect(200)).body.avatarUrl).toBe(done.avatarUrl);

    await api().put(`${P}/me/username`).set(h.bearer(kamrul)).send({ username: 'kamrul10' }).expect(200);
    await api().put(`${P}/me/player-profile`).set(h.bearer(kamrul)).send({ sports: [{ sportKey: 'cricket', positions: ['wicketkeeper'] }], bio: 'Keeps wicket on weekends.' }).expect(200);
    expect((await api().get(`${P}/players/kamrul10`).expect(200)).body.avatarUrl).toBe(done.avatarUrl);

    expect((await api().delete(`${P}/me/avatar`).set(h.bearer(kamrul)).expect(200)).body.avatarUrl).toBeNull();
    await api().delete(`${P}/me/avatar`).set(h.bearer(kamrul)).expect(200);
    // Removed at the start of this test and here; the second removal now has nothing to remove.
    expect(await models.AuditLog.count({ where: { action: 'user.avatar_removed', entityId: kamrul.user.id } })).toBe(2);
  });

  it('availability: blocks and weekly repeats, the busy strip without reasons, requests over blocked time, the accept re-check, jobs and the horizon (FR-05, FR-14)', async () => {
    const { pro: kamrul, profile } = await x.liveProfile({ docsReviewer, reviewer });
    const m = await h.signupUser({ name: 'Rafi Ahmed' });

    // A one-off block on day 6 (19:00–23:30 Dhaka) and every day-9 weekday 18:00–22:00 as a repeat.
    const weekday9 = new Date(Date.parse(dayStart(9)) + 6 * 3600000).getUTCDay();
    const saved = (
      await putBlocks(kamrul, {
        from: dayStart(0),
        to: dayStart(14),
        blocks: [{ start: dhakaAt(6, 19), end: dhakaAt(6, 23, 30), reason: 'Family wedding' }],
        repeats: [{ weekdays: [weekday9], from: '18:00', to: '22:00', reason: 'League nights' }],
      }).expect(200)
    ).body;
    expect(saved.blocks).toEqual([expect.objectContaining({ start: dhakaAt(6, 19), end: dhakaAt(6, 23, 30), reason: 'Family wedding' })]);
    expect(saved.repeats).toEqual([expect.objectContaining({ weekdays: [weekday9], from: '18:00', to: '22:00', reason: 'League nights' })]);
    expect(saved.spans.filter((s) => s.repeat).map((s) => s.start)).toEqual(expect.arrayContaining([dhakaAt(2, 18), dhakaAt(9, 18)]));
    expect(saved.spans.filter((s) => s.repeat)).toHaveLength(2);
    expect(await models.AuditLog.count({ where: { action: 'availability.updated', entityId: kamrul.user.id } })).toBe(1);

    // The public busy strip: times only.
    const busy = (await api().get(`${P}/hire/profiles/${profile.id}/availability?from=${encodeURIComponent(dayStart(0))}&to=${encodeURIComponent(dayStart(14))}`).expect(200)).body;
    expect(busy.busy).toEqual(expect.arrayContaining([{ start: dhakaAt(6, 19), end: dhakaAt(6, 23, 30) }, { start: dhakaAt(9, 18), end: dhakaAt(9, 22) }]));
    expect(JSON.stringify(busy)).not.toMatch(/wedding|League/);
    expect((await api().get(`${P}/hire/profiles/${profile.slug}`).expect(200)).body.busy).toEqual(expect.arrayContaining([{ start: dhakaAt(6, 19), end: dhakaAt(6, 23, 30) }]));

    // A request over the block (19:30 on day 6, or day 9) is refused; another day is fine.
    expect((await send(m, await x.matchRequest(profile.id, [dhakaAt(6, 19, 30)]))).body.code).toBe('PRO_UNAVAILABLE');
    expect((await send(m, await x.matchRequest(profile.id, [dhakaAt(9, 19, 30)]))).body.code).toBe('PRO_UNAVAILABLE');
    const open = await send(m, await x.matchRequest(profile.id, [dhakaAt(8, 19, 30)]));
    expect(open.status).toBe(201);

    // The pro then blocks day 8 (and drops the day-6 block): the check shows and accept refuses.
    const second = (await putBlocks(kamrul, { from: dayStart(0), to: dayStart(14), blocks: [{ start: dhakaAt(8, 19), end: dhakaAt(8, 21) }] }).expect(200)).body;
    expect(second.blocks).toEqual([expect.objectContaining({ start: dhakaAt(8, 19), reason: null })]);
    expect(second.repeats).toHaveLength(1); // repeats left alone when not sent
    expect(await models.AvailabilityBlock.count({ where: { userId: kamrul.user.id, status: 'removed' } })).toBe(1);
    const pending = (await get(kamrul, '/pro/requests?status=pending').expect(200)).body.items;
    expect(pending[0].checks.find((ch) => ch.key === 'available')).toEqual({ key: 'available', ok: false });
    expect((await pro(kamrul, `requests/${open.body.request.id}/accept`).expect(422)).body).toMatchObject({ code: 'CHECKS_FAILED', errors: [{ field: 'available' }] });

    // Clearing the calendar (and the repeats) frees it; a booked job cannot be blocked over.
    await putBlocks(kamrul, { from: dayStart(0), to: dayStart(14), blocks: [], repeats: [] }).expect(200);
    expect((await pro(kamrul, `requests/${open.body.request.id}/accept`).expect(200)).body.request.status).toBe('accepted_unpaid');
    const over = await putBlocks(kamrul, { from: dayStart(0), to: dayStart(14), blocks: [{ start: dhakaAt(8, 20), end: dhakaAt(8, 21) }] }).expect(409);
    expect(over.body).toMatchObject({ code: 'BLOCK_OVER_JOB' });
    const mine = (await get(kamrul, `/pro/availability?from=${encodeURIComponent(dayStart(7))}&to=${encodeURIComponent(dayStart(10))}`).expect(200)).body;
    expect(mine).toMatchObject({ blocks: [], repeats: [], booked: [{ start: dhakaAt(8, 19, 30), locked: true, status: 'reserved' }], horizonDays: 60 });

    // The horizon and bad ranges.
    expect((await putBlocks(kamrul, { from: dayStart(0), to: dayStart(70), blocks: [] }).expect(422)).body.errors[0]).toMatchObject({ field: 'to' });
    expect((await putBlocks(kamrul, { from: dayStart(-1), to: dayStart(3), blocks: [] }).expect(422)).body.errors[0]).toMatchObject({ field: 'from' });
    expect((await putBlocks(kamrul, { from: dayStart(0), to: dayStart(3), blocks: [], repeats: [{ weekdays: [1, 1], from: '18:00', to: '20:00' }] }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    await get(kamrul, `/pro/availability?from=${encodeURIComponent(dayStart(0))}&to=${encodeURIComponent(dayStart(90))}`).expect(422);

    // A whole day blocked: not available today in the directory.
    await putBlocks(kamrul, { from: dayStart(0), to: dayStart(1), blocks: [{ start: dayStart(0), end: dayStart(1) }] }).expect(200);
    expect((await api().get(`${P}/hire/profiles?category=officials`).expect(200)).body.items[0].availableToday).toBe(false);
  }, 120000);

  it('stats (FR-52), insights from the ledger (M19 §6.3) and completeness', async () => {
    const { pro: kamrul, profile } = await x.liveProfile({ docsReviewer, reviewer });
    // A released job: ৳4,500 less 10% = ৳4,050 earned today.
    const one = await confirmed(profile, kamrul);
    await x.moveJob(one.job.id, 5);
    await pro(kamrul, `jobs/${one.job.id}/check-in`).expect(200);
    await pro(kamrul, `jobs/${one.job.id}/complete`, { note: 'Umpired the full match' }).expect(200);
    await me(one.manager, `hire-jobs/${one.job.id}/confirm`).expect(200);
    // A second one marked complete and waiting for release; a third request declined.
    const two = await confirmed(profile, kamrul, { days: 6 });
    await x.moveJob(two.job.id, 5);
    await pro(kamrul, `jobs/${two.job.id}/check-in`).expect(200);
    await pro(kamrul, `jobs/${two.job.id}/complete`).expect(200);
    const third = await send(one.manager, await x.matchRequest(profile.id, [x.at1930(10)]));
    await models.sequelize.query("UPDATE hire_requests SET created_at = now() - interval '40 minutes' WHERE id = ?", { replacements: [third.body.request.id] });
    await pro(kamrul, `requests/${third.body.request.id}/decline`, { reason: 'fee_too_low' }).expect(200);
    await h.drainEvents();

    const row = await models.HireProfile.findByPk(profile.id);
    expect(row).toMatchObject({ jobsDone: 1, acceptanceRate: 66.67 });
    expect(row.medianReplyMinutes).toBeGreaterThanOrEqual(0);
    expect(row.medianReplyMinutes).toBeLessThanOrEqual(40);
    const card = (await api().get(`${P}/hire/profiles?category=officials`).expect(200)).body.items[0];
    expect(card).toMatchObject({ jobsDone: 1, acceptanceRate: 66.67, medianReplyMinutes: row.medianReplyMinutes });

    const ins = (await get(kamrul, '/pro/insights?period=7w').expect(200)).body;
    expect(ins.buckets).toHaveLength(7);
    expect(ins.buckets[6].amount).toBe(405000);
    expect(ins).toMatchObject({
      period: '7w',
      earned: { total: 405000, previous: 0, delta: null },
      releasingSoon: { net: 405000, count: 1, nextAt: expect.any(String) },
      jobs: { done: 1, upcoming: 0 },
      acceptanceRate: 66.67,
      rating: { avg: null, count: 0 },
      whoHiresYou: [{ key: 'individual', label: 'Individual', jobs: 2 }],
    });
    const year = (await get(kamrul, '/pro/insights?period=yr').expect(200)).body;
    expect(year.buckets).toHaveLength(12);
    expect(year.earned.total).toBe(405000);
    await get(kamrul, '/pro/insights?period=month').expect(422);
    // Someone with nothing yet.
    const nobody = await h.signupUser({ name: 'New Person' });
    expect((await get(nobody, '/pro/insights').expect(200)).body).toMatchObject({ earned: { total: 0 }, acceptanceRate: null, whoHiresYou: [] });

    // Completeness: the profile is missing its photo (removed after going live), a longer bio, the calendar and a payout account.
    await api().delete(`${P}/me/avatar`).set(h.bearer(kamrul)).expect(200);
    const mineView = (await get(kamrul, `/pro/profiles/${profile.id}`).expect(200)).body;
    expect(mineView.stats).toMatchObject({ jobsDone: 1, acceptanceRate: 66.67 });
    const steps = Object.fromEntries(mineView.completeness.steps.map((s) => [s.key, s.done]));
    expect(steps).toEqual({ photo: false, headline: true, bio: false, rateCard: true, credential: true, availability: false, payoutAccount: false });
    expect(mineView.completeness.score).toBe(43);
    await api().post(`${P}/me/avatar`).set(h.bearer(kamrul)).set('Content-Type', 'image/png').send(f.PNG).expect(200);
    await putBlocks(kamrul, { from: dayStart(20), to: dayStart(21), blocks: [{ start: dhakaAt(20, 10), end: dhakaAt(20, 12) }] }).expect(200);
    const after = (await get(kamrul, `/pro/profiles/${profile.id}`).expect(200)).body.completeness;
    expect(after.steps.filter((s) => s.done).map((s) => s.key)).toEqual(['photo', 'headline', 'rateCard', 'credential', 'availability']);

    const player = (await get(kamrul, '/me/player-profile').expect(200)).body;
    expect(player.completeness).toEqual({ score: 20, steps: [{ key: 'sports', done: false }, { key: 'bio', done: false }, { key: 'team', done: false }, { key: 'esportsUid', done: false }, { key: 'nid', done: true }] });

    // The bio step follows hire.profile_bio_min_chars.
    await h.setSettingForTest('hire.profile_bio_min_chars', 0);
    expect((await get(kamrul, `/pro/profiles/${profile.id}`).expect(200)).body.completeness.steps.find((s) => s.key === 'bio').done).toBe(true);

    // Nightly hire.stats-recompute: requests older than hire.acceptance_window_days stop counting; released jobs stay.
    await models.sequelize.query("UPDATE hire_requests SET created_at = now() - interval '100 days' WHERE profile_id = ?", { replacements: [profile.id] });
    expect((await require('../../src/modules/hire/hire.jobs').recomputeStats()).profiles).toBeGreaterThanOrEqual(1);
    expect(await models.HireProfile.findByPk(profile.id)).toMatchObject({ jobsDone: 1, acceptanceRate: null, medianReplyMinutes: null });
  }, 120000);

  it('ledger earningsBy groups released net by Dhaka day and purpose, and ignores other accounts', async () => {
    const ledger = require('../../src/modules/payments').ledger;
    expect(await ledger.earningsBy(master.user.id, { purposes: [], from: new Date(0), to: new Date() })).toEqual([]);
    expect(await ledger.earningsBy(master.user.id, { purposes: ['hire'], from: new Date(Date.now() - DAY), to: new Date(Date.now() + DAY) })).toEqual([]);
  });
});
