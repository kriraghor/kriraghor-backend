'use strict';

/**
 * WhatsApp provider facade (M24 §25, ADR-012): Meta's WhatsApp Cloud API for gyms' own numbers, connected
 * through Kriraghor's Meta app (embedded sign-up, coexistence). Drivers:
 *  - memory:  keeps calls in memory, answers like Meta (automated tests);
 *  - console: prints one line per call, no network (local development);
 *  - cloud:   the Graph API at config.whatsapp.graphUrl (production, once gym_whatsapp.api_enabled is on).
 * Every function throws on failure with err.code (Meta's error code as text, or 'network'), so callers record
 * why a message failed. Tokens and numbers are never logged.
 */
const crypto = require('crypto');
const config = require('../../config');

const calls = [];
const randomId = (p) => `${p}${crypto.randomInt(1e9, 9e9)}`;

function fail(code, message) {
  const err = new Error(message);
  err.code = String(code);
  return err;
}

async function graph(method, path, { token = null, body = null, query = null } = {}) {
  const url = new URL(`${config.whatsapp.graphUrl}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw fail('network', `WhatsApp Cloud API unreachable: ${e.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw fail(data.error?.code ?? res.status, data.error?.message ?? `WhatsApp Cloud API ${res.status}`);
  return data;
}

const cloud = {
  // The embedded sign-up's code → a business integration system user token for the gym's account.
  exchangeCode: async ({ code }) => {
    const r = await graph('GET', 'oauth/access_token', { query: { client_id: config.whatsapp.appId, client_secret: config.whatsapp.appSecret, code } });
    return { token: r.access_token };
  },
  phoneInfo: async ({ phoneNumberId, token }) => {
    const r = await graph('GET', phoneNumberId, { token, query: { fields: 'display_phone_number,verified_name,quality_rating,messaging_limit_tier' } });
    return { displayNumber: r.display_phone_number, verifiedName: r.verified_name ?? null, quality: r.quality_rating ?? null, messagingLimit: r.messaging_limit_tier ?? null };
  },
  subscribeApp: async ({ wabaId, token }) => graph('POST', `${wabaId}/subscribed_apps`, { token }),
  // Kriraghor pays Meta: share Kriraghor's credit line with the gym's account (needs Solution Partner status).
  attachCredit: async ({ wabaId }) => {
    if (!config.whatsapp.creditLineId) return { attached: false };
    await graph('POST', `${config.whatsapp.creditLineId}/whatsapp_credit_sharing_and_attach`, { token: `${config.whatsapp.appId}|${config.whatsapp.appSecret}`, query: { waba_id: wabaId, waba_currency: 'USD' } });
    return { attached: true };
  },
  createTemplate: async ({ wabaId, token, body }) => {
    const r = await graph('POST', `${wabaId}/message_templates`, { token, body });
    return { metaId: String(r.id), status: String(r.status ?? 'PENDING').toLowerCase(), category: String(r.category ?? body.category).toLowerCase() };
  },
  listTemplates: async ({ wabaId, token }) => {
    const r = await graph('GET', `${wabaId}/message_templates`, { token, query: { fields: 'id,name,language,status,category,rejected_reason', limit: '100' } });
    return (r.data ?? []).map((t) => ({ metaId: String(t.id), code: t.name, locale: t.language, status: String(t.status).toLowerCase(), category: String(t.category).toLowerCase(), reason: t.rejected_reason ?? null }));
  },
  sendTemplate: async ({ phoneNumberId, token, to, template, locale, values }) => {
    const r = await graph('POST', `${phoneNumberId}/messages`, {
      token,
      body: { messaging_product: 'whatsapp', to, type: 'template', template: { name: template, language: { code: locale }, components: [{ type: 'body', parameters: values.map((text) => ({ type: 'text', text })) }] } },
    });
    return { wamid: r.messages?.[0]?.id };
  },
};

const memory = {
  exchangeCode: async ({ code }) => {
    calls.push({ fn: 'exchangeCode' });
    if (code === 'bad-code') throw fail(100, 'Invalid verification code');
    return { token: `token-${code}` };
  },
  phoneInfo: async ({ phoneNumberId }) => {
    calls.push({ fn: 'phoneInfo', phoneNumberId });
    return { displayNumber: '+880 1700-000000', verifiedName: 'Test Gym', quality: 'GREEN', messagingLimit: 'TIER_250' };
  },
  subscribeApp: async ({ wabaId }) => calls.push({ fn: 'subscribeApp', wabaId }),
  attachCredit: async ({ wabaId }) => {
    calls.push({ fn: 'attachCredit', wabaId });
    return { attached: Boolean(config.whatsapp.creditLineId) };
  },
  createTemplate: async ({ wabaId, body }) => {
    calls.push({ fn: 'createTemplate', wabaId, name: body.name, language: body.language });
    return { metaId: randomId('tpl'), status: 'pending', category: body.category.toLowerCase() };
  },
  listTemplates: async () => [],
  sendTemplate: async ({ phoneNumberId, to, template, locale, values }) => {
    if (to.endsWith('0000000')) throw fail(131026, 'Message undeliverable');
    const wamid = `wamid.${randomId('')}`;
    calls.push({ fn: 'sendTemplate', phoneNumberId, to, template, locale, values, wamid });
    return { wamid };
  },
};

const consoleDriver = Object.fromEntries(
  Object.entries(memory).map(([name, fn]) => [
    name,
    async (args) => {
      // eslint-disable-next-line no-console
      console.log(`[whatsapp:console] ${name}${args.template ? ` ${args.template}/${args.locale}` : ''}`);
      return fn(args);
    },
  ])
);

const drivers = { cloud, memory, console: consoleDriver };
const driver = () => drivers[config.whatsapp.driver];

/** Meta's webhook signature: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). */
function signatureValid(raw, header, secret = config.whatsapp.appSecret) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=') || !Buffer.isBuffer(raw)) return false;
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

module.exports = {
  exchangeCode: (a) => driver().exchangeCode(a),
  phoneInfo: (a) => driver().phoneInfo(a),
  subscribeApp: (a) => driver().subscribeApp(a),
  attachCredit: (a) => driver().attachCredit(a),
  createTemplate: (a) => driver().createTemplate(a),
  listTemplates: (a) => driver().listTemplates(a),
  sendTemplate: (a) => driver().sendTemplate(a),
  signatureValid,
  /** Test helpers. */
  calls: () => [...calls],
  sent: () => calls.filter((c) => c.fn === 'sendTemplate'),
  clear: () => calls.splice(0, calls.length),
};
