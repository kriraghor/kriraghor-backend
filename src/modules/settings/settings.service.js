'use strict';

/**
 * SettingsService (M03-FR-10, 13, 16, 17, 18). Every number the platform uses lives in
 * platform_settings; code reads it here and never keeps its own default.
 *
 *  - load() reads all rows into a per-process cache, refreshed after a 60 s TTL.
 *  - get(key) is synchronous from the cache; an unknown key throws SETTING_UNKNOWN.
 *  - After an apply, publishBust() tells every process (api, worker, realtime pods) to reload
 *    through Redis pub/sub, so a new value is used everywhere within about 2 s.
 *  - getAt(key, at) answers from settings_history, for reports and disputes.
 *  - snapshot(keys) is what bookings, orders and registrations store with themselves.
 */
const { Op } = require('sequelize');
const config = require('../../config');
const logger = require('../../common/logger');
const { AppError } = require('../../common/errors');
const { getRedis, createRedis } = require('../../common/redis');
const { PlatformSetting, SettingsHistory } = require('../../models');
const { SETTING_KEYS } = require('../../db/seed');

const TTL_MS = 60 * 1000;
const BUST_CHANNEL = `${config.redis.prefix}:settings:bust`;

const state = { byKey: new Map(), loadedAt: 0, refreshing: null, stamp: null };

const unknown = (key) => new AppError(422, 'SETTING_UNKNOWN', 'Unknown setting', { errors: [{ field: key, message: `No setting called ${key}` }] });

function toEntry(row) {
  const r = row.get({ plain: true });
  return {
    key: r.key,
    category: r.category,
    value: r.value,
    valueType: r.valueType,
    unit: r.unit,
    minValue: r.minValue === null ? null : Number(r.minValue),
    maxValue: r.maxValue === null ? null : Number(r.maxValue),
    enumOptions: r.enumOptions,
    approval: r.approval,
    isPublic: r.isPublic,
    labelEn: r.labelEn,
    labelBn: r.labelBn,
    whyEn: r.whyEn,
    whyBn: r.whyBn,
    version: r.version,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt,
  };
}

/** (Re)load every setting into the process cache. */
async function load({ transaction } = {}) {
  const rows = await PlatformSetting.findAll({ transaction });
  const byKey = new Map(rows.map((r) => [r.key, toEntry(r)]));
  state.byKey = byKey;
  state.loadedAt = Date.now();
  const latest = rows.reduce((max, r) => (r.updatedAt > max ? r.updatedAt : max), new Date(0));
  state.stamp = `${latest.toISOString()}#${rows.reduce((n, r) => n + r.version, 0)}`;
  return byKey.size;
}

const isLoaded = () => state.loadedAt > 0;

function refreshIfStale() {
  if (Date.now() - state.loadedAt < TTL_MS || state.refreshing) return;
  state.refreshing = load()
    .catch((err) => logger.warn({ err }, 'settings refresh failed; keeping the cached values'))
    .finally(() => {
      state.refreshing = null;
    });
}

function ensureLoaded() {
  if (!isLoaded()) throw new Error('Settings are not loaded yet: call settings.load() at startup');
  refreshIfStale();
}

function entry(key) {
  ensureLoaded();
  const e = state.byKey.get(key);
  if (!e) throw unknown(key);
  return e;
}

/** Current value of a setting. */
const get = (key) => entry(key).value;

/** Full definition (value, bounds, approval, labels, version). */
const definition = (key) => entry(key);

/** Every definition, optionally one category, in seed order then key order. */
function list({ category } = {}) {
  ensureLoaded();
  const order = new Map(SETTING_KEYS.map((k, i) => [k, i]));
  return [...state.byKey.values()]
    .filter((e) => !category || e.category === category)
    .sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9) || a.key.localeCompare(b.key));
}

/** M03-FR-17: value and version, to store with a transaction. */
function snapshot(keys) {
  return Object.fromEntries(keys.map((k) => [k, { value: get(k), version: entry(k).version }]));
}

/**
 * M03-FR-13: the value effective at `at`, from history. Before the first history row the
 * seeded (version 1) value applies.
 */
async function getAt(key, at = new Date()) {
  entry(key);
  const row =
    (await SettingsHistory.findOne({ where: { key, effectiveAt: { [Op.lte]: at } }, order: [['effectiveAt', 'DESC'], ['version', 'DESC']] })) ||
    (await SettingsHistory.findOne({ where: { key }, order: [['version', 'ASC']] }));
  return row ? { value: row.newValue, version: row.version, effectiveAt: row.effectiveAt } : { value: get(key), version: entry(key).version, effectiveAt: null };
}

const camel = (s) => s.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());

/**
 * M03-FR-18: public keys only, nested by prefix with camelCase names. Money settings drop the
 * "_poisha" suffix and become { amount, currency }.
 */
function publicView() {
  const out = {};
  for (const e of list()) {
    if (!e.isPublic) continue;
    const [group, ...rest] = e.key.split('.');
    const name = camel(rest.join('_').replace(/_poisha$/, ''));
    out[group] = out[group] || {};
    out[group][name] = e.valueType === 'money' ? { amount: e.value, currency: 'BDT' } : e.value;
  }
  return { ...out, version: state.stamp };
}

/** Cache stamp for ETags. */
const stamp = () => state.stamp;

/** Keys the code needs that are missing from the database. */
const missingKeys = () => SETTING_KEYS.filter((k) => !state.byKey.has(k));

/**
 * Boot check (M03 §12): refuse to start when the seed has not run. Called by every
 * entrypoint before it reports ready.
 */
async function bootCheck() {
  await load();
  const missing = missingKeys();
  if (missing.length) {
    throw new Error(`platform_settings is missing ${missing.length} key(s), e.g. ${missing.slice(0, 5).join(', ')}. Run the release step (migrate + seed).`);
  }
}

/** Tell every process to reload. Called after commit; a failure only delays the TTL refresh. */
async function publishBust(keys) {
  try {
    await getRedis().publish(BUST_CHANNEL, JSON.stringify({ keys, at: new Date().toISOString() }));
  } catch (err) {
    logger.warn({ err: err.message }, 'settings cache bust publish failed');
  }
}

/** Reload this process whenever any process applies a change. Returns the subscriber connection. */
async function subscribe() {
  const sub = createRedis('settings-sub');
  sub.on('message', (channel) => {
    if (channel !== BUST_CHANNEL) return;
    load().catch((err) => logger.warn({ err }, 'settings reload after bust failed'));
  });
  await sub.subscribe(BUST_CHANNEL);
  return sub;
}

module.exports = { load, isLoaded, get, definition, list, snapshot, getAt, publicView, stamp, missingKeys, bootCheck, publishBust, subscribe, BUST_CHANNEL, TTL_MS };

/** History of one key, newest first (admin History drawer). */
async function history(key, { limit = 50 } = {}) {
  entry(key);
  const { User } = require('../../models');
  const { serializeHistory } = require('./settings.serializer');
  const rows = await SettingsHistory.findAll({ where: { key }, order: [['version', 'DESC']], limit });
  const ids = [...new Set(rows.flatMap((r) => [r.changedBy, r.approvedBy]).filter(Boolean))];
  const users = ids.length ? await User.findAll({ where: { id: ids }, attributes: ['id', 'displayName'] }) : [];
  const names = new Map(users.map((u) => [u.id, u.displayName]));
  return { key, items: rows.map((r) => serializeHistory(r, names)) };
}

module.exports.history = history;
