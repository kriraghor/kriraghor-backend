'use strict';

// Tester feedback batch 4 (19 Nov 2026): a hire profile needs the person's photo to be sent for review
// (M11-FR-17), and can show an intro video given as a link, never uploaded (M11-FR-16). The link is part of
// the working copy, so an edit of a live profile is reviewed before the public sees the video.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const x = require('../fixtures/hire');

const { api, P, models } = h;

let master;
let reviewer;
let docsReviewer;
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

const patch = (who, id, body) => api().patch(`${P}/pro/profiles/${id}`).set(h.bearer(who)).send(body);
const submit = (who, id) => api().post(`${P}/pro/profiles/${id}/submit`).set(h.bearer(who));
const YT = 'https://youtu.be/dQw4w9WgXcQ';
const YT_EMBED = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';

describe('M11-FR-16 and FR-17: profile photo and intro video', () => {
  it('a new profile is sent only with a photo, and can start with a video link', async () => {
    const pro = await x.applicant('pro', 'Nusrat Jahan');
    const draft = await api()
      .post(`${P}/pro/profiles`)
      .set(h.bearer(pro))
      .send({ roleKey: 'fitness_trainer', headline: 'Strength coach for beginners', experienceLevel: 'semi_pro', baseAreaId: await f.areaId('dhanmondi'), introVideoUrl: 'https://vimeo.com/123456789' })
      .expect(201);
    expect(draft.body.introVideo).toEqual({ url: 'https://vimeo.com/123456789', provider: 'vimeo', kind: 'iframe', playUrl: 'https://player.vimeo.com/video/123456789' });
    await api().put(`${P}/pro/profiles/${draft.body.id}/rate-card`).set(h.bearer(pro)).send({ ...x.UMPIRE_CARD, items: [{ unit: 'hourly', rate: 150000 }] }).expect(200);
    expect((await submit(pro, draft.body.id).expect(409)).body.code).toBe('PHOTO_REQUIRED');
    expect((await api().get(`${P}/pro/profiles/${draft.body.id}`).set(h.bearer(pro)).expect(200)).body.completeness.steps.find((s) => s.key === 'photo').done).toBe(false);
    await api().post(`${P}/me/avatar`).set(h.bearer(pro)).set('Content-Type', 'image/png').send(f.PNG).expect(200);
    expect((await submit(pro, draft.body.id).expect(200)).body.status).toBe('pending_review');
    // Reviewers see the photo and the link.
    const staff = (await api().get(`${P}/admin/hire/profiles/${draft.body.id}`).set(h.bearer(reviewer)).expect(200)).body;
    expect(staff.owner.avatarUrl).toMatch(/\/avatars\//);
    expect(staff.introVideoUrl).toBe('https://vimeo.com/123456789');
  });

  it('a link is checked when saved, reviewed with the edit, shown on the card and page, and can be removed', async () => {
    const { pro, profile } = await x.liveProfile({ docsReviewer, reviewer });
    expect(profile.introVideo).toBeNull();

    const bad = await patch(pro, profile.id, { introVideoUrl: 'https://fb.watch/abc123/' }).expect(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'introVideoUrl', code: 'facebook_video' });
    expect((await patch(pro, profile.id, { introVideoUrl: 'http://youtu.be/dQw4w9WgXcQ' }).expect(422)).body.errors[0].code).toBe('not_https');

    const saved = (await patch(pro, profile.id, { introVideoUrl: `  ${YT}  ` }).expect(200)).body;
    expect(saved).toMatchObject({ introVideoUrl: YT, editStatus: 'draft', introVideo: { provider: 'youtube', kind: 'iframe', playUrl: YT_EMBED } });
    // Not public until the edit is approved.
    const before = (await api().get(`${P}/hire/profiles/${profile.slug}`).expect(200)).body;
    expect(before).toMatchObject({ introVideo: null, hasIntroVideo: false });

    await submit(pro, profile.id).expect(200);
    await h.drainEvents();
    const sub = await models.Submission.findOne({ where: { kind: 'hire_profile', subjectId: profile.id, status: 'pending_review' } });
    expect(sub.payload.diff.introVideoUrl).toEqual({ from: null, to: YT });
    await f.review(reviewer, 'hire_profile', profile.id);

    const page = (await api().get(`${P}/hire/profiles/${profile.slug}`).expect(200)).body;
    expect(page.introVideo).toEqual({ url: YT, provider: 'youtube', kind: 'iframe', playUrl: YT_EMBED });
    const card = (await api().get(`${P}/hire/profiles?category=officials`).expect(200)).body.items.find((c) => c.id === profile.id);
    expect(card.hasIntroVideo).toBe(true);

    // A kind of link switched off is hidden from the page and refused on save.
    await h.setSettingForTest('hire.intro_video_providers', ['vimeo', 'video_file']);
    expect((await api().get(`${P}/hire/profiles/${profile.slug}`).expect(200)).body).toMatchObject({ introVideo: null, hasIntroVideo: false });
    expect((await patch(pro, profile.id, { introVideoUrl: YT }).expect(422)).body.errors[0].code).toBe('provider_off');
    await h.setSettingForTest('hire.intro_video_providers', ['youtube', 'vimeo', 'facebook', 'google_drive', 'onedrive', 'dropbox', 'video_file', 'hls']);

    // Removing it: an empty link clears the working copy; the edit is reviewed like any other.
    expect((await patch(pro, profile.id, { introVideoUrl: '' }).expect(200)).body).toMatchObject({ introVideoUrl: null, introVideo: null });
    await submit(pro, profile.id).expect(200);
    await h.drainEvents();
    await f.review(reviewer, 'hire_profile', profile.id);
    expect((await api().get(`${P}/hire/profiles/${profile.slug}`).expect(200)).body.introVideo).toBeNull();
  });

  it('an HLS playlist and a Dropbox file play in the page player, never through Kriraghor', async () => {
    const { pro, profile } = await x.liveProfile({ docsReviewer, reviewer });
    const hls = (await patch(pro, profile.id, { introVideoUrl: 'https://media.example.org/intro/index.m3u8' }).expect(200)).body.introVideo;
    expect(hls).toMatchObject({ provider: 'hls', kind: 'hls', playUrl: 'https://media.example.org/intro/index.m3u8' });
    const box = (await patch(pro, profile.id, { introVideoUrl: 'https://www.dropbox.com/scl/fi/abc/intro.mp4?rlkey=k1&dl=0' }).expect(200)).body.introVideo;
    expect(box).toMatchObject({ provider: 'dropbox', kind: 'file', playUrl: 'https://www.dropbox.com/scl/fi/abc/intro.mp4?rlkey=k1&raw=1' });
    // The database keeps links https only (chk_hire_profiles_intro_video).
    await expect(models.HireProfile.update({ introVideoUrl: 'http://x.example.org/a.mp4' }, { where: { id: profile.id } })).rejects.toThrow(/chk_hire_profiles_intro_video/);
  });
});
