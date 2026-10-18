'use strict';

/**
 * M08 pure rules: SMS encoding (FR-09), quiet hours (FR-10, §6.4), channel resolution with mandatory
 * categories (FR-06, §6.3), template rendering with typed variables (FR-07) and dedupe keys (FR-02).
 * No I/O; 100% branch coverage.
 */
const moneyHelpers = require('../../common/money');

// ---------------------------------------------------------------- categories (§6.3)
const CATEGORIES = {
  security: { mandatory: ['in_app', 'sms'], defaults: ['in_app', 'sms', 'email'] },
  money: { mandatory: ['in_app', 'sms'], defaults: ['in_app', 'sms', 'email'] },
  bookings: { mandatory: ['in_app'], defaults: ['in_app', 'sms'] },
  hire: { mandatory: ['in_app'], defaults: ['in_app', 'sms'] },
  orders: { mandatory: ['in_app'], defaults: ['in_app', 'sms'] },
  offers: { mandatory: ['in_app'], defaults: ['in_app', 'sms'] },
  tournaments: { mandatory: ['in_app'], defaults: ['in_app', 'sms'] },
  moderation: { mandatory: ['in_app'], defaults: ['in_app', 'sms'] },
  disputes_reports: { mandatory: ['in_app', 'sms'], defaults: ['in_app', 'sms', 'email'] },
  reviews: { mandatory: [], defaults: ['in_app'] },
  // M23 follow alerts: in-app only (an entry's channels all go out unless turned off, so no SMS here, Q148).
  event_alerts: { mandatory: [], defaults: ['in_app'] },
  // M16 sports teams: invites, membership and captaincy.
  teams: { mandatory: ['in_app'], defaults: ['in_app', 'sms'] },
  staff_ops: { mandatory: ['in_app'], defaults: ['in_app', 'email'] },
};
const CHANNELS = ['in_app', 'sms', 'email'];

/**
 * Channels a notification goes out on: the catalogue entry's channels, minus those the user turned
 * off, except mandatory cells which ignore opt-outs (FR-06). `prefs` is a Map "category:channel" → bool.
 */
function resolveChannels({ category, channels, prefs = new Map() }) {
  const cat = CATEGORIES[category];
  if (!cat) throw new Error(`Unknown notification category ${category}`);
  return channels.filter((ch) => cat.mandatory.includes(ch) || prefs.get(`${category}:${ch}`) !== false);
}

const isMandatory = (category, channel) => Boolean(CATEGORIES[category]?.mandatory.includes(channel));

// ---------------------------------------------------------------- SMS encoding (FR-09)
// GSM 03.38 basic set plus the extension table (extension characters cost two septets).
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
);
const GSM_EXT = new Set('^{}\\[~]|€\f');

function smsEncoding(text) {
  for (const ch of text) if (!GSM_BASIC.has(ch) && !GSM_EXT.has(ch)) return 'ucs2';
  return 'gsm7';
}

/** Segments: GSM-7 160 single / 153 per part; UCS-2 70 single / 67 per part (UTF-16 code units). */
function smsSegments(text) {
  const encoding = smsEncoding(text);
  let units = 0;
  if (encoding === 'gsm7') for (const ch of text) units += GSM_EXT.has(ch) ? 2 : 1;
  else units = text.length; // UTF-16 code units, as the handset counts them
  const [single, multi] = encoding === 'gsm7' ? [160, 153] : [70, 67];
  const segments = units === 0 ? 1 : units <= single ? 1 : Math.ceil(units / multi);
  return { encoding, units, segments };
}

// ---------------------------------------------------------------- quiet hours (FR-10, §6.4)
const DHAKA_OFFSET_MIN = 6 * 60; // Asia/Dhaka has no daylight saving
const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * When a channel message may go out. In-app and urgent messages go now; others inside the quiet
 * window (e.g. 22:00–08:00 Dhaka, wrapping midnight) wait until the window ends.
 */
function deliverAt({ now = new Date(), urgent = false, channel, quietStart = '22:00', quietEnd = '08:00', quietEnabled = true }) {
  if (urgent || channel === 'in_app' || !quietEnabled) return now;
  const local = new Date(now.getTime() + DHAKA_OFFSET_MIN * 60000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const start = toMinutes(quietStart);
  const end = toMinutes(quietEnd);
  const wraps = start > end;
  const inQuiet = wraps ? minute >= start || minute < end : minute >= start && minute < end;
  if (!inQuiet) return now;
  // Next occurrence of `end` in Dhaka time, expressed in UTC.
  const endLocal = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Math.floor(end / 60), end % 60));
  if (endLocal.getTime() <= local.getTime()) endLocal.setUTCDate(endLocal.getUTCDate() + 1);
  return new Date(endLocal.getTime() - DHAKA_OFFSET_MIN * 60000);
}

// ---------------------------------------------------------------- templates (FR-07, §6.2)
const bnDigits = (s) => moneyHelpers.bnDigits(String(s));

function formatValue(type, value, locale) {
  switch (type) {
    case 'money':
      // Poisha in, "৳2,100" or "৳২,১০০" out (common/money: integer taka and two-digit poisha).
      return moneyHelpers.format(Number(value), locale);
    case 'datetime': {
      const text = new Intl.DateTimeFormat(locale === 'bn' ? 'bn-BD' : 'en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'Asia/Dhaka',
      }).format(new Date(value));
      return text;
    }
    case 'number':
      return locale === 'bn' ? bnDigits(value) : String(value);
    default:
      return String(value);
  }
}

class TemplateError extends Error {}

/**
 * Render `{{name}}` placeholders. Every declared variable must be present (FR-07 fails closed);
 * text variables are cut to maxLen; undeclared placeholders are an error too.
 */
function render(text, variables, values, locale) {
  const decl = new Map((variables || []).map((v) => [v.name, v]));
  for (const v of decl.values()) {
    if (values[v.name] === undefined || values[v.name] === null) throw new TemplateError(`Missing variable ${v.name}`);
  }
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name) => {
    const v = decl.get(name);
    if (!v) throw new TemplateError(`Undeclared variable ${name}`);
    const out = formatValue(v.type, values[name], locale);
    return v.maxLen && out.length > v.maxLen ? `${out.slice(0, v.maxLen - 1)}…` : out;
  });
}

// ---------------------------------------------------------------- dedupe (FR-02)
/** code:subject:recipient:bucket, the bucket being the dedupe window number. */
function dedupeKey({ code, subjectId, userId, at = new Date(), windowHours = 24 }) {
  const bucket = Math.floor(at.getTime() / (windowHours * 3600 * 1000));
  return `${code}:${subjectId}:${userId}:${bucket}`;
}

// ---------------------------------------------------------------- masking (FR-15)
const maskPhone = (phone) => {
  const s = String(phone);
  // "+8801•••••4321" (M08-FR-15): country code and operator prefix, then the last 4 digits.
  return s.length <= 9 ? '•••' : `${s.slice(0, 5)}${'•'.repeat(s.length - 9)}${s.slice(-4)}`;
};
/** OTP codes never reach the log: every run of 4 to 8 digits becomes bullets. */
const redactCodes = (text) => text.replace(/\b\d{4,8}\b/g, (m) => '•'.repeat(m.length));

module.exports = {
  CATEGORIES,
  CHANNELS,
  resolveChannels,
  isMandatory,
  smsEncoding,
  smsSegments,
  deliverAt,
  formatValue,
  render,
  TemplateError,
  dedupeKey,
  maskPhone,
  redactCodes,
};
