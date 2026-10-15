'use strict';

const { z } = require('zod');

const dateTime = z.iso.datetime({ offset: true });
const CHANNELS = ['in_app', 'sms', 'email'];
const STATUSES = ['queued', 'deferred', 'sent', 'delivered', 'failed', 'rate_limited', 'suppressed'];

const listQuery = z.object({
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  category: z.string().max(30).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const readBody = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(100) }),
  z.object({ all: z.literal(true), before: dateTime.optional().meta({ description: 'Only notifications created up to this time (avoids racing a new arrival)' }) }),
]);

const prefsBody = z.object({
  prefs: z
    .array(z.object({ category: z.string().max(30), channel: z.enum(CHANNELS), enabled: z.boolean() }))
    .max(60)
    .default([]),
  quietHours: z.boolean().optional(),
});

const deliveriesQuery = z.object({
  userId: z.uuid().optional(),
  code: z.string().max(60).optional(),
  status: z.enum(STATUSES).optional(),
  phoneSuffix: z.string().regex(/^\d{3,4}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------- responses ----------------
const NotificationItem = z
  .object({
    id: z.uuid(),
    code: z.string(),
    category: z.string(),
    roleContext: z.string().nullable(),
    title: z.string(),
    body: z.string(),
    link: z.string().nullable(),
    readAt: dateTime.nullable(),
    createdAt: dateTime,
  })
  .meta({ id: 'Notification' });

const NotificationPage = z.object({ items: z.array(NotificationItem), nextCursor: z.string().nullable(), unreadCount: z.number().int() }).meta({ id: 'NotificationPage' });

const NotificationPrefs = z
  .object({
    categories: z.array(
      z.object({
        category: z.string(),
        channels: z.array(z.object({ channel: z.enum(CHANNELS), enabled: z.boolean(), locked: z.boolean(), offered: z.boolean() })),
      })
    ),
    quietHours: z.boolean(),
    quietWindow: z.object({ start: z.string(), end: z.string() }),
    locale: z.enum(['en', 'bn']),
  })
  .meta({ id: 'NotificationPrefs' });

const Delivery = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    code: z.string().nullable(),
    category: z.string().nullable(),
    channel: z.enum(['in_app', 'sms', 'email', 'push']),
    status: z.enum(STATUSES),
    attempts: z.number().int(),
    provider: z.string().nullable(),
    errorCode: z.string().nullable(),
    phone: z.string().nullable().meta({ description: 'Masked, e.g. +8801•••••4321' }),
    segments: z.number().int().nullable(),
    deliverAt: dateTime,
    sentAt: dateTime.nullable(),
    createdAt: dateTime,
  })
  .meta({ id: 'NotificationDelivery' });

module.exports = { listQuery, readBody, prefsBody, deliveriesQuery, NotificationItem, NotificationPage, NotificationPrefs, Delivery };
