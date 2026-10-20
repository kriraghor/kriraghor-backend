'use strict';

/**
 * Builds postman/kriraghor-notifications.postman_collection.json (M08 notifications core and the
 * Phase 1 exit check). node postman/build-collection-m08.js
 *
 * Variables: adminAccessToken (master A), adminAccessToken2 (master B), accessToken (a member).
 * Unattended: `node postman/run-m08.js` signs them in, pre-mints one settings.write step-up token per
 * master (stepUpQueueA / stepUpQueueB) and runs a worker loop (relay, consumers, deliveries).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-notifications.postman_collection.json');

/** Requests as the member (customer token). */
const member = (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: 'Bearer {{accessToken}}' });
  return r;
};

const collection = {
  info: {
    name: 'Kriraghor API: M08 Notifications (Phase 1 exit check)',
    description: [
      'Master A proposes a fee change with step-up; master B is asked to approve; B approves; A gets the critical alert. Plus the bell, preferences and the delivery log.',
      'Unattended: `node postman/run-m08.js` (uses the kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m08.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    ['baseUrl', 'http://localhost:4000/api/v1'],
    ['adminAccessToken', ''],
    ['adminAccessToken2', ''],
    ['accessToken', ''],
    ['pushId', ''],
    ['stepUpToken', ''],
    ['stepUpTokenB', ''],
    ['requestId', ''],
  ].map(([key, value]) => ({ key, value })),
  item: [
    {
      name: '0. Guards',
      item: [
        req('Bell without a token (expect 401)', 'GET', '/me/notifications', { as: false, expect: { status: 401, code: 'AUTH_REQUIRED' } }),
        member('Turn off a mandatory cell (expect 422)', 'PUT', '/me/notification-prefs', {
          body: { prefs: [{ category: 'security', channel: 'sms', enabled: false }] },
          expect: { status: 422, code: 'PREF_MANDATORY' },
        }),
      ],
    },
    {
      name: '1. Phase 1 exit check',
      item: [
        req('A proposes shop commission 5 → 6% (step-up)', 'POST', '/admin/settings/change-requests', {
          stepUp: true,
          body: { changes: [{ key: 'fees.shop_commission_pct', to: 6 }], reason: 'Postman M08 exit check' },
          expect: { status: 201 },
          save: { requestId: 'id' },
          checks: [['waiting for a second master', "j.status === 'proposed'"]],
        }),
        req("B's bell asks for approval", 'GET', '/admin/me/notifications', {
          as: 'B',
          waitMs: 2000,
          expect: { status: 200 },
          checks: [['approval needed', "j.unreadCount === 1 && j.items[0].code === 'SETTING_CHANGE_PROPOSED' && j.items[0].title === 'Approval needed'"]],
        }),
        req('B approves (step-up)', 'POST', '/admin/settings/change-requests/{{requestId}}/approve', {
          as: 'B',
          stepUp: true,
          body: { note: 'Agreed' },
          expect: { status: 200 },
          checks: [['applied', "j.status === 'applied'"]],
        }),
        req('The change is in the audit log (critical, step-up)', 'GET', '/admin/audit-logs?action=setting.changed', {
          expect: { status: 200 },
          checks: [['critical + step-up', "j.items[0].severity === 'critical' && j.items[0].stepUp === true"]],
        }),
        req("A's bell has the critical alert", 'GET', '/admin/me/notifications', {
          waitMs: 2000,
          expect: { status: 200 },
          checks: [['critical change', "j.items.some((n) => n.code === 'AUDIT_CRITICAL' && n.body.includes('fees.shop_commission_pct'))"]],
        }),
        req("B is not alerted about B's own change", 'GET', '/admin/me/notifications', {
          as: 'B',
          expect: { status: 200 },
          checks: [['no AUDIT_CRITICAL for the actor', "!j.items.some((n) => n.code === 'AUDIT_CRITICAL')"]],
        }),
        req('Emails went out (delivery log)', 'GET', '/admin/notifications/deliveries', {
          expect: { status: 200 },
          checks: [['two emails sent', "j.items.filter((d) => d.channel === 'email' && d.status === 'sent').length === 2"]],
        }),
      ],
    },
    {
      name: '2. Bell',
      item: [
        req('Unread count', 'GET', '/admin/me/notifications/unread-count', { expect: { status: 200 }, checks: [['one unread', 'j.unreadCount === 1']] }),
        req('Mark all read', 'POST', '/admin/me/notifications/read', { body: { all: true }, expect: { status: 200 }, checks: [['none unread', 'j.unreadCount === 0']] }),
        member('Member bell (empty)', 'GET', '/me/notifications', { expect: { status: 200 }, checks: [['empty', 'j.items.length === 0 && j.unreadCount === 0']] }),
      ],
    },
    {
      name: '3. Preferences',
      item: [
        member('Read preferences', 'GET', '/me/notification-prefs', {
          expect: { status: 200 },
          checks: [['security SMS locked', "j.categories.find((c) => c.category === 'security').channels.find((c) => c.channel === 'sms').locked === true"]],
        }),
        member('Turn off moderation SMS and quiet hours', 'PUT', '/me/notification-prefs', {
          body: { prefs: [{ category: 'moderation', channel: 'sms', enabled: false }], quietHours: false },
          expect: { status: 200 },
          checks: [['saved', "j.quietHours === false && j.categories.find((c) => c.category === 'moderation').channels.find((c) => c.channel === 'sms').enabled === false"]],
        }),
      ],
    },
    {
      name: '4. Push (the mobile app)',
      item: [
        member('Register a token that is not an Expo token (expect 422)', 'POST', '/me/push-subscriptions', { body: { token: 'not-an-expo-token', platform: 'expo' }, expect: { status: 422 } }),
        member('Register this phone', 'POST', '/me/push-subscriptions', {
          body: { token: 'ExponentPushToken[postmanPhone000001]', platform: 'expo', deviceLabel: 'Postman phone' },
          expect: { status: 201 },
          save: { pushId: 'id' },
          checks: [['token never returned', "j.tokenTail === '00001]' && !JSON.stringify(j).includes('postmanPhone') && j.current === true"]],
        }),
        member('Register the same token again (200, same device)', 'POST', '/me/push-subscriptions', {
          body: { token: 'ExponentPushToken[postmanPhone000001]', platform: 'expo', deviceLabel: 'Postman phone' },
          expect: { status: 200 },
          checks: [['same device', "j.id === pm.collectionVariables.get('pushId')"]],
        }),
        member('List phones', 'GET', '/me/push-subscriptions', { expect: { status: 200 }, checks: [['one phone', 'j.items.length === 1']] }),
        member('Push is offered in preferences, never locked', 'GET', '/me/notification-prefs', {
          expect: { status: 200 },
          checks: [['push cell', "j.categories.every((c) => { const p = c.channels.find((x) => x.channel === 'push'); return p && p.offered && !p.locked; })"]],
        }),
        member('Remove this phone', 'DELETE', '/me/push-subscriptions/{{pushId}}', { expect: { status: 204 } }),
        member('List phones (none)', 'GET', '/me/push-subscriptions', { expect: { status: 200 }, checks: [['none', 'j.items.length === 0']] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
const count = collection.item.reduce((n, f) => n + f.item.length, 0);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${count} requests)`);
