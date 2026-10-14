'use strict';

/**
 * Origin allowlists (ADR-004). Entries are exact origins ("https://kriraghor.com") or
 * patterns with one wildcard label ("http://*.kriraghor.localhost"). A wildcard matches exactly
 * one DNS label, and every pattern is anchored, so "https://evil.com/?x=kriraghor.com"
 * and "https://a.b.kriraghor.localhost" never match.
 */
function compile(entries) {
  const exact = new Set();
  const patterns = [];
  for (const entry of entries) {
    if (entry.includes('*')) {
      const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
      const escaped = entry.replace(/[.+?^${}()|[\]\\/]/g, '\\$&').replace('*', label);
      patterns.push(new RegExp(`^${escaped}$`, 'i'));
    } else {
      exact.add(entry.toLowerCase().replace(/\/$/, ''));
    }
  }
  return (origin) => {
    if (!origin) return false;
    const o = origin.toLowerCase();
    return exact.has(o) || patterns.some((re) => re.test(o));
  };
}

/** Origin of a request: the Origin header, else the origin part of Referer. */
function requestOrigin(req) {
  const origin = req.get('origin');
  if (origin && origin !== 'null') return origin;
  const referer = req.get('referer');
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

module.exports = { compile, requestOrigin };
