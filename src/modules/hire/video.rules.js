'use strict';

/**
 * M11-FR-16 (tester feedback, 19 Nov 2026): an intro video on a hire profile, given as a link and never
 * uploaded to Kriraghor. Pure: nothing here fetches the link. A link is recognised by its host and turned
 * into what the page plays:
 *   iframe  YouTube (youtube-nocookie), Vimeo, Facebook, Google Drive, OneDrive (its embed link)
 *   file    Dropbox (raw=1) and any https link to an .mp4, .webm or .m4v file, played by <video>
 *   hls     an https link to an .m3u8 playlist (native HLS in Safari, hls.js elsewhere)
 * Providers can be switched off with the setting hire.intro_video_providers (provider keys below).
 */

const PROVIDERS = ['youtube', 'vimeo', 'facebook', 'google_drive', 'onedrive', 'dropbox', 'video_file', 'hls'];
const MAX_LENGTH = 500;

const YOUTUBE = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const VIMEO = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
const FACEBOOK = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com']);
const DROPBOX = new Set(['dropbox.com', 'www.dropbox.com']);
const VIDEO_FILE = /\.(mp4|webm|m4v)$/i;

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;

/** Why a link is refused (shown under the field). */
const REASONS = {
  not_https: 'Use an https:// link',
  too_long: `Use a link of at most ${MAX_LENGTH} characters`,
  local_host: 'Use a public link',
  unsupported: 'Use a YouTube, Vimeo, Facebook, Google Drive, OneDrive or Dropbox link, or a link to an .mp4, .webm or .m3u8 file',
  youtube_id: 'Use the link of one YouTube video',
  vimeo_id: 'Use the link of one Vimeo video',
  facebook_video: 'Use the full facebook.com link of the video (fb.watch links cannot be shown)',
  drive_file: 'Use the share link of one Google Drive file',
  onedrive_embed: 'In OneDrive choose Embed and paste the link from the code (onedrive.live.com/embed?…)',
  dropbox_file: 'Use the share link of one video file (.mp4, .webm or .m4v) in Dropbox',
  provider_off: 'This kind of video link is not accepted at the moment',
};

const fail = (reason) => ({ ok: false, reason, message: REASONS[reason] });
const ok = (provider, kind, playUrl) => ({ ok: true, provider, kind, playUrl });

function youtube(u) {
  let id = null;
  if (u.hostname === 'youtu.be') id = u.pathname.split('/')[1];
  else if (u.pathname === '/watch') id = u.searchParams.get('v');
  else {
    const m = u.pathname.match(/^\/(shorts|embed|live)\/([^/]+)/);
    id = m ? m[2] : null;
  }
  return id && YT_ID.test(id) ? ok('youtube', 'iframe', `https://www.youtube-nocookie.com/embed/${id}`) : fail('youtube_id');
}

function vimeo(u) {
  const m = u.hostname === 'player.vimeo.com' ? u.pathname.match(/^\/video\/(\d{1,15})$/) : u.pathname.match(/^\/(\d{1,15})(?:\/([a-f0-9]{6,20}))?$/);
  if (!m) return fail('vimeo_id');
  const hash = m[2] ?? u.searchParams.get('h');
  return ok('vimeo', 'iframe', `https://player.vimeo.com/video/${m[1]}${hash && /^[a-f0-9]{6,20}$/.test(hash) ? `?h=${hash}` : ''}`);
}

function facebook(u) {
  const video = /^\/[^/]+\/videos\/(?:[^/]+\/)?\d+\/?$/.test(u.pathname) || /^\/reel\/\d+\/?$/.test(u.pathname) || (u.pathname === '/watch' && /^\d+$/.test(u.searchParams.get('v') ?? ''));
  if (!video) return fail('facebook_video');
  const href = `https://www.facebook.com${u.pathname}${u.pathname === '/watch' ? `?v=${u.searchParams.get('v')}` : ''}`;
  return ok('facebook', 'iframe', `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(href)}&show_text=false`);
}

function drive(u) {
  const m = u.pathname.match(/^\/file\/d\/([^/]+)/);
  const id = m ? m[1] : u.pathname === '/open' ? u.searchParams.get('id') : null;
  return id && DRIVE_ID.test(id) ? ok('google_drive', 'iframe', `https://drive.google.com/file/d/${id}/preview`) : fail('drive_file');
}

function onedrive(u) {
  // Only the embed link carries what the player needs; share links (1drv.ms, /redir) would have to be fetched.
  if (u.pathname !== '/embed') return fail('onedrive_embed');
  const keep = new URLSearchParams();
  for (const k of ['cid', 'resid', 'authkey', 'redeem']) if (u.searchParams.get(k)) keep.set(k, u.searchParams.get(k));
  if (!keep.get('resid') && !keep.get('redeem')) return fail('onedrive_embed');
  return ok('onedrive', 'iframe', `https://onedrive.live.com/embed?${keep.toString()}`);
}

function dropbox(u) {
  if (!/^\/(s|scl\/fi)\//.test(u.pathname) || !VIDEO_FILE.test(u.pathname)) return fail('dropbox_file');
  const q = new URLSearchParams();
  if (u.searchParams.get('rlkey')) q.set('rlkey', u.searchParams.get('rlkey'));
  q.set('raw', '1');
  return ok('dropbox', 'file', `https://www.dropbox.com${u.pathname}?${q.toString()}`);
}

/** Every recognised provider, before the on/off setting is applied. */
function recognise(raw) {
  const text = String(raw ?? '').trim();
  if (text.length > MAX_LENGTH) return fail('too_long');
  let u;
  try {
    u = new URL(text);
  } catch {
    return fail('unsupported');
  }
  if (u.protocol !== 'https:' || u.username || u.password) return fail('not_https');
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[') || /(^|\.)(localhost|local|internal)$/.test(host)) return fail('local_host');
  if (YOUTUBE.has(host)) return youtube(u);
  if (VIMEO.has(host)) return vimeo(u);
  if (FACEBOOK.has(host)) return facebook(u);
  if (host === 'fb.watch') return fail('facebook_video');
  if (host === 'drive.google.com') return drive(u);
  if (host === 'onedrive.live.com' || host === '1drv.ms') return onedrive(u);
  if (DROPBOX.has(host)) return dropbox(u);
  if (/\.m3u8$/i.test(u.pathname)) return ok('hls', 'hls', u.toString());
  if (VIDEO_FILE.test(u.pathname)) return ok('video_file', 'file', u.toString());
  return fail('unsupported');
}

/** The intro video for a link, or why it is refused; `enabled` is hire.intro_video_providers. */
function parseIntroVideo(raw, enabled = PROVIDERS) {
  const r = recognise(raw);
  if (r.ok && !enabled.includes(r.provider)) return fail('provider_off');
  return r;
}

/** What the public page gets for a stored link: null when it is no longer accepted. */
function introVideoView(raw, enabled = PROVIDERS) {
  if (!raw) return null;
  const r = parseIntroVideo(raw, enabled);
  return r.ok ? { url: String(raw).trim(), provider: r.provider, kind: r.kind, playUrl: r.playUrl } : null;
}

module.exports = { PROVIDERS, MAX_LENGTH, REASONS, parseIntroVideo, introVideoView };
