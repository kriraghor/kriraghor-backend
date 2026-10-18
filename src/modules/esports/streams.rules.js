'use strict';

/**
 * Stream links and embeds (M21-FR-29, M23). Pure. A link is accepted when it is https on the
 * platform's own hosts; the canonical video or channel reference is parsed from it so embeds are built
 * from the reference, never from the stored URL. Nothing here fetches a URL (no oEmbed, no SSRF).
 *
 *   YouTube   watch?v=<id> · youtu.be/<id> · /live/<id> · /embed/<id>   → yt:v:<id>
 *             /channel/UC…/live                                          → yt:c:<channel>
 *   Facebook  /watch/?v=<n>                                              → fb:watch:<n>
 *             /<page>/videos/<n> (or /<page>/videos/<slug>/<n>)          → fb:<page>/<n>
 *   Anything else on a known host (TikTok live, @handle links, fb.watch) is a link without an embed.
 */
const HOSTS = {
  youtube: ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'],
  facebook: ['facebook.com', 'www.facebook.com', 'fb.watch', 'm.facebook.com'],
  tiktok: ['tiktok.com', 'www.tiktok.com'],
};
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const FB_PAGE = /^[A-Za-z0-9.]{1,80}$/;
const DIGITS = /^\d{5,25}$/;

function youtubeRef(u) {
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.hostname === 'youtu.be') return YT_ID.test(parts[0] ?? '') ? `yt:v:${parts[0]}` : null;
  if (parts[0] === 'watch') {
    const v = u.searchParams.get('v') ?? '';
    return YT_ID.test(v) ? `yt:v:${v}` : null;
  }
  if ((parts[0] === 'live' || parts[0] === 'embed') && YT_ID.test(parts[1] ?? '')) return `yt:v:${parts[1]}`;
  if (parts[0] === 'channel' && YT_CHANNEL.test(parts[1] ?? '') && parts[2] === 'live') return `yt:c:${parts[1]}`;
  return null;
}

function facebookRef(u) {
  if (u.hostname === 'fb.watch') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'watch') {
    const v = u.searchParams.get('v') ?? '';
    return DIGITS.test(v) ? `fb:watch:${v}` : null;
  }
  if (parts[1] === 'videos' && FB_PAGE.test(parts[0])) {
    const n = DIGITS.test(parts[2] ?? '') ? parts[2] : parts[3];
    return DIGITS.test(n ?? '') ? `fb:${parts[0]}/${n}` : null;
  }
  return null;
}

/**
 * { ref } for an acceptable link (ref null = link only), or { error: 'STREAM_URL_INVALID' }.
 * `other` (M21 only) takes any https link and never embeds.
 */
function parseStream(platform, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { error: 'STREAM_URL_INVALID' };
  }
  if (u.protocol !== 'https:' || u.username || u.password) return { error: 'STREAM_URL_INVALID' };
  if (platform === 'other') return { ref: null };
  if (!HOSTS[platform] || !HOSTS[platform].includes(u.hostname)) return { error: 'STREAM_URL_INVALID' };
  if (platform === 'youtube') return { ref: youtubeRef(u) };
  if (platform === 'facebook') return { ref: facebookRef(u) };
  return { ref: null };
}

/** The player URL for a reference (null = no embed: show the link). */
const REFS = [
  [/^yt:v:([A-Za-z0-9_-]{11})$/, (m) => `https://www.youtube-nocookie.com/embed/${m[1]}`],
  [/^yt:c:(UC[A-Za-z0-9_-]{22})$/, (m) => `https://www.youtube-nocookie.com/embed/live_stream?channel=${m[1]}`],
  [/^fb:watch:(\d{5,25})$/, (m) => fbPlayer(`https://www.facebook.com/watch/?v=${m[1]}`)],
  [/^fb:([A-Za-z0-9.]{1,80})\/(\d{5,25})$/, (m) => fbPlayer(`https://www.facebook.com/${m[1]}/videos/${m[2]}/`)],
];
function fbPlayer(href) {
  return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(href)}&show_text=false`;
}
function embedFor(ref) {
  for (const [re, url] of REFS) {
    const m = re.exec(ref ?? '');
    if (m) return url(m);
  }
  return null;
}

module.exports = { HOSTS, parseStream, embedFor };
