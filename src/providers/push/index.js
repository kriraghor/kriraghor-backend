'use strict';

const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../common/logger');

/**
 * Push provider facade (M08 push channel, the mobile app). Drivers:
 *  - log:    one log line per message, without the text (local development)
 *  - memory: keeps messages in memory (automated tests)
 *  - expo:   the Expo push API (https://docs.expo.dev/push-notifications/sending-notifications/)
 *
 * send(messages) → one ticket per message, in order: { ok: true, id } or { ok: false, error, message }.
 * It throws only when the whole request failed (network, 5xx), so M08 can retry the delivery.
 * receipts(ids) → Map id → { ok: true } | { ok: false, error, message }; ids not ready yet are absent.
 * `error` uses Expo's codes; DeviceNotRegistered means the token is dead and is revoked by M08.
 */
const TIMEOUT_MS = 15000;
const SEND_CHUNK = 100; // Expo accepts up to 100 messages per request
const RECEIPT_CHUNK = 1000; // and up to 1000 receipt ids

// ---------------------------------------------------------------- memory (tests)
const outbox = [];
const memoryReceipts = new Map();
/** Tokens the memory driver treats as uninstalled apps: at send (`ticket`) or only in the receipt (`receipt`). */
const deadTokens = new Map();

const memory = {
  async send(messages) {
    return messages.map((m) => {
      const id = crypto.randomUUID();
      outbox.push({ ...m, id, at: new Date() });
      if (deadTokens.get(m.to) === 'ticket') return { ok: false, error: 'DeviceNotRegistered', message: 'not registered' };
      memoryReceipts.set(id, deadTokens.get(m.to) === 'receipt' ? { ok: false, error: 'DeviceNotRegistered', message: 'not registered' } : { ok: true });
      return { ok: true, id };
    });
  },
  async receipts(ids) {
    return new Map(ids.filter((id) => memoryReceipts.has(id)).map((id) => [id, memoryReceipts.get(id)]));
  },
};

// ---------------------------------------------------------------- log (local)
const log = {
  async send(messages) {
    // No title or body: they can name people (no PII in logs).
    for (const m of messages) logger.info({ token: `…${String(m.to).slice(-6)}`, code: m.data?.code, priority: m.priority }, 'push (log driver)');
    return messages.map(() => ({ ok: true, id: crypto.randomUUID() }));
  },
  async receipts(ids) {
    return new Map(ids.map((id) => [id, { ok: true }]));
  },
};

// ---------------------------------------------------------------- expo
async function expoPost(path, body) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' };
  if (config.push.expoAccessToken) headers.Authorization = `Bearer ${config.push.expoAccessToken}`;
  const res = await fetch(`${config.push.expoUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw Object.assign(new Error(`Expo push answered ${res.status}`), { code: `expo_http_${res.status}` });
  const json = await res.json();
  if (json.errors?.length) throw Object.assign(new Error(json.errors[0].message ?? 'Expo push error'), { code: String(json.errors[0].code ?? 'expo_error').slice(0, 60) });
  return json.data;
}

const toResult = (r) => (r?.status === 'ok' ? { ok: true, id: r.id } : { ok: false, error: r?.details?.error ?? 'Unknown', message: r?.message ?? '' });

const expo = {
  async send(messages) {
    const out = [];
    for (let i = 0; i < messages.length; i += SEND_CHUNK) {
      const data = await expoPost('/send', messages.slice(i, i + SEND_CHUNK));
      out.push(...data.map(toResult));
    }
    return out;
  },
  async receipts(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += RECEIPT_CHUNK) {
      const data = await expoPost('/getReceipts', { ids: ids.slice(i, i + RECEIPT_CHUNK) });
      for (const [id, r] of Object.entries(data ?? {})) out.set(id, r.status === 'ok' ? { ok: true } : { ok: false, error: r.details?.error ?? 'Unknown', message: r.message ?? '' });
    }
    return out;
  },
};

const drivers = { memory, log, expo };
const driver = () => drivers[config.push.driver];

/** An Expo push token, as expo-notifications hands it to the app. */
const EXPO_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,100}\]$/;

module.exports = {
  EXPO_TOKEN,
  send: (messages) => driver().send(messages),
  receipts: (ids) => driver().receipts(ids),
  name: () => config.push.driver,
  // Test helpers (memory driver).
  sent: () => [...outbox],
  lastTo: (token) => [...outbox].reverse().find((m) => m.to === token),
  markDead: (token, when = 'ticket') => deadTokens.set(token, when),
  clear: () => {
    outbox.splice(0, outbox.length);
    memoryReceipts.clear();
    deadTokens.clear();
  },
};
