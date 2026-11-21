'use strict';

/**
 * M24 §25 Kriraghor's WhatsApp message templates (M24-FR-163), created in every connected WhatsApp Business
 * account in English and Bangla when the number is connected, and approved by Meta one by one. A message the
 * gym starts must use an approved template; the values fill the numbered slots in order.
 *  - utility: receipts, reminders, payment links and a single update to one member (consent `service`);
 *  - marketing: notices and wishes to many members (consent `news`), always with the STOP line.
 * Meta decides the final category; a template it moves to marketing is charged and consented as marketing
 * (gym_whatsapp_templates.category follows the webhook).
 */
const STOP_EN = 'Reply STOP to stop these messages.';
const STOP_BN = 'এই মেসেজ বন্ধ করতে STOP লিখে উত্তর দিন।';

const TEMPLATES = Object.freeze({
  kg_receipt: {
    category: 'utility',
    params: ['gym', 'receiptNo', 'amount', 'link'],
    en: '{{1}}: we received {{3}}, receipt {{2}}. See your receipt: {{4}}',
    bn: '{{1}}: আমরা {{3}} পেয়েছি, রসিদ {{2}}। আপনার রসিদ দেখুন: {{4}}',
    example: ['Iron Yard Banani', 'IY-R26-000123', '৳2,500', 'https://gym.kriraghor.com/r/abc'],
  },
  kg_renewal_due: {
    category: 'utility',
    params: ['gym', 'endsOn', 'link'],
    en: '{{1}}: your membership ends on {{2}}. Renew here: {{3}}',
    bn: '{{1}}: আপনার সদস্যপদ {{2}} তারিখে শেষ হবে। এখানে নবায়ন করুন: {{3}}',
    example: ['Iron Yard Banani', '28 Nov 2026', 'https://gym.kriraghor.com/p/abc'],
  },
  kg_ends_today: {
    category: 'utility',
    params: ['gym', 'link'],
    en: '{{1}}: your membership ends today. Renew here: {{2}}',
    bn: '{{1}}: আপনার সদস্যপদ আজ শেষ হচ্ছে। এখানে নবায়ন করুন: {{2}}',
    example: ['Iron Yard Banani', 'https://gym.kriraghor.com/p/abc'],
  },
  kg_overdue: {
    category: 'utility',
    params: ['gym', 'outstanding', 'dueOn', 'link'],
    en: '{{1}}: {{2}} has been due since {{3}}. Pay here: {{4}}',
    bn: '{{1}}: {{3}} থেকে {{2}} বাকি আছে। এখানে পরিশোধ করুন: {{4}}',
    example: ['Iron Yard Banani', '৳2,500', '15 Nov 2026', 'https://gym.kriraghor.com/p/abc'],
  },
  kg_pay_link: {
    category: 'utility',
    params: ['gym', 'amount', 'link'],
    en: '{{1}}: pay {{2}} here: {{3}}',
    bn: '{{1}}: {{2}} এখানে পরিশোধ করুন: {{3}}',
    example: ['Iron Yard Banani', '৳2,500', 'https://gym.kriraghor.com/p/abc'],
  },
  kg_update: {
    category: 'utility',
    params: ['gym', 'message'],
    en: 'A message from {{1}} about your membership: {{2}}',
    bn: 'আপনার সদস্যপদ নিয়ে {{1}}-এর বার্তা: {{2}}',
    example: ['Iron Yard Banani', 'Your locker key is ready at the front desk.'],
  },
  kg_notice: {
    category: 'marketing',
    params: ['gym', 'title', 'message'],
    en: `{{1}}: {{2}}\n\n{{3}}\n\n${STOP_EN}`,
    bn: `{{1}}: {{2}}\n\n{{3}}\n\n${STOP_BN}`,
    example: ['Iron Yard Banani', 'New Zumba class', 'From Monday at 7 pm. Book in the app.'],
  },
  kg_greeting: {
    category: 'marketing',
    params: ['gym', 'message'],
    en: `{{1}}: {{2}}\n\n${STOP_EN}`,
    bn: `{{1}}: {{2}}\n\n${STOP_BN}`,
    example: ['Iron Yard Banani', 'Eid Mubarak from all of us! The gym is closed on Eid day.'],
  },
});

/** Which template each kind of message uses. */
const KIND_TEMPLATE = Object.freeze({
  receipt: 'kg_receipt',
  renewal_due: 'kg_renewal_due',
  ends_today: 'kg_ends_today',
  overdue: 'kg_overdue',
  pay_link: 'kg_pay_link',
  single: 'kg_update',
  notice: 'kg_notice',
  greeting: 'kg_greeting',
});

/** The automatic kinds a branch can switch on (M24-FR-165). */
const AUTO_KINDS = Object.freeze(['receipt', 'renewal_due', 'ends_today', 'overdue', 'pay_link']);

/** The Graph API body that creates one template in an account. */
function createBody(code, locale) {
  const t = TEMPLATES[code];
  return {
    name: code,
    language: locale,
    category: t.category.toUpperCase(),
    components: [{ type: 'BODY', text: t[locale], example: { body_text: [t.example] } }],
  };
}

/** The positional values of a template from named values, in its slot order (missing → ''). */
const valuesOf = (code, named) => TEMPLATES[code].params.map((p) => String(named[p] ?? ''));

/** The text a member sees (the history preview): the template with its values filled in. */
const render = (code, locale, values) => TEMPLATES[code][locale].replace(/\{\{(\d+)\}\}/g, (_, n) => values[Number(n) - 1] ?? '');

module.exports = { TEMPLATES, KIND_TEMPLATE, AUTO_KINDS, createBody, valuesOf, render };
