'use strict';

const { compile, requestOrigin } = require('../../src/common/origins');

describe('origin allowlist (ADR-004)', () => {
  const allowed = compile(['https://kriraghor.com', 'https://www.kriraghor.com', 'https://*.esports.kriraghor.com', 'http://*.kriraghor.localhost']);

  it.each([
    ['https://kriraghor.com', true],
    ['https://KRIRAGHOR.com', true],
    ['https://www.kriraghor.com', true],
    ['https://dhaka-kings.esports.kriraghor.com', true],
    ['http://esports.kriraghor.localhost', true],
    ['http://kriraghor.com', false], // scheme matters
    ['https://kriraghor.com.evil.com', false],
    ['https://evil.com', false],
    ['https://a.b.esports.kriraghor.com', false], // one label only
    ['https://-bad.esports.kriraghor.com', false],
    ['http://kriraghor.localhost', false], // the wildcard needs a label
    [undefined, false],
  ])('%s → %s', (origin, expected) => {
    expect(allowed(origin)).toBe(expected);
  });

  it('reads Origin, then falls back to the Referer origin', () => {
    const req = (headers) => ({ get: (k) => headers[k.toLowerCase()] });
    expect(requestOrigin(req({ origin: 'https://kriraghor.com' }))).toBe('https://kriraghor.com');
    expect(requestOrigin(req({ origin: 'null', referer: 'https://kriraghor.com/me?x=1' }))).toBe('https://kriraghor.com');
    expect(requestOrigin(req({ referer: 'not a url' }))).toBeNull();
    expect(requestOrigin(req({}))).toBeNull();
  });
});
