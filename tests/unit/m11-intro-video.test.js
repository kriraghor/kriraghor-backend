'use strict';

// M11-FR-16: an intro video given as a link (YouTube, Vimeo, Facebook, Google Drive, OneDrive, Dropbox,
// .mp4/.webm/.m4v files, .m3u8 playlists), turned into what the page plays; never fetched or uploaded.
const { parseIntroVideo, introVideoView, PROVIDERS, MAX_LENGTH } = require('../../src/modules/hire/video.rules');

const play = (url, enabled) => parseIntroVideo(url, enabled);
const reason = (url, enabled) => parseIntroVideo(url, enabled).reason;

describe('M11-FR-16 intro video links', () => {
  it('YouTube: watch, youtu.be, shorts, embed and live links play through youtube-nocookie', () => {
    const embed = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';
    for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://youtube.com/embed/dQw4w9WgXcQ', 'https://www.youtube.com/live/dQw4w9WgXcQ'])
      expect(play(url)).toEqual({ ok: true, provider: 'youtube', kind: 'iframe', playUrl: embed });
    expect(reason('https://www.youtube.com/watch?v=short')).toBe('youtube_id');
    expect(reason('https://www.youtube.com/@kriraghor')).toBe('youtube_id');
    expect(reason('https://youtu.be/')).toBe('youtube_id');
  });

  it('Vimeo: public and private (hash) links, and player links', () => {
    expect(play('https://vimeo.com/123456789').playUrl).toBe('https://player.vimeo.com/video/123456789');
    expect(play('https://vimeo.com/123456789/abcdef1234').playUrl).toBe('https://player.vimeo.com/video/123456789?h=abcdef1234');
    expect(play('https://player.vimeo.com/video/42?h=0a1b2c3d').playUrl).toBe('https://player.vimeo.com/video/42?h=0a1b2c3d');
    expect(play('https://player.vimeo.com/video/42?h=not-hex!').playUrl).toBe('https://player.vimeo.com/video/42');
    expect(play('https://vimeo.com/987654?h=abcdef12').playUrl).toBe('https://player.vimeo.com/video/987654?h=abcdef12');
    expect(reason('https://vimeo.com/channels/staffpicks')).toBe('vimeo_id');
  });

  it('Facebook: page videos, reels and watch links through the video plugin; fb.watch is refused', () => {
    const r = play('https://www.facebook.com/kriraghor/videos/1234567890/');
    expect(r.provider).toBe('facebook');
    expect(r.playUrl).toBe(`https://www.facebook.com/plugins/video.php?href=${encodeURIComponent('https://www.facebook.com/kriraghor/videos/1234567890/')}&show_text=false`);
    expect(play('https://m.facebook.com/reel/987654321').ok).toBe(true);
    expect(play('https://web.facebook.com/watch?v=555').playUrl).toContain(encodeURIComponent('https://www.facebook.com/watch?v=555'));
    expect(play('https://www.facebook.com/kriraghor/videos/some-title/1234567890').ok).toBe(true);
    expect(reason('https://www.facebook.com/kriraghor')).toBe('facebook_video');
    expect(reason('https://www.facebook.com/watch?v=abc')).toBe('facebook_video');
    expect(reason('https://www.facebook.com/watch')).toBe('facebook_video');
    expect(reason('https://fb.watch/abc123/')).toBe('facebook_video');
  });

  it('Google Drive: file and open links play the preview', () => {
    const preview = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/preview';
    expect(play('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing').playUrl).toBe(preview);
    expect(play('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp').playUrl).toBe(preview);
    expect(reason('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp')).toBe('drive_file');
    expect(reason('https://drive.google.com/file/d/short/view')).toBe('drive_file');
  });

  it('OneDrive: only the embed link, keeping just the player parameters', () => {
    expect(play('https://onedrive.live.com/embed?cid=ABC&resid=ABC%21101&authkey=%21XYZ&em=2').playUrl).toBe('https://onedrive.live.com/embed?cid=ABC&resid=ABC%21101&authkey=%21XYZ');
    expect(play('https://onedrive.live.com/embed?redeem=aHR0cHM6').playUrl).toBe('https://onedrive.live.com/embed?redeem=aHR0cHM6');
    expect(reason('https://1drv.ms/v/s!AbCdEf')).toBe('onedrive_embed');
    expect(reason('https://onedrive.live.com/embed?cid=ABC')).toBe('onedrive_embed');
  });

  it('Dropbox: a shared video file plays raw, keeping its rlkey', () => {
    expect(play('https://www.dropbox.com/scl/fi/abc123/intro.mp4?rlkey=k1&dl=0')).toEqual({ ok: true, provider: 'dropbox', kind: 'file', playUrl: 'https://www.dropbox.com/scl/fi/abc123/intro.mp4?rlkey=k1&raw=1' });
    expect(play('https://dropbox.com/s/abc/intro.webm?dl=0').playUrl).toBe('https://www.dropbox.com/s/abc/intro.webm?raw=1');
    expect(reason('https://www.dropbox.com/scl/fi/abc123/notes.pdf?dl=0')).toBe('dropbox_file');
    expect(reason('https://www.dropbox.com/home')).toBe('dropbox_file');
  });

  it('Direct files and HLS playlists from any public https host', () => {
    expect(play('https://cdn.example.org/v/intro.MP4')).toEqual({ ok: true, provider: 'video_file', kind: 'file', playUrl: 'https://cdn.example.org/v/intro.MP4' });
    expect(play('https://media.example.org/live/index.m3u8?token=1')).toEqual({ ok: true, provider: 'hls', kind: 'hls', playUrl: 'https://media.example.org/live/index.m3u8?token=1' });
    expect(reason('https://example.org/watch/intro')).toBe('unsupported');
  });

  it('refuses http, user info, local hosts, long links and text that is not a link', () => {
    expect(reason('http://youtu.be/dQw4w9WgXcQ')).toBe('not_https');
    expect(reason('https://me:pw@cdn.example.org/a.mp4')).toBe('not_https');
    for (const url of ['https://localhost/a.mp4', 'https://127.0.0.1/a.mp4', 'https://[::1]/a.mp4', 'https://media.internal/a.mp4', 'https://box/a.mp4']) expect(reason(url)).toBe('local_host');
    expect(reason(`https://cdn.example.org/${'a'.repeat(MAX_LENGTH)}.mp4`)).toBe('too_long');
    expect(reason('my video')).toBe('unsupported');
    expect(reason(null)).toBe('unsupported');
    expect(parseIntroVideo('my video').message).toMatch(/YouTube/);
  });

  it('a provider switched off in hire.intro_video_providers is refused, and hidden on the page', () => {
    const on = PROVIDERS.filter((p) => p !== 'hls');
    expect(reason('https://media.example.org/a.m3u8', on)).toBe('provider_off');
    expect(play('https://youtu.be/dQw4w9WgXcQ', on).ok).toBe(true);
    expect(introVideoView('https://media.example.org/a.m3u8', on)).toBeNull();
    expect(introVideoView('  https://youtu.be/dQw4w9WgXcQ ')).toEqual({ url: 'https://youtu.be/dQw4w9WgXcQ', provider: 'youtube', kind: 'iframe', playUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
    expect(introVideoView(null)).toBeNull();
  });
});
