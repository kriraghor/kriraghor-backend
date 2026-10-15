'use strict';

/** Branded HTML for notification emails; the plain-text body is always sent alongside (FR-17). */
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const linkify = (s) => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0B7A4B">$1</a>');

function emailHtml({ title, body }, locale = 'en') {
  const paragraphs = escape(body)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px;line-height:1.5">${linkify(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const footer = locale === 'bn' ? 'ক্রীড়াঘর থেকে স্বয়ংক্রিয় বার্তা। নোটিফিকেশন সেটিংস অ্যাকাউন্টে বদলাতে পারবেন।' : 'An automatic message from Kriraghor. You can change notification settings in your account.';
  return `<!doctype html><html lang="${locale}"><body style="margin:0;background:#F4F3EF;font-family:Arial,Helvetica,sans-serif;color:#201E1D">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" style="max-width:520px;background:#ffffff" cellpadding="0" cellspacing="0">
      <tr><td style="background:#0B7A4B;color:#ffffff;padding:16px 24px;font-size:18px;font-weight:bold">ক্রীড়াঘর Kriraghor</td></tr>
      <tr><td style="padding:24px"><h1 style="margin:0 0 16px;font-size:20px">${escape(title ?? '')}</h1>${paragraphs}</td></tr>
    </table>
    <p style="color:#888780;font-size:12px;margin:16px 0 0">${footer}</p>
  </td></tr></table></body></html>`;
}

module.exports = { emailHtml };
