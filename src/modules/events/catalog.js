'use strict';

/**
 * Domain event registry (M04 §6.3, FR-12, FR-18, FR-19). Every event a module publishes is listed
 * here with its version and a zod schema for the payload. publish() rejects unknown events and
 * invalid payloads before commit. Payloads carry IDs, codes, amounts, statuses and timestamps only:
 * no phone, NID, DOB, email or names (consumers read details through the producer's service).
 *
 * Built so far: M01, M03, M04. Each later module adds its events here when it is built.
 */
const { z } = require('zod');

const id = z.string().min(1).max(64);
const uuid = z.uuid();
const role = z.string().max(32);
const iso = z.string().max(40);
const json = z.unknown();
const catalogItem = z.object({ table: z.string(), id: uuid, key: z.string(), version: z.number().int().optional(), isActive: z.boolean().optional() });

const EVENTS = {
  // ---------------- M01 Identity ----------------
  'user.registered': { module: 'M01', version: 1, schema: z.object({ userId: uuid, roles: z.array(role) }) },
  'user.suspended': { module: 'M01', version: 1, schema: z.object({ userId: uuid, sanctionId: uuid, until: iso.nullable() }) },
  'user.banned': { module: 'M01', version: 1, schema: z.object({ userId: uuid, sanctionId: uuid }) },
  'user.restored': { module: 'M01', version: 1, schema: z.object({ userId: uuid }) },
  'user.email_changed': { module: 'M01', version: 1, schema: z.object({ userId: uuid }) },
  'user_role.applied': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role }) },
  'user_role.activated': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role }) },
  'user_role.reinstated': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role }) },
  'user_role.rejected': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role, reasonCode: z.string().max(40).nullable() }) },
  'user_role.suspended': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role, reasonCode: z.string().max(40).nullable() }) },
  'user_role.withdrawn': { module: 'M01', version: 1, schema: z.object({ userId: uuid, role }) },
  'staff.invited': { module: 'M01', version: 1, schema: z.object({ userId: uuid }) },
  'staff.activated': { module: 'M01', version: 1, schema: z.object({ userId: uuid }) },
  'staff.offboarded': { module: 'M01', version: 1, schema: z.object({ userId: uuid }) },
  'staff.permissions_changed': { module: 'M01', version: 1, schema: z.object({ userId: uuid, added: z.array(z.string()), removed: z.array(z.string()) }) },
  'session.revoked': { module: 'M01', version: 1, schema: z.object({ userId: uuid, cause: z.string().max(40), count: z.number().int().min(1) }) },

  // ---------------- M03 Settings and catalogue ----------------
  'setting.change_proposed': {
    module: 'M03',
    version: 1,
    schema: z.object({ requestId: uuid, keys: z.array(z.string()), proposedBy: uuid, source: z.string(), needsFourEyes: z.boolean() }),
  },
  'setting.changed': {
    module: 'M03',
    version: 1,
    schema: z.object({ key: z.string(), version: z.number().int(), oldValue: json, newValue: json, effectiveAt: iso, requestId: uuid }),
  },
  'setting.change_rejected': { module: 'M03', version: 1, schema: z.object({ requestId: uuid, code: z.string().optional() }) },
  'setting.change_withdrawn': { module: 'M03', version: 1, schema: z.object({ requestId: uuid }) },
  'catalog_item.created': { module: 'M03', version: 1, schema: catalogItem },
  'catalog_item.updated': { module: 'M03', version: 1, schema: catalogItem },
  'catalog_item.deactivated': { module: 'M03', version: 1, schema: catalogItem },

  // ---------------- M04 Audit and events ----------------
  'audit.critical_recorded': {
    module: 'M04',
    version: 1,
    schema: z.object({ auditLogId: id, action: z.string(), actorId: uuid.nullable(), entityType: z.string().nullable(), entityId: id.nullable() }),
  },
  'audit_log.exported': { module: 'M04', version: 1, schema: z.object({ exportId: uuid, requestedBy: uuid, rowCount: z.number().int() }) },
  'audit.chain_mismatch_detected': { module: 'M04', version: 1, schema: z.object({ seq: z.number().int(), auditLogId: id }) },
  'outbox.event_dead_lettered': { module: 'M04', version: 1, schema: z.object({ eventId: uuid, eventType: z.string(), consumer: z.string(), attempts: z.number().int() }) },
};

/** FR-19: `<aggregate>.<past_tense_verb>`, snake_case. Irregular past tenses are listed. */
const IRREGULAR = new Set(['sent', 'paid', 'held', 'won', 'lost', 'made', 'begun', 'done', 'drawn', 'shown', 'thrown', 'given', 'taken', 'built', 'set', 'put', 'cut', 'withdrawn', 'chosen', 'written', 'frozen', 'unfrozen', 'seen', 'broken', 'sold', 'told', 'found', 'left', 'met', 'read', 'run', 'spent', 'struck']);
function nameError(name) {
  const m = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(name);
  if (!m) return 'Use <aggregate>.<verb> in snake_case';
  const verb = m[2].split('_').pop();
  if (verb.endsWith('ed') || IRREGULAR.has(verb)) return null;
  return `"${m[2]}" is not past tense`;
}

/** FR-18: banned payload field names, matched as any word of a camelCase or snake_case key (displayName, user_email, phoneNumber). */
const PII_WORDS = new Set(['phone', 'nid', 'dob', 'email', 'name']);
const words = (key) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split('_');
function piiFields(value, path = '') {
  if (Array.isArray(value)) return value.flatMap((v, i) => piiFields(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const here = path ? `${path}.${k}` : k;
    return [...(words(k).some((w) => PII_WORDS.has(w)) ? [here] : []), ...piiFields(v, here)];
  });
}

const definition = (name) => EVENTS[name];

module.exports = { EVENTS, definition, nameError, piiFields };
