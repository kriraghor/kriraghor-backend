'use strict';

/**
 * Active message templates (M08 §6.2), cached per process for a minute. Lookup falls back from the
 * recipient's locale to English (edge case 9). Rendering errors fail closed (FR-07).
 */
const logger = require('../../common/logger');
const { MessageTemplate } = require('../../models');
const { render, TemplateError } = require('./notify.rules');

const TTL_MS = 60 * 1000;
let cache = { at: 0, byKey: new Map() };

async function load() {
  const rows = await MessageTemplate.findAll({ where: { isActive: true } });
  cache = { at: Date.now(), byKey: new Map(rows.map((r) => [`${r.code}:${r.channel}:${r.locale}`, r.get({ plain: true })])) };
  return cache.byKey.size;
}

async function find(code, channel, locale) {
  if (Date.now() - cache.at > TTL_MS) await load();
  const exact = cache.byKey.get(`${code}:${channel}:${locale}`);
  if (exact) return exact;
  const en = cache.byKey.get(`${code}:${channel}:en`);
  if (en && locale !== 'en') logger.warn({ code, channel, locale }, 'template missing in this locale; using English');
  return en ?? null;
}

/**
 * Render a template for one recipient: { title, body, version }. `title` is the template subject
 * (in-app title, email subject). Throws TemplateError when the template is missing or a variable is.
 */
async function renderFor(code, channel, locale, values) {
  const t = await find(code, channel, locale);
  if (!t) throw new TemplateError(`No active template ${code}.${channel}`);
  const lang = t.locale;
  return {
    title: t.subject ? render(t.subject, t.variables, values, lang) : null,
    body: render(t.body, t.variables, values, lang),
    version: t.version,
    locale: lang,
  };
}

/** Test helper: forget the cache so seeded changes are seen at once. */
const reset = () => {
  cache = { at: 0, byKey: new Map() };
};

module.exports = { load, find, renderFor, reset };
