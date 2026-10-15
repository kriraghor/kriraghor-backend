'use strict';

const { z } = require('zod');

const dateTime = z.iso.datetime({ offset: true });
const settingKey = z
  .string()
  .max(80)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, 'A setting key like fees.hire_pct');
/** Every shape a setting value can take (see value_type). */
const settingValue = z
  .union([z.number(), z.boolean(), z.string().max(200), z.array(z.union([z.number(), z.string().max(40)])).max(20), z.record(z.string().max(40), z.number())])
  .meta({ description: 'Typed by the setting: number, bool, string (enum, HH:mm), list, or a map of numbers' });

const REQUEST_STATUS = ['proposed', 'approved', 'applied', 'rejected', 'withdrawn', 'superseded'];
const CATEGORIES = ['fees', 'booking', 'market', 'hire', 'tournament', 'esports', 'gym', 'moderation', 'money_limits', 'risk', 'accounts', 'security', 'simulator', 'operations', 'notifications'];

// ---------------- requests ----------------
const changeRequestCreate = z.object({
  changes: z
    .array(z.object({ key: settingKey, to: settingValue }))
    .min(1)
    .max(30)
    .refine((list) => new Set(list.map((c) => c.key)).size === list.length, 'Each setting can appear only once'),
  effectiveAt: dateTime.optional().meta({ description: 'When the change takes effect; omit for now' }),
  reason: z.string().trim().min(5, 'Say why in a few words').max(2000),
  source: z.enum(['fees_screen', 'risk_desk', 'api']).default('fees_screen'),
  projection: z.record(z.string(), z.unknown()).optional().meta({ description: 'Fee simulator projection, kept with the request' }),
});

const optionalNote = z.object({ note: z.string().trim().max(2000).optional() });
const requiredNote = z.object({ note: z.string().trim().min(3, 'Add a short note').max(2000) });

// ---------------- responses ----------------
const Setting = z
  .object({
    key: z.string(),
    category: z.string(),
    value: settingValue,
    valueType: z.enum(['int', 'decimal', 'money', 'bool', 'enum', 'time', 'json', 'int_list', 'string_list']),
    unit: z.string().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    options: z.array(z.string()).nullable(),
    approval: z.enum(['single', 'four_eyes']),
    isPublic: z.boolean(),
    label: z.object({ en: z.string(), bn: z.string() }),
    why: z.object({ en: z.string().nullable(), bn: z.string().nullable() }).nullable(),
    version: z.number().int(),
    updatedBy: z.uuid().nullable(),
    updatedAt: dateTime.nullable(),
  })
  .meta({ id: 'Setting' });

const Person = z.object({ id: z.uuid(), displayName: z.string().nullable() }).nullable();

const SettingHistoryEntry = z
  .object({
    version: z.number().int(),
    oldValue: settingValue.nullable(),
    newValue: settingValue,
    effectiveAt: dateTime.nullable(),
    requestId: z.uuid().nullable(),
    changedBy: Person,
    approvedBy: Person,
    reason: z.string().nullable(),
  })
  .meta({ id: 'SettingHistoryEntry' });

const ChangeRequest = z
  .object({
    id: z.uuid(),
    status: z.enum(REQUEST_STATUS),
    source: z.enum(['fees_screen', 'simulator', 'risk_desk', 'api']),
    changes: z.array(z.object({ key: z.string(), from: settingValue, to: settingValue })),
    projection: z.record(z.string(), z.unknown()).nullable(),
    reason: z.string(),
    effectiveAt: dateTime,
    needsFourEyes: z.boolean(),
    needsSecondApprover: z.boolean(),
    proposedBy: Person,
    approvedBy: Person,
    decidedBy: Person,
    decidedAt: dateTime.nullable(),
    decisionNote: z.string().nullable(),
    appliedAt: dateTime.nullable(),
    createdAt: dateTime,
  })
  .meta({ id: 'SettingsChangeRequest' });

const PublicSettings = z
  .record(z.string(), z.unknown())
  .meta({ id: 'PublicSettings', description: 'Public settings grouped by prefix with camelCase names; money as { amount, currency }. Includes a `version` stamp.' });

module.exports = {
  REQUEST_STATUS,
  CATEGORIES,
  settingKey,
  keyParam: z.object({ key: settingKey }),
  idParam: z.object({ id: z.uuid() }),
  settingsQuery: z.object({ category: z.enum(CATEGORIES).optional() }),
  requestsQuery: z.object({ status: z.enum(REQUEST_STATUS).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  historyQuery: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  changeRequestCreate,
  approve: optionalNote,
  withdraw: optionalNote,
  reject: requiredNote,
  Setting,
  SettingHistoryEntry,
  ChangeRequest,
  PublicSettings,
};
