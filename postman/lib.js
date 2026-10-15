'use strict';

/**
 * Shared helpers for the Postman collection builders (M03, M04): requests with bearer tokens for
 * master A or B, pre-minted step-up tokens taken from stepUpQueueA/B, and generated test scripts.
 */
const json = (o) => ({ mode: 'raw', raw: JSON.stringify(o, null, 2), options: { raw: { language: 'json' } } });

/** Test script: status/code assertions, extra checks, and saving values from 2xx responses. */
function tests({ save = {}, expect, checks = [] } = {}) {
  const exec = [
    'let j = null; try { j = pm.response.json(); } catch (e) {}',
    "const get = (o, p) => p.split('.').filter(Boolean).reduce((a, k) => (a == null ? undefined : a[k]), o);",
    'const ok = pm.response.code >= 200 && pm.response.code < 300;',
  ];
  for (const [k, p] of Object.entries(save)) {
    exec.push(`if (ok && j) { const v = get(j, '${p}'); if (v !== undefined && v !== null && v !== '') pm.collectionVariables.set('${k}', v); }`);
  }
  if (expect) {
    exec.push(`pm.test('status ${expect.status}${expect.code ? ` ${expect.code}` : ''}', () => {`);
    exec.push(`  pm.response.to.have.status(${expect.status});`);
    if (expect.code) exec.push(`  pm.expect(j && j.code).to.eql('${expect.code}');`);
    exec.push('});');
  }
  for (const [title, expr] of checks) exec.push(`pm.test(${JSON.stringify(title)}, () => { pm.expect(${expr}).to.eql(true); });`);
  return { listen: 'test', script: { type: 'text/javascript', exec } };
}

/** Pre-request: take the next pre-minted step-up token for master A or B, when the runner provided some. */
function takeStepUp(who) {
  const queue = `stepUpQueue${who}`;
  const target = who === 'A' ? 'stepUpToken' : 'stepUpTokenB';
  return {
    listen: 'prerequest',
    script: {
      type: 'text/javascript',
      exec: [
        `const q = String(pm.variables.get('${queue}') || '').split(',').filter(Boolean);`,
        `if (q.length) { pm.variables.set('${target}', q.shift()); pm.environment.set('${queue}', q.join(',')); }`,
      ],
    },
  };
}

function url(p) {
  const [pathname, qs] = p.split('?');
  const u = { raw: `{{baseUrl}}${p}`, host: ['{{baseUrl}}'], path: pathname.split('/').filter(Boolean) };
  if (qs) u.query = qs.split('&').map((kv) => { const [key, value] = kv.split('='); return { key, value }; });
  return u;
}

/** as: false (public), 'A' or 'B' (master). stepUp: send the step-up header for that master. */
const req = (name, method, p, { body, as = 'A', stepUp = false, desc, save, expect, checks, waitMs } = {}) => ({
  name,
  event: [
    ...(stepUp ? [takeStepUp(as)] : []),
    ...(waitMs ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: [`setTimeout(() => {}, ${waitMs});`] } }] : []),
    tests({ save, expect, checks }),
  ],
  request: {
    method,
    header: [
      ...(body ? [{ key: 'Content-Type', value: 'application/json' }] : []),
      ...(as === 'A' ? [{ key: 'Authorization', value: 'Bearer {{adminAccessToken}}' }] : []),
      ...(as === 'B' ? [{ key: 'Authorization', value: 'Bearer {{adminAccessToken2}}' }] : []),
      ...(stepUp ? [{ key: 'X-Step-Up', value: as === 'A' ? '{{stepUpToken}}' : '{{stepUpTokenB}}' }] : []),
    ],
    ...(body ? { body: json(body) } : {}),
    url: url(p),
    ...(desc ? { description: desc } : {}),
  },
});

module.exports = { json, tests, takeStepUp, url, req };
